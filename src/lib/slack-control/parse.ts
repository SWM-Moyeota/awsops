// Rule-based parsing of Slack control commands — deliberately no LLM, so a model can't misread or be
// talked into picking a target. The requester still confirms the parsed target (step 1).
// 제어 명령은 규칙으로만 해석한다 (AI 착각·프롬프트 인젝션 방지). 해석 결과는 요청자가 1단계에서 확인한다.
import type { ControlAction, ControllableInstance } from './types';

// Command forms only — "켜진/켜져/꺼진" (state questions) must not match.
// 명령형만 — "켜진/켜져/꺼진" 같은 상태 질문은 매칭되지 않게 한다.
const COMMANDS: Array<[ControlAction, RegExp]> = [
  ['reboot', /재부팅|재시작|리부트|^(please\s+)?(reboot|restart)\b/i],
  ['stop', /꺼\s*(줘|주세요|주라|라|봐)|끄(자|기|세요)|(정지|중지)\s*(해|시켜|하자|요청|좀)?(?![가-힣]*[된돼])|멈춰|^(please\s+)?(stop|shut\s*down)\b/i],
  ['start', /켜\s*(줘|주세요|주라|라|봐)|켜(자|기|세요)|(시작|기동)\s*(해|시켜|하자|좀)|^(please\s+)?start\b/i],
];

const INSTANCE_ID = /\bi-[0-9a-f]{8,17}\b/gi;

/** Mentions removed so English commands can be anchored to the start ("stop api-dev", not "... stop ..."). */
function clean(text: string): string {
  return text.replace(/<@[^>]+>/g, ' ').trim();
}

export function detectAction(text: string): ControlAction | null {
  const t = clean(text);
  for (const [action, re] of COMMANDS) if (re.test(t)) return action;
  return null;
}

export type ParseResult =
  | { kind: 'none' }
  | { kind: 'request'; action: ControlAction; instance: ControllableInstance }
  | { kind: 'no-target'; action: ControlAction }
  | { kind: 'ambiguous'; action: ControlAction; candidates: ControllableInstance[] };

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-token name match — `api-dev` must not match inside `api-dev-2`. */
export function mentionsName(text: string, name: string): boolean {
  if (!name) return false;
  return new RegExp(`(^|[^A-Za-z0-9_-])${escapeRe(name)}(?![A-Za-z0-9_-])`, 'i').test(text);
}

export function parseControlRequest(text: string, instances: ControllableInstance[]): ParseResult {
  const action = detectAction(text);
  if (!action) return { kind: 'none' };

  const ids = new Set((text.match(INSTANCE_ID) ?? []).map(s => s.toLowerCase()));
  const matched = instances.filter(i => ids.has(i.id.toLowerCase()) || mentionsName(text, i.name));
  if (matched.length === 1) return { kind: 'request', action, instance: matched[0] };
  if (matched.length > 1) return { kind: 'ambiguous', action, candidates: matched };
  return { kind: 'no-target', action };
}
