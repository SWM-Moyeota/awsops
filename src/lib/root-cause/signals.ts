// CloudWatch signal detection: ALB 5xx, unhealthy targets, instance status checks, alarms.
// CloudWatch 신호 감지 — ALB 5xx, 비정상 대상, 인스턴스 상태 검사, 알람.
import { CloudWatchClient, GetMetricDataCommand, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import type { GraphData, GraphNode } from '@/lib/dep-graph/types';
import { accountCredentials } from '@/lib/cloudtrail-access';
import type { Signal } from './types';

// 1-minute points, any order; missing minutes count as 0. / 1분 단위 점, 순서 무관, 빠진 분은 0.
export type Series = Array<{ t: string; v: number }>;
// One GetMetricData query. / GetMetricData 쿼리 하나.
export interface MetricQuery { id: string; namespace: string; metric: string; dimensions: Record<string, string>; stat: 'Sum' | 'Maximum' }
// A CloudWatch alarm in ALARM state, trimmed. / ALARM 상태 알람 요약.
export interface AlarmInfo { name: string; arn: string; stateUpdatedAt: string; dimensions: Record<string, string> }
export interface SignalDeps {
  getMetricData?: (q: MetricQuery[], from: Date, to: Date) => Promise<Record<string, Series>>;
  describeAlarms?: () => Promise<AlarmInfo[]>;
}

const MIN = 60_000;
// Points in (now-fromMin, now-toMin]. / (now-fromMin, now-toMin] 구간의 점.
function slice(series: Series, now: Date, fromMin: number, toMin: number): Array<{ ms: number; t: string; v: number }> {
  const hi = now.getTime() - toMin * MIN;
  const lo = now.getTime() - fromMin * MIN;
  return series.map((p) => ({ ms: Date.parse(p.t), t: p.t, v: p.v })).filter((p) => p.ms > lo && p.ms <= hi);
}
function firstPositive(pts: Array<{ ms: number; t: string; v: number }>, min: number): string | null {
  const hit = pts.filter((p) => p.v >= min).sort((a, b) => a.ms - b.ms)[0];
  return hit ? new Date(hit.ms).toISOString() : null;
}

// 5xx spike vs the previous hour. / 직전 1시간 대비 5xx 급증.
export function detect5xx(series: Series, now: Date): { startedAt: string; recent: number; baseline: number } | null {
  const last = slice(series, now, 5, 0);
  const recent = last.reduce((s, p) => s + p.v, 0);
  const base = slice(series, now, 65, 5).reduce((s, p) => s + p.v, 0) / 12;
  if (!(recent >= 10 && recent > 3 * Math.max(1, base))) return null;
  const startedAt = firstPositive(last, Number.MIN_VALUE);
  return startedAt ? { startedAt, recent, baseline: base } : null;
}

// Newly non-zero metric: quiet for 30 min, then >= 1 in the last 5. / 30분 0이다가 최근 5분 내 1 이상.
export function detectRise(series: Series, now: Date): { startedAt: string; recent: number } | null {
  const last = slice(series, now, 5, 0);
  const recent = Math.max(0, ...last.map((p) => p.v));
  if (recent < 1) return null;
  if (Math.max(0, ...slice(series, now, 35, 5).map((p) => p.v)) !== 0) return null;
  const startedAt = firstPositive(last, 1);
  return startedAt ? { startedAt, recent } : null;
}

// Targets to watch in this account. / 이 계정에서 볼 대상.
export function watchTargets(data: GraphData, accountId: string): { lbs: GraphNode[]; tgs: GraphNode[]; instances: GraphNode[] } {
  const mine = data.nodes.filter((n) => n.accountId === accountId);
  const lbs = mine.filter((n) => n.type === 'lb' && n.attrs?.lbType === 'application');
  const lbArns = new Set(lbs.map((n) => n.arn));
  const tgArns = new Set(data.edges.filter((e) => e.type === 'forwards_to' && lbArns.has(e.src)).map((e) => e.dst));
  return {
    lbs,
    tgs: mine.filter((n) => n.type === 'tg' && tgArns.has(n.arn)),
    instances: mine.filter((n) => n.type === 'instance' && n.attrs?.state === 'running'),
  };
}

// "arn:...:loadbalancer/app/x/y" -> "app/x/y". / ARN에서 LoadBalancer 차원 값.
export function lbDimension(arn: string): string { return arn.split(':loadbalancer/')[1] ?? arn; }
// "arn:...:targetgroup/x/y" -> "targetgroup/x/y". / ARN에서 TargetGroup 차원 값.
export function tgDimension(arn: string): string { const i = arn.indexOf('targetgroup/'); return i >= 0 ? arn.slice(i) : arn; }

function sumSeries(list: Series[]): Series {
  const m = new Map<string, number>();
  for (const s of list) for (const p of s) m.set(p.t, (m.get(p.t) ?? 0) + p.v);
  return Array.from(m).map(([t, v]) => ({ t, v }));
}

function errName(e: unknown): string { return e instanceof Error ? e.name : 'Error'; }

// Default GetMetricData: batches of 500, follows NextToken. / 기본 GetMetricData — 500개씩, NextToken 순회.
async function defaultGetMetricData(accountId: string, region: string, queries: MetricQuery[], from: Date, to: Date): Promise<Record<string, Series>> {
  const credentials = await accountCredentials(accountId, 'awsops-root-cause');
  const client = new CloudWatchClient({ region, ...(credentials ? { credentials } : {}) });
  const out: Record<string, Series> = {};
  for (let i = 0; i < queries.length; i += 500) {
    const batch = queries.slice(i, i + 500);
    let token: string | undefined;
    do {
      const res = await client.send(new GetMetricDataCommand({
        StartTime: from, EndTime: to, ScanBy: 'TimestampAscending', NextToken: token,
        MetricDataQueries: batch.map((q) => ({
          Id: q.id, ReturnData: true,
          MetricStat: { Period: 60, Stat: q.stat, Metric: { Namespace: q.namespace, MetricName: q.metric, Dimensions: Object.entries(q.dimensions).map(([Name, Value]) => ({ Name, Value })) } },
        })),
      }));
      for (const r of res.MetricDataResults ?? []) {
        const arr = (out[r.Id ?? ''] ??= []);
        (r.Timestamps ?? []).forEach((t, k) => arr.push({ t: t.toISOString(), v: r.Values?.[k] ?? 0 }));
      }
      token = res.NextToken;
    } while (token);
  }
  return out;
}

async function defaultDescribeAlarms(accountId: string, region: string): Promise<AlarmInfo[]> {
  const credentials = await accountCredentials(accountId, 'awsops-root-cause');
  const client = new CloudWatchClient({ region, ...(credentials ? { credentials } : {}) });
  const out: AlarmInfo[] = [];
  let token: string | undefined;
  do {
    const res = await client.send(new DescribeAlarmsCommand({ StateValue: 'ALARM', AlarmTypes: ['MetricAlarm'], NextToken: token }));
    for (const a of res.MetricAlarms ?? []) {
      out.push({
        name: a.AlarmName ?? '', arn: a.AlarmArn ?? '',
        stateUpdatedAt: a.StateUpdatedTimestamp?.toISOString() ?? '',
        dimensions: Object.fromEntries((a.Dimensions ?? []).map((d) => [d.Name ?? '', d.Value ?? ''])),
      });
    }
    token = res.NextToken;
  } while (token);
  return out;
}

// Resolve an alarm's dimensions to a graph node ARN (same account only). / 알람 차원을 같은 계정 그래프 노드로.
function resolveAlarm(dims: Record<string, string>, data: GraphData, accountId: string): string | null {
  const nodes = data.nodes.filter((n) => n.accountId === accountId);
  const find = (pred: (n: GraphNode) => boolean) => nodes.find(pred)?.arn ?? null;
  if (dims.TargetGroup) { const r = find((n) => n.type === 'tg' && n.arn.endsWith(`:${dims.TargetGroup}`)); if (r) return r; }
  if (dims.LoadBalancer) { const r = find((n) => n.type === 'lb' && n.arn.endsWith(`:loadbalancer/${dims.LoadBalancer}`)); if (r) return r; }
  if (dims.InstanceId) { const r = find((n) => n.type === 'instance' && n.id === dims.InstanceId); if (r) return r; }
  if (dims.DBInstanceIdentifier) { const r = find((n) => n.type === 'rds' && n.id === dims.DBInstanceIdentifier); if (r) return r; }
  if (dims.FunctionName) { const r = find((n) => n.type === 'lambda' && n.id === dims.FunctionName); if (r) return r; }
  return null;
}

// Detect anomalies for one account+region. / 한 계정+리전의 이상 신호 감지.
export async function fetchSignals(accountId: string, region: string, data: GraphData, now: Date, deps: SignalDeps = {}): Promise<Signal[]> {
  const getMetricData = deps.getMetricData ?? ((q, f, t) => defaultGetMetricData(accountId, region, q, f, t));
  const describeAlarms = deps.describeAlarms ?? (() => defaultDescribeAlarms(accountId, region));
  const inRegion = (n: GraphNode) => !n.region || n.region === region;
  const t = watchTargets(data, accountId);
  const lbs = t.lbs.filter(inRegion), tgs = t.tgs.filter(inRegion), instances = t.instances.filter(inRegion);
  const lbOf = new Map<string, string>();
  for (const e of data.edges) if (e.type === 'forwards_to' && lbs.some((l) => l.arn === e.src)) lbOf.set(e.dst, e.src);

  const queries: MetricQuery[] = [];
  const owner = new Map<string, { node: GraphNode; kind: 'elb' | 'target' | 'tg' | 'ec2' }>();
  const add = (q: MetricQuery, node: GraphNode, kind: 'elb' | 'target' | 'tg' | 'ec2') => { queries.push(q); owner.set(q.id, { node, kind }); };
  lbs.forEach((n, i) => {
    const dimensions = { LoadBalancer: lbDimension(n.arn) };
    add({ id: `lb${i}e`, namespace: 'AWS/ApplicationELB', metric: 'HTTPCode_ELB_5XX_Count', dimensions, stat: 'Sum' }, n, 'elb');
    add({ id: `lb${i}t`, namespace: 'AWS/ApplicationELB', metric: 'HTTPCode_Target_5XX_Count', dimensions, stat: 'Sum' }, n, 'target');
  });
  tgs.forEach((n, i) => {
    const lb = lbOf.get(n.arn);
    if (!lb) return;
    add({ id: `tg${i}`, namespace: 'AWS/ApplicationELB', metric: 'UnHealthyHostCount', dimensions: { LoadBalancer: lbDimension(lb), TargetGroup: tgDimension(n.arn) }, stat: 'Maximum' }, n, 'tg');
  });
  instances.forEach((n, i) => {
    add({ id: `ec${i}`, namespace: 'AWS/EC2', metric: 'StatusCheckFailed', dimensions: { InstanceId: n.id }, stat: 'Maximum' }, n, 'ec2');
  });

  const signals: Signal[] = [];
  if (queries.length) {
    try {
      const res = await getMetricData(queries, new Date(now.getTime() - 70 * MIN), now);
      const lbParts = new Map<string, { node: GraphNode; parts: Series[] }>();
      for (const q of queries) {
        const o = owner.get(q.id)!;
        const s = res[q.id] ?? [];
        if (o.kind === 'elb' || o.kind === 'target') {
          const e = lbParts.get(o.node.arn) ?? { node: o.node, parts: [] };
          e.parts.push(s); lbParts.set(o.node.arn, e);
        } else if (o.kind === 'tg') {
          const r = detectRise(s, now);
          if (r) signals.push({ kind: 'tg-unhealthy', accountId, region, resourceArn: o.node.arn, startedAt: r.startedAt, detail: `비정상 대상 ${r.recent}개`, recent: r.recent });
        } else {
          const r = detectRise(s, now);
          if (r) signals.push({ kind: 'ec2-status', accountId, region, resourceArn: o.node.arn, startedAt: r.startedAt, detail: '상태 검사 실패', recent: r.recent });
        }
      }
      for (const { node, parts } of Array.from(lbParts.values())) {
        const r = detect5xx(sumSeries(parts), now);
        if (r) signals.push({ kind: 'alb-5xx', accountId, region, resourceArn: node.arn, startedAt: r.startedAt, detail: `5분 5xx ${Math.round(r.recent)}건, 평소 ${Math.round(r.baseline)}건`, recent: r.recent, baseline: r.baseline });
      }
    } catch (e) { console.error('[root-cause] getMetricData failed:', errName(e)); }
  }

  try {
    const alarms = await describeAlarms();
    for (const a of alarms) {
      const ms = Date.parse(a.stateUpdatedAt);
      if (!Number.isFinite(ms) || now.getTime() - ms > 15 * MIN) continue;
      signals.push({ kind: 'alarm', accountId, region, resourceArn: resolveAlarm(a.dimensions, data, accountId), alarmArn: a.arn, alarmName: a.name, startedAt: new Date(ms).toISOString(), detail: `알람 ${a.name}` });
    }
  } catch (e) { console.error('[root-cause] describeAlarms failed:', errName(e)); }
  return signals;
}
