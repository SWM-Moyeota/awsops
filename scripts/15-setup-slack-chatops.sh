#!/bin/bash
set -e
################################################################################
#                                                                              #
#   Step 15: Slack ChatOps 설정 / Slack ChatOps Setup                          #
#                                                                              #
#   Slack에서 @AWSops 로 AI에게 바로 묻는 봇의 토큰 2개를 SSM에 저장하고,       #
#   대시보드 서버를 재시작해 Socket Mode 연결을 엽니다.                         #
#   Stores the bot's two Slack tokens in SSM and restarts the dashboard so    #
#   it opens the Socket Mode connection.                                       #
#                                                                              #
#   관리자 Mac(또는 IAM 권한이 있는 곳)에서 실행합니다.                         #
#   Run from the admin's Mac (or anywhere with IAM permissions).               #
#                                                                              #
#   먼저 Slack 앱을 만드세요 / Create the Slack app first:                      #
#     docs/runbooks/slack-chatops.md  (manifest: slack-chatops-manifest.yaml)  #
#                                                                              #
#   생성 / Creates (idempotent - overwrite):                                   #
#     SSM /ops/awsops/slack-bot-token  (SecureString, xoxb-...)                #
#     SSM /ops/awsops/slack-app-token  (SecureString, xapp-...)                #
#   IAM 변경 없음 — EC2 역할의 AmazonSSMManagedInstanceCore가 읽기를 허용.       #
#   No IAM change — the EC2 role can already read these parameters.           #
#                                                                              #
#   사용법 / Usage:                                                            #
#     bash scripts/15-setup-slack-chatops.sh [--no-restart] [-y]               #
#       --no-restart  서버 재시작 생략 / skip restarting the dashboard           #
#       -y, --yes     확인 질문 생략 / skip the restart prompt                   #
#                                                                              #
#   환경 변수 (선택) / Env overrides (optional): AWS_PROFILE,                   #
#     AWS_DEFAULT_REGION, INSTANCE_ID                                          #
#                                                                              #
#   토큰은 화면에 표시/로그/히스토리에 남지 않습니다.                            #
#   Tokens are never echoed, logged or stored in shell history.                #
#                                                                              #
################################################################################

GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"
export AWS_DEFAULT_REGION="$REGION"
export AWS_PAGER=""

RESTART=true
ASSUME_YES=false
for arg in "$@"; do
    case "$arg" in
        --no-restart) RESTART=false ;;
        -y|--yes)     ASSUME_YES=true ;;
        -h|--help)    sed -n 2,35p "$0"; exit 0 ;;
        *) echo -e "${RED}알 수 없는 옵션 / Unknown option: $arg${NC}"; exit 1 ;;
    esac
done

INSTANCE_ID="${INSTANCE_ID:-i-0806bafeb330307d5}"
BOT_PARAM="/ops/awsops/slack-bot-token"
APP_PARAM="/ops/awsops/slack-app-token"
TAGS="Key=Realm,Value=awsops Key=ServiceDomain,Value=aws Key=ServiceComponent,Value=awsops-poc Key=Environment,Value=sandbox"

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

echo ""
echo -e "${CYAN}=================================================================${NC}"
echo -e "${CYAN}   Step 15: Slack ChatOps 설정 / Slack ChatOps Setup${NC}"
echo -e "${CYAN}=================================================================${NC}"
echo "  계정 / Account: $(aws sts get-caller-identity --query Account --output text)   리전 / Region: $REGION"
echo ""

# $1=param name, $2=prompt label, $3=required prefix
store_token() {
    local name="$1" label="$2" prefix="$3" token file exists=false
    read -rsp "  $label (${prefix}..., 입력은 숨겨짐 / hidden): " token
    echo ""
    case "$token" in
        "$prefix"*) ;;
        *) echo -e "${RED}오류: ${prefix} 로 시작해야 합니다 / ERROR: must start with ${prefix}${NC}"; exit 1 ;;
    esac
    # argv/히스토리에 남기지 않도록 0600 임시 파일 사용 / 0600 temp file keeps it out of argv & history
    file="$TMP_DIR/token.txt"
    ( umask 077; printf '%s' "$token" > "$file" )
    token=""
    aws ssm get-parameter --name "$name" >/dev/null 2>&1 && exists=true
    if [ "$exists" = true ]; then
        aws ssm put-parameter --name "$name" --type SecureString --overwrite --value "file://$file" >/dev/null
        aws ssm add-tags-to-resource --resource-type Parameter --resource-id "$name" --tags $TAGS >/dev/null
    else
        aws ssm put-parameter --name "$name" --type SecureString --value "file://$file" --tags $TAGS >/dev/null
    fi
    rm -f "$file"
    echo -e "  ${GREEN}OK${NC} $name (SecureString)"
}

echo -e "${CYAN}[1/2] 토큰 저장 / Store tokens${NC}"
echo "  Bot User OAuth Token: Slack 앱 → OAuth & Permissions"
store_token "$BOT_PARAM" "Bot token" "xoxb-"
echo "  App-Level Token: Slack 앱 → Basic Information → App-Level Tokens (connections:write)"
store_token "$APP_PARAM" "App token" "xapp-"

echo ""
echo -e "${CYAN}[2/2] 대시보드 재시작 / Restart dashboard${NC}"
if [ "$RESTART" = false ]; then
    echo "  건너뜀 / skipped (--no-restart). 다음 재시작 때 연결됩니다 / connects on next restart."
    exit 0
fi
if [ "$ASSUME_YES" = false ]; then
    read -rp "  $INSTANCE_ID 의 대시보드를 재시작할까요? / Restart the dashboard on $INSTANCE_ID? [y/N] " ans
    case "$ans" in y|Y|yes) ;; *) echo "  건너뜀 / skipped"; exit 0 ;; esac
fi
CMD_ID=$(aws ssm send-command --instance-ids "$INSTANCE_ID" --document-name AWS-RunShellScript \
    --comment "awsops slack-chatops restart" \
    --parameters 'commands=["sudo -u ec2-user bash -lc \"cd /home/ec2-user/awsops && bash scripts/09-start-all.sh >/dev/null 2>&1; sleep 10; grep slack-chatops /tmp/awsops-server.log | tail -3\""]' \
    --query Command.CommandId --output text)
echo "  재시작 중... / restarting (SSM $CMD_ID)"
for _ in $(seq 1 30); do
    sleep 5
    STATUS=$(aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" --query Status --output text 2>/dev/null || echo Pending)
    case "$STATUS" in Success|Failed|Cancelled|TimedOut) break ;; esac
done
OUT=$(aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" --query StandardOutputContent --output text 2>/dev/null || true)
if echo "$OUT" | grep -q "connected as"; then
    echo -e "  ${GREEN}OK${NC} $(echo "$OUT" | grep 'connected as' | tail -1)"
    echo ""
    echo "  이제 Slack 채널에서 /invite @AWSops 후 '@AWSops 지금 켜진 EC2 뭐 있어?' 처럼 물어보세요."
else
    echo -e "  ${YELLOW}연결 로그를 찾지 못했어요 / connection log not found:${NC}"
    echo "$OUT" | sed 's/^/    /'
    echo "  서버에서 확인 / check on the server: grep slack-chatops /tmp/awsops-server.log"
fi
