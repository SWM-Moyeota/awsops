// Small helpers shared by the extractors.
// 추출기들이 같이 쓰는 작은 도우미.
import type { Row } from '../types';
import { str } from '../nodes';

export const acct = (r: Row): string => str(r.account_id) ?? '';
export const field = (o: unknown, k: string): string | undefined =>
  o && typeof o === 'object' ? str((o as Record<string, unknown>)[k]) : undefined;
/** Rows of one query, objects only. / 한 쿼리의 행 중 객체만. */
export const listRows = (rows: Record<string, unknown>, q: string): Row[] =>
  Array.isArray(rows[q]) ? (rows[q] as Row[]).filter(r => r && typeof r === 'object') : [];
