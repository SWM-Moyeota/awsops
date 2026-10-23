// Cost Radar cleanup recommendations — pure rules over raw inventory (guidance only, never executes).
// 비용 레이더 정리 추천 — 원본 인벤토리에 대한 순수 규칙 (안내만, 실행하지 않음).
import { priceEc2, priceEbs, priceSnapshot, pricePublicIp, priceLb } from './pricing';
import type { RawInventory, Recommendation, RuleId, Row, Savings } from './types';

const LONG_STOPPED_DAYS = 7;
const OLD_SNAPSHOT_DAYS = 90;
const OFFICE_HOURS_PER_WEEK = 50; // weekdays 09-19 / 평일 09~19시
const HOURS_PER_WEEK = 168;
const GP3_SAVING_RATE = 0.2;
const DAYS_PER_MONTH = 30.4;
const KST_OFFSET_MS = 9 * 3600 * 1000;
const DAY_MS = 86400000;
const MANAGED_TAG_PREFIXES = ['aws:ecs:', 'elbv2.k8s.aws/', 'aws:autoscaling:'];
const GUIDE_URL = 'https://docs.aws.amazon.com/scheduler/latest/UserGuide/what-is-scheduler.html';

const round2 = (n: number) => Math.round(n * 100) / 100;
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const numOrNull = (v: unknown) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const utcDay = (d: Date) => Math.floor(d.getTime() / DAY_MS);

function parseJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
}
function arr(v: unknown): unknown[] | null {
  const p = parseJson(v);
  return Array.isArray(p) ? p : null;
}
function tagsOf(row: Row): Record<string, string> {
  const p = parseJson(row.tags);
  if (!p || typeof p !== 'object' || Array.isArray(p)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(p as Record<string, unknown>)) out[k] = str(v);
  return out;
}
const isManaged = (tags: Record<string, string>) => Object.keys(tags).some(k => MANAGED_TAG_PREFIXES.some(p => k.startsWith(p)));

/** "User initiated (2026-10-23 12:58:30 GMT)" -> Date, or null when unparseable. */
export function parseStateTransitionTime(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = /\((\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT\)/.exec(s);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isNaN(t) ? null : new Date(t);
}

const consoleBase = (region: string) => `https://${region}.console.aws.amazon.com/ec2/home?region=${region}`;

function ebsMonthly(v: Row): number | null {
  return priceEbs({
    volumeType: str(v.volume_type), sizeGb: num(v.size), iops: numOrNull(v.iops), throughput: numOrNull(v.throughput), region: str(v.region),
  }).monthly;
}

function recommendAccount(inv: RawInventory, now: Date): Recommendation[] {
  const accountId = inv.accountId;
  const out: Recommendation[] = [];
  const add = (rule: RuleId, row: Row, resourceId: string, rec: Partial<Recommendation> & Pick<Recommendation, 'monthlySaving' | 'cliCommand' | 'consoleUrl'>) => {
    out.push({
      id: `${rule}:${accountId}:${resourceId}`, rule, resourceId, accountId, region: str(row.region), params: {},
      countedInTotal: true, tags: tagsOf(row), ...rec, monthlySaving: round2(rec.monthlySaving),
    });
  };

  // 1. Unused public IPs / 미사용 퍼블릭 IP
  for (const e of inv.eips) {
    if (e.association_id) continue;
    const id = str(e.allocation_id), region = str(e.region);
    add('unused-eip', e, id, {
      params: { publicIp: str(e.public_ip) },
      monthlySaving: pricePublicIp({ region }).monthly ?? 0,
      cliCommand: `aws ec2 release-address --allocation-id ${id} --region ${region}`,
      consoleUrl: `${consoleBase(region)}#ElasticIpDetails:AllocationId=${id}`,
    });
  }

  // 2. Unattached EBS / 미사용 EBS
  for (const v of inv.volumes) {
    if (str(v.state) !== 'available') continue;
    const id = str(v.volume_id), region = str(v.region);
    add('unattached-ebs', v, id, {
      params: { sizeGb: num(v.size), volumeType: str(v.volume_type) },
      monthlySaving: ebsMonthly(v) ?? 0,
      cliCommand: `aws ec2 delete-volume --volume-id ${id} --region ${region}`,
      consoleUrl: `${consoleBase(region)}#VolumeDetails:volumeId=${id}`,
    });
  }

  // 3. Long-stopped EC2: saving = attached EBS cost / 오래 멈춘 EC2: 절약액 = 연결된 EBS 비용
  const volumesByInstance = new Map<string, Row[]>();
  for (const v of inv.volumes) {
    for (const a of arr(v.attachments) ?? []) {
      const iid = str((a as Record<string, unknown>)?.InstanceId);
      if (!iid) continue;
      volumesByInstance.set(iid, [...(volumesByInstance.get(iid) ?? []), v]);
    }
  }
  const coveredVolumes = new Set<string>(); // EBS counted under a long-stopped instance / 멈춘 EC2 아래 합산된 EBS
  for (const i of inv.instances) {
    if (str(i.instance_state) !== 'stopped') continue;
    const since = parseStateTransitionTime(str(i.state_transition_time));
    if (!since) continue; // never guess / 추측하지 않음
    const days = utcDay(now) - utcDay(since); // UTC calendar days / UTC 날짜 차이
    if (days < LONG_STOPPED_DAYS) continue;
    const id = str(i.instance_id), region = str(i.region);
    const vols = volumesByInstance.get(id) ?? [];
    vols.forEach(v => coveredVolumes.add(str(v.volume_id)));
    add('long-stopped-ec2', i, id, {
      params: { days, since: since.toISOString() },
      monthlySaving: vols.reduce((s, v) => s + (ebsMonthly(v) ?? 0), 0),
      cliCommand: `aws ec2 terminate-instances --instance-ids ${id} --region ${region}`,
      consoleUrl: `${consoleBase(region)}#InstanceDetails:instanceId=${id}`,
    });
  }

  // 4. Old snapshots (upper bound: volume size) / 오래된 스냅샷 (볼륨 크기 기준 상한)
  for (const s of inv.snapshots) {
    if (s.owner_id && str(s.owner_id) !== accountId) continue;
    const started = new Date(str(s.start_time));
    if (Number.isNaN(started.getTime())) continue;
    const days = utcDay(now) - utcDay(started);
    if (days < OLD_SNAPSHOT_DAYS) continue;
    const id = str(s.snapshot_id), region = str(s.region);
    add('old-snapshot', s, id, {
      params: { days, sizeGb: num(s.volume_size) },
      monthlySaving: priceSnapshot({ sizeGb: num(s.volume_size), region }).monthly ?? 0,
      cliCommand: `aws ec2 delete-snapshot --snapshot-id ${id} --region ${region}`,
      consoleUrl: `${consoleBase(region)}#SnapshotDetails:snapshotId=${id}`,
    });
  }

  // 5. Empty target groups / load balancers (skipped when the TG query failed)
  //    빈 타겟 그룹·로드밸런서 (타겟 그룹 조회 실패 시 건너뜀)
  if (!inv.errors['target-groups']) {
    const emptyTg = new Map<string, { empty: boolean; managed: boolean; lbs: string[] }>();
    for (const t of inv.targetGroups) {
      const health = arr(t.target_health_descriptions);
      const arn = str(t.target_group_arn), region = str(t.region);
      const tags = tagsOf(t);
      const empty = health !== null && health.length === 0; // null = unknown, not empty
      const managed = isManaged(tags);
      emptyTg.set(arn, { empty, managed, lbs: (arr(t.load_balancer_arns) ?? []).map(str) });
      if (!empty) continue;
      add('empty-tg', t, arn, {
        params: { name: str(t.target_group_name) },
        monthlySaving: 0,
        countedInTotal: !managed,
        ...(managed ? { note: 'maybe-scaled-to-zero' as const } : {}),
        cliCommand: `aws elbv2 delete-target-group --target-group-arn ${arn} --region ${region}`,
        consoleUrl: `${consoleBase(region)}#TargetGroup:targetGroupArn=${encodeURIComponent(arn)}`,
      });
    }
    const lbs: [Row, 'application' | 'network'][] = [...inv.albs.map(l => [l, 'application'] as [Row, 'application']), ...inv.nlbs.map(l => [l, 'network'] as [Row, 'network'])];
    for (const [l, type] of lbs) {
      const arn = str(l.arn), region = str(l.region);
      const mine = Array.from(emptyTg.values()).filter(t => t.lbs.includes(arn));
      if (!mine.every(t => t.empty)) continue;
      const managed = mine.some(t => t.managed);
      add('empty-lb', l, arn, {
        params: { name: str(l.name), type, targetGroups: mine.length },
        monthlySaving: priceLb({ type, region }).monthly ?? 0,
        countedInTotal: !managed,
        ...(managed ? { note: 'maybe-scaled-to-zero' as const } : {}),
        cliCommand: `aws elbv2 delete-load-balancer --load-balancer-arn ${arn} --region ${region}`,
        consoleUrl: `${consoleBase(region)}#LoadBalancer:loadBalancerArn=${encodeURIComponent(arn)}`,
      });
    }
  }

  // 6. Office hours: running EC2 with a price / 24시간 켜진 EC2 (가격이 있는 것만)
  for (const i of inv.instances) {
    if (str(i.instance_state) !== 'running') continue;
    const region = str(i.region);
    const monthly = priceEc2({
      instanceType: str(i.instance_type), platformDetails: str(i.platform_details), tenancy: str(i.placement_tenancy), region,
    }).monthly;
    if (monthly === null) continue;
    const id = str(i.instance_id);
    add('office-hours', i, id, {
      params: { monthly: round2(monthly), hoursPerWeek: OFFICE_HOURS_PER_WEEK },
      monthlySaving: monthly * (1 - OFFICE_HOURS_PER_WEEK / HOURS_PER_WEEK),
      cliCommand: `# Guide only, no stop command: schedule start/stop with EventBridge Scheduler ${GUIDE_URL}`,
      consoleUrl: `${consoleBase(region)}#InstanceDetails:instanceId=${id}`,
    });
  }

  // 7. gp2 -> gp3 / gp2를 gp3로
  for (const v of inv.volumes) {
    if (str(v.volume_type) !== 'gp2') continue;
    const id = str(v.volume_id), region = str(v.region);
    add('gp2-to-gp3', v, id, {
      params: { sizeGb: num(v.size) },
      monthlySaving: (ebsMonthly(v) ?? 0) * GP3_SAVING_RATE,
      countedInTotal: !coveredVolumes.has(id),
      cliCommand: `aws ec2 modify-volume --volume-id ${id} --volume-type gp3 --region ${region}`,
      consoleUrl: `${consoleBase(region)}#VolumeDetails:volumeId=${id}`,
    });
  }
  return out;
}

/**
 * Per resource id only the larger counted saving stays counted; the rest remain listed with countedInTotal=false.
 * 리소스 ID당 합계에 넣는 것은 큰 절약액 하나뿐, 나머지는 목록에 남기되 합계에서 뺀다.
 */
function dedupe(recs: Recommendation[]): Recommendation[] {
  const winner = new Map<string, Recommendation>();
  for (const r of recs) {
    if (!r.countedInTotal) continue;
    const key = `${r.accountId}:${r.resourceId}`;
    const cur = winner.get(key);
    if (!cur || r.monthlySaving > cur.monthlySaving) winner.set(key, r);
  }
  return recs.map(r => (r.countedInTotal && winner.get(`${r.accountId}:${r.resourceId}`) !== r ? { ...r, countedInTotal: false } : r));
}

export function recommend(inv: RawInventory[], now: Date): Recommendation[] {
  return dedupe(inv.flatMap(i => recommendAccount(i, now)));
}

/**
 * Remaining months = calendar-day difference between KST today and Dec 31 of that year, divided by 30.4.
 * (Today is excluded: 2026-10-24 -> 68 days.) / 남은 일수 = KST 오늘과 12월 31일의 날짜 차이 (오늘 제외).
 */
export function summarizeSavings(recs: Recommendation[], monthlyTotal: number, now: Date): Savings {
  const monthly = round2(recs.filter(r => r.countedInTotal).reduce((s, r) => s + r.monthlySaving, 0));
  const kst = new Date(now.getTime() + KST_OFFSET_MS);
  const days = Math.max(0, utcDay(new Date(Date.UTC(kst.getUTCFullYear(), 11, 31))) - utcDay(kst));
  const months = days / DAYS_PER_MONTH;
  return {
    monthly,
    yearEndCurrent: round2(monthlyTotal * months),
    yearEndAfter: round2(Math.max(0, monthlyTotal - monthly) * months),
  };
}
