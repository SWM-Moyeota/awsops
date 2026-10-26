// "만든 사람" 문구 — 배지와 테스트가 함께 쓰는 순수 함수.
import type { CreatorLookup, ToolId } from '@/lib/change-timeline/types';

// TODO(integration): replace with toolLabel from ./format
export function toolLabel(tool: ToolId, via?: string): string {
  const names: Record<ToolId, string> = {
    console: '콘솔', cli: 'CLI', terraform: 'Terraform', sdk: 'SDK',
    cloudformation: 'CloudFormation', autoscaling: 'Auto Scaling', other: '기타',
  };
  const base = names[tool];
  if (via && via.replace(/\s/g, '').toLowerCase() !== base.replace(/\s/g, '').toLowerCase()) return `${via} 통해`;
  return base;
}

export function monthDay(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

export function creatorSubject(l: CreatorLookup): string {
  const name = l.actor?.name ?? '';
  const person = l.actor?.kind === 'person' || l.actor?.kind === 'root';
  return `${name}${person ? '님이' : '이(가)'}`;
}

export function creatorDetail(l: CreatorLookup): string {
  const parts = [monthDay(l.time), l.tool ? toolLabel(l.tool, l.via) : ''].filter(Boolean);
  if (l.deletedAt) parts.push(`${monthDay(l.deletedAt)} 삭제됨`);
  return parts.join(' · ');
}

export function creatorText(l?: CreatorLookup): string {
  if (!l) return '';
  if (l.status === 'too-old') return '90일보다 오래돼서 기록이 없어요';
  if (l.status === 'none' || !l.actor) return '기록 없음';
  const detail = creatorDetail(l);
  return `${creatorSubject(l)} 만들었어요${detail ? ` · ${detail}` : ''}`;
}

// Safe ISO conversion for list timestamps; undefined when unparseable.
export function toIsoOrUndefined(v: unknown): string | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

// `${accountId}:${resourceId}` plus optional `|iso`; null when id parts are missing.
export function creatorKey(accountId: unknown, resourceId: unknown, createdAt?: unknown): string | null {
  if (!accountId || !resourceId) return null;
  const iso = toIsoOrUndefined(createdAt);
  return `${accountId}:${resourceId}${iso ? `|${iso}` : ''}`;
}
