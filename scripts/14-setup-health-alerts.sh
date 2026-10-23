#!/bin/bash
set -e
################################################################################
#                                                                              #
#   Step 14: 헬스 알림 워치독 설정 / Health-Alert Watchdog Setup               #
#                                                                              #
#   서버 외부(Lambda)에서 대시보드 EC2/ALB 상태를 감시하고 Slack으로 알립니다.   #
#   Out-of-server watchdog (Lambda) that watches the dashboard EC2/ALB and     #
#   notifies Slack.                                                            #
#                                                                              #
#   관리자 Mac(또는 IAM 권한이 있는 곳)에서 실행합니다 (EC2 에서 실행 금지).      #
#   Run from the admin's Mac (NOT from the EC2 instance itself).               #
#                                                                              #
#   생성 / Creates (idempotent - create-or-update):                            #
#     1. IAM role   awsops-health-watchdog-role (+ WatchdogAccess inline)      #
#     2. Lambda     awsops-health-watchdog (python3.12, reserved conc. 1)      #
#     3. EventBridge rules: awsops-health-5min, awsops-ec2-state,              #
#                           awsops-ec2-api-calls (+ targets, permissions)      #
#     4. SSM        /ops/awsops/slack-webhook-url (SecureString)                   #
#                   /ops/awsops/health/watchdog-state (String, {})                 #
#     5. EC2 role   awsops-ec2-role inline AWSopsHealthMonitor                 #
#                   (lambda:InvokeFunction on the 19 tool Lambdas)             #
#                                                                              #
#   사용법 / Usage:                                                            #
#     bash scripts/14-setup-health-alerts.sh [--dry-run] [--reset-webhook] [-y]#
#       --dry-run        계획만 출력, AWS 변경 없음 / print plan only, no changes#
#       --reset-webhook  Slack 웹훅을 다시 입력 / re-prompt the Slack webhook   #
#       -y, --yes        확인 질문 생략 / skip the Proceed? prompt              #
#                                                                              #
#   환경 변수 (선택) / Env overrides (optional): AWS_PROFILE, AWS_DEFAULT_REGION#
#     INSTANCE_ID, ALB_NAME, DASHBOARD_URL, EC2_ROLE_NAME                      #
#                                                                              #
#   Slack 웹훅 URL은 화면에 표시/로그/히스토리에 남지 않습니다.                  #
#   The Slack webhook URL is never echoed, logged or stored in history.        #
#                                                                              #
################################################################################

# -- Colors & common variables ------------------------------------------------
GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
WORK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"
export AWS_DEFAULT_REGION="$REGION"
# CLI pager 비활성화 / disable CLI pager
export AWS_PAGER=""

DRY_RUN=false
RESET_WEBHOOK=false
ASSUME_YES=false
for arg in "$@"; do
    case "$arg" in
        --dry-run)       DRY_RUN=true ;;
        --reset-webhook) RESET_WEBHOOK=true ;;
        -y|--yes)        ASSUME_YES=true ;;
        -h|--help)       sed -n 2,36p "$0"; exit 0 ;;
        *) echo -e "${RED}알 수 없는 옵션 / Unknown option: $arg${NC}"; exit 1 ;;
    esac
done

# -- Names & values (Task 5 interface contract) -------------------------------
INSTANCE_ID="${INSTANCE_ID:-i-0806bafeb330307d5}"
ALB_NAME="${ALB_NAME:-awsops-alb}"
DASHBOARD_URL="${DASHBOARD_URL:-https://awsops.moyeota.co.kr/}"
EC2_ROLE_NAME="${EC2_ROLE_NAME:-awsops-ec2-role}"

FUNC_NAME="awsops-health-watchdog"
FUNC_SRC="$WORK_DIR/agent/lambda/health_watchdog.py"
FUNC_HANDLER="health_watchdog.lambda_handler"
ROLE_NAME="awsops-health-watchdog-role"
WEBHOOK_PARAM="/ops/awsops/slack-webhook-url"
STATE_PARAM="/ops/awsops/health/watchdog-state"
RULE_5MIN="awsops-health-5min"
RULE_STATE="awsops-ec2-state"
RULE_API="awsops-ec2-api-calls"

TAG_REALM="Realm=awsops"; TAG_DOMAIN="ServiceDomain=aws"
TAG_COMP="ServiceComponent=awsops-poc"; TAG_ENV="Environment=sandbox"

# 19개 도구 Lambda (06c 와 동일) / the 19 tool Lambdas (same as 06c)
TOOL_LAMBDAS=(
    awsops-network-mcp awsops-reachability-analyzer awsops-flow-monitor
    awsops-eks-mcp awsops-ecs-mcp awsops-iac-mcp awsops-terraform-mcp
    awsops-iam-mcp awsops-cloudwatch-mcp awsops-cloudtrail-mcp awsops-cost-mcp
    awsops-aws-knowledge awsops-core-mcp awsops-dynamodb-mcp awsops-rds-mcp
    awsops-valkey-mcp awsops-msk-mcp awsops-steampipe-query awsops-istio-mcp
)

# -- Temp dir (정리 보장 / always cleaned up) ----------------------------------
TMP_DIR="$(mktemp -d)"
chmod 700 "$TMP_DIR"
trap 'rm -rf "$TMP_DIR"' EXIT

echo ""
echo -e "${CYAN}=================================================================${NC}"
echo -e "${CYAN}   Step 14: 헬스 알림 워치독 설정 / Health-Alert Watchdog Setup${NC}"
echo -e "${CYAN}=================================================================${NC}"
echo ""

# -- [1/7] 사전 점검 / Pre-flight ---------------------------------------------
echo -e "${CYAN}[1/7] 사전 점검 / Pre-flight checks...${NC}"

for cmd in aws python3; do
    if ! command -v "$cmd" &>/dev/null; then
        echo -e "${RED}오류: $cmd 를 찾을 수 없습니다 / ERROR: $cmd not found${NC}"
        exit 1
    fi
done

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)
if [ -z "$ACCOUNT_ID" ]; then
    echo -e "${RED}오류: AWS 자격 증명을 확인할 수 없습니다 / ERROR: cannot resolve AWS credentials${NC}"
    exit 1
fi
if [ ! -f "$FUNC_SRC" ]; then
    if [ "$DRY_RUN" = true ]; then
        echo -e "  ${YELLOW}경고 / WARN: $FUNC_SRC 없음 (dry-run 이므로 계속) / not found (continuing, dry-run)${NC}"
    else
        echo -e "${RED}오류: $FUNC_SRC 를 찾을 수 없습니다 / ERROR: $FUNC_SRC not found${NC}"
        exit 1
    fi
fi

ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
FUNC_ARN="arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${FUNC_NAME}"
WEBHOOK_ARN="arn:aws:ssm:${REGION}:${ACCOUNT_ID}:parameter${WEBHOOK_PARAM}"
STATE_ARN="arn:aws:ssm:${REGION}:${ACCOUNT_ID}:parameter${STATE_PARAM}"

echo "  Account:   $ACCOUNT_ID"
echo "  Region:    $REGION"
echo "  Instance:  $INSTANCE_ID"
echo "  Dashboard: $DASHBOARD_URL"

# -- 현재 상태 조회 (읽기 전용) / Current state (read-only) -------------------
role_exists=false;  aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1 && role_exists=true
func_exists=false;  aws lambda get-function --function-name "$FUNC_NAME" >/dev/null 2>&1 && func_exists=true
ec2role_exists=false; aws iam get-role --role-name "$EC2_ROLE_NAME" >/dev/null 2>&1 && ec2role_exists=true

param_exists() {
    # describe-parameters: 값을 읽지 않고 존재만 확인 / existence only, never reads the value
    local n
    n=$(aws ssm describe-parameters \
        --parameter-filters "Key=Name,Option=Equals,Values=$1" \
        --query 'length(Parameters)' --output text 2>/dev/null || echo 0)
    [ "$n" != "0" ] && [ -n "$n" ]
}
webhook_exists=false; param_exists "$WEBHOOK_PARAM" && webhook_exists=true
state_exists=false;   param_exists "$STATE_PARAM" && state_exists=true

rule_exists() {
    aws events describe-rule --name "$1" >/dev/null 2>&1
}

act() { if [ "$1" = true ]; then echo "UPDATE"; else echo "CREATE"; fi; }

need_webhook_prompt=false
if [ "$webhook_exists" = false ] || [ "$RESET_WEBHOOK" = true ]; then need_webhook_prompt=true; fi

# -- [2/7] 계획 출력 / Plan ---------------------------------------------------
echo ""
echo -e "${CYAN}[2/7] 계획 / Plan${NC}"
printf "  %-8s IAM role        %s (+ AWSLambdaBasicExecutionRole, inline WatchdogAccess)\n" "$(act $role_exists)" "$ROLE_NAME"
printf "  %-8s Lambda          %s (python3.12, %s, 30s, 128MB, reserved concurrency 1)\n" "$(act $func_exists)" "$FUNC_NAME" "$FUNC_HANDLER"
printf "           Lambda env      INSTANCE_ID=%s ALB_NAME=%s\n" "$INSTANCE_ID" "$ALB_NAME"
printf "                           DASHBOARD_URL=%s\n" "$DASHBOARD_URL"
printf "                           WEBHOOK_PARAM=%s STATE_PARAM=%s\n" "$WEBHOOK_PARAM" "$STATE_PARAM"
for r in "$RULE_5MIN:rate(5 minutes)" "$RULE_STATE:EC2 Instance State-change ($INSTANCE_ID)" "$RULE_API:CloudTrail Stop/Start/TerminateInstances"; do
    rn="${r%%:*}"; rd="${r#*:}"
    rx=false; rule_exists "$rn" && rx=true
    printf "  %-8s EventBridge     %s  [%s]\n" "$(act $rx)" "$rn" "$rd"
done
if [ "$webhook_exists" = true ] && [ "$RESET_WEBHOOK" = false ]; then
    printf "  %-8s SSM             %s (SecureString, 기존 값 유지 / keep existing value)\n" "KEEP" "$WEBHOOK_PARAM"
elif [ "$webhook_exists" = true ]; then
    printf "  %-8s SSM             %s (SecureString, --reset-webhook: 웹훅 재입력 / re-prompt)\n" "UPDATE" "$WEBHOOK_PARAM"
else
    printf "  %-8s SSM             %s (SecureString, 웹훅 입력 필요 / webhook prompt)\n" "CREATE" "$WEBHOOK_PARAM"
fi
if [ "$state_exists" = true ]; then
    printf "  %-8s SSM             %s (String, 기존 값 유지 / keep existing value)\n" "KEEP" "$STATE_PARAM"
else
    printf "  %-8s SSM             %s (String, {})\n" "CREATE" "$STATE_PARAM"
fi
if [ "$ec2role_exists" = true ]; then
    printf "  %-8s EC2 role policy %s / AWSopsHealthMonitor (lambda:InvokeFunction x%d)\n" "UPSERT" "$EC2_ROLE_NAME" "${#TOOL_LAMBDAS[@]}"
else
    printf "  %-8s EC2 role policy %s / AWSopsHealthMonitor (역할 없음 - 건너뜀 / role not found - will skip)\n" "SKIP" "$EC2_ROLE_NAME"
fi
echo "           Tags            $TAG_REALM $TAG_DOMAIN $TAG_COMP $TAG_ENV"
echo ""

if [ "$DRY_RUN" = true ]; then
    echo -e "${YELLOW}--dry-run: 계획만 출력했습니다. AWS 리소스는 변경되지 않았습니다.${NC}"
    echo -e "${YELLOW}--dry-run: plan only. No AWS resources were created or modified.${NC}"
    echo ""
    exit 0
fi

if [ "$ASSUME_YES" = false ]; then
    read -r -p "Proceed? (y/n) " CONFIRM
    if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
        echo "취소되었습니다 / Cancelled."
        exit 0
    fi
fi

# -- [3/7] Slack 웹훅 → SSM / Slack webhook → SSM -----------------------------
echo ""
echo -e "${CYAN}[3/7] SSM 파라미터 / SSM parameters...${NC}"

if [ "$need_webhook_prompt" = true ]; then
    if [ ! -t 0 ]; then
        echo -e "${RED}오류: 웹훅 입력에는 대화형 터미널이 필요합니다 / ERROR: interactive terminal required for the webhook prompt${NC}"
        exit 1
    fi
    echo "  Slack Incoming Webhook URL 을 입력하세요 (입력은 표시되지 않습니다)."
    echo "  Enter the Slack Incoming Webhook URL (input is hidden)."
    read -rsp "  Webhook URL: " WEBHOOK_URL
    echo ""
    case "$WEBHOOK_URL" in
        https://hooks.slack.com/*) ;;
        *)
            WEBHOOK_URL=""
            echo -e "${RED}오류: https://hooks.slack.com/ 로 시작해야 합니다 / ERROR: must start with https://hooks.slack.com/${NC}"
            exit 1 ;;
    esac
    # argv/히스토리에 남기지 않도록 0600 임시 파일 사용 / 0600 temp file keeps it out of argv & history
    WEBHOOK_FILE="$TMP_DIR/webhook.txt"
    ( umask 077; printf '%s' "$WEBHOOK_URL" > "$WEBHOOK_FILE" )
    chmod 600 "$WEBHOOK_FILE"
    WEBHOOK_URL=""
    if [ "$webhook_exists" = true ]; then
        aws ssm put-parameter --name "$WEBHOOK_PARAM" --type SecureString --overwrite \
            --value "file://$WEBHOOK_FILE" >/dev/null
        aws ssm add-tags-to-resource --resource-type Parameter --resource-id "$WEBHOOK_PARAM" \
            --tags Key=Realm,Value=awsops Key=ServiceDomain,Value=aws Key=ServiceComponent,Value=awsops-poc Key=Environment,Value=sandbox >/dev/null
    else
        aws ssm put-parameter --name "$WEBHOOK_PARAM" --type SecureString \
            --value "file://$WEBHOOK_FILE" \
            --tags Key=Realm,Value=awsops Key=ServiceDomain,Value=aws Key=ServiceComponent,Value=awsops-poc Key=Environment,Value=sandbox >/dev/null
    fi
    rm -f "$WEBHOOK_FILE"
    echo -e "  ${GREEN}OK${NC} $WEBHOOK_PARAM (SecureString)"
else
    echo "  $WEBHOOK_PARAM: 기존 값 유지 / keeping existing value (--reset-webhook 으로 변경 / to change)"
fi

if [ "$state_exists" = false ]; then
    printf '%s' '{}' > "$TMP_DIR/state.json"
    aws ssm put-parameter --name "$STATE_PARAM" --type String --value "file://$TMP_DIR/state.json" \
        --tags Key=Realm,Value=awsops Key=ServiceDomain,Value=aws Key=ServiceComponent,Value=awsops-poc Key=Environment,Value=sandbox >/dev/null
    echo -e "  ${GREEN}OK${NC} $STATE_PARAM = {}"
else
    echo "  $STATE_PARAM: 기존 값 유지 / keeping existing value"
fi

# -- [4/7] Lambda IAM 역할 / Lambda IAM role -----------------------------------
echo ""
echo -e "${CYAN}[4/7] Lambda IAM 역할 / Lambda IAM role...${NC}"

cat > "$TMP_DIR/trust.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{"Effect": "Allow", "Principal": {"Service": "lambda.amazonaws.com"}, "Action": "sts:AssumeRole"}]
}
EOF

cat > "$TMP_DIR/watchdog-access.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadInfra",
      "Effect": "Allow",
      "Action": ["ec2:DescribeInstances", "elasticloadbalancing:Describe*", "cloudwatch:GetMetricData"],
      "Resource": "*"
    },
    {
      "Sid": "ReadParams",
      "Effect": "Allow",
      "Action": "ssm:GetParameter",
      "Resource": ["${WEBHOOK_ARN}", "${STATE_ARN}"]
    },
    {
      "Sid": "WriteState",
      "Effect": "Allow",
      "Action": "ssm:PutParameter",
      "Resource": "${STATE_ARN}"
    }
  ]
}
EOF

ROLE_CREATED=false
if [ "$role_exists" = true ]; then
    aws iam update-assume-role-policy --role-name "$ROLE_NAME" --policy-document "file://$TMP_DIR/trust.json"
    aws iam tag-role --role-name "$ROLE_NAME" \
        --tags Key=Realm,Value=awsops Key=ServiceDomain,Value=aws Key=ServiceComponent,Value=awsops-poc Key=Environment,Value=sandbox
else
    aws iam create-role --role-name "$ROLE_NAME" \
        --assume-role-policy-document "file://$TMP_DIR/trust.json" \
        --description "AWSops health watchdog Lambda role" \
        --tags Key=Realm,Value=awsops Key=ServiceDomain,Value=aws Key=ServiceComponent,Value=awsops-poc Key=Environment,Value=sandbox >/dev/null
    ROLE_CREATED=true
fi
aws iam attach-role-policy --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name WatchdogAccess \
    --policy-document "file://$TMP_DIR/watchdog-access.json"
echo -e "  ${GREEN}OK${NC} $ROLE_NAME"
if [ "$ROLE_CREATED" = true ]; then
    echo "  IAM 전파 대기 (10s) / Waiting for IAM propagation (10s)..."
    sleep 10
fi

# -- [5/7] Lambda 배포 / Deploy Lambda ----------------------------------------
echo ""
echo -e "${CYAN}[5/7] Lambda 배포 / Deploy Lambda...${NC}"

# 핸들러 단독 패키징 (cross_account.py 미포함) / handler packaged ALONE
ZIP_FILE="$TMP_DIR/health_watchdog.zip"
python3 - "$FUNC_SRC" "$ZIP_FILE" <<'PYEOF'
import sys, zipfile
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    z.write(src, "health_watchdog.py")
PYEOF

cat > "$TMP_DIR/lambda-env.json" <<EOF
{"Variables": {
  "INSTANCE_ID": "${INSTANCE_ID}",
  "ALB_NAME": "${ALB_NAME}",
  "DASHBOARD_URL": "${DASHBOARD_URL}",
  "WEBHOOK_PARAM": "${WEBHOOK_PARAM}",
  "STATE_PARAM": "${STATE_PARAM}"
}}
EOF

if [ "$func_exists" = true ]; then
    aws lambda update-function-code --function-name "$FUNC_NAME" \
        --zip-file "fileb://$ZIP_FILE" >/dev/null
    aws lambda wait function-updated --function-name "$FUNC_NAME"
    aws lambda update-function-configuration --function-name "$FUNC_NAME" \
        --runtime python3.12 --handler "$FUNC_HANDLER" --role "$ROLE_ARN" \
        --timeout 30 --memory-size 128 \
        --environment "file://$TMP_DIR/lambda-env.json" >/dev/null
    aws lambda wait function-updated --function-name "$FUNC_NAME"
    aws lambda tag-resource --resource "$FUNC_ARN" \
        --tags Realm=awsops,ServiceDomain=aws,ServiceComponent=awsops-poc,Environment=sandbox
    echo -e "  ${GREEN}OK${NC} $FUNC_NAME (updated)"
else
    created=false
    for attempt in 1 2 3 4 5 6; do
        if aws lambda create-function --function-name "$FUNC_NAME" \
            --runtime python3.12 --handler "$FUNC_HANDLER" --role "$ROLE_ARN" \
            --zip-file "fileb://$ZIP_FILE" --timeout 30 --memory-size 128 \
            --environment "file://$TMP_DIR/lambda-env.json" \
            --tags Realm=awsops,ServiceDomain=aws,ServiceComponent=awsops-poc,Environment=sandbox \
            >/dev/null 2>"$TMP_DIR/create-err.txt"; then
            created=true; break
        fi
        # 새 역할 전파 지연이면 재시도 / retry if the new role has not propagated yet
        if grep -q "cannot be assumed" "$TMP_DIR/create-err.txt"; then
            echo "  역할 전파 대기 중... (재시도 $attempt/6) / waiting for role propagation (retry $attempt/6)"
            sleep 10
        else
            cat "$TMP_DIR/create-err.txt" >&2
            break
        fi
    done
    if [ "$created" = false ]; then
        echo -e "${RED}오류: Lambda 생성 실패 / ERROR: Lambda creation failed${NC}"
        exit 1
    fi
    aws lambda wait function-active --function-name "$FUNC_NAME"
    echo -e "  ${GREEN}OK${NC} $FUNC_NAME (created)"
fi

# 동시 실행 1로 제한 (중복 알림/상태 경쟁 방지) / reserved concurrency 1 (no duplicate alerts / state races)
if aws lambda put-function-concurrency --function-name "$FUNC_NAME" \
    --reserved-concurrent-executions 1 >/dev/null 2>"$TMP_DIR/conc-err.txt"; then
    echo -e "  ${GREEN}OK${NC} reserved concurrency = 1"
else
    echo -e "  ${YELLOW}경고 / WARN: reserved concurrency 설정 실패 (계정 동시성 한도?) / could not set reserved concurrency (account limit?)${NC}"
    sed 's/^/    /' "$TMP_DIR/conc-err.txt"
fi

# -- [6/7] EventBridge 규칙 / EventBridge rules --------------------------------
echo ""
echo -e "${CYAN}[6/7] EventBridge 규칙 / EventBridge rules...${NC}"

cat > "$TMP_DIR/pattern-state.json" <<EOF
{"source":["aws.ec2"],"detail-type":["EC2 Instance State-change Notification"],"detail":{"instance-id":["${INSTANCE_ID}"],"state":["running","stopping","stopped","shutting-down","terminated"]}}
EOF
# 대상 인스턴스만 매칭 — 다른 팀의 Stop/Start 이벤트가 동시성 1 워치독을 소모하지 않도록 (핸들러도 재확인)
# match only our instance so other teams' Stop/Start calls don't consume the concurrency-1 watchdog
# (the handler re-checks the instance id as well)
cat > "$TMP_DIR/pattern-api.json" <<EOF
{"source":["aws.ec2"],"detail-type":["AWS API Call via CloudTrail"],"detail":{"eventSource":["ec2.amazonaws.com"],"eventName":["StopInstances","StartInstances","TerminateInstances"],"requestParameters":{"instancesSet":{"items":{"instanceId":["${INSTANCE_ID}"]}}}}}
EOF

# put_rule <name> <description> <schedule|pattern> <value-or-file>
put_rule() {
    local name="$1" desc="$2" kind="$3" val="$4" rule_arn
    if [ "$kind" = schedule ]; then
        rule_arn=$(aws events put-rule --name "$name" --description "$desc" --state ENABLED \
            --schedule-expression "$val" --query RuleArn --output text)
    else
        rule_arn=$(aws events put-rule --name "$name" --description "$desc" --state ENABLED \
            --event-pattern "file://$val" --query RuleArn --output text)
    fi
    aws events tag-resource --resource-arn "$rule_arn" \
        --tags Key=Realm,Value=awsops Key=ServiceDomain,Value=aws Key=ServiceComponent,Value=awsops-poc Key=Environment,Value=sandbox
    aws events put-targets --rule "$name" --targets "Id=watchdog,Arn=$FUNC_ARN" >/dev/null
    # 규칙 ARN 이 바뀌어도 일치하도록 재생성 / recreate so the source-arn always matches
    aws lambda remove-permission --function-name "$FUNC_NAME" --statement-id "$name" >/dev/null 2>&1 || true
    aws lambda add-permission --function-name "$FUNC_NAME" --statement-id "$name" \
        --action lambda:InvokeFunction --principal events.amazonaws.com \
        --source-arn "$rule_arn" >/dev/null
    echo -e "  ${GREEN}OK${NC} $name"
}

put_rule "$RULE_5MIN"  "AWSops health watchdog - 5 minute poll"            schedule "rate(5 minutes)"
put_rule "$RULE_STATE" "AWSops health watchdog - EC2 state-change events"  pattern  "$TMP_DIR/pattern-state.json"
put_rule "$RULE_API"   "AWSops health watchdog - EC2 stop/start API calls" pattern  "$TMP_DIR/pattern-api.json"

# -- [7/7] EC2 역할 인라인 정책 / EC2 role inline policy -----------------------
echo ""
echo -e "${CYAN}[7/7] EC2 역할 정책 / EC2 role inline policy (AWSopsHealthMonitor)...${NC}"

if [ "$ec2role_exists" = true ]; then
    python3 - "$ACCOUNT_ID" "$REGION" "$TMP_DIR/health-monitor.json" "${TOOL_LAMBDAS[@]}" <<'PYEOF'
import json, sys
account, region, out = sys.argv[1], sys.argv[2], sys.argv[3]
arns = [f"arn:aws:lambda:{region}:{account}:function:{n}" for n in sys.argv[4:]]
policy = {
    "Version": "2012-10-17",
    "Statement": [{"Sid": "HealthMonitorProbe", "Effect": "Allow",
                   "Action": "lambda:InvokeFunction", "Resource": arns}],
}
with open(out, "w") as f:
    json.dump(policy, f, indent=2)
PYEOF
    aws iam put-role-policy --role-name "$EC2_ROLE_NAME" --policy-name AWSopsHealthMonitor \
        --policy-document "file://$TMP_DIR/health-monitor.json"
    echo -e "  ${GREEN}OK${NC} $EC2_ROLE_NAME / AWSopsHealthMonitor (${#TOOL_LAMBDAS[@]} functions)"
else
    echo -e "  ${YELLOW}건너뜀 / SKIP: 역할 $EC2_ROLE_NAME 없음 / role not found${NC}"
fi

# -- 검증: 워치독 1회 호출 / Verify: invoke watchdog once ----------------------
echo ""
echo -e "${CYAN}검증 / Verify: 워치독 1회 호출 / invoking watchdog once...${NC}"
printf '%s' '{"source":"aws.events","detail-type":"Scheduled Event"}' > "$TMP_DIR/invoke-payload.json"
if aws lambda invoke --function-name "$FUNC_NAME" \
    --cli-binary-format raw-in-base64-out --payload "file://$TMP_DIR/invoke-payload.json" \
    "$TMP_DIR/invoke-out.json" >"$TMP_DIR/invoke-meta.json" 2>&1; then
    echo "  Result:"
    sed 's/^/    /' "$TMP_DIR/invoke-out.json"
    echo ""
    if grep -q FunctionError "$TMP_DIR/invoke-meta.json"; then
        echo -e "  ${RED}Lambda 가 오류를 반환했습니다 / Lambda returned an error:${NC}"
        sed 's/^/    /' "$TMP_DIR/invoke-meta.json"
        exit 1
    fi
else
    echo -e "  ${RED}호출 실패 / Invoke failed:${NC}"
    sed 's/^/    /' "$TMP_DIR/invoke-meta.json"
    exit 1
fi

echo ""
echo -e "${GREEN}=================================================================${NC}"
echo -e "${GREEN}   Step 14 완료 / Complete${NC}"
echo -e "${GREEN}=================================================================${NC}"
echo "  Lambda:      $FUNC_NAME"
echo "  Rules:       $RULE_5MIN, $RULE_STATE, $RULE_API"
echo "  SSM:         $WEBHOOK_PARAM, $STATE_PARAM"
echo "  웹훅 변경 / Change webhook: bash scripts/14-setup-health-alerts.sh --reset-webhook"
echo ""
