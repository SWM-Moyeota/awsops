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
    ]) expect(detectActionIntent(t), t).toBe(false);
  });
});
