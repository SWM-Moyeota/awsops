#!/bin/bash
set -euo pipefail
################################################################################
#                                                                              #
#   Step 17: 안전한 AI 실행 / Safe AI Actions executor role                    #
#                                                                              #
#   Slack에서 AI가 계획하고 사람 2명이 승인한 작업(태그, 보안그룹 인바운드,     #
#   시작/정지)만 실행하는 전용 IAM 역할을 만들고, 대시보드 EC2 역할이 그        #
#   역할을 맡을 수 있게 합니다. 실행할 때마다 세션 정책으로 더 좁혀집니다.      #
#   Creates the dedicated IAM role that executes AI-planned, two-person-       #
#   approved changes (tags, SG ingress, start/stop), and lets the dashboard's  #
#   EC2 role assume it. Each execution narrows it further with a session      #
#   policy (src/lib/action-plan/session-policy.ts).                            #
#                                                                              #
#   관리자 Mac(또는 IAM 권한이 있는 곳)에서 실행합니다.                         #
#   Run from the admin's Mac (or anywhere with IAM permissions).               #
#                                                                              #
#   생성 / Creates (idempotent):                                               #
#     IAM role  AWSopsActionExecutorRole                                       #
#       trust:  awsops-ec2-role only, SourceIdentity "slack-*" required        #
#       allow:  ec2:Start/StopInstances on the instance IDs given, and         #
#               ec2:CreateTags/DeleteTags/Authorize/RevokeSecurityGroupIngress #
#               on the instance and security-group IDs given — ONLY when the   #
#               resource is also tagged awsops:control=allow (both required —  #
#               a tag alone can be added by anyone in the shared account)      #
#       deny:   ec2:CreateTags/DeleteTags touching any awsops:* tag key        #
#               (the AI can never grant itself a new target)                   #
#     EC2 role  awsops-ec2-role inline AWSopsActionExecutorAssume              #
#                                                                              #
#   대상 지정 (둘 다 필요) / Opt a resource in (both needed):                   #
#     1) aws ec2 create-tags --resources i-xxxx sg-yyyy --tags Key=awsops:control,Value=allow
#     2) 이 스크립트에 ID 나열 / list the IDs here (the full list each time)   #
#                                                                              #
#   사용법 / Usage: bash scripts/17-setup-action-executor.sh [i-xxxx|sg-yyyy ...]
#     ID 없이 실행하면 실행 권한을 모두 제거 / no IDs = remove all permissions  #
#   환경 변수 (선택) / Env: AWS_PROFILE, AWS_DEFAULT_REGION, EC2_ROLE_NAME      #
#                                                                              #
################################################################################

GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"
export AWS_DEFAULT_REGION="$REGION"
export AWS_PAGER=""
EC2_ROLE_NAME="${EC2_ROLE_NAME:-awsops-ec2-role}"
ROLE_NAME="AWSopsActionExecutorRole"
POLICY_NAME="ActionExecutorListedOnly"
# The bot executes in ap-northeast-2 (src/lib/action-plan/aws.ts) — keep the policy in the same region.
[ "$REGION" = "ap-northeast-2" ] || { echo "REGION must be ap-northeast-2 (bot region)"; exit 1; }

INSTANCE_IDS=()
GROUP_IDS=()
for arg in "$@"; do
    if [[ "$arg" =~ ^i-[0-9a-f]{8,17}$ ]]; then
        INSTANCE_IDS+=("$arg")
    elif [[ "$arg" =~ ^sg-[0-9a-f]{8,17}$ ]]; then
        GROUP_IDS+=("$arg")
    else
        echo "잘못된 ID / invalid id (i-... 또는 sg-... 만): $arg"; exit 1
    fi
done
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
TAGS="Key=Realm,Value=awsops Key=ServiceDomain,Value=aws Key=ServiceComponent,Value=awsops-poc Key=Environment,Value=sandbox"

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

echo ""
echo -e "${CYAN}=================================================================${NC}"
echo -e "${CYAN}   Step 17: 안전한 AI 실행 / Safe AI Actions executor role${NC}"
echo -e "${CYAN}=================================================================${NC}"
echo "  계정 / Account: $ACCOUNT_ID   리전 / Region: $REGION"

# Same trust as Step 16: only the dashboard role, and only with a "slack-<approver>" SourceIdentity (shows in CloudTrail).
# 16번과 같은 신뢰 정책 — 대시보드 역할만, 승인자 SourceIdentity("slack-...")가 있을 때만 맡을 수 있다.
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

# Explicit ID list AND the tag on every Allow: other teams in the shared account can add a tag, but not edit this policy.
# Security-group ARN only, no security-group-rule/* — matches session-policy.ts (AWS Service Authorization Reference:
# AuthorizeSecurityGroupIngress needs security-group-rule only when TagSpecifications are passed; the executor passes none).
# 모든 Allow에 ID 목록과 태그를 둘 다 요구한다. 보안그룹 규칙 ARN(security-group-rule/*)은 주지 않는다.
if [ ${#INSTANCE_IDS[@]} -gt 0 ] || [ ${#GROUP_IDS[@]} -gt 0 ]; then
    python3 - "$REGION" "$ACCOUNT_ID" "$TMP_DIR/permissions.json" ${INSTANCE_IDS[@]+"${INSTANCE_IDS[@]}"} ${GROUP_IDS[@]+"${GROUP_IDS[@]}"} <<'PYEOF'
import json, sys
region, account, out = sys.argv[1], sys.argv[2], sys.argv[3]
ids = sys.argv[4:]
instances = [f"arn:aws:ec2:{region}:{account}:instance/{i}" for i in ids if i.startswith("i-")]
groups = [f"arn:aws:ec2:{region}:{account}:security-group/{g}" for g in ids if g.startswith("sg-")]
tagged = {"StringEquals": {"aws:ResourceTag/awsops:control": "allow"}}
statements = []
if instances:
    statements.append({
        "Sid": "StartStopListedAndTaggedOnly", "Effect": "Allow",
        "Action": ["ec2:StartInstances", "ec2:StopInstances"],
        "Resource": instances, "Condition": tagged,
    })
statements.append({
    "Sid": "TagsListedAndTaggedOnly", "Effect": "Allow",
    "Action": ["ec2:CreateTags", "ec2:DeleteTags"],
    "Resource": instances + groups, "Condition": tagged,
})
if groups:
    statements.append({
        "Sid": "IngressListedAndTaggedOnly", "Effect": "Allow",
        "Action": ["ec2:AuthorizeSecurityGroupIngress", "ec2:RevokeSecurityGroupIngress"],
        "Resource": groups, "Condition": tagged,
    })
# The AI must never add, change or remove awsops:* tags (e.g. awsops:control) — that would widen its own targets.
statements.append({
    "Sid": "DenyAwsopsTagKeys", "Effect": "Deny",
    "Action": ["ec2:CreateTags", "ec2:DeleteTags"],
    "Resource": "*",
    "Condition": {"ForAnyValue:StringLike": {"aws:TagKeys": ["awsops:*"]}},
})
# DeleteTags without a Tags list deletes every tag (awsops:control included), and aws:TagKeys is then absent,
# so the ForAnyValue Deny above does not match. Deny that form outright. 태그 목록 없는 DeleteTags(전체 삭제)도 거부.
statements.append({
    "Sid": "DenyDeleteAllTags", "Effect": "Deny",
    "Action": "ec2:DeleteTags",
    "Resource": "*",
    "Condition": {"Null": {"aws:TagKeys": "true"}},
})
json.dump({"Version": "2012-10-17", "Statement": statements}, open(out, "w"), indent=2)
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
echo -e "${CYAN}[1/2] 실행 전용 역할 / Executor role ${ROLE_NAME}${NC}"
if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
    aws iam update-assume-role-policy --role-name "$ROLE_NAME" --policy-document "file://$TMP_DIR/trust.json"
    aws iam tag-role --role-name "$ROLE_NAME" --tags $TAGS
else
    aws iam create-role --role-name "$ROLE_NAME" \
        --assume-role-policy-document "file://$TMP_DIR/trust.json" \
        --description "AWSops Slack AI-planned, approval-gated tag/SG/start/stop (listed + tagged resources only)" \
        --max-session-duration 3600 --tags $TAGS >/dev/null
fi
if [ ${#INSTANCE_IDS[@]} -gt 0 ] || [ ${#GROUP_IDS[@]} -gt 0 ]; then
    aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name "$POLICY_NAME" \
        --policy-document "file://$TMP_DIR/permissions.json"
    echo -e "  ${GREEN}OK${NC} $ROLE_NAME — 허용 / allowed: ${INSTANCE_IDS[*]-} ${GROUP_IDS[*]-} (태그 awsops:control=allow도 필요 / tag also required)"
else
    aws iam delete-role-policy --role-name "$ROLE_NAME" --policy-name "$POLICY_NAME" 2>/dev/null || true
    echo -e "  ${GREEN}OK${NC} $ROLE_NAME — 허용된 리소스 없음 / no resources allowed (ID를 인자로 주면 허용)"
fi

echo ""
echo -e "${CYAN}[2/2] 대시보드 역할에 맡기 권한 / Assume permission on ${EC2_ROLE_NAME}${NC}"
aws iam put-role-policy --role-name "$EC2_ROLE_NAME" --policy-name AWSopsActionExecutorAssume \
    --policy-document "file://$TMP_DIR/assume.json"
echo -e "  ${GREEN}OK${NC} $EC2_ROLE_NAME / AWSopsActionExecutorAssume"

echo ""
echo "  다음 / Next:"
echo "   1) 대상에 태그 / tag resources:  aws ec2 create-tags --resources i-xxxx sg-yyyy --tags Key=awsops:control,Value=allow"
echo "   2) 이 스크립트에 ID 나열 / list IDs:  bash scripts/17-setup-action-executor.sh i-xxxx sg-yyyy [...]"
echo "   3) data/config.json:  \"actionPlan\": {\"enabled\": true}  (승인자는 slackControl.approverIds를 함께 씀 / approvers shared)"
