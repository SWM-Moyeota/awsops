import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { getConfig } from '@/lib/app-config';

// Service configuration — config 파일에서 읽거나 자동 감지
// Service config — read from data/config.json or auto-detect
const BEDROCK_REGION = 'ap-northeast-2';
const AGENTCORE_REGION = 'ap-northeast-2';

// 런타임에 config에서 AgentCore 설정 로드 / Load AgentCore config at runtime
export function getAgentRuntimeArn(): string {
  const config = getConfig();
  return config.agentRuntimeArn || '';
}
export function getCodeInterpreterName(): string {
  const config = getConfig();
  return config.codeInterpreterName || '';
}

// AWS SDK clients / AWS SDK 클라이언트
export const bedrockClient = new BedrockRuntimeClient({ region: BEDROCK_REGION });
export const agentCoreClient = new BedrockAgentCoreClient({ region: AGENTCORE_REGION });
