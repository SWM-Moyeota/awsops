import { describe, it, expect } from 'vitest';
import { detectActionIntent } from '../detect';

describe('detectActionIntent', () => {
  it('detectsImperativeActionsOnTagsAndSecurityGroups', () => {
    for (const t of [
      'web-dev에 owner=jiwoo 태그 붙여줘',
      'sg-0abc 8080 포트 열어줘',
      'api 서버 인바운드 규칙 삭제해 주세요',
      'web-dev 태그 env 지워줘',
      'web-dev 끄고 owner 태그 달아줘',
      '<@U123ABC> web-dev 태그 붙여줘',
      // documented examples (ADR-011, runbook, spec §3.3)
      'sg-web에 8080 열어줘',
      'sg-web에 사무실에서 8080 열어줘',
      'web-dev 8080 열어줘',
      'web-dev 끄고 22번 포트 닫아줘',
      '8080 포트 열어줘요',
      'web-dev 3306 막아 주세요',
      'sg-api 443 허용해줘',
    ]) expect(detectActionIntent(t), t).toBe(true);
  });

  it('howToQuestionsAreNotIntents', () => {
    for (const t of [
      '8080 포트 여는 방법 알려줘',
      '태그 어떻게 붙여?',
      '보안그룹 규칙 추가할 수 있어?',
      '포트 열면 돼?',
      'web-dev 꺼줘',
      '지금 열린 포트 뭐 있어?',
      '<@U123ABC> 태그 어떻게 붙여줘?',
      '',
      // a number alone is not a target without an open/close verb, and IPs are not ports
      'web-dev 8080 꺼줘',
      '10.0.0.0/8 열어줘',
      '2024년 보고서 열어줘',
      '대시보드 10개 열어줘',
      // imperative combined with a how-to / hypothetical marker
      '8080 포트 열어줘 하는 방법 알려줘',
      'sg-web에 8080 열어줘 하면 돼?',
      '태그 붙여줘 라고 하면 어떻게 돼?',
      '보안그룹 규칙 삭제해줘 할 수 있어?',
      'web-dev 8080 열어줘도 돼?',
      '22번 포트 닫아줘 해도 돼?',
      '태그 지워줘 할까?',
    ]) expect(detectActionIntent(t), t).toBe(false);
  });
});
