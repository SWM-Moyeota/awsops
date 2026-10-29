// Pure helpers for /terraform-export: stage/outcome/reason labels, percents, seeds, file names, account choice.
// Terraform 코드 변환 화면의 순수 함수 — 단계·결과·제외 이유 문구, 비율, 씨앗 만들기, 파일 이름, 계정 고르기.
import type { ExcludeReason, ExportSeed, ItemOutcome, ItemResult, JobStats, Stage, TfType } from '@/lib/tf-export/types';

export type T = (key: string, params?: Record<string, string | number>) => string;

// Stages shown in the stepper, in order / 진행 표시에 쓰는 단계(순서대로)
export const STEPS: Stage[] = ['prepare', 'generate', 'rules', 'ai-fix', 'diff', 'refactor', 'verify', 'package'];
export const MAX_ARNS = 60;
export const POLL_MS = 3_000;
const ALL_ACCOUNTS = '__all__';

// i18n key segment per stage ('ai-fix' → 'aiFix') / 단계별 i18n 키 조각
function stageKey(stage: string): string {
  return stage === 'ai-fix' ? 'aiFix' : stage;
}

/** Korean (or en/zh) name of a stage; unknown stages fall back to the raw value. / 단계 이름. */
export function stageLabel(stage: Stage | string, t: T): string {
  const key = `tfExport.stage.${stageKey(stage)}`;
  const text = t(key);
  return text === key ? stage : text;
}

/** The job has stopped (no more polling). / 작업이 멈췄는지(더 확인하지 않음). */
export function isSettled(stage: Stage | string | undefined): boolean {
  return stage === 'done' || stage === 'failed';
}

export type StepState = 'done' | 'current' | 'todo' | 'failed';

/**
 * State of each stepper step. `lastStage` is the last running stage this screen saw; a failed job marks it red.
 * 단계별 표시 상태 — lastStage는 이 화면이 마지막으로 본 진행 단계이고, 실패한 작업은 그 단계를 빨간색으로 표시한다.
 */
export function stepStates(stage: Stage | string, lastStage?: Stage | string | null): StepState[] {
  if (stage === 'done') return STEPS.map(() => 'done');
  if (stage === 'failed') {
    const at = lastStage ? STEPS.indexOf(lastStage as Stage) : -1;
    return STEPS.map((_, i) => (at < 0 ? 'todo' : i < at ? 'done' : i === at ? 'failed' : 'todo'));
  }
  const at = STEPS.indexOf(stage as Stage);
  return STEPS.map((_, i) => (at < 0 ? 'todo' : i < at ? 'done' : i === at ? 'current' : 'todo'));
}

/** "✅ diff 0" / "🟡 ignore 사용" / "❌ 실패". / 결과 문구. */
export function outcomeLabel(outcome: ItemOutcome, t: T): string {
  return t(`tfExport.outcome.${outcome === 'pass-ignore' ? 'passIgnore' : outcome}`);
}

/** Accent color name of an outcome (StatsCard-style names). / 결과의 강조색 이름. */
export function outcomeColor(outcome: ItemOutcome): 'green' | 'orange' | 'red' {
  return outcome === 'pass' ? 'green' : outcome === 'pass-ignore' ? 'orange' : 'red';
}

/** Which stage a resource passed at. / 어느 단계에서 통과했는지. */
export function passedAtLabel(p: ItemResult['passedAt'], t: T): string {
  return p ? t(`tfExport.passedAt.${p}`) : '—';
}

/** Why a resource was left out. / 제외된 이유. */
export function excludeReasonLabel(reason: ExcludeReason | string, t: T): string {
  const map: Record<string, string> = {
    'attached-to-instance': 'attachedToInstance', unsupported: 'unsupported', 'over-limit': 'overLimit',
    'other-region': 'otherRegion', shared: 'shared', managed: 'managed', 'service-role': 'serviceRole',
  };
  return map[reason] ? t(`tfExport.reason.${map[reason]}`) : reason;
}

/** Whole percent ("93%"); "—" when there is nothing to count. / 정수 퍼센트, 셀 것이 없으면 "—". */
export function percent(n: number, total: number): string {
  if (!Number.isFinite(n) || !Number.isFinite(total) || total <= 0) return '—';
  const p = Math.round((Math.min(Math.max(n, 0), total) / total) * 100);
  return `${p}%`;
}

/** Pass rates after rules, after AI and final. / 규칙만·AI 후·최종 통과율. */
export function passRates(s: Pick<JobStats, 'total' | 'passRules' | 'passAi' | 'passFinal'>): { rules: string; ai: string; final: string } {
  return { rules: percent(s.passRules, s.total), ai: percent(s.passAi, s.total), final: percent(s.passFinal, s.total) };
}

/** Per-type pass rows, most resources first. / 종류별 통과 줄(많은 순). */
export function byTypeRows(byType: JobStats['byType'] | undefined): Array<{ tfType: TfType; total: number; pass: number; rate: string }> {
  return Object.entries(byType ?? {})
    .map(([tfType, v]) => ({ tfType: tfType as TfType, total: v?.total ?? 0, pass: v?.pass ?? 0, rate: percent(v?.pass ?? 0, v?.total ?? 0) }))
    .sort((a, b) => b.total - a.total || a.tfType.localeCompare(b.tfType));
}

export type SeedKind = ExportSeed['kind'];
export interface SeedForm { kind: SeedKind; tagKey: string; tagValue: string; prefix: string; vpcArn: string; arns: string[] }

/**
 * Seed from the form, or null when it is not ready (same limits as the API: tag 1–128, prefix 1–64, vpc `arn:aws:ec2:`, 1–60 ARNs).
 * 입력으로 씨앗을 만든다 — 덜 채웠으면 null (API와 같은 제한).
 */
export function buildSeed(f: SeedForm): ExportSeed | null {
  if (f.kind === 'tag') {
    const key = f.tagKey.trim(); const value = f.tagValue.trim();
    return key && value && key.length <= 128 && value.length <= 128 ? { kind: 'tag', key, value } : null;
  }
  if (f.kind === 'prefix') {
    const prefix = f.prefix.trim();
    return prefix && prefix.length <= 64 ? { kind: 'prefix', prefix } : null;
  }
  if (f.kind === 'vpc') {
    const arn = f.vpcArn.trim();
    return arn.startsWith('arn:aws:ec2:') && arn.length <= 2048 ? { kind: 'vpc', arn } : null;
  }
  const arns = Array.from(new Set(f.arns.map((a) => a.trim()).filter((a) => a.startsWith('arn:') && a.length <= 2048)));
  return arns.length > 0 && arns.length <= MAX_ARNS ? { kind: 'arns', arns } : null;
}

/** Add an ARN once, never past 60. / ARN을 한 번만, 60개까지 더한다. */
export function addArn(list: string[], arn: string, max = MAX_ARNS): string[] {
  if (!arn || list.includes(arn) || list.length >= max) return list;
  return [...list, arn];
}

/** Stable text key of a seed (to tell if a preview still matches the form). / 씨앗의 고정 문자열 키. */
export function seedKey(seed: ExportSeed | null): string {
  if (!seed) return '';
  if (seed.kind === 'arns') return `arns:${[...seed.arns].sort().join(',')}`;
  if (seed.kind === 'tag') return `tag:${seed.key}=${seed.value}`;
  if (seed.kind === 'prefix') return `prefix:${seed.prefix}`;
  return `vpc:${seed.arn}`;
}

/** Short description of a seed for the job list. / 지난 작업 목록에 쓰는 씨앗 설명. */
export function seedLabel(seed: ExportSeed | undefined, t: T): string {
  if (!seed) return '—';
  if (seed.kind === 'tag') return t('tfExport.seedLabel.tag', { key: seed.key, value: seed.value });
  if (seed.kind === 'prefix') return t('tfExport.seedLabel.prefix', { prefix: seed.prefix });
  if (seed.kind === 'vpc') return t('tfExport.seedLabel.vpc', { id: arnTail(seed.arn) });
  return t('tfExport.seedLabel.arns', { count: seed.arns.length });
}

/** Last segment of an ARN (after "/" or ":"). / ARN의 마지막 조각. */
export function arnTail(arn: string): string {
  const slash = arn.lastIndexOf('/');
  if (slash >= 0) return arn.slice(slash + 1);
  const colon = arn.lastIndexOf(':');
  return colon >= 0 ? arn.slice(colon + 1) : arn;
}

/** Text files the viewer can show (binary zips are left out). / 화면에서 볼 수 있는 텍스트 파일(zip은 뺀다). */
export function viewableFiles(files: string[] | undefined): string[] {
  return (files ?? []).filter((f) => !/\.zip$/i.test(f));
}

/** The bundle has secret variables to fill (CHANGE_ME). / 채워야 할 비밀 변수가 있는지. */
export function hasSecretVars(files: string[] | undefined): boolean {
  return (files ?? []).includes('terraform.tfvars.example');
}

export function fileUrl(id: string, name: string): string {
  return `/api/terraform-export?${new URLSearchParams({ op: 'file', id, name })}`;
}
export function downloadUrl(id: string): string {
  return `/api/terraform-export?${new URLSearchParams({ op: 'download', id })}`;
}

/**
 * The one account a job runs on: the selected account, or the only configured one under "all accounts"; otherwise null.
 * 작업할 계정 하나 — 고른 계정, "전체 계정"이면 계정이 하나뿐일 때만 그 계정, 아니면 null.
 */
export function effectiveAccount(currentAccountId: string, accounts: Array<{ accountId: string }>): string | null {
  if (currentAccountId && currentAccountId !== ALL_ACCOUNTS) return currentAccountId;
  return accounts.length === 1 ? accounts[0].accountId : null;
}

/** Split text on `backticks` into plain and code parts. / 백틱으로 감싼 부분을 코드 조각으로 나눈다. */
export function splitCode(text: string): Array<{ code: boolean; text: string }> {
  return text.split('`').map((part, i) => ({ code: i % 2 === 1, text: part })).filter((p) => p.text !== '');
}

/** Local "MM-DD HH:mm" for a timestamp; "" when invalid. / 로컬 "MM-DD HH:mm", 잘못된 값이면 "". */
export function localDateTime(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Elapsed "M분 S초" between two times (end defaults to now). / 걸린 시간. */
export function elapsed(startIso: string, endIso: string | undefined, t: T, now = Date.now()): string {
  const s = Date.parse(startIso);
  const e = endIso ? Date.parse(endIso) : now;
  if (!Number.isFinite(s) || !Number.isFinite(e)) return '';
  const sec = Math.max(0, Math.round((e - s) / 1000));
  const m = Math.floor(sec / 60);
  return m > 0 ? t('tfExport.elapsedMin', { m, s: sec % 60 }) : t('tfExport.elapsedSec', { s: sec });
}

/** Friendly resource kind (graph kinds reuse depGraph.type.*, listeners have their own). / 리소스 종류 이름. */
export function typeLabel(nodeType: string, t: T): string {
  const key = nodeType === 'listener' ? 'tfExport.type.listener' : `depGraph.type.${nodeType}`;
  const text = t(key);
  return text === key ? nodeType : text;
}
