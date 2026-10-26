// Change timeline query layer: filtered list, creator lookup, text search.
// 변경 기록 조회: 필터 목록, 생성자 조회, 텍스트 검색.
import { eventNamesFor } from './catalog';
import { readRecords, readState } from './store';
import type {
  AccountRegionState, ChangeRecord, ChangesQuery, ChangesResponse, CreatorLookup, IngestState, RangeId, TrackedRegion,
} from './types';

const MAX_RECORDS = 500;
const MAX_SEARCH = 20;
const HOURS: Record<Exclude<RangeId, 'all'>, number> = { '24h': 24, '7d': 168, '30d': 720, '90d': 2160 };

export interface QueryDeps {
  read?: typeof readRecords;
  state?: typeof readState;
  /** Tracked event names for a region; defaults to the catalog. / 리전별 추적 이벤트 이름 (기본값은 catalog). */
  namesFor?: (region: string) => string[];
}

export function rangeStart(range: RangeId, now: Date): Date {
  return range === 'all' ? new Date(0) : new Date(now.getTime() - HOURS[range] * 3_600_000);
}

/** Backfill is done once every tracked name is done; with no names, once a run has reached lastTo. */
export function isBackfillComplete(state: AccountRegionState, names: string[]): boolean {
  if (names.length === 0) return !!state.lastTo;
  return names.every((n) => state.backfillDone.includes(n));
}

const byTimeDesc = (a: ChangeRecord, b: ChangeRecord) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0);

export async function queryChanges(q: ChangesQuery, deps: QueryDeps = {}): Promise<ChangesResponse> {
  const read = deps.read ?? readRecords;
  const getState = deps.state ?? readState;
  const namesFor = deps.namesFor ?? ((region: string) => eventNamesFor(region as TrackedRegion));
  const now = q.now ?? new Date();
  const all = q.accountId === '__all__';

  const scoped = (await read(rangeStart(q.range, now), now))
    .filter((r) => !r.failed && (all || r.accountId === q.accountId) && (!q.kind || r.kind === q.kind));
  const isPerson = (r: ChangeRecord) => r.actor.kind === 'person' || r.actor.kind === 'root';
  const facets = {
    people: Array.from(new Set(scoped.filter(isPerson).map((r) => r.actor.name))).sort(),
    resourceTypes: Array.from(new Set(scoped.map((r) => r.resourceType))).sort(),
  };

  const needle = q.q?.toLowerCase();
  const filtered = scoped
    .filter((r) => (!q.actor || r.actor.name === q.actor) && (!q.resourceType || r.resourceType === q.resourceType)
      && (!needle || r.resourceName.toLowerCase().includes(needle) || r.resourceId.toLowerCase().includes(needle)))
    .sort(byTimeDesc);

  const summary = {
    creates: filtered.filter((r) => r.kind === 'create').length,
    deletes: filtered.filter((r) => r.kind === 'delete').length,
    people: new Set(filtered.filter(isPerson).map((r) => r.actor.name)).size,
  };

  const entries = Object.entries((await getState()).accounts).filter(([k]) => all || k.split(':')[0] === q.accountId);
  const from = entries.map(([, s]) => s.backfillFrom).sort()[0] ?? null;
  const last = entries.map(([, s]) => s.lastRunAt).filter((x): x is string => !!x).sort().pop() ?? null;
  return {
    records: filtered.slice(0, MAX_RECORDS),
    summary,
    facets,
    status: {
      coverageFrom: from,
      lastIngestAt: last,
      backfilling: entries.some(([k, s]) => !isBackfillComplete(s, namesFor(k.split(':')[1] ?? ''))),
      failedAccounts: Array.from(new Set(entries.filter(([, s]) => s.lastError).map(([k]) => k.split(':')[0]))),
    },
    truncated: filtered.length > MAX_RECORDS,
  };
}

type KeyInput = string | { key: string; createdAt?: string };

export async function findCreators(keys: KeyInput[], deps: QueryDeps = {}): Promise<CreatorLookup[]> {
  const read = deps.read ?? readRecords;
  const getState: () => Promise<IngestState> = deps.state ?? readState;
  const items = keys.map((k) => (typeof k === 'string' ? { key: k } : k));
  const records = await read(new Date(0), new Date());
  const starts = Object.values((await getState()).accounts).map((s) => s.backfillFrom).sort();
  const coverage = starts[0] ? new Date(starts[0]).getTime() : null;

  return items.map(({ key, createdAt }): CreatorLookup => {
    const i = key.indexOf(':');
    const accountId = key.slice(0, i);
    const rid = key.slice(i + 1);
    const mine = records
      .filter((r) => !r.failed && r.accountId === accountId
        && (r.resourceId === rid || (r.resourceType === 's3-bucket' && r.resourceName === rid)))
      .sort(byTimeDesc);
    const created = mine.find((r) => r.kind === 'create');
    if (!created) {
      const tooOld = createdAt && coverage !== null && new Date(createdAt).getTime() < coverage;
      return { key, status: tooOld ? 'too-old' : 'none' };
    }
    const del = mine.find((r) => r.kind === 'delete' && r.time > created.time);
    return {
      key, status: 'found', actor: created.actor, time: created.time, tool: created.tool,
      ...(created.via ? { via: created.via } : {}), ...(del ? { deletedAt: del.time } : {}),
    };
  });
}

export async function searchByText(text: string, deps: QueryDeps = {}): Promise<ChangeRecord[]> {
  const read = deps.read ?? readRecords;
  const t = text.toLowerCase();
  const all = (await read(new Date(0), new Date())).filter((r) => !r.failed);
  const exact = all.filter((r) => r.resourceName.toLowerCase() === t || r.resourceId.toLowerCase() === t);
  const hits = exact.length ? exact : all.filter((r) => r.resourceName.toLowerCase().includes(t) || r.resourceId.toLowerCase().includes(t));
  return hits.sort(byTimeDesc).slice(0, MAX_SEARCH);
}
