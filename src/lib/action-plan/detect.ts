// Rule-based detection of "change a tag / security group" requests — a pure function, no LLM, no I/O.
// Both an imperative verb and a target word must be present; how-to and hypothetical questions are left to the AI.
// 규칙 기반 감지: 명령형 동사와 대상 단어가 함께 있어야 하고, 방법·가정 질문은 건드리지 않는다.

// 붙여/달아/바꿔/변경해/지워/떼/삭제해/추가해/열어/닫아/막아/허용해 + 줘·줘요·주세요·주라·라
const ENDING = String.raw`\s*(줘요?|주세요|주라|라)(?![가-힣])`;
const IMPERATIVE = new RegExp(`(붙여|달아|바꿔|변경해|지워|떼어?|삭제해|추가해|열어|닫아|막아|허용해)${ENDING}`);
// open/close/allow/block only — these take a port or a security group as their object.
const OPEN_CLOSE = new RegExp(`(열어|닫아|막아|허용해)${ENDING}`);

const TARGET = /태그|보안\s*그룹|\bsg-[\w-]+|포트|인바운드|규칙/i;
// With an open/close verb, a bare port number (2-5 digits, not part of an IP/CIDR) or an sg-… name is a target:
// "web-dev 8080 열어줘", "sg-web에 8080 열어줘". 열어/닫아 동사와 함께면 포트 번호나 sg-…도 대상으로 본다.
// Numbers that are clearly dates/counts/money ("2024년", "10개", "100%") are not ports.
const PORT_OR_SG = /(?<![\w.:/-])\d{2,5}(?![\d.:/,%])(?!\s*(년|월|일|시간?|분|초|개|명|원|건|대|번째|퍼센트))|\bsg-[\w-]+/i;

// How-to / ability / hypothetical forms: "방법", "어떻게", "할 수 있어?", "하면 돼?"
const NOT_ACTION = /방법|어떻게|수\s*있|면\s*(돼|되|안)|할까|해도\s*(돼|되)/;

export function detectActionIntent(text: string): boolean {
  const t = text.replace(/<@[^>]+>/g, ' ').trim();
  if (!t) return false;
  if (NOT_ACTION.test(t)) return false;
  if (IMPERATIVE.test(t) && TARGET.test(t)) return true;
  return OPEN_CLOSE.test(t) && PORT_OR_SG.test(t);
}
