import { describe, it, expect } from 'vitest';
import { GRAPH_QUERIES } from '../queries';

const NAMES = ['vpc','subnet','eni','instance','sg','sgRule','alb','nlb','clb','tg','rds','lambda','role','policy','nat','eip','ebs','s3','cloudfront'];

describe('GRAPH_QUERIES', () => {
  it('has all 19 names', () => {
    expect(Object.keys(GRAPH_QUERIES).sort()).toEqual([...NAMES].sort());
  });
  it('are SELECT-only with no dollar sign', () => {
    for (const [k, q] of Object.entries(GRAPH_QUERIES)) {
      expect(q.trim(), k).toMatch(/^select/i);
      expect(q, k).not.toContain('$');
    }
  });
  it('select account_id and region', () => {
    for (const [k, q] of Object.entries(GRAPH_QUERIES)) {
      expect(q, k).toMatch(/\baccount_id\b/);
      expect(q, k).toMatch(/\bregion\b/);
    }
  });
  it('never selects lambda tags', () => {
    expect(GRAPH_QUERIES.lambda).not.toMatch(/\btags\b/);
  });
  it('policy only reads customer-managed policies', () => {
    expect(GRAPH_QUERIES.policy).toMatch(/is_aws_managed\s*=\s*false/);
  });
});
