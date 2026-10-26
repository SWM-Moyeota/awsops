// Cost Detective panel — pure Korean copy helpers (headline, cause sentence, signed money). No React, unit-tested.
// Particles (을/를, 이/가) come from the change-timeline helpers so both pages read the same way.
// 돈 탐정 패널 — 순수 문구 함수 (제목 문장, 원인 문장, 부호 붙은 금액). React 없음, 단위 테스트 대상.
import type { CategoryId, CauseKind, ExplainCause, ExplainDays, ExplainResponse } from '@/lib/cost-radar/types';
import { kstDate, withObject, withSubject } from '@/components/changes/format';

type Action = NonNullable<ExplainCause['action']>;

/** Korean label per cost-radar category (resourceTypeLabel style). / 카테고리별 한국어 이름. */
const CATEGORY_LABELS: Record<CategoryId, string> = {
  ec2: 'EC2 서버',
  loadbalancer: '로드밸런서',
  nat: 'NAT 게이트웨이',
  'vpc-endpoint': 'VPC 엔드포인트',
  'public-ip': '탄력적 IP',
  storage: 'EBS',
  rds: 'RDS',
  elasticache: 'ElastiCache',
};

/** Category label; storage rows that are snapshots read "EBS 스냅샷". / 스토리지 중 스냅샷은 "EBS 스냅샷". */
export function categoryLabel(category: CategoryId, resourceId: string): string {
  if (category === 'storage' && resourceId.startsWith('snap-')) return 'EBS 스냅샷';
  return CATEGORY_LABELS[category] ?? category;
}

const UNKNOWN = '금액 알 수 없음';
const MINUS = '−'; // typographic minus / 수학 기호 마이너스

/** "+$38.00" / "−$12.40" / "$0.00" / "금액 알 수 없음". `signed` adds "+" to increases. / 증가에 + 부호. */
export function money(n: number | null, signed: boolean): string {
  if (n === null || typeof n !== 'number' || !Number.isFinite(n)) return UNKNOWN;
  const cents = Math.round(n * 100);
  const abs = (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = cents < 0 ? MINUS : cents > 0 && signed ? '+' : '';
  return `${sign}$${abs}`;
}

const SINCE: Record<ExplainDays, string> = { 1: '어제보다', 7: '지난 7일 동안', 30: '지난 30일 동안' };
const DURING: Record<ExplainDays, string> = { 1: '지난 하루 동안', 7: '지난 7일 동안', 30: '지난 30일 동안' };

/** Panel headline. Changes under $1 (either way) read as "no real change". / $1 미만 변화는 "거의 변화가 없어요". */
export function headline(r: ExplainResponse): string {
  if (r.mode === 'timeline-only' || r.delta === null || !Number.isFinite(r.delta)) {
    return `${DURING[r.days] ?? DURING[7]} 생기거나 바뀐 리소스예요`;
  }
  const since = SINCE[r.days] ?? SINCE[7];
  if (Math.abs(r.delta) < 1) return `${since} 월 예상 비용에 거의 변화가 없어요`;
  return `${since} 월 예상 비용이 ${money(Math.abs(r.delta), false)} ${r.delta > 0 ? '늘었어요' : '줄었어요'}`;
}

const KIND_ACTION: Record<CauseKind, Action> = { added: 'create', removed: 'delete', changed: 'modify' };

/** "jiwoo님이 RDS moyeota-test-db를 만들었어요" / "RDS x가 새로 생겼어요 · 누가 했는지 기록 없음". */
export function causeSentence(c: ExplainCause): string {
  const what = `${categoryLabel(c.category, c.resourceId)} ${c.name || c.resourceId}`;
  if (!c.actor) {
    const happened = c.kind === 'added'
      ? `${withSubject(what)} 새로 생겼어요`
      : c.kind === 'removed'
      ? `${withSubject(what)} 사라졌어요`
      : `${what}의 금액이 바뀌었어요`;
    return `${happened} · 누가 했는지 기록 없음`;
  }
  const action = c.action ?? KIND_ACTION[c.kind];
  const did = action === 'modify'
    ? `${what}의 설정을 바꿨어요`
    : `${withObject(what)} ${action === 'delete' ? '지웠어요' : action === 'stop' ? '껐어요' : action === 'start' ? '켰어요' : '만들었어요'}`;
  const who = c.actor.kind === 'person' ? `${c.actor.name}님이` : withSubject(c.actor.name);
  return `${who} ${did}`;
}

/** Cause row date "10월 25일" in KST (year added when not this year). / 원인 행 날짜 (KST). */
export function causeDate(iso: string | undefined, now: Date = new Date()): string {
  return iso ? kstDate(iso, now) : '';
}
