// Change timeline — pure display helpers (Korean Toss-style copy, KST times, console links).
// Shared by the /changes page, the "만든 사람" lines on resource lists and Slack.
// 변경 기록 표시용 순수 함수 (토스 스타일 문장, KST 시각, 콘솔 링크). 페이지·리소스 목록·Slack이 같이 쓴다.
import type { ChangeRecord, ChangesResponse, RangeId, ResourceType, ToolId } from '@/lib/change-timeline/types';

const TYPE_LABELS: Record<ResourceType, string> = {
  's3-bucket': 'S3 버킷',
  'ec2-instance': 'EC2 서버',
  'ebs-volume': 'EBS 볼륨',
  'ebs-snapshot': 'EBS 스냅샷',
  'security-group': '보안그룹',
  'elastic-ip': '탄력적 IP',
  'nat-gateway': 'NAT 게이트웨이',
  'vpc': 'VPC',
  'subnet': '서브넷',
  'load-balancer': '로드밸런서',
  'target-group': '타겟그룹',
  'rds-instance': 'RDS 데이터베이스',
  'rds-cluster': 'RDS 클러스터',
  'elasticache-cluster': 'ElastiCache 클러스터',
  'elasticache-replication-group': 'ElastiCache 복제 그룹',
  'elasticache-serverless': 'ElastiCache 서버리스',
  'lambda-function': 'Lambda 함수',
  'ecr-repository': 'ECR 저장소',
  'ecs-cluster': 'ECS 클러스터',
  'ecs-service': 'ECS 서비스',
  'eks-cluster': 'EKS 클러스터',
  'dynamodb-table': 'DynamoDB 테이블',
  'iam-user': 'IAM 사용자',
  'iam-role': 'IAM 역할',
};

export function resourceTypeLabel(t: ResourceType): string {
  return TYPE_LABELS[t] ?? t;
}

export function resourceEmoji(t: ResourceType): string {
  if (t === 's3-bucket') return '🪣';
  if (t === 'ec2-instance') return '🖥️';
  if (t === 'ebs-volume' || t === 'ebs-snapshot') return '💽';
  if (t === 'security-group') return '🛡️';
  if (t.startsWith('rds-') || t.startsWith('elasticache-') || t === 'dynamodb-table') return '🗄️';
  if (t === 'lambda-function') return '⚡';
  if (t.startsWith('ecr-') || t.startsWith('ecs-') || t.startsWith('eks-')) return '📦';
  if (t.startsWith('iam-')) return '👤';
  return '🌐'; // elastic-ip, nat-gateway, vpc, subnet, load-balancer, target-group
}

const TOOL_LABELS: Record<ToolId, string> = {
  console: '콘솔',
  cli: 'CLI',
  terraform: 'Terraform',
  sdk: 'SDK',
  cloudformation: 'CloudFormation',
  autoscaling: 'Auto Scaling',
  other: '기타',
};

/** Tool label; a service acting for a person reads "{via} 통해". / 도구 이름, 서비스가 대신 했으면 "{via} 통해". */
export function toolLabel(tool: ToolId, via?: string): string {
  const base = TOOL_LABELS[tool] ?? TOOL_LABELS.other;
  return via && via !== base ? `${via} 통해` : base;
}

// ---------- Korean particles (받침) ----------

const DIGIT_BATCHIM = new Set(['0', '1', '3', '6', '7', '8']); // 영 일 삼 육 칠 팔
const LETTER_NAME_BATCHIM = new Set(['L', 'M', 'N', 'R']); // 엘 엠 엔 알

/** Whether the word, as read aloud in Korean, ends in a final consonant. / 한국어로 읽었을 때 받침으로 끝나는지. */
export function hasBatchim(word: string): boolean {
  let w = word.trim();
  // Ignore trailing "(…)" and symbols/emoji: "CloudFormation (CDK)" is read by "CloudFormation".
  for (let prev = ''; prev !== w;) { prev = w; w = w.replace(/\s*\([^()]*\)\s*$/, '').replace(/[^0-9A-Za-z가-힣]+$/, ''); }
  if (!w) return false;
  const last = w[w.length - 1];
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;
  if (/[0-9]/.test(last)) return DIGIT_BATCHIM.has(last);
  const run = (w.match(/[A-Za-z]+$/) ?? [''])[0];
  if (run.length > 0 && run === run.toUpperCase()) return LETTER_NAME_BATCHIM.has(last); // acronym: EKS 이케이에스
  return /(?:[lmn]|ng)$/i.test(run);
}

export const withObject = (w: string): string => `${w}${hasBatchim(w) ? '을' : '를'}`;
export const withSubject = (w: string): string => `${w}${hasBatchim(w) ? '이' : '가'}`;

// ---------- sentences ----------

/** "**sungyoon**님이 S3 버킷을 만들었어요" split into the bold name and the rest. / 굵은 이름과 나머지로 나눈 문장. */
export function sentence(r: ChangeRecord): { who: string; rest: string } {
  const label = resourceTypeLabel(r.resourceType);
  const what = r.kind === 'modify' ? `${label}의 설정을 바꿨어요`
    : `${withObject(label)} ${r.kind === 'delete' ? '지웠어요' : r.kind === 'stop' ? '껐어요' : r.kind === 'start' ? '켰어요' : '만들었어요'}`;
  const who = r.actor.name;
  if (r.actor.kind === 'person') return { who, rest: `님이 ${what}` };
  const subject = withSubject(who).slice(who.length);
  return { who, rest: `${subject} ${what}${r.actor.kind === 'root' ? ' ⚠️' : ''}` };
}

const RANGE_WORDS: Record<RangeId, string> = {
  '24h': '오늘', '7d': '이번 주에', '30d': '이번 달에', '90d': '최근 90일 동안', all: '지금까지',
};

export function summarySentence(s: ChangesResponse['summary'], range: RangeId): string {
  const when = RANGE_WORDS[range] ?? RANGE_WORDS['7d'];
  if (s.creates > 0 && s.deletes > 0) return `${when} ${s.creates}개가 생기고 ${s.deletes}개가 사라졌어요`;
  if (s.creates > 0) return `${when} ${s.creates}개가 생겼어요`;
  if (s.deletes > 0) return `${when} ${s.deletes}개가 사라졌어요`;
  return `${when} 생기거나 사라진 리소스가 없어요`;
}

// ---------- KST time ----------

const KST_MS = 9 * 3_600_000;

/** Calendar parts in KST (UTC+9, no DST). / KST 기준 날짜 조각. */
function kstParts(d: Date) {
  const k = new Date(d.getTime() + KST_MS);
  return { y: k.getUTCFullYear(), m: k.getUTCMonth() + 1, d: k.getUTCDate(), h: k.getUTCHours(), min: k.getUTCMinutes() };
}
const parse = (iso: string): Date | null => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** "오후 2:02" */
export function kstTime(iso: string): string {
  const d = parse(iso);
  if (!d) return '';
  const { h, min } = kstParts(d);
  return `${h < 12 ? '오전' : '오후'} ${h % 12 === 0 ? 12 : h % 12}:${String(min).padStart(2, '0')}`;
}

/** "2026년 10월 26일 오후 2:02" */
export function kstDateTime(iso: string): string {
  const d = parse(iso);
  if (!d) return '';
  const p = kstParts(d);
  return `${p.y}년 ${p.m}월 ${p.d}일 ${kstTime(iso)}`;
}

/** "10월 26일" (with the year when it is not this year). / 올해가 아니면 연도를 붙인다. */
export function kstDate(iso: string, now: Date = new Date()): string {
  const d = parse(iso);
  if (!d) return '';
  const p = kstParts(d);
  return p.y === kstParts(now).y ? `${p.m}월 ${p.d}일` : `${p.y}년 ${p.m}월 ${p.d}일`;
}

const kstDayNumber = (d: Date): number => Math.floor((d.getTime() + KST_MS) / 86_400_000);

/** "오늘 · 10월 26일" / "어제 · 10월 25일" / "10월 24일" */
export function kstDayLabel(iso: string, now: Date): string {
  const d = parse(iso);
  if (!d) return '';
  const diff = kstDayNumber(now) - kstDayNumber(d);
  const date = kstDate(iso, now);
  if (diff === 0) return `오늘 · ${date}`;
  if (diff === 1) return `어제 · ${date}`;
  return date;
}

/** Group records (already newest first) by KST day. / 최신순 기록을 KST 날짜별로 묶는다. */
export function groupByKstDay(records: ChangeRecord[], now: Date = new Date()): Array<{ label: string; records: ChangeRecord[] }> {
  const groups: Array<{ key: number; label: string; records: ChangeRecord[] }> = [];
  for (const r of records) {
    const d = parse(r.time);
    const key = d ? kstDayNumber(d) : Number.NaN;
    const last = groups[groups.length - 1];
    if (last && (last.key === key || (Number.isNaN(last.key) && Number.isNaN(key)))) last.records.push(r);
    else groups.push({ key, label: kstDayLabel(r.time, now), records: [r] });
  }
  return groups.map(({ label, records: rs }) => ({ label, records: rs }));
}

// ---------- AWS console ----------

/** Console deep link for s3/ec2/rds/security-group/lambda, else null. / 지원 종류만 콘솔 링크. */
export function consoleUrl(r: Pick<ChangeRecord, 'resourceType' | 'resourceId' | 'region'>): string | null {
  const id = encodeURIComponent(r.resourceId);
  const region = r.region || 'ap-northeast-2';
  const base = `https://${region}.console.aws.amazon.com`;
  switch (r.resourceType) {
    case 's3-bucket': return `https://s3.console.aws.amazon.com/s3/buckets/${id}`;
    case 'ec2-instance': return r.resourceId.startsWith('i-') ? `${base}/ec2/home?region=${region}#InstanceDetails:instanceId=${id}` : null;
    case 'security-group': return r.resourceId.startsWith('sg-') ? `${base}/ec2/home?region=${region}#SecurityGroup:groupId=${id}` : null;
    case 'rds-instance': return `${base}/rds/home?region=${region}#database:id=${id}`;
    case 'lambda-function': return `${base}/lambda/home?region=${region}#/functions/${id}`;
    default: return null;
  }
}
