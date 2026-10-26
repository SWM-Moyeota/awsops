// extractUsedTools pins current output / 현재 출력을 고정한다
import { describe, it, expect } from 'vitest';
import { extractUsedTools, KNOWN_TOOLS, TOOL_KEYWORD_MAP } from '../tools';

describe('extractUsedTools', () => {
  it('returns [] for plain text with no tool hints', () => {
    expect(extractUsedTools('안녕하세요 hello')).toEqual([]);
  });
  it('reads <tool_call> name tags', () => {
    expect(extractUsedTools('<tool_call>{"name": "my_custom_tool"}')).toEqual(['my_custom_tool']);
  });
  it('reads "tool_name" fields', () => {
    expect(extractUsedTools('{"tool_name": "other_tool"}')).toEqual(['other_tool']);
  });
  it('keeps backtick names only if known', () => {
    expect(extractUsedTools('used `analyze_reachability` and `not_a_tool`')).toContain('analyze_reachability');
    expect(extractUsedTools('used `not_a_tool`')).not.toContain('not_a_tool');
  });
  it('detects known tool names in plain text', () => {
    expect(extractUsedTools('ran query_flow_logs yesterday')).toContain('query_flow_logs');
  });
  it('infers tools from keywords', () => {
    const r = extractUsedTools('Reachability 분석 결과, 예산 초과');
    expect(r).toContain('analyze_reachability');
    expect(r).toContain('list_budgets');
  });
  it('dedupes', () => {
    const r = extractUsedTools('`analyze_reachability` analyze_reachability Reachability');
    expect(r.filter(t => t === 'analyze_reachability')).toHaveLength(1);
  });
  it('keyword map only references plausible tool names', () => {
    expect(KNOWN_TOOLS.has('analyze_reachability')).toBe(true);
    expect(Object.keys(TOOL_KEYWORD_MAP)).toContain('get_cost_and_usage');
  });
});
