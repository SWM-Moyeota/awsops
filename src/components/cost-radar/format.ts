// Cost Radar page helpers — pure functions (money, donut gradient, labels). No React, unit-tested.
// 비용 레이더 화면 헬퍼 — 순수 함수 (금액, 도넛 그라디언트, 라벨). React 없음, 단위 테스트 대상.
import type { CategoryId, CategoryTotal, Recommendation, RuleId } from '@/lib/cost-radar/types';

/** Page-only palette (KA$H style). / 이 페이지 전용 팔레트. */
export const PALETTE = {
  bg: '#0b0b0d',
  card: '#17171a',
  line: '#232327',
  text: '#f4f4f5',
  muted: '#9ca3af',
  lime: '#D6F25C',
  pink: '#F26DB0',
  purple: '#B583F7',
  orange: '#F7A23B',
  sky: '#8EC5FF',
  gray: '#9CA3AF',
  white: '#f4f4f5',
} as const;

/** Fixed colour per category (donut slice + row icon). / 카테고리별 고정 색. */
export const CATEGORY_COLORS: Record<CategoryId, string> = {
  ec2: PALETTE.lime,
  loadbalancer: PALETTE.pink,
  nat: PALETTE.purple,
  'vpc-endpoint': PALETTE.orange,
  'public-ip': PALETTE.sky,
  storage: PALETTE.gray,
  rds: '#5EEAD4',
  elasticache: '#FCA5A5',
};

/** Savings card background rotation (lime / white / purple / pink). / 절약 카드 배경 순환. */
export const CARD_COLORS = [PALETTE.lime, PALETTE.white, PALETTE.purple, PALETTE.pink] as const;

/** Fonts are injected as CSS variables on the page root only. / 글꼴은 페이지 루트의 CSS 변수로만 주입. */
// Weight 800 + no synthesis: Latin stays Archivo Black (its only face, never faux-bolded), Hangul/CJK fallback renders heavy.
// 굵기 800 + 합성 끔: 라틴 문자는 Archivo Black 그대로, 한글·중국어 대체 글꼴은 굵게.
export const DISPLAY_FONT = { fontFamily: 'var(--font-cr-display), system-ui, sans-serif', letterSpacing: '-0.5px', fontWeight: 800, fontSynthesis: 'none' } as const;
export const HAND_FONT = { fontFamily: 'var(--font-cr-hand), cursive' } as const;

const finite = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0);

/** $1,234.56 — never NaN. / 항상 숫자로 표시. */
export function formatMoney(n: number | null | undefined): string {
  const v = finite(n);
  const sign = v < 0 ? '-' : '';
  return `${sign}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Big total: { whole: '$268', cents: '.40' }. / 큰 총액을 정수부·소수부로 분리. */
export function splitMoney(n: number | null | undefined): { whole: string; cents: string } {
  const s = formatMoney(n);
  const dot = s.lastIndexOf('.');
  return { whole: s.slice(0, dot), cents: s.slice(dot) };
}

/** Compact amount for savings cards / year-end: >= $1 rounds to dollars, below shows cents. / 카드용 짧은 금액. */
export function formatShort(n: number | null | undefined): string {
  const v = Math.abs(finite(n));
  if (v === 0) return '$0';
  if (v < 1) return `$${v.toFixed(2)}`;
  return `$${Math.round(v).toLocaleString('en-US')}`;
}

/**
 * CSS conic-gradient from category totals (uses amounts, not rounded percents, so slices always close at 100%).
 * Empty or zero total -> a flat ring colour. / 카테고리 금액으로 conic-gradient 생성 (합계 0이면 단색).
 */
export function donutGradient(categories: Pick<CategoryTotal, 'id' | 'monthly'>[], empty: string = PALETTE.line): string {
  const parts = categories.filter(c => finite(c.monthly) > 0);
  const total = parts.reduce((s, c) => s + c.monthly, 0);
  if (total <= 0) return `conic-gradient(${empty} 0 100%)`;
  let at = 0;
  const stops = parts.map((c, i) => {
    const from = at;
    at = i === parts.length - 1 ? 100 : at + (c.monthly / total) * 100;
    return `${CATEGORY_COLORS[c.id] ?? PALETTE.gray} ${round3(from)}% ${round3(at)}%`;
  });
  return `conic-gradient(${stops.join(', ')})`;
}
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Trend percent label: +12% / -8% / 0%. / 추이 퍼센트 라벨. */
export function trendLabel(changePercent: number): string {
  const v = Math.round(finite(changePercent));
  return `${v > 0 ? '+' : ''}${v}%`;
}

/** Key used for the creators endpoint and the client cache. / creators API·캐시 키. */
export const creatorKey = (r: Pick<Recommendation, 'accountId' | 'region' | 'resourceId'>) => `${r.accountId}:${r.region}:${r.resourceId}`;

/** Short readable resource name: Name tag, then `name` param, then the id (ARN -> last segment). / 표시용 이름. */
export function displayName(r: Pick<Recommendation, 'resourceId' | 'tags' | 'params'>): string {
  const tag = r.tags?.Name;
  if (tag) return tag;
  const p = r.params?.name;
  if (typeof p === 'string' && p) return p;
  return shortId(r.resourceId);
}
export function shortId(id: string): string {
  if (!id.startsWith('arn:')) return id;
  const parts = id.split('/');
  return parts.length >= 2 ? parts[parts.length - 2] : id;
}

/** Definite waste (vs. optimisations: office hours, gp2->gp3). / 확실한 낭비 (최적화 제안과 구분). */
const WASTE_RULES = new Set<RuleId>(['unused-eip', 'unattached-ebs', 'long-stopped-ec2', 'empty-lb', 'empty-tg', 'old-snapshot']);
export const isWasteRule = (rule: RuleId) => WASTE_RULES.has(rule);

/**
 * Cards shown on the page: saving > 0, a note, or an empty target group (0 USD but a cleanup target per spec §5.2).
 * Definite waste first, then optimisations; each group by saving desc.
 * 화면에 보일 카드: 확실한 낭비 먼저, 그다음 최적화 제안 — 각 그룹은 절약액 큰 순.
 */
export function visibleRecommendations(recs: Recommendation[]): Recommendation[] {
  return recs
    .filter(r => r.monthlySaving > 0 || !!r.note || r.rule === 'empty-tg')
    .sort((a, b) =>
      Number(isWasteRule(b.rule)) - Number(isWasteRule(a.rule))
      || b.monthlySaving - a.monthlySaving
      || Number(b.countedInTotal) - Number(a.countedInTotal));
}

/** i18n key for a recommendation note. / 추천 메모의 번역 키. */
export function noteKey(note: Recommendation['note']): string | null {
  if (note === 'maybe-scaled-to-zero') return 'costRadar.note.maybeScaledToZero';
  if (note === 'managed-instance') return 'costRadar.note.managedInstance';
  return null;
}

/** Snapshot rows are priced at the source volume size (upper bound). / 스냅샷은 원본 볼륨 크기 기준 상한값. */
export const hasSnapshots = (resources: { id: string }[]) => resources.some(r => r.id.startsWith('snap-'));

/** Split "a {x} b" into text and placeholder parts for rich rendering. / 템플릿을 텍스트/자리표시자로 분리. */
export function splitTemplate(template: string): ({ text: string } | { key: string })[] {
  const out: ({ text: string } | { key: string })[] = [];
  const re = /\{(\w+)\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template))) {
    if (m.index > last) out.push({ text: template.slice(last, m.index) });
    out.push({ key: m[1] });
    last = m.index + m[0].length;
  }
  if (last < template.length) out.push({ text: template.slice(last) });
  return out;
}

/** Whole minutes since a timestamp (ms), never negative. / 경과 분. */
export const minutesSince = (at: number, now: number) => Math.max(0, Math.floor((now - at) / 60000));

/** Rule params ready for i18n interpolation (money params formatted). / 번역 보간용 파라미터 (금액은 서식 적용). */
export function reasonParams(r: Pick<Recommendation, 'params'>): Record<string, string | number> {
  const out: Record<string, string | number> = { ...r.params };
  if (typeof out.monthly === 'number') out.monthly = formatMoney(out.monthly);
  if (typeof out.since === 'string') out.since = out.since.slice(0, 10);
  return out;
}
