// Fixture sanity: anonymized and self-consistent / 픽스처 점검: 익명화 및 일관성
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const dir = join(__dirname, 'fixtures');
const read = (f: string) => readFileSync(join(dir, f), 'utf-8');
const files = ['generated.raw.tf', 'plan-errors.txt', 'plan.json'];

describe('tf-export fixtures', () => {
  it('contains no real account ids (only 111122223333)', () => {
    for (const f of files) {
      const ids = read(f).match(/(?<![0-9A-Za-z])[0-9]{12}(?![0-9A-Za-z])/g) ?? [];
      expect(ids.filter(i => i !== '111122223333'), f).toEqual([]);
    }
  });
  it('contains no email addresses', () => {
    for (const f of files) expect(read(f), f).not.toMatch(/[A-Za-z0-9._-]+@[A-Za-z0-9-]+\.[A-Za-z]/);
  });
  it('error log line refs exist in generated.raw.tf', () => {
    const total = read('generated.raw.tf').split('\n').length;
    const refs = (read('plan-errors.txt').match(/on generated\.tf line \d+/g) ?? []).map(m => Number(m.replace(/\D/g, '')));
    expect(refs.length).toBeGreaterThan(0);
    for (const n of refs) {
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(total);
    }
  });
  it('plan.json parses with >= 14 resource changes', () => {
    const plan = JSON.parse(read('plan.json'));
    expect(plan.resource_changes.length).toBeGreaterThanOrEqual(14);
  });
  it('has no real EC2 dashed-IP hostnames', () => {
    for (const f of files) {
      const hosts = read(f).match(/ec2-\d+-\d+-\d+-\d+/g) ?? [];
      expect(hosts.filter(h => h !== 'ec2-203-0-113-10'), f).toEqual([]);
    }
  });
  it('has no public IPv4 outside allowed ranges', () => {
    const ok = (ip: string) => {
      const [a, b, c] = ip.split('.').map(Number);
      return ip === '0.0.0.0' || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 203 && b === 0 && c === 113);
    };
    for (const f of files) {
      const ips = read(f).match(/(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g) ?? [];
      expect(ips.filter(i => !ok(i)), f).toEqual([]);
    }
  });
  it('keeps the fake secret for secret-handling tests', () => {
    expect(read('generated.raw.tf')).toMatch(/DB_PASSWORD\s*=\s*"fake-secret-1"/);
    expect(read('plan.json')).toContain('"DB_PASSWORD":"fake-secret-1"');
  });
});
