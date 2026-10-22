#!/bin/bash
set -e
################################################################################
#                                                                              #
#   Step 6e: AgentCore 설정 적용 / Apply AgentCore Configuration               #
#                                                                              #
#   route.ts와 agent.py에 현재 계정의 AgentCore 리소스 ID를 자동 설정합니다.    #
#   Auto-configures route.ts and agent.py with this account's resource IDs.    #
#                                                                              #
#   설정 대상 / Configures:                                                     #
#     - route.ts: AGENT_RUNTIME_ARN, CODE_INTERPRETER_ID, ACCOUNT_ID          #
#     - agent.py: 7 Gateway URLs                                               #
#                                                                              #
#   실행 조건 / Prerequisites:                                                  #
#     - Step 6a (Runtime), 6b (Gateways), 6d (Code Interpreter) 완료          #
#     - Step 3 이후 재빌드 필요 (npm run build)                                #
#                                                                              #
################################################################################

# -- 색상 / Colors ------------------------------------------------------------
GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
BOLD='\033[1m'
WORK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "unknown")

echo ""
echo -e "${CYAN}=================================================================${NC}"
echo -e "${CYAN}   Step 6e: AgentCore 설정 적용 / Apply Configuration${NC}"
echo -e "${CYAN}=================================================================${NC}"
echo ""
echo "  리전 / Region:  $REGION"
echo "  계정 / Account: $ACCOUNT_ID"
echo ""

###############################################################################
#  [1/4] 리소스 ID 조회 / Discover Resource IDs                                #
###############################################################################
echo -e "${CYAN}[1/4] AgentCore 리소스 조회 / Discovering resources...${NC}"

# Runtime ID 조회 / Get Runtime ID
RUNTIME_ID=$(aws bedrock-agentcore-control list-agent-runtimes --region "$REGION" --output json 2>/dev/null | \
    python3 -c "import json,sys;rts=json.load(sys.stdin);items=[v for k,v in rts.items() if isinstance(v,list)];print(items[0][0]['agentRuntimeId'] if items and items[0] else '')" 2>/dev/null || echo "")
if [ -z "$RUNTIME_ID" ]; then
    echo -e "${RED}오류: AgentCore Runtime을 찾을 수 없습니다. 06a를 먼저 실행하세요.${NC}"
    echo -e "${RED}ERROR: Runtime not found. Run 06a first.${NC}"
    exit 1
fi
RUNTIME_ARN="arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:runtime/${RUNTIME_ID}"
echo "  Runtime:          $RUNTIME_ID"

# Code Interpreter ID 조회 / Get Code Interpreter ID
CI_ID=$(aws bedrock-agentcore-control list-code-interpreters --region "$REGION" --output json 2>/dev/null | \
    python3 -c "import json,sys;d=json.load(sys.stdin);cis=d.get('codeInterpreterSummaries',[]);print(cis[0]['codeInterpreterId'] if cis else '')" 2>/dev/null || echo "")
if [ -z "$CI_ID" ]; then
    echo -e "${YELLOW}경고: Code Interpreter를 찾을 수 없습니다 (선택 사항)${NC}"
    CI_ID="NONE"
fi
echo "  Code Interpreter: $CI_ID"

# Gateway IDs 조회 / Get Gateway IDs
echo "  Gateways:"
declare -A GW_MAP
GATEWAYS_JSON=$(aws bedrock-agentcore-control list-gateways --region "$REGION" --output json 2>/dev/null)

for GW_KEY in network container iac data security monitoring cost ops; do
    GW_NAME="awsops-${GW_KEY}-gateway"
    # 정확한 이름 매칭 (awsops-{key}-gateway) / Exact name match
    GW_ID=$(echo "$GATEWAYS_JSON" | python3 -c "import json,sys;gws=json.load(sys.stdin).get('items',[]);print(next((g['gatewayId'] for g in gws if g.get('name','')=='awsops-${GW_KEY}-gateway'), ''))" 2>/dev/null || echo "")
    if [ -n "$GW_ID" ]; then
        GW_MAP[$GW_KEY]="$GW_ID"
        GW_URL="https://${GW_ID}.gateway.bedrock-agentcore.${REGION}.amazonaws.com/mcp"
        echo "    ${GW_KEY}: $GW_ID"
    else
        echo -e "    ${GW_KEY}: ${YELLOW}없음 / not found${NC}"
    fi
done

###############################################################################
#  [2/4] route.ts 업데이트 / Update route.ts                                   #
###############################################################################
echo ""
echo -e "${CYAN}[2/4] route.ts 업데이트 / Updating route.ts...${NC}"

ROUTE_FILE="$WORK_DIR/src/app/api/ai/route.ts"
if [ ! -f "$ROUTE_FILE" ]; then
    echo -e "${RED}오류: route.ts를 찾을 수 없습니다 / route.ts not found${NC}"
    exit 1
fi

# 백업 / Backup
cp "$ROUTE_FILE" "${ROUTE_FILE}.bak"

# AGENT_RUNTIME_ARN 업데이트 / Update Runtime ARN
sed -i "s|const AGENT_RUNTIME_ARN = '.*';|const AGENT_RUNTIME_ARN = '${RUNTIME_ARN}';|" "$ROUTE_FILE"
echo "  ✓ AGENT_RUNTIME_ARN = ${RUNTIME_ARN}"

# CODE_INTERPRETER_ID 업데이트 / Update Code Interpreter ID
if [ "$CI_ID" != "NONE" ]; then
    sed -i "s|const CODE_INTERPRETER_ID = '.*';|const CODE_INTERPRETER_ID = '${CI_ID}';|" "$ROUTE_FILE"
    echo "  ✓ CODE_INTERPRETER_ID = ${CI_ID}"
fi

# 앱은 이 값들을 data/config.json에서 읽는다 (위 sed는 상수가 남아 있는 구버전 소스용)
# The app reads these from data/config.json (the sed above only matters for older sources)
CONFIG_FILE="$WORK_DIR/data/config.json"
mkdir -p "$WORK_DIR/data"
python3 - "$CONFIG_FILE" "$RUNTIME_ARN" "$CI_ID" <<'PYEOF'
import json, os, sys
path, arn, ci = sys.argv[1:4]
cfg = json.load(open(path)) if os.path.exists(path) else {}
cfg['agentRuntimeArn'] = arn
if ci and ci != 'NONE':
    cfg['codeInterpreterName'] = ci
json.dump(cfg, open(path, 'w'), indent=2)
PYEOF
echo "  ✓ data/config.json: agentRuntimeArn / codeInterpreterName"

# 계정 ID 확인 (이미 올바른 경우 스킵) / Verify account ID
if grep -q "605134447633\|730335239360" "$ROUTE_FILE"; then
    sed -i "s|605134447633|${ACCOUNT_ID}|g; s|730335239360|${ACCOUNT_ID}|g" "$ROUTE_FILE"
    echo "  ✓ 계정 ID 업데이트 / Account ID updated to ${ACCOUNT_ID}"
else
    echo "  ✓ 계정 ID 이미 올바름 / Account ID already correct"
fi

###############################################################################
#  [3/4] agent.py 업데이트 / Update agent.py                                   #
###############################################################################
echo ""
echo -e "${CYAN}[3/4] agent.py 업데이트 / Updating agent.py...${NC}"

AGENT_FILE="$WORK_DIR/agent/agent.py"
if [ ! -f "$AGENT_FILE" ]; then
    echo -e "${RED}오류: agent.py를 찾을 수 없습니다 / agent.py not found${NC}"
    exit 1
fi

# 백업 / Backup
cp "$AGENT_FILE" "${AGENT_FILE}.bak"

# 각 Gateway URL 업데이트 / Update each Gateway URL
for GW_KEY in network container iac data security monitoring cost ops; do
    GW_ID="${GW_MAP[$GW_KEY]}"
    if [ -n "$GW_ID" ]; then
        NEW_URL="https://${GW_ID}.gateway.bedrock-agentcore.${REGION}.amazonaws.com/mcp"
        # 해당 키의 URL 라인을 찾아서 교체 / Find and replace the URL for this key
        python3 -c "
import re
with open('${AGENT_FILE}', 'r') as f:
    content = f.read()
# '\"${GW_KEY}\"' 키의 URL을 새 URL로 교체 / Replace URL for this key
# 줄 맨 앞의 딕셔너리 항목만 교체 — 주석 안의 예시 URL은 건드리지 않는다 (git pull 충돌 방지)
# Only rewrite real dict entries at line start, never example URLs inside comments
pattern = r'(?m)(^[ \t]*\"${GW_KEY}\":\s*\")https://[^\"]+(\",?)'
replacement = r'\g<1>${NEW_URL}\g<2>'
content = re.sub(pattern, replacement, content)
with open('${AGENT_FILE}', 'w') as f:
    f.write(content)
"
        echo "  ✓ ${GW_KEY}: ${GW_ID}"
    fi
done

###############################################################################
#  [4/4] 재빌드 + 재시작 / Rebuild + Restart                                    #
###############################################################################
echo ""
echo -e "${CYAN}[4/4] 재빌드 및 재시작 / Rebuilding and restarting...${NC}"

cd "$WORK_DIR"
echo "  빌드 중... / Building..."
npm run build 2>&1 | tail -5

# 기존 서버 중지 + 재시작 / Stop + restart server
if command -v fuser &>/dev/null; then
    fuser -k 3000/tcp 2>/dev/null || true
fi
sleep 2
nohup npm run start > /tmp/awsops-server.log 2>&1 &
sleep 3

# 확인 / Verify
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/awsops 2>/dev/null || echo "000")
echo "  서버 상태 / Server: HTTP $HTTP_CODE"

###############################################################################
#  요약 / Summary                                                               #
###############################################################################
echo ""
echo -e "${GREEN}=================================================================${NC}"
echo -e "${GREEN}   Step 6e 완료: AgentCore 설정 적용됨 / Configuration Applied${NC}"
echo -e "${GREEN}=================================================================${NC}"
echo ""
echo "  계정 / Account:     $ACCOUNT_ID"
echo "  리전 / Region:      $REGION"
echo "  Runtime:            $RUNTIME_ID"
echo "  Code Interpreter:   $CI_ID"
echo ""
echo "  Gateways:"
for GW_KEY in network container iac data security monitoring cost ops; do
    GW_ID="${GW_MAP[$GW_KEY]}"
    [ -n "$GW_ID" ] && echo "    ${GW_KEY}: ${GW_ID}"
done
echo ""
echo "  수정된 파일 / Modified files:"
echo "    - src/app/api/ai/route.ts (Runtime ARN, Code Interpreter ID)"
echo "    - agent/agent.py (7 Gateway URLs)"
echo ""
echo "  백업 파일 / Backups:"
echo "    - src/app/api/ai/route.ts.bak"
echo "    - agent/agent.py.bak"
echo ""
echo -e "  ${BOLD}AI 채팅 테스트 / Test AI Chat:${NC}"
echo "    브라우저에서 /awsops/ai 페이지 접속"
echo "    Open /awsops/ai page in browser"
echo ""
