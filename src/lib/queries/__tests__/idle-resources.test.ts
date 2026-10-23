import { describe, it, expect } from 'vitest';
import { SQL_UNATTACHED_EBS } from '../idle-resources';

describe('idle-resources SQL', () => {
  it('unattachedEbsFiltersOnStateColumn', () => {
    expect(SQL_UNATTACHED_EBS).toContain("state = 'available'");
    expect(SQL_UNATTACHED_EBS).not.toMatch(/\bstatus\b/);
    expect(SQL_UNATTACHED_EBS).not.toContain('$');
  });
});
