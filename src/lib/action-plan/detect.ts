// Rule-based detection of "change a tag / security group" requests — a pure function, no LLM, no I/O.
// Both an imperative verb and a target word must be present; how-to and hypothetical questions are left to the AI.
// 규칙 기반 감지: 명령형 동사와 대상 단어가 함께 있어야 하고, 방법·가정 질문은 건드리지 않는다.

// 붙여/달아/바꿔/변경해/지워/떼/삭제해/추가해/열어/닫아/막아/허용해 + 줘·주세요·주라·라
const IMPERATIVE = /(붙여|달아|바꿔|변경해|지워|떼어?|삭제해|추가해|열어|닫아|막아|허용해)\s*(줘|주세요|주라|라)(?![가-힣])/;

const TARGET = /태그|보안\s*그룹|\bsg-[0-9a-f]+|포트|인바운드|규칙/i;

// How-to / ability / hypothetical forms: "방법", "어떻게", "할 수 있어?", "하면 돼?"
const NOT_ACTION = /방법|어떻게|수\s*있|면\s*(돼|되|안)|할까|해도\s*(돼|되)/;

export function detectActionIntent(text: string): boolean {
  const t = text.replace(/<@[^>]+>/g, ' ').trim();
  if (!t) return false;
  if (NOT_ACTION.test(t)) return false;
  return IMPERATIVE.test(t) && TARGET.test(t);
}
