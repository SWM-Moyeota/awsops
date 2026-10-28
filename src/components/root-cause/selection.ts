// Pure selection rules for /root-cause: search-box keys, result freshness, stale hook data, foreign incidents.
// 장애 원인 분석 화면의 선택 규칙(순수 함수) — 검색창 키, 결과 최신 여부, 지난 훅 데이터, 다른 계정 사건.

export type KeyAction = { type: 'move'; index: number } | { type: 'pick'; index: number } | { type: 'close' } | null;

export interface KeyState {
  open: boolean;
  count: number;
  active: number;
  /** Results belong to what is typed now. / 결과가 지금 입력한 글자의 것인지. */
  fresh: boolean;
  /** The key came from a focused option button, not the input. / 키가 결과 버튼에서 왔는지. */
  onOption: boolean;
}

/**
 * What a key press in the search box should do. Enter on an option button is left to the button's own click;
 * Enter in the input picks only when the results are fresh.
 * 검색창 키 처리 — 결과 버튼 위의 Enter는 버튼 자신의 click에 맡기고, 입력창의 Enter는 결과가 최신일 때만 고른다.
 */
export function searchKeyAction(key: string, s: KeyState): KeyAction {
  if (key === 'Escape') return { type: 'close' };
  if (!s.open || s.count === 0) return null;
  if (key === 'ArrowDown') return { type: 'move', index: (s.active + 1) % s.count };
  if (key === 'ArrowUp') return { type: 'move', index: (s.active - 1 + s.count) % s.count };
  if (key === 'Enter') {
    if (s.onOption || !s.fresh) return null;
    return { type: 'pick', index: Math.min(Math.max(0, s.active), s.count - 1) };
  }
  return null;
}

/**
 * Results are fresh when the debounced query equals the typed text, they were loaded for that query, and nothing is loading.
 * 디바운스된 검색어가 입력과 같고, 그 검색어로 받은 결과이며, 불러오는 중이 아닐 때만 최신이다.
 */
export function isFresh(p: { text: string; q: string; dataQ: string | null; loading: boolean; maxQ: number }): boolean {
  return !!p.q && p.text.trim().slice(0, p.maxQ) === p.q && p.dataQ === p.q && !p.loading;
}

export interface KeyedState<T> { data: T | null; loading: boolean; key: string | null }

/**
 * What a hook should return for `key`: data stored for another key is hidden (and counts as loading until the effect runs).
 * 훅이 돌려줄 값 — 다른 키로 받은 데이터는 숨기고, 효과가 돌기 전까지는 불러오는 중으로 본다.
 */
export function viewFor<T>(state: KeyedState<T>, key: string | null): { data: T | null; loading: boolean; stale: boolean } {
  if (!key) return { data: null, loading: false, stale: false };
  if (state.key !== key) return { data: null, loading: true, stale: true };
  return { data: state.data, loading: state.loading, stale: false };
}

/** An incident outside the selected account (never with "all accounts"). / 선택한 계정 밖의 사건인지. */
export function isForeign(incidentAccountId: string, currentAccountId: string): boolean {
  return currentAccountId !== '__all__' && incidentAccountId !== currentAccountId;
}
