#!/bin/bash
set -euo pipefail
################################################################################
#                                                                              #
#   Step 16: Slack 승인 기반 EC2 제어 / Slack Approval-Gated EC2 Control       #
#                                                                              #
#   Slack에서 2단계 승인을 거친 EC2 시작/정지/재부팅만 실행하는 전용 IAM 역할을  #
#   만들고, 대시보드 EC2 역할이 그 역할을 맡을 수 있게 합니다.                  #
#   Creates the dedicated IAM role that executes approved EC2 start/stop/     #
#   reboot, and lets the dashboard's EC2 role assume it.                      #
#                                                                              #
#   관리자 Mac(또는 IAM 권한이 있는 곳)에서 실행합니다.                         #
#   Run from the admin's Mac (or anywhere with IAM permissions).               #
#                                                                              #
#   생성 / Creates (idempotent):                                               #
#     IAM role  AWSopsSlackControlRole                                         #
#       trust:  awsops-ec2-role only, SourceIdentity "slack-*" required        #
#       allow:  ec2:Start/Stop/RebootInstances ONLY on the instance IDs given  #
#               as arguments AND tagged awsops:control=allow (both required —  #
#               a tag alone can be added by anyone in the shared account)      #
#     EC2 role  awsops-ec2-role inline AWSopsSlackControlAssume                #
#                                                                              #
#   제어 대상 지정 (둘 다 필요) / Opt a server in (both needed):                #
#     1) aws ec2 create-tags --resources i-xxxx --tags Key=awsops:control,Value=allow
#     2) 이 스크립트에 ID 나열 / list the ID here (the full list each time)    #
#                                                                              #
#   사용법 / Usage: bash scripts/16-setup-slack-control.sh [i-xxxx ...]        #
#     ID 없이 실행하면 제어 권한을 모두 제거 / no IDs = remove all control      #
#   환경 변수 (선택) / Env: AWS_PROFILE, AWS_DEFAULT_REGION, EC2_ROLE_NAME      #
#                                                                              #
################################################################################

GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"
export AWS_DEFAULT_REGION="$REGION"
export AWS_PAGER=""
EC2_ROLE_NAME="${EC2_ROLE_NAME:-awsops-ec2-role}"
ROLE_NAME="AWSopsSlackControlRole"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
# The bot executes in ap-northeast-2 (src/lib/slack-control/ec2.ts) — keep the policy in the same region.
[ "$REGION" = "ap-northeast-2" ] || { echo "REGION must be ap-northeast-2 (bot region)"; exit 1; }

INSTANCE_IDS=()
for arg in "$@"; do
    [[ "$arg" =~ ^i-[0-9a-f]{8,17}$ ]] || { echo "잘못된 인스턴스 ID / invalid instance id: $arg"; exit 1; }
    INSTANCE_IDS+=("$arg")
done
TAGS="Key=Realm,Value=awsops Key=ServiceDomain,Value=aws Key=ServiceComponent,Value=awsops-poc Key=Environment,Value=sandbox"

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

echo ""
echo -e "${CYAN}=================================================================${NC}"
echo -e "${CYAN}   Step 16: Slack 승인 기반 EC2 제어 / Slack Approval-Gated EC2 Control${NC}"
echo -e "${CYAN}=================================================================${NC}"
echo "  계정 / Account: $ACCOUNT_ID   리전 / Region: $REGION"

# Only the dashboard role may assume it, and only with a "slack-<approver>" SourceIdentity (shows in CloudTrail).
# 대시보드 역할만, 그리고 승인자 SourceIdentity("slack-...")가 있을 때만 맡을 수 있다.
cat > "$TMP_DIR/trust.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"AWS": "arn:aws:iam::${ACCOUNT_ID}:role/${EC2_ROLE_NAME}"},
    "Action": ["sts:AssumeRole", "sts:SetSourceIdentity"],
    "Condition": {"StringLike": {"sts:SourceIdentity": "slack-*"}}
  }]
}
EOF

# Explicit instance list AND the tag: other teams in the shared account can add a tag, but not edit this policy.
# 인스턴스 목록과 태그를 둘 다 요구 — 공유 계정의 다른 팀이 태그는 붙일 수 있어도 이 정책은 못 바꾼다.
if [ ${#INSTANCE_IDS[@]} -gt 0 ]; then
    python3 - "$REGION" "$ACCOUNT_ID" "$TMP_DIR/permissions.json" "${INSTANCE_IDS[@]}" <<'PYEOF'
import json, sys
region, account, out = sys.argv[1], sys.argv[2], sys.argv[3]
arns = [f"arn:aws:ec2:{region}:{account}:instance/{i}" for i in sys.argv[4:]]
policy = {"Version": "2012-10-17", "Statement": [{
    "Sid": "StartStopRebootListedAndTaggedOnly", "Effect": "Allow",
    "Action": ["ec2:StartInstances", "ec2:StopInstances", "ec2:RebootInstances"],
    "Resource": arns,
    "Condition": {"StringEquals": {"aws:ResourceTag/awsops:control": "allow"}},
}]}
json.dump(policy, open(out, "w"), indent=2)
PYEOF
fi

cat > "$TMP_DIR/assume.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["sts:AssumeRole", "sts:SetSourceIdentity"],
    "Resource": "arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
  }]
}
EOF

echo ""
echo -e "${CYAN}[1/2] 제어 전용 역할 / Control role ${ROLE_NAME}${NC}"
if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
    aws iam update-assume-role-policy --role-name "$ROLE_NAME" --policy-document "file://$TMP_DIR/trust.json"
    aws iam tag-role --role-name "$ROLE_NAME" --tags $TAGS
else
    aws iam create-role --role-name "$ROLE_NAME" \
        --assume-role-policy-document "file://$TMP_DIR/trust.json" \
        --description "AWSops Slack approval-gated EC2 start/stop/reboot (tagged instances only)" \
        --max-session-duration 3600 --tags $TAGS >/dev/null
fi
aws iam delete-role-policy --role-name "$ROLE_NAME" --policy-name StartStopRebootTaggedOnly 2>/dev/null || true
if [ ${#INSTANCE_IDS[@]} -gt 0 ]; then
    aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name StartStopRebootListedOnly \
        --policy-document "file://$TMP_DIR/permissions.json"
    echo -e "  ${GREEN}OK${NC} $ROLE_NAME — 제어 허용 / allowed: ${INSTANCE_IDS[*]} (태그 awsops:control=allow도 필요 / tag also required)"
else
    aws iam delete-role-policy --role-name "$ROLE_NAME" --policy-name StartStopRebootListedOnly 2>/dev/null || true
    echo -e "  ${GREEN}OK${NC} $ROLE_NAME — 제어 가능한 인스턴스 없음 / no instances allowed (ID를 인자로 주면 허용)"
fi

echo ""
echo -e "${CYAN}[2/2] 대시보드 역할에 맡기 권한 / Assume permission on ${EC2_ROLE_NAME}${NC}"
aws iam put-role-policy --role-name "$EC2_ROLE_NAME" --policy-name AWSopsSlackControlAssume \
    --policy-document "file://$TMP_DIR/assume.json"
echo -e "  ${GREEN}OK${NC} $EC2_ROLE_NAME / AWSopsSlackControlAssume"

echo ""
echo "  다음 / Next:"
echo "   1) 제어할 서버에 태그 / tag servers:  aws ec2 create-tags --resources i-xxxx --tags Key=awsops:control,Value=allow"
echo "   2) 이 스크립트에 ID 나열 / list IDs:  bash scripts/16-setup-slack-control.sh i-xxxx [i-yyyy ...]"
echo "   3) data/config.json에 승인자 / approvers:  \"slackControl\": {\"approverIds\": [\"U0...\"]}"
