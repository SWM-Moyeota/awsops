// parseClassification pins current parsing / 현재 파싱을 고정한다
import { describe, it, expect, vi } from 'vitest';
import { parseClassification } from '../classify';

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

describe('parseClassification', () => {
  it('parses a multi-route reply', () => {
    expect(parseClassification('{"routes": ["network", "cost"]}')).toEqual(['network', 'cost']);
  });
  it('drops invalid routes and caps at 3', () => {
    expect(parseClassification('{"routes": ["bogus", "network", "cost", "data", "security"]}')).toEqual(['network', 'cost', 'data']);
  });
  it('falls to single route when no multi route is valid', () => {
    expect(parseClassification('{"routes": ["bogus"], "route": "cost"}')).toEqual(['cost']);
  });
  it('parses a single route', () => {
    expect(parseClassification('Answer: {"route": "security"}')).toEqual(['security']);
  });
  it('falls back to general for invalid or unparsable text', () => {
    expect(parseClassification('{"route": "bogus"}')).toEqual(['general']);
    expect(parseClassification('no json here')).toEqual(['general']);
    expect(parseClassification('')).toEqual(['general']);
  });
});
