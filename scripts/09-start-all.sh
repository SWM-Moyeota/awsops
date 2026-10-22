#!/bin/bash
set -e
################################################################################
#                                                                              #
#   AWSops Dashboard - Start All Services                                      #
#                                                                              #
#   Starts:                                                                    #
#     1. Steampipe service (embedded PostgreSQL, port 9193)                    #
#     2. Next.js production server (port 3000)                                 #
#                                                                              #
#   Shows:                                                                     #
#     - Service status check                                                   #
#     - CloudFront URL (auto-detected)                                         #
#     - Cognito login info (password masked)                                   #
#                                                                              #
################################################################################

# -- Colors & common variables ------------------------------------------------
GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
WORK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "unknown")

echo ""
echo -e "${CYAN}=================================================================${NC}"
echo -e "${CYAN}   AWSops Dashboard - Start All Services${NC}"
echo -e "${CYAN}=================================================================${NC}"
echo ""

# -- [1/2] Steampipe service ---------------------------------------------------
# Prefer the systemd unit when installed (scripts/13-setup-steampipe-systemd.sh)
# so processes stay under systemd supervision (Restart=always).
echo -e "${CYAN}[1/2] Starting Steampipe service (port 9193)...${NC}"
if [ -f /etc/systemd/system/steampipe.service ]; then
    sudo systemctl start steampipe.service
    echo -e "  ${GREEN}Started via systemd (steampipe.service)${NC}"
elif steampipe service status 2>&1 | grep -q "is running"; then
    echo -e "  ${GREEN}Already running${NC}"
else
    steampipe service stop --force 2>/dev/null || true
    sleep 2
    # Pass the app's password so config.json and the DB stay in sync
    SP_PW=$(python3 -c "import json; print(json.load(open('$WORK_DIR/data/config.json')).get('steampipePassword',''))" 2>/dev/null || echo "")
    if [ -n "$SP_PW" ]; then
        steampipe service start --database-listen network --database-port 9193 --database-password "$SP_PW"
    else
        steampipe service start --database-listen network --database-port 9193
    fi
    echo -e "  ${GREEN}Started${NC}"
fi

# -- [2/2] Next.js server -----------------------------------------------------
# Prefer the systemd unit (awsops.service, Restart=always) over nohup — a nohup'd
# process dies silently and nothing restarts it (see known incident 2026-04-02).
echo ""
echo -e "${CYAN}[2/2] Starting Next.js production server (port 3000)...${NC}"

if [ -f /etc/systemd/system/awsops.service ]; then
    sudo systemctl restart awsops.service
    sleep 3
    echo -e "  ${GREEN}Started via systemd (awsops.service)${NC}"
else
    # Kill existing process on port 3000
    fuser -k 3000/tcp 2>/dev/null || true
    sleep 1

    cd "$WORK_DIR"
    nohup sh -c "PORT=3000 npm run start" > /tmp/awsops-server.log 2>&1 &
    sleep 3
    echo -e "  ${GREEN}Started (log: /tmp/awsops-server.log)${NC}"
fi

# Wake the in-server health monitor (starts its 5-min loop on first request).
# Next.js may need a few seconds to listen, so retry like 13's ExecStartPost (6 x 5s). Non-fatal.
# 서버 내장 헬스 모니터 기동 (첫 요청에서 5분 루프 시작) — 최대 30초 재시도, 실패해도 스크립트는 계속
HEALTH_OK=0
for i in 1 2 3 4 5 6; do
    if curl -sf -o /dev/null --max-time 20 http://localhost:3000/api/health; then
        HEALTH_OK=1
        break
    fi
    sleep 5
done
if [ "$HEALTH_OK" = "1" ]; then
    echo -e "  ${GREEN}Health monitor: started${NC}"
else
    echo -e "  ${YELLOW}WARNING: Health monitor not started yet (http://localhost:3000/api/health did not respond)${NC}"
    echo -e "  ${YELLOW}         Start it manually once the dashboard is up: curl -s http://localhost:3000/api/health${NC}"
fi

# -- [3/3] OpenCost port-forward (if OpenCost installed) ----------------------
echo ""
echo -e "${CYAN}[3/3] Starting OpenCost port-forward (if installed)...${NC}"
if kubectl get deployment opencost -n opencost &>/dev/null 2>&1; then
    # Kill existing port-forward / 기존 포트 포워딩 종료
    pkill -f "kubectl port-forward.*opencost.*9003" 2>/dev/null || true
    sleep 1
    nohup kubectl port-forward svc/opencost 9003:9003 -n opencost --address 0.0.0.0 > /tmp/opencost-portforward.log 2>&1 &
    sleep 3
    if curl -s --connect-timeout 3 "http://localhost:9003/healthz" &>/dev/null; then
        echo -e "  ${GREEN}OpenCost port-forward active (localhost:9003)${NC}"
    else
        echo -e "  ${YELLOW}OpenCost port-forward starting... (check /tmp/opencost-portforward.log)${NC}"
    fi
else
    echo -e "  ${YELLOW}OpenCost not installed (skip)${NC}"
fi

# -- Service status check ------------------------------------------------------
echo ""
echo -e "${CYAN}=================================================================${NC}"
echo -e "${CYAN}   Service Status${NC}"
echo -e "${CYAN}=================================================================${NC}"

# Steampipe
if steampipe service status 2>&1 | grep -q "is running"; then
    SP_PW=$(steampipe service status --show-password 2>&1 | grep Password | awk '{print $2}')
    echo -e "  ${GREEN}OK${NC}  Steampipe          port 9193  (pw: ${SP_PW:0:4}****)"
else
    echo -e "  ${RED}FAIL${NC}  Steampipe          NOT RUNNING"
fi

# Next.js
HTTP=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null)
if [ "$HTTP" = "200" ]; then
    echo -e "  ${GREEN}OK${NC}  Next.js            port 3000  (HTTP 200)"
else
    echo -e "  ${RED}FAIL${NC}  Next.js            NOT RUNNING (HTTP $HTTP)"
fi

# Steampipe API via Next.js
API=$(curl -s --max-time 5 -X POST http://localhost:3000/api/steampipe \
    -H "Content-Type: application/json" \
    -d '{"queries":{"t":"SELECT 1 as ok"}}' 2>/dev/null)
if echo "$API" | grep -q "ok"; then
    echo -e "  ${GREEN}OK${NC}  Steampipe API      working"
else
    echo -e "  ${RED}FAIL${NC}  Steampipe API      NOT responding"
fi

# OpenCost
if curl -s --connect-timeout 3 "http://localhost:9003/healthz" &>/dev/null; then
    echo -e "  ${GREEN}OK${NC}  OpenCost           port 9003  (port-forward)"
elif kubectl get deployment opencost -n opencost &>/dev/null 2>&1; then
    echo -e "  ${YELLOW}WARN${NC}  OpenCost           installed but port-forward not active"
else
    echo -e "  ${YELLOW}SKIP${NC}  OpenCost           not installed"
fi

# -- Access URLs ---------------------------------------------------------------
echo ""
echo -e "${CYAN}=================================================================${NC}"
echo -e "${CYAN}   Access URLs${NC}"
echo -e "${CYAN}=================================================================${NC}"
echo "  Local:       http://localhost:3000/"

# Auto-detect Dashboard URL from CDK stack output (ALB + custom domain)
DASHBOARD_URL=$(aws cloudformation describe-stacks \
    --stack-name AwsopsStack --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='DashboardURL'].OutputValue | [0]" \
    --output text 2>/dev/null || echo "")

if [ -n "$DASHBOARD_URL" ] && [ "$DASHBOARD_URL" != "None" ]; then
    echo -e "  Dashboard:   ${GREEN}${DASHBOARD_URL}${NC}"
else
    echo -e "  Dashboard:   ${YELLOW}(not configured)${NC}"
fi

# -- Cognito login info --------------------------------------------------------
echo ""
echo -e "${CYAN}=================================================================${NC}"
echo -e "${CYAN}   Login${NC}"
echo -e "${CYAN}=================================================================${NC}"

POOL_ID=$(aws cognito-idp list-user-pools --max-results 10 --region "$REGION" \
    --query "UserPools[?contains(Name, 'AWSops')].Id | [0]" --output text 2>/dev/null || echo "")

if [ -n "$POOL_ID" ] && [ "$POOL_ID" != "None" ]; then
    ADMIN_USER=$(aws cognito-idp list-users --user-pool-id "$POOL_ID" --region "$REGION" \
        --query "Users[0].Username" --output text 2>/dev/null || echo "")

    COGNITO_DOMAIN=$(aws cognito-idp describe-user-pool --user-pool-id "$POOL_ID" --region "$REGION" \
        --query "UserPool.Domain" --output text 2>/dev/null || echo "")

    if [ -n "$ADMIN_USER" ] && [ "$ADMIN_USER" != "None" ]; then
        echo -e "  ${GREEN}Cognito Authentication Enabled${NC}"
        echo "  User Pool:   $POOL_ID"
        echo "  ID:          $ADMIN_USER"
        echo "  Password:    ********"
        if [ -n "$COGNITO_DOMAIN" ] && [ "$COGNITO_DOMAIN" != "None" ]; then
            echo "  Login URL:   https://${COGNITO_DOMAIN}.auth.${REGION}.amazoncognito.com"
        fi
    else
        echo -e "  ${YELLOW}Cognito configured but no users found${NC}"
        echo "  Pool: $POOL_ID"
    fi
else
    echo -e "  ${YELLOW}Cognito not configured${NC}"
    echo "  Run: bash scripts/05-setup-cognito.sh"
fi

echo ""
echo -e "${CYAN}=================================================================${NC}"
echo ""
