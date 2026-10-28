// Shape checks for the replay-test scenarios (not the ranking itself).
// 재현 시험 시나리오 데이터 모양 검사 — 순위 자체는 eval.test.ts가 잰다.
import { describe, it, expect } from 'vitest';
import { SCENARIOS } from '../eval/scenarios';
import type { Scenario } from '../types';

type Obj = Record<string, unknown>;
const NOISE = new Set(['UpdateInstanceInformation', 'CreateLogStream']);
const MIN = 60_000;

const answerOf = (s: Scenario): Obj => {
  const hits = s.events.filter(e => e.eventID === s.answer);
  if (hits.length !== 1) throw new Error(`${s.id}: answer matches ${hits.length} events`);
  return hits[0];
};

// Required categories and the answer event name each one implies. / 필수 종류와 정답 이벤트 이름.
const REQUIRED: Record<string, (name: string) => boolean> = {
  'sg-revoke': n => n === 'RevokeSecurityGroupIngress',
  'tg-deregister': n => n === 'DeregisterTargets',
  'instance-stop': n => n === 'StopInstances',
  'listener-rule': n => n === 'ModifyListener' || n === 'ModifyRule',
  // Real CloudTrail names carry a version suffix (UpdateFunctionConfiguration20150331v2). / 실제 이름엔 버전 접미사.
  'lambda-config': n => n.startsWith('UpdateFunctionConfiguration'),
  'iam-detach': n => n === 'DetachRolePolicy',
  'rds-modify': n => n === 'ModifyDBInstance',
  'eni-sg-swap': n => n === 'ModifyNetworkInterfaceAttribute',
  'noise-heavy': () => true,
};

describe('SCENARIOS', () => {
  it('has at least 24 scenarios with unique ids', () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(24);
    expect(new Set(SCENARIOS.map(s => s.id)).size).toBe(SCENARIOS.length);
  });

  it('covers every required category at least twice, and >= 2 known limits', () => {
    for (const cat of Object.keys(REQUIRED)) {
      expect(SCENARIOS.filter(s => s.category === cat && !s.knownLimit).length, cat).toBeGreaterThanOrEqual(2);
    }
    expect(SCENARIOS.filter(s => s.knownLimit).length).toBeGreaterThanOrEqual(2);
  });

  it('every non-limit scenario belongs to a required category', () => {
    for (const s of SCENARIOS.filter(x => !x.knownLimit)) expect(Object.keys(REQUIRED), s.id).toContain(s.category);
  });

  describe.each(SCENARIOS.map(s => [s.id, s] as const))('%s', (_id, s) => {
    it('answer is exactly one successful event, 2–40 min before start', () => {
      const a = answerOf(s);
      expect(a.errorCode).toBeUndefined();
      const lead = (Date.parse(s.startedAt) - Date.parse(String(a.eventTime))) / MIN;
      expect(lead).toBeGreaterThanOrEqual(2);
      expect(lead).toBeLessThanOrEqual(40);
    });

    it('answer event name fits the category', () => {
      const name = String(answerOf(s).eventName);
      if (!s.knownLimit) expect(REQUIRED[s.category](name), name).toBe(true);
      expect(NOISE.has(name)).toBe(false);
    });

    it('events look like raw CloudTrail records', () => {
      const ids = new Set<string>();
      for (const e of s.events) {
        expect(typeof e.eventID).toBe('string');
        ids.add(String(e.eventID));
        expect(String(e.eventTime)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
        expect(e.readOnly).toBe(false);
        expect(String(e.eventSource)).toMatch(/\.amazonaws\.com$/);
        expect(typeof e.eventName).toBe('string');
        expect(typeof e.awsRegion).toBe('string');
        expect(typeof e.sourceIPAddress).toBe('string');
        expect(typeof e.userAgent).toBe('string');
        expect(e.recipientAccountId).toBe(s.accountId);
        const ui = e.userIdentity as Obj;
        expect(ui && typeof ui === 'object').toBe(true);
        expect(ui.accountId).toBe(s.accountId);
        expect(e.requestParameters === null || typeof e.requestParameters === 'object').toBe(true);
        if (e.eventSource === 'iam.amazonaws.com') expect(e.awsRegion).toBe('us-east-1');
      }
      expect(ids.size).toBe(s.events.length);
    });

    it('carries at least 3 distractors, including noise', () => {
      expect(s.events.length - 1).toBeGreaterThanOrEqual(3);
      expect(s.events.some(e => NOISE.has(String(e.eventName)))).toBe(true);
      // At least 3 non-noise distractors besides the answer. / 정답 외에 잡음이 아닌 함정이 3개 이상.
      expect(s.events.filter(e => e.eventID !== s.answer && !NOISE.has(String(e.eventName))).length).toBeGreaterThanOrEqual(3);
    });

    it('graph snapshots are consistent', () => {
      expect(s.graphs.length).toBeGreaterThanOrEqual(1);
      const start = Date.parse(s.startedAt);
      // At least one snapshot inside the hour before start. / 시작 전 1시간 안에 스냅샷이 하나 이상.
      expect(s.graphs.some(g => Date.parse(g.builtAt) <= start && Date.parse(g.builtAt) >= start - 60 * MIN)).toBe(true);
      for (const snap of s.graphs) {
        const nodes = new Map(snap.data.nodes.map(n => [n.arn, n]));
        expect(nodes.size, 'duplicate node arn').toBe(snap.data.nodes.length);
        for (const n of snap.data.nodes) {
          expect(n.arn.startsWith('arn:aws:')).toBe(true);
          expect(n.accountId).toMatch(/^\d{12}$/);
          // ARN account segment matches accountId (S3 ARNs have none). / ARN 계정 칸과 accountId 일치.
          const seg = n.arn.split(':')[4];
          if (n.type !== 's3') expect(seg, n.arn).toBe(n.accountId);
        }
        for (const e of snap.data.edges) {
          const src = nodes.get(e.src), dst = nodes.get(e.dst);
          expect(src, `missing src ${e.src}`).toBeDefined();
          expect(dst, `missing dst ${e.dst}`).toBeDefined();
          // Ruling: every edge joins two nodes of the same account. / 간선은 같은 계정 노드끼리만.
          expect(src!.accountId, `${e.src} -> ${e.dst}`).toBe(dst!.accountId);
        }
      }
      if (s.targetArn) expect(s.graphs.some(g => g.data.nodes.some(n => n.arn === s.targetArn && n.accountId === s.accountId))).toBe(true);
    });
  });

  it('noise-heavy scenarios have >= 30 noise events', () => {
    for (const s of SCENARIOS.filter(x => x.category === 'noise-heavy')) {
      expect(s.events.filter(e => NOISE.has(String(e.eventName))).length, s.id).toBeGreaterThanOrEqual(30);
    }
  });

  it('IAM detach answers are recorded in us-east-1', () => {
    for (const s of SCENARIOS.filter(x => x.category === 'iam-detach')) expect(answerOf(s).awsRegion, s.id).toBe('us-east-1');
  });

  it('ENI swap scenarios: the old uses_sg edge is in the earliest snapshot but gone from the latest', () => {
    for (const s of SCENARIOS.filter(x => x.category === 'eni-sg-swap')) {
      expect(s.graphs.length, s.id).toBeGreaterThanOrEqual(2);
      const eniId = String((answerOf(s).requestParameters as Obj).networkInterfaceId);
      const sorted = [...s.graphs].sort((a, b) => Date.parse(a.builtAt) - Date.parse(b.builtAt));
      const sgEdges = (i: number) => {
        const d = sorted[i].data;
        const eni = d.nodes.find(n => n.type === 'eni' && n.id === eniId && n.accountId === s.accountId);
        expect(eni, `${s.id}: eni ${eniId}`).toBeDefined();
        return new Set(d.edges.filter(e => e.src === eni!.arn && e.type === 'uses_sg').map(e => e.dst));
      };
      const first = sgEdges(0), last = sgEdges(sorted.length - 1);
      expect(Array.from(first).some(dst => !last.has(dst)), s.id).toBe(true);
    }
  });

  it('known-limit answers are not graph resources', () => {
    for (const s of SCENARIOS.filter(x => x.knownLimit)) {
      expect(['ReplaceRoute', 'ReplaceNetworkAclEntry', 'ChangeResourceRecordSets'], s.id).toContain(answerOf(s).eventName);
    }
  });
});
