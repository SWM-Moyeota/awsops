#!/bin/bash
set -e
################################################################################
#                                                                              #
#   Step 6g: Redeploy the agent image to the EXISTING AgentCore Runtime        #
#                                                                              #
#   agent/ 아래 코드(agent.py, requirements.txt 등)를 고친 뒤 실행한다.          #
#   06a를 다시 돌리면 Runtime이 중복 생성되므로, 이미지만 다시 빌드해서          #
#   기존 Runtime을 새 버전으로 업데이트한다.                                     #
#                                                                              #
#   Rebuilds agent/ (arm64), pushes to ECR and updates the existing runtime    #
#   in place. Use this instead of re-running 06a, which would create a         #
#   duplicate runtime. Needs ecr:* and bedrock-agentcore:UpdateAgentRuntime    #
#   + iam:PassRole on the caller (see TempAgentCoreSetup in the runbook).      #
#                                                                              #
################################################################################

WORK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"
RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/awsops-agent"

RT_ID=$(aws bedrock-agentcore-control list-agent-runtimes --region "$REGION" \
    --query "agentRuntimes[?agentRuntimeName=='awsops_agent'].agentRuntimeId | [0]" --output text)
if [ -z "$RT_ID" ] || [ "$RT_ID" = "None" ]; then
    echo -e "${RED}ERROR: runtime 'awsops_agent' not found — run 06a first.${NC}"
    exit 1
fi
echo "  Runtime: $RT_ID"

# -- [1/3] Build + push ---------------------------------------------------------
echo -e "${CYAN}[1/3] Building and pushing agent image (arm64)...${NC}"
aws ecr get-login-password --region "$REGION" | \
    docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com" >/dev/null
docker buildx create --use 2>/dev/null || true
docker buildx build --platform linux/arm64 --no-cache -t "${ECR_URI}:latest" --push "$WORK_DIR/agent/" 2>&1 | tail -5

# -- [2/3] Smoke test: the container must start before we hand it to AgentCore ---
#   AgentCore only reports "error when starting the runtime"; a crash on import is
#   far easier to read here.
echo -e "${CYAN}[2/3] Smoke-testing the image locally...${NC}"
docker pull -q "${ECR_URI}:latest" >/dev/null
docker rm -f awsops-agent-smoke >/dev/null 2>&1 || true
docker run -d --name awsops-agent-smoke -e AWS_REGION="$REGION" -e AWS_DEFAULT_REGION="$REGION" \
    "${ECR_URI}:latest" >/dev/null
sleep 20
if [ "$(docker inspect -f '{{.State.Running}}' awsops-agent-smoke)" != "true" ]; then
    echo -e "${RED}ERROR: agent container exited on startup:${NC}"
    docker logs awsops-agent-smoke 2>&1 | tail -20
    docker rm -f awsops-agent-smoke >/dev/null 2>&1
    exit 1
fi
# Gateway discovery result (informational: inside Docker on EC2 the IMDS hop limit can
# block credentials, in which case discovery only succeeds on AgentCore itself).
docker logs awsops-agent-smoke 2>&1 | grep -i "gateway" | head -3 | sed 's/^/  /'
docker rm -f awsops-agent-smoke >/dev/null 2>&1
echo -e "  ${GREEN}Container starts cleanly${NC}"

# -- [3/3] Update the runtime (new version; DEFAULT endpoint follows it) ---------
#   KNOWN ISSUE: update requires --role-arn and --network-configuration again.
echo -e "${CYAN}[3/3] Updating AgentCore Runtime...${NC}"
AGENT_MODEL_ID=$(python3 -c "import json;print(json.load(open('$WORK_DIR/data/config.json')).get('bedrockModelId',''))" 2>/dev/null || echo "")
RT_ENV_ARGS=()
if [ -n "$AGENT_MODEL_ID" ]; then
    RT_ENV_ARGS=(--environment-variables "BEDROCK_MODEL_ID=${AGENT_MODEL_ID}")
    echo "  Model: $AGENT_MODEL_ID (from data/config.json)"
fi

aws bedrock-agentcore-control update-agent-runtime \
    --agent-runtime-id "$RT_ID" \
    --role-arn "arn:aws:iam::${ACCOUNT_ID}:role/AWSopsAgentCoreRole" \
    --agent-runtime-artifact "{\"containerConfiguration\":{\"containerUri\":\"${ECR_URI}:latest\"}}" \
    --network-configuration '{"networkMode":"PUBLIC"}' \
    "${RT_ENV_ARGS[@]}" \
    --region "$REGION" --query '[agentRuntimeVersion,status]' --output text

for _ in $(seq 1 30); do
    RT_STATUS=$(aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$RT_ID" \
        --region "$REGION" --query status --output text)
    [ "$RT_STATUS" = "READY" ] && break
    echo "  Runtime status: $RT_STATUS — waiting..."
    sleep 10
done
echo -e "${GREEN}Runtime $RT_ID is $RT_STATUS${NC}"
