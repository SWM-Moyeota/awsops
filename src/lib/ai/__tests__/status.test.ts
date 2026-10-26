// buildStatus / pick pin current output / 현재 출력을 고정한다
import { describe, it, expect } from 'vitest';
import { buildStatus, pick } from '../status';

describe('pick', () => {
  it('chooses by language, defaulting to English', () => {
    expect(pick('ko', 'en', 'ko', 'zh')).toBe('ko');
    expect(pick('zh', 'en', 'ko', 'zh')).toBe('zh');
    expect(pick('en', 'en', 'ko', 'zh')).toBe('en');
    expect(pick(undefined, 'en', 'ko', 'zh')).toBe('en');
    expect(pick('fr', 'en', 'ko', 'zh')).toBe('en');
  });
});

describe('buildStatus', () => {
  it('ko samples', () => {
    const s = buildStatus('ko');
    expect(s.classifying).toBe('🔍 질문 분석 중...');
    expect(s.multiRoute('A + B')).toBe('📡 멀티 라우트: A + B');
    expect(s.sqlQuerying(true)).toBe('🔎 Steampipe 쿼리 실행 중... (재시도)');
    expect(s.agentcoreProgress('Network', 30)).toBe('🤖 Network 도구 실행 중... (30s)');
  });
  it('en samples, also the default for undefined/unknown', () => {
    for (const lang of ['en', undefined, 'fr']) {
      const s = buildStatus(lang);
      expect(s.classifying).toBe('🔍 Analyzing question...');
      expect(s.connecting('Cost')).toBe('📡 Connecting to Cost...');
      expect(s.sqlQuerying(false)).toBe('🔎 Running Steampipe query...');
      expect(s.analyzing(5)).toBe('📊 Analyzing 5 rows of data...');
    }
  });
  it('zh samples', () => {
    const s = buildStatus('zh');
    expect(s.classifying).toBe('🔍 正在分析问题...');
    expect(s.synthesizing(2)).toBe('📊 正在合成 2 个响应...');
    expect(s.sqlQuerying(true)).toBe('🔎 正在运行 Steampipe 查询...（重试）');
    expect(s.topologyResolving).toBe('🗺️ Resolving target VPC...');
  });
});
