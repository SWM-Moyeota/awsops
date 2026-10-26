# 변경 기록 화면 컴포넌트

## 역할
`/changes` 페이지 UI. 연결된 계정에서 누가 언제 어떤 리소스를 **만들고 지웠는지** 토스 스타일 문장으로 보여 준다. 조회만 한다 — AWS를 바꾸는 버튼은 없다.

## 주요 파일
- `ChangeTimelineView.tsx` — 페이지 본문 (클라이언트). `GET /api/changes?accountId=&range=&kind=&actor=&type=&q=` 조회, `useAccountContext().currentAccountId`를 따른다(계정이 바뀌면 사람·서비스 필터 초기화). 검색은 300ms 디바운스, 처음 90일 수집 중에는 30초마다 다시 조회. 상태 줄(수집 중 · 마지막 수집 · 실패한 계정 별칭), 빈 상태("아직 기록이 없어요" + 이유), 오류(다시 시도), 500건 넘으면 안내
- `ChangeSummary.tsx` — 요약 문장(26px, "생기고" 뒤 줄바꿈) + 설명 + 숫자 카드 3개(생성 초록 · 삭제 빨강 · 작업한 사람)
- `ChangeFilters.tsx` — 둥근 칩(기간 · 전체/생성/삭제 · 사람 · 서비스, 가로 스크롤, 선택값은 목록에서 빠져도 유지) + "리소스 이름으로 찾기"
- `ChangeRow.tsx` — 한 줄: 42px 동그란 아이콘(생성 초록 · 삭제 빨강 · 자동/AWSops 회색 배경 + 서비스 이모지), 문장(이름 굵게), `[생성]/[삭제] · 이름 · 도구 · 시각`, `›`. `KindTag`, `RoundIcon`도 내보낸다
- `ChangeDetailPanel.tsx` — 상세 패널(모바일은 아래 시트, 넓은 화면은 오른쪽): KST 전체 시각, 사람, 도구, IP, 리전, 계정 별칭, 리소스 이름/ID, 이벤트, 콘솔 링크(s3·ec2·rds·보안그룹·lambda, 지워진 리소스는 숨김), 같은 리소스의 다른 기록(`range=all&q=<resourceId>`로 열 때만 조회)
- `format.ts` — 순수 함수 + `__tests__/format.test.ts`. `resourceTypeLabel`, `resourceEmoji`, `toolLabel(tool, via?)`, `sentence`, `summarySentence`, `kstTime`, `kstDateTime`, `kstDate`, `kstDayLabel`, `groupByKstDay`, `consoleUrl`, `withObject`/`withSubject`(받침)
- 페이지 래퍼 `src/app/changes/page.tsx` — `next/font/local`로 `fonts/PretendardVariable.woff2`를 `--font-pretendard` 변수로 이 페이지 루트에만 주입

## 규칙
- 팔레트(배경 #0a0e1a, 카드 #0f1629/#151d30, 선 #1a2540, 글자 #f2f4f6/#b0b8c1/#6b7684, 파랑 #4593fc, 초록 #00d68f, 빨강 #ff5f6d)는 Tailwind 임의값으로 쓴다. 카드 반경 24px, 칩은 알약 모양. Pretendard는 이 화면과 변경 기록 관련 새 UI에만
- 문장은 한국어 고정(`format.ts`). 그 밖의 라벨은 `changes.*`, `sidebar.changes` 번역 키 — ko/en/zh 모두
- "작업한 사람" 수에는 `person`·`root`만 센다(서버 `queryChanges`가 계산)
- `@/lib/change-timeline`에서는 `types`만 `import type`으로 가져온다 (서버 코드를 클라이언트 번들에 넣지 않음)

---

# Change Timeline UI Components (English)

## Role
UI for `/changes`: who created and deleted which resource, and when, as Toss-style Korean sentences. Read-only — no button changes AWS.

## Files
- `ChangeTimelineView.tsx` — page body (client). Fetches `GET /api/changes?accountId=&range=&kind=&actor=&type=&q=` for `useAccountContext().currentAccountId` (person/type filters reset on account change). 300 ms search debounce; refetches every 30 s while the first 90-day backfill runs. Status line (collecting · last collected · failed account aliases), empty state with a reason, error with retry, a note past 500 records
- `ChangeSummary.tsx` — summary sentence (26px) + description + 3 stat cards (created green · deleted red · people)
- `ChangeFilters.tsx` — pill chips (range · all/create/delete · people · types, horizontal scroll, the selected value stays visible) + search box
- `ChangeRow.tsx` — one row: 42px round icon (green/red, grey for auto/AWSops, service emoji), sentence with the bold name, `[tag] · name · tool · time`, `›`. Also exports `KindTag`, `RoundIcon`
- `ChangeDetailPanel.tsx` — detail panel (bottom sheet on mobile, right drawer on wide screens): KST time, person, tool, IP, region, account alias, resource name/ID, event, console link (s3/ec2/rds/security-group/lambda, hidden once deleted), other records for the same resource (fetched on open with `range=all&q=<resourceId>`)
- `format.ts` — pure helpers + `__tests__/format.test.ts` (labels, emoji, `toolLabel(tool, via?)`, sentences with 받침-aware particles, KST time/day labels, grouping, console links)
- Page wrapper `src/app/changes/page.tsx` — injects `fonts/PretendardVariable.woff2` via `next/font/local` as `--font-pretendard` on this page root only

## Rules
- Palette as Tailwind arbitrary values; 24px card radius, pill chips; Pretendard only in this UI and the related new change-timeline UI
- Sentences are Korean (`format.ts`); other labels use `changes.*` and `sidebar.changes` in ko/en/zh
- The people count includes only `person` and `root` actors (computed by `queryChanges` on the server)
- Import only `types` (as `import type`) from `@/lib/change-timeline` so server code stays out of the client bundle
