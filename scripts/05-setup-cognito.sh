#!/bin/bash
set -e
################################################################################
#                                                                              #
#   Step 5: Cognito Authentication Setup (ALB authenticate-cognito)            #
#                                                                              #
#   Creates:                                                                   #
#     1. User Pool (email username, NO symbols required in password)           #
#     2. Domain (no 'aws' in name - Cognito restriction)                       #
#     3. App Client (OAuth2 authorization code flow)                           #
#     4. Admin user (email format, permanent password)                         #
#     5. authenticate-cognito action on ALB HTTPS(443) listener                #
#                                                                              #
#   NOTE: CloudFront + Lambda@Edge 방식에서 ALB 내장 Cognito 인증으로 변경됨.   #
#         (조직 SCP가 CloudFront 생성을 차단 → ALB HTTPS + ACM 구성)            #
#         Replaced CloudFront + Lambda@Edge with ALB built-in Cognito auth     #
#         (org SCP blocks CloudFront creation).                                #
#                                                                              #
#   Environment variables:                                                     #
#     APP_DOMAIN             - App domain [auto: CFN DashboardURL output]      #
#     ADMIN_EMAIL            - Admin email [admin@awsops.local]                #
#     ADMIN_PASSWORD         - Admin password [prompted if unset]              #
#     COGNITO_DOMAIN_PREFIX  - Domain prefix [ops-dashboard-<account>]         #
#                                                                              #
#   Known issues handled:                                                      #
#     - Domain cannot contain 'aws' -> use 'ops-dashboard-*'                   #
#     - Username must be email format -> username-attributes email             #
#     - Password policy must NOT require symbols (known issue)                 #
#     - ALB auth requires HTTPS listener + client secret                       #
#                                                                              #
################################################################################

# -- Colors & common variables ------------------------------------------------
GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
WORK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "unknown")

APP_DOMAIN="${APP_DOMAIN:-}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@awsops.local}"
# 기본 비밀번호는 공개 저장소에 노출되므로 두지 않는다 — 없으면 직접 입력받는다
# No default password (it would be public in the repo) — prompt when not provided
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
if [ -z "$ADMIN_PASSWORD" ]; then
    if [ -t 0 ]; then
        read -sp "  관리자 비밀번호 (8자 이상) / Admin password (min 8 chars) for $ADMIN_EMAIL: " ADMIN_PASSWORD
        echo ""
    fi
    if [ ${#ADMIN_PASSWORD} -lt 8 ]; then
        echo "ERROR: ADMIN_PASSWORD (8+ chars) is required — set the env var or run interactively."
        exit 1
    fi
fi
# Cognito 도메인은 전체 AWS에서 고유해야 함 → 계정 ID 포함
# Cognito domain must be globally unique → include account ID
COGNITO_DOMAIN_PREFIX="${COGNITO_DOMAIN_PREFIX:-ops-dashboard-${ACCOUNT_ID}}"

echo ""
echo -e "${CYAN}=================================================================${NC}"
echo -e "${CYAN}   Step 5: Cognito Authentication Setup (ALB auth)${NC}"
echo -e "${CYAN}=================================================================${NC}"
echo ""

# 앱 도메인 자동 감지 / Auto-detect app domain from stack outputs
if [ -z "$APP_DOMAIN" ]; then
    APP_DOMAIN=$(aws cloudformation describe-stacks \
        --stack-name AwsopsStack --region "$REGION" \
        --query "Stacks[0].Outputs[?OutputKey=='DashboardURL'].OutputValue | [0]" \
        --output text 2>/dev/null | sed 's|https://||; s|/awsops$||; s|/$||' || echo "")
fi
if [ -z "$APP_DOMAIN" ] || [ "$APP_DOMAIN" = "None" ]; then
    echo -e "${RED}오류: 앱 도메인을 확인할 수 없습니다. / ERROR: Cannot determine app domain.${NC}"
    echo "  export APP_DOMAIN='awsops.dev1.musinsa.io'"
    exit 1
fi

# ALB HTTPS 리스너 ARN / ALB HTTPS listener ARN from stack outputs
LISTENER_ARN=$(aws cloudformation describe-stacks \
    --stack-name AwsopsStack --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='HttpsListenerArn'].OutputValue | [0]" \
    --output text 2>/dev/null || echo "")
if [ -z "$LISTENER_ARN" ] || [ "$LISTENER_ARN" = "None" ]; then
    echo -e "${RED}오류: HTTPS 리스너 ARN을 찾을 수 없습니다. AwsopsStack 배포를 확인하세요.${NC}"
    echo -e "${RED}ERROR: HttpsListenerArn output not found. Check AwsopsStack deployment.${NC}"
    exit 1
fi

echo "  App Domain:   $APP_DOMAIN"
echo "  Listener:     ${LISTENER_ARN##*/}"
echo "  Admin Email:  $ADMIN_EMAIL"
echo "  Domain:       $COGNITO_DOMAIN_PREFIX"
echo ""

# -- [1/6] Create User Pool ---------------------------------------------------
#   KNOWN ISSUE: Password policy must NOT require symbols.
#   We had failures when RequireSymbols was true.
#   See: docs/TROUBLESHOOTING.md #10 (Cognito)
echo -e "${CYAN}[1/6] Creating Cognito User Pool...${NC}"
echo -e "  ${YELLOW}NOTE: Password policy does NOT require symbols (known issue fix)${NC}"

POOL_ID=$(aws cognito-idp create-user-pool \
    --pool-name AWSops-UserPool \
    --auto-verified-attributes email \
    --username-attributes email \
    --mfa-configuration OFF \
    --user-pool-tags Realm=awsops,ServiceDomain=aws,ServiceComponent=awsops-poc,Environment=sandbox \
    --policies '{
        "PasswordPolicy": {
            "MinimumLength": 8,
            "RequireUppercase": true,
            "RequireLowercase": true,
            "RequireNumbers": true,
            "RequireSymbols": false,
            "TemporaryPasswordValidityDays": 7
        }
    }' \
    --region "$REGION" \
    --query "UserPool.Id" --output text 2>&1)

if [ -z "$POOL_ID" ] || [ "$POOL_ID" = "None" ]; then
    echo -e "${RED}ERROR: Failed to create User Pool.${NC}"
    exit 1
fi
POOL_ARN="arn:aws:cognito-idp:${REGION}:${ACCOUNT_ID}:userpool/${POOL_ID}"
echo "  User Pool ID: $POOL_ID"

# -- [2/6] Create Domain ------------------------------------------------------
#   KNOWN ISSUE: Domain name cannot contain 'aws'.
#   See: docs/TROUBLESHOOTING.md #10
echo ""
echo -e "${CYAN}[2/6] Creating Cognito domain...${NC}"
echo -e "  ${YELLOW}NOTE: Domain cannot contain 'aws' -> using '$COGNITO_DOMAIN_PREFIX'${NC}"

aws cognito-idp create-user-pool-domain \
    --domain "$COGNITO_DOMAIN_PREFIX" \
    --user-pool-id "$POOL_ID" \
    --region "$REGION" 2>/dev/null || echo "  Domain may already exist, continuing..."

COGNITO_DOMAIN="${COGNITO_DOMAIN_PREFIX}.auth.${REGION}.amazoncognito.com"
echo "  Domain: $COGNITO_DOMAIN"

# -- [3/6] Create App Client ---------------------------------------------------
#   ALB authenticate-cognito 콜백은 고정 경로 /oauth2/idpresponse 사용
#   ALB authenticate-cognito uses the fixed callback path /oauth2/idpresponse
echo ""
echo -e "${CYAN}[3/6] Creating App Client (OAuth2 authorization code flow)...${NC}"

CLIENT_OUTPUT=$(aws cognito-idp create-user-pool-client \
    --user-pool-id "$POOL_ID" \
    --client-name AWSops-Dashboard \
    --generate-secret \
    --supported-identity-providers COGNITO \
    --callback-urls "https://${APP_DOMAIN}/oauth2/idpresponse" \
    --logout-urls "https://${APP_DOMAIN}/" \
    --allowed-o-auth-flows code \
    --allowed-o-auth-scopes openid email profile \
    --allowed-o-auth-flows-user-pool-client \
    --region "$REGION" --output json 2>&1)

CLIENT_ID=$(echo "$CLIENT_OUTPUT" | python3 -c "import json,sys;print(json.load(sys.stdin)['UserPoolClient']['ClientId'])")

if [ -z "$CLIENT_ID" ]; then
    echo -e "${RED}ERROR: Failed to create App Client.${NC}"
    exit 1
fi
echo "  Client ID: $CLIENT_ID"

# -- [4/6] Create Admin User --------------------------------------------------
echo ""
echo -e "${CYAN}[4/6] Creating admin user ($ADMIN_EMAIL)...${NC}"

aws cognito-idp admin-create-user \
    --user-pool-id "$POOL_ID" \
    --username "$ADMIN_EMAIL" \
    --user-attributes Name=email,Value="$ADMIN_EMAIL" Name=email_verified,Value=true \
    --message-action SUPPRESS \
    --temporary-password 'TempPass1!' \
    --region "$REGION" 2>/dev/null || true

aws cognito-idp admin-set-user-password \
    --user-pool-id "$POOL_ID" \
    --username "$ADMIN_EMAIL" \
    --password "$ADMIN_PASSWORD" \
    --permanent \
    --region "$REGION" 2>/dev/null

echo "  Admin: $ADMIN_EMAIL (permanent password set)"

# -- [5/6] Attach authenticate-cognito to ALB HTTPS listener -------------------
#   기본 액션(대시보드)과 forward 규칙(/vscode/*) 모두에 인증 부착
#   Attach auth to the default action (dashboard) and every forwarding rule (/vscode/*)
echo ""
echo -e "${CYAN}[5/6] Attaching Cognito auth to ALB listener...${NC}"

AUTH_CONFIG="UserPoolArn=${POOL_ARN},UserPoolClientId=${CLIENT_ID},UserPoolDomain=${COGNITO_DOMAIN_PREFIX},OnUnauthenticatedRequest=authenticate,Scope=openid email profile,SessionTimeout=28800"

# 기본 액션의 타겟 그룹 조회 / Current default-action target group
DEFAULT_TG=$(aws elbv2 describe-listeners --listener-arns "$LISTENER_ARN" --region "$REGION" \
    --query "Listeners[0].DefaultActions[?Type=='forward'].TargetGroupArn | [0]" --output text)

aws elbv2 modify-listener --listener-arn "$LISTENER_ARN" --region "$REGION" \
    --default-actions \
    "Type=authenticate-cognito,Order=1,AuthenticateCognitoConfig={${AUTH_CONFIG}}" \
    "Type=forward,Order=2,TargetGroupArn=${DEFAULT_TG}" > /dev/null
echo "  Default action (dashboard): Cognito auth attached"

# forward 규칙 전체에 인증 부착 (CDK: /vscode/* = priority 10) — redirect 규칙은 제외
# Attach auth to every forwarding rule (CDK puts /vscode/* at priority 10); redirect-only rules are skipped
RULES=$(aws elbv2 describe-rules --listener-arn "$LISTENER_ARN" --region "$REGION" \
    --query "Rules[?Priority!='default'].[RuleArn, Priority, Actions[?Type=='forward'].TargetGroupArn | [0]]" \
    --output text)
RULE_COUNT=0
while read -r RULE_ARN RULE_PRIO RULE_TG; do
    [ -z "$RULE_ARN" ] || [ "$RULE_TG" = "None" ] || [ -z "$RULE_TG" ] && continue
    aws elbv2 modify-rule --rule-arn "$RULE_ARN" --region "$REGION" \
        --actions \
        "Type=authenticate-cognito,Order=1,AuthenticateCognitoConfig={${AUTH_CONFIG}}" \
        "Type=forward,Order=2,TargetGroupArn=${RULE_TG}" > /dev/null
    echo "  Rule priority ${RULE_PRIO}: Cognito auth attached"
    RULE_COUNT=$((RULE_COUNT+1))
done <<< "$RULES"
[ "$RULE_COUNT" -eq 0 ] && echo -e "  ${YELLOW}WARN: no forwarding rules found — only the default action is protected${NC}"

# -- [6/6] Verify --------------------------------------------------------------
echo ""
echo -e "${CYAN}[6/6] Verifying...${NC}"
AUTH_COUNT=$(aws elbv2 describe-listeners --listener-arns "$LISTENER_ARN" --region "$REGION" \
    --query "length(Listeners[0].DefaultActions[?Type=='authenticate-cognito'])" --output text 2>/dev/null || echo "0")
if [ "$AUTH_COUNT" -ge 1 ] 2>/dev/null; then
    echo -e "  ${GREEN}✓ Listener default action has authenticate-cognito${NC}"
else
    echo -e "  ${YELLOW}⚠ Could not verify auth action on listener${NC}"
fi

# -- Summary -------------------------------------------------------------------
echo ""
echo -e "${GREEN}=================================================================${NC}"
echo -e "${GREEN}   Step 5 Complete: Cognito + ALB Authentication${NC}"
echo -e "${GREEN}=================================================================${NC}"
echo ""
echo "  User Pool ID:     $POOL_ID"
echo "  Client ID:        $CLIENT_ID"
echo "  Cognito Domain:   $COGNITO_DOMAIN"
echo "  Admin Login:      $ADMIN_EMAIL / ********"
echo "  Dashboard:        https://${APP_DOMAIN}/"
echo "  VSCode:           https://${APP_DOMAIN}/"
echo ""
echo "  NOTE: Step 8 (CloudFront + Lambda@Edge 연동)은 더 이상 필요 없습니다."
echo "        Step 8 (CloudFront + Lambda@Edge) is no longer needed."
echo ""
echo "  Password policy: symbols NOT required (known issue fix)"
echo ""
