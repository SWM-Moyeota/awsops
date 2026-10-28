// Shape checks for the replay-test scenarios (not the ranking itself).
// 재현 시험 시나리오 데이터 모양 검사 — 순위 자체는 eval.test.ts가 잰다.
import { describe, it, expect } from 'vitest';
import { SCENARIOS } from '../eval/scenarios';
import type { GraphData, GraphNode } from '@/lib/dep-graph/types';
import type { Scenario } from '../types';

type Obj = Record<string, unknown>;
const NOISE = new Set(['UpdateInstanceInformation', 'CreateLogStream']);
const MIN = 60_000;

// Undirected reachability from `from`, never entering vpc/subnet nodes (they join everything).
// 방향 무시 도달 가능 노드 집합 — vpc/subnet은 모든 것을 잇기 때문에 들어가지 않는다.
function reachable(data: GraphData, from: string): Set<string> {
  const type = new Map(data.nodes.map(n => [n.arn, n.type]));
  const adj = new Map<string, string[]>();
  for (const e of data.edges) {
    adj.set(e.src, [...(adj.get(e.src) ?? []), e.dst]);
    adj.set(e.dst, [...(adj.get(e.dst) ?? []), e.src]);
  }
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    for (const next of adj.get(queue.shift()!) ?? []) {
      const t = type.get(next);
      if (seen.has(next) || t === 'vpc' || t === 'subnet') continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

// Graph nodes named anywhere in requestParameters (by id or ARN, scenario account only).
// requestParameters 어디든 id·ARN으로 언급된 그래프 노드 (시나리오 계정만).
function namedNodes(req: unknown, data: GraphData, accountId: string): GraphNode[] {
  const strings = new Set<string>();
  // Listener / rule ARNs name their load balancer. / 리스너·규칙 ARN은 그 로드밸런서를 가리킨다.
  const LISTENER = /^(arn:aws:elasticloadbalancing:[^:]+:\d{12}:)listener(?:-rule)?\/((?:app|net)\/[^/]+\/[0-9a-f]+)\//;
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      strings.add(v);
      const m = LISTENER.exec(v);
      if (m) strings.add(`${m[1]}loadbalancer/${m[2]}`);
    }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(req);
  return data.nodes.filter(n => n.accountId === accountId && (strings.has(n.id) || strings.has(n.arn)));
}
const byTime = (s: Scenario) => [...s.graphs].sort((a, b) => Date.parse(a.builtAt) - Date.parse(b.builtAt));
const isTag = (name: string) => /Tag/.test(name);

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

  // Review Focus #1: the swapped ENI is linked to the target only through the old SG, so only the
  // pre-change snapshot connects it. / 바뀐 ENI는 옛 SG로만 대상에 이어져, 변경 전 스냅샷에서만 닿는다.
  it('ENI swap scenarios: answer resources reachable from the target only in the earliest snapshot', () => {
    for (const s of SCENARIOS.filter(x => x.category === 'eni-sg-swap')) {
      const graphs = byTime(s);
      const first = graphs[0].data, last = graphs[graphs.length - 1].data;
      const req = answerOf(s).requestParameters as Obj;
      const eni = first.nodes.find(n => n.type === 'eni' && n.id === req.networkInterfaceId && n.accountId === s.accountId);
      expect(eni, s.id).toBeDefined();
      expect(reachable(first, s.targetArn!).has(eni!.arn), `${s.id}: eni reachable before`).toBe(true);
      const nowReach = reachable(last, s.targetArn!);
      const named = namedNodes(req, last, s.accountId);
      expect(named.length, s.id).toBeGreaterThanOrEqual(2);
      for (const n of named) expect(nowReach.has(n.arn), `${s.id}: ${n.type} ${n.id} unreachable after`).toBe(false);
    }
  });

  // Controller ruling: a connected, successful, non-tag distractor in (nearly) every scored scenario.
  // 대상과 연결된, 성공한, 태그가 아닌 함정을 채점 시나리오 대부분에 둔다.
  it('scored scenarios carry a connected, successful, non-tag, non-noise distractor', () => {
    const missing: string[] = [];
    for (const s of SCENARIOS.filter(x => !x.knownLimit)) {
      const ok = s.events.some(e => {
        const name = String(e.eventName);
        if (e.eventID === s.answer || e.errorCode || NOISE.has(name) || isTag(name)) return false;
        return s.graphs.some(g => {
          const reach = reachable(g.data, s.targetArn!);
          return namedNodes(e.requestParameters, g.data, s.accountId).some(n => reach.has(n.arn));
        });
      });
      if (!ok) missing.push(s.id);
    }
    expect(missing).toEqual([]);
  });

  it('known-limit answers are not graph resources', () => {
    for (const s of SCENARIOS.filter(x => x.knownLimit)) {
      expect(['ReplaceRoute', 'ReplaceNetworkAclEntry', 'ChangeResourceRecordSets'], s.id).toContain(answerOf(s).eventName);
    }
  });
});
