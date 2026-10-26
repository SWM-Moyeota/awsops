// Inputs shared by the two pipelines / 두 파이프라인이 함께 받는 입력
// POST(route.ts)가 검증·계정 조회·사용자 조회를 마친 뒤 만든다. 값은 리팩터링 전 POST 스코프의 변수와 같다.
// Built by POST (route.ts) after validation, account lookup and user lookup. Values equal the former POST-scope variables.
import type { UserInfo } from '@/lib/auth-utils';
import type { buildStatus } from './status';

export interface PipelineInput {
  messages: Array<{role: string; content: string}>;
  modelKey?: string;          // request body `model`
  lang?: string;              // request body `lang` (POST's `clientLang`)
  accountId?: string;         // validated accountId, or undefined
  accountAlias?: string;      // `getAccountById(accountId)?.alias`, read once in POST (both paths)
  requestId: string;          // randomUUID() from POST — one per request (health vote)
  user: UserInfo;             // getUserFromRequest(request) (POST's `currentUser`)
}

// Streaming needs the values POST computed before validation, passed as-is (no recomputation).
// 스트리밍은 POST가 검증 전에 계산한 값을 그대로 받는다 (다시 계산하지 않는다).
export interface StreamPipelineInput extends PipelineInput {
  status: ReturnType<typeof buildStatus>; // POST's `STATUS` = buildStatus(clientLang)
  systemPrompt: string;       // POST's `SYSTEM_PROMPT` = getSystemPrompt(clientLang)
  isEn: boolean;              // POST's `isEn` = clientLang !== 'ko'
}
