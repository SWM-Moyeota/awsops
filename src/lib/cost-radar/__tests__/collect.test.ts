import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/steampipe', () => ({ runQuery: vi.fn() }));

import { collectInventory, MAX_CONCURRENT_QUERIES } from '../collect';

const A = '111111111111';

describe('collectInventory', () => {
  it('caps concurrent Steampipe queries per account at 4', async () => {
    let active = 0;
    let peak = 0;
    const sqls: string[] = [];
    const runQuery = vi.fn(async (sql: string) => {
      sqls.push(sql);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return { rows: [] };
    });
    const inv = await collectInventory(A, { runQuery });
    expect(MAX_CONCURRENT_QUERIES).toBe(4);
    expect(runQuery).toHaveBeenCalledTimes(11);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
    expect(inv.errors).toEqual({});
    for (const sql of sqls) expect(sql).not.toContain('$');
  });

  it('passes the account id and records failures per category without throwing', async () => {
    const runQuery = vi.fn(async (sql: string, opts?: { accountId?: string }) => {
      expect(opts?.accountId).toBe(A);
      if (sql.includes('aws_vpc_nat_gateway')) throw new Error('boom');
      if (sql.includes('aws_elasticache_cluster')) return { rows: [], error: 'denied' };
      return { rows: [{ x: 1 }] };
    });
    const inv = await collectInventory(A, { runQuery });
    expect(inv.errors).toEqual({ nat: 'boom', elasticache: 'denied' });
    expect(inv.instances).toEqual([{ x: 1 }]);
    expect(inv.nats).toEqual([]);
  });

  it('selects the public IPv4 and RDS status columns', async () => {
    const sqls: string[] = [];
    await collectInventory(A, { runQuery: async (sql: string) => { sqls.push(sql); return { rows: [] }; } });
    const find = (t: string) => sqls.find((s) => s.includes(`FROM ${t}`))!;
    expect(find('aws_ec2_instance')).toContain('public_ip_address');
    for (const t of ['aws_ec2_application_load_balancer', 'aws_ec2_network_load_balancer']) {
      expect(find(t)).toContain('scheme');
      expect(find(t)).toContain('availability_zones');
    }
    expect(find('aws_rds_db_instance')).toMatch(/\bstatus\b/);
  });
});
