import { describe, it, expect } from 'vitest';
import { headline, causeSentence, money, causeDate, categoryLabel } from '../explain-format';
import type { ExplainCause, ExplainResponse } from '@/lib/cost-radar/types';

const resp = (over: Partial<ExplainResponse>): ExplainResponse => ({
  mode: 'snapshot', days: 7, fromDay: '2026-10-20', accountId: '__all__',
  baseMonthly: 100, currentMonthly: 145, delta: 45, causes: [], unexplained: 0, notes: [], ...over,
});

const cause = (over: Partial<ExplainCause>): ExplainCause => ({
  kind: 'added', accountId: '111111111111', resourceId: 'db-1', name: 'moyeota-test-db', category: 'rds',
  monthlyBefore: null, monthlyAfter: 38, impact: 38, ...over,
});

describe('headline', () => {
  it('headlineUpDownFlatTimeline', () => {
    expect(headline(resp({ days: 1, delta: 45 }))).toBe('어제보다 월 예상 비용이 $45.00 늘었어요');
    expect(headline(resp({ days: 7, delta: 45 }))).toBe('지난 7일 동안 월 예상 비용이 $45.00 늘었어요');
    expect(headline(resp({ days: 30, delta: -12.4 }))).toBe('지난 30일 동안 월 예상 비용이 $12.40 줄었어요');
    expect(headline(resp({ days: 7, delta: 1234.5 }))).toBe('지난 7일 동안 월 예상 비용이 $1,234.50 늘었어요');
    // |delta| < 1 is flat, on both sides / ±$1 미만은 변화 없음
    expect(headline(resp({ days: 7, delta: 0.99 }))).toBe('지난 7일 동안 월 예상 비용에 거의 변화가 없어요');
    expect(headline(resp({ days: 1, delta: -0.5 }))).toBe('어제보다 월 예상 비용에 거의 변화가 없어요');
    expect(headline(resp({ days: 7, delta: 1 }))).toBe('지난 7일 동안 월 예상 비용이 $1.00 늘었어요');
    // timeline mode / 기록 기반 모드
    expect(headline(resp({ mode: 'timeline-only', days: 7, baseMonthly: null, delta: null }))).toBe('지난 7일 동안 생기거나 바뀐 리소스예요');
    expect(headline(resp({ mode: 'timeline-only', days: 30, baseMonthly: null, delta: null }))).toBe('지난 30일 동안 생기거나 바뀐 리소스예요');
    expect(headline(resp({ mode: 'timeline-only', days: 1, baseMonthly: null, delta: null }))).toBe('지난 하루 동안 생기거나 바뀐 리소스예요');
  });
});

describe('causeSentence', () => {
  it('causeSentenceWithAndWithoutActor', () => {
    expect(causeSentence(cause({ action: 'create', actor: { kind: 'person', name: 'jiwoo' } })))
      .toBe('jiwoo님이 RDS moyeota-test-db를 만들었어요');
    expect(causeSentence(cause({
      kind: 'removed', category: 'ec2', name: 'web-1', action: 'delete', actor: { kind: 'person', name: 'sungyoon' },
      monthlyBefore: 30, monthlyAfter: 0, impact: -30,
    }))).toBe('sungyoon님이 EC2 서버 web-1을 지웠어요');
    // non-person actors take 이/가 / 사람이 아니면 이/가
    expect(causeSentence(cause({ category: 'ec2', name: 'node-a', action: 'create', actor: { kind: 'auto', name: 'Auto Scaling' } })))
      .toBe('Auto Scaling이 EC2 서버 node-a를 만들었어요');
    expect(causeSentence(cause({ category: 'storage', name: 'vol-9', action: 'create', actor: { kind: 'awsops', name: 'AWSops' } })))
      .toBe('AWSops가 EBS vol-9를 만들었어요');
    // actor without action falls back to the cause kind / action이 없으면 kind로 동사 결정
    expect(causeSentence(cause({ kind: 'removed', name: 'old-db', actor: { kind: 'person', name: 'jiwoo' } })))
      .toBe('jiwoo님이 RDS old-db를 지웠어요');
    // no actor: never invent one / 사람 없음: 지어내지 않는다
    expect(causeSentence(cause({ name: 'moyeota-test-db' })))
      .toBe('RDS moyeota-test-db가 새로 생겼어요 · 누가 했는지 기록 없음');
    expect(causeSentence(cause({ kind: 'removed', category: 'nat', name: 'nat-main', impact: null })))
      .toBe('NAT 게이트웨이 nat-main이 사라졌어요 · 누가 했는지 기록 없음');
    expect(causeSentence(cause({ kind: 'changed', category: 'ec2', name: 'api-server', impact: 20 })))
      .toBe('EC2 서버 api-server의 금액이 바뀌었어요 · 누가 했는지 기록 없음');
    // empty name falls back to the id / 이름이 비면 id
    expect(causeSentence(cause({ name: '', resourceId: 'i-0abc' }))).toBe('RDS i-0abc가 새로 생겼어요 · 누가 했는지 기록 없음');
  });

  it('causeSentenceStateVerbs', () => {
    const p = { kind: 'person' as const, name: 'jiwoo' };
    expect(causeSentence(cause({ kind: 'removed', category: 'ec2', name: 'k8s-practice', action: 'stop', actor: p })))
      .toBe('jiwoo님이 EC2 서버 k8s-practice를 껐어요');
    expect(causeSentence(cause({ kind: 'added', category: 'ec2', name: 'k8s-practice', action: 'start', actor: p })))
      .toBe('jiwoo님이 EC2 서버 k8s-practice를 켰어요');
    expect(causeSentence(cause({ kind: 'changed', category: 'rds', name: 'main-db', action: 'modify', actor: p })))
      .toBe('jiwoo님이 RDS main-db의 설정을 바꿨어요');
    expect(causeSentence(cause({ kind: 'changed', category: 'storage', name: 'data', action: 'modify', actor: { kind: 'root', name: 'root' } })))
      .toBe('root가 EBS data의 설정을 바꿨어요');
  });
});

describe('labels and dates', () => {
  it('maps every category to a Korean label', () => {
    expect(categoryLabel('ec2', 'i-1')).toBe('EC2 서버');
    expect(categoryLabel('rds', 'db')).toBe('RDS');
    expect(categoryLabel('storage', 'vol-1')).toBe('EBS');
    expect(categoryLabel('storage', 'snap-1')).toBe('EBS 스냅샷');
    expect(categoryLabel('loadbalancer', 'x')).toBe('로드밸런서');
    expect(categoryLabel('nat', 'x')).toBe('NAT 게이트웨이');
    expect(categoryLabel('vpc-endpoint', 'x')).toBe('VPC 엔드포인트');
    expect(categoryLabel('public-ip', 'x')).toBe('탄력적 IP');
    expect(categoryLabel('elasticache', 'x')).toBe('ElastiCache');
  });
  it('formats the cause date as a KST month/day', () => {
    const now = new Date('2026-10-27T03:00:00Z');
    expect(causeDate('2026-10-25T05:00:00Z', now)).toBe('10월 25일');
    expect(causeDate('2026-10-25T16:00:00Z', now)).toBe('10월 26일'); // 01:00 KST next day
    expect(causeDate(undefined, now)).toBe('');
    expect(causeDate('nope', now)).toBe('');
  });
});

describe('money', () => {
  it('moneySignsAndUnknown', () => {
    expect(money(38, true)).toBe('+$38.00');
    expect(money(-12.4, true)).toBe('−$12.40');
    expect(money(1234.567, true)).toBe('+$1,234.57');
    expect(money(38, false)).toBe('$38.00');
    expect(money(-12.4, false)).toBe('−$12.40');
    expect(money(0, true)).toBe('$0.00');
    expect(money(-0.004, true)).toBe('$0.00'); // rounds to cents before the sign / 센트 반올림 후 부호
    expect(money(null, true)).toBe('금액 알 수 없음');
    expect(money(null, false)).toBe('금액 알 수 없음');
    expect(money(NaN, true)).toBe('금액 알 수 없음');
  });
});
