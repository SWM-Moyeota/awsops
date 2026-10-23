#!/bin/bash
set -e
################################################################################
#                                                                              #
#   Step 12b: AI 도구 Lambda의 크로스 어카운트 접근 / Cross-account for tools   #
#                                                                              #
#   12-setup-multi-account.sh는 Steampipe(대시보드 조회)만 연결한다.            #
#   AI 에이전트의 도구 Lambda가 대상 계정을 조회하려면 두 가지가 더 필요하다:    #
#     1. Lambda 역할에 대상 계정 AWSopsReadOnlyRole AssumeRole 권한            #
#     2. 각 도구 Lambda에 AWSOPS_EXTERNAL_ID 환경변수                          #
#                                                                              #
#   12 only wires Steampipe. For the AI agent's tool Lambdas to query target  #
#   accounts they also need sts:AssumeRole on the target role and the         #
#   External ID in their environment. Run from the admin Mac (IAM + Lambda    #
#   write access); idempotent; existing Lambda env vars are preserved.        #
#                                                                              #
#   Usage:                                                                     #
#     AWSOPS_EXTERNAL_ID=... bash scripts/12b-setup-lambda-cross-account.sh    #
#       [--dry-run] [-y]                                                       #
#                                                                              #
################################################################################

GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"
EXTERNAL_ID="${AWSOPS_EXTERNAL_ID:-}"
ROLE_NAME="${AWSOPS_ROLE_NAME:-AWSopsReadOnlyRole}"
LAMBDA_ROLE="${AWSOPS_LAMBDA_ROLE:-AWSopsLambdaNetworkRole}"
POLICY_NAME="AWSopsCrossAccountAssume"
DRY_RUN=false; ASSUME_YES=false
for a in "$@"; do
    case "$a" in
        --dry-run) DRY_RUN=true ;;
        -y|--yes)  ASSUME_YES=true ;;
        *) echo "Unknown option: $a"; exit 1 ;;
    esac
done

# 도구 Lambda 19개 — 06c / 14 / CDK와 같은 목록 / same list as 06c, 14 and CDK
TOOL_LAMBDAS=(
  awsops-aws-knowledge awsops-cloudtrail-mcp awsops-cloudwatch-mcp awsops-core-mcp
  awsops-cost-mcp awsops-dynamodb-mcp awsops-ecs-mcp awsops-eks-mcp awsops-flow-monitor
  awsops-iac-mcp awsops-iam-mcp awsops-istio-mcp awsops-msk-mcp awsops-network-mcp
  awsops-rds-mcp awsops-reachability-analyzer awsops-steampipe-query awsops-terraform-mcp
  awsops-valkey-mcp
)

if [ -z "$EXTERNAL_ID" ]; then
    echo -e "${RED}ERROR: AWSOPS_EXTERNAL_ID 가 필요합니다 / AWSOPS_EXTERNAL_ID is required${NC}"
    echo "  (대상 계정 CloudFormation 스택의 ExternalId 값 / the ExternalId used in the target-account stack)"
    exit 1
fi

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo -e "${CYAN}Step 12b: Lambda cross-account access${NC}"
echo "  Account: $ACCOUNT_ID  Region: $REGION"
echo "  UPSERT  IAM inline policy $LAMBDA_ROLE / $POLICY_NAME (sts:AssumeRole on arn:aws:iam::*:role/$ROLE_NAME)"
echo "  UPDATE  ${#TOOL_LAMBDAS[@]} Lambda env: AWSOPS_EXTERNAL_ID (+ AWSOPS_ROLE_NAME), existing vars kept"
if $DRY_RUN; then echo -e "${YELLOW}--dry-run: no changes made.${NC}"; exit 0; fi
if ! $ASSUME_YES; then read -r -p "Proceed? (y/n) " c; [ "$c" = "y" ] || { echo "Cancelled."; exit 0; }; fi

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# 1. Lambda role: assume the read-only role in any target account (trust policy + External ID on the target side gate it)
cat > "$TMP/policy.json" <<POL
{"Version":"2012-10-17","Statement":[{"Sid":"AssumeTargetReadOnlyRole","Effect":"Allow",
 "Action":"sts:AssumeRole","Resource":"arn:aws:iam::*:role/${ROLE_NAME}"}]}
POL
aws iam put-role-policy --role-name "$LAMBDA_ROLE" --policy-name "$POLICY_NAME" \
    --policy-document "file://$TMP/policy.json"
echo -e "  ${GREEN}OK${NC} $LAMBDA_ROLE / $POLICY_NAME"

# 2. Merge env vars into each tool Lambda (never drop STEAMPIPE_* etc.)
for fn in "${TOOL_LAMBDAS[@]}"; do
    if ! aws lambda get-function-configuration --function-name "$fn" --region "$REGION" \
            --query 'Environment.Variables' --output json > "$TMP/env.json" 2>/dev/null; then
        echo -e "  ${YELLOW}SKIP${NC} $fn (not found)"; continue
    fi
    python3 - "$TMP/env.json" "$EXTERNAL_ID" "$ROLE_NAME" > "$TMP/env-new.json" <<'PY'
import json, sys
path, ext, role = sys.argv[1:4]
cur = json.load(open(path)) or {}
cur['AWSOPS_EXTERNAL_ID'] = ext
if role != 'AWSopsReadOnlyRole':
    cur['AWSOPS_ROLE_NAME'] = role
print(json.dumps({'Variables': cur}))
PY
    aws lambda wait function-updated --function-name "$fn" --region "$REGION" 2>/dev/null || true
    aws lambda update-function-configuration --function-name "$fn" --region "$REGION" \
        --environment "file://$TMP/env-new.json" --query 'LastUpdateStatus' --output text > /dev/null
    echo -e "  ${GREEN}OK${NC} $fn"
done

echo ""
echo -e "${GREEN}Done.${NC} 대상 계정을 고른 뒤 AI 어시스턴트에 진단 질문을 하면 도구가 그 계정을 조회합니다."
echo "      Pick the target account in the dashboard and ask the AI a diagnostic question to verify."
