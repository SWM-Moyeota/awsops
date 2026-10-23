# 비용 레이더 화면 컴포넌트

## 역할
`/cost-radar` 페이지 UI. 지금 켜진 리소스의 월 예상 비용(도넛 + 항목별 금액)과 정리 추천(절약 카드 + 상세 패널)을 보여준다. **알려주기만 한다** — AWS 리소스를 바꾸는 버튼은 어디에도 두지 않는다.

## 주요 파일
- `CostRadarView.tsx` — 페이지 본문 (클라이언트). `GET /api/cost-radar?accountId=` 조회, 전역 계정 선택이 All이면 계정 알약으로 페이지 안에서만 계정 전환, 경고 배너(로딩 중엔 숨김)·로딩 스켈레톤·오류(다시 시도)·빈 상태(경고가 없을 때만 "과금 리소스 없음", 0원이어도 추천이 있으면 오른쪽 카드 표시)·스냅샷 상한값 안내(디스크·스냅샷 행)·가격 미확인 목록(접힘)·하단 고정 추정 안내(기준일은 `PRICE_AS_OF`)
- `CostDonut.tsx` — CSS `conic-gradient` 도넛, 가운데 총액 `$X` + `.XX`, `trend`가 있을 때만 지난주 대비 배지
- `SavingsCard.tsx` — 추천 1건 알약 카드 (라임/흰색/보라/핑크 순환), `countedInTotal=false`면 취소선 + "합계 제외"
- `RecommendationPanel.tsx` — 추천 상세 모달: 이유, 만든 사람(열 때만 `GET /api/cost-radar/creators?ids=` 조회, id별 상태 캐시), 태그, "삭제 전 만든 사람에게 확인하세요", CLI 복사(`navigator.clipboard`, 실패 시 안내, 여러 줄 명령은 줄바꿈 유지 — 스냅샷/AMI 먼저), `cliCommand`가 비면(업무시간 추천) 복사 상자 대신 스케줄 안내(`costRadar.officeHoursGuide`), 콘솔 링크(새 탭)
- `format.ts` — 순수 헬퍼 (팔레트, 카테고리 색, 금액 서식, 도넛 그라디언트, 표시 이름, 템플릿 분리) + `__tests__/format.test.ts`
- 페이지 래퍼 `src/app/cost-radar/page.tsx` — 서버 컴포넌트, `next/font/google`의 Archivo Black(400)·Caveat(700)을 CSS 변수(`--font-cr-display`, `--font-cr-hand`)로 이 페이지 루트에만 주입

## 규칙
- 팔레트(#0b0b0d 배경, #17171a 카드, 라임·핑크·보라·주황·하늘·회색)와 두 글꼴은 이 페이지 안에서만 쓴다. 홈 요약 카드(`dashboard/CostRadarSummaryCard.tsx`)는 기존 네이비 스타일
- 카드 목록: 절약액 > 0, `note` 있음, 또는 빈 타겟 그룹(0원이지만 스펙 §5.2상 정리 대상) — 확실한 낭비(EIP·EBS·멈춘 EC2·빈 LB/TG·오래된 스냅샷) 먼저, 그다음 최적화(업무시간·gp3), 각각 절약액 내림차순. 합친 목록에서 8개까지 보이고 "모두 보기". `note` 문구는 `noteKey()`로 번역 키 선택
- 2단 배치는 뷰포트 1140px부터 (사이드바 240px 제외 시 페이지 폭 약 900px), 그 아래는 1단
- 번역 키는 `costRadar.*`, `sidebar.costRadar`, `dashboard.costRadar*` — ko/en/zh 모두. 규칙 사유 문구는 `recommend.ts`의 params 이름(`publicIp`, `sizeGb`, `volumeType`, `days`, `targetGroups`, `hoursPerWeek`, `monthly`)을 쓴다
- `@/lib/cost-radar`에서는 `types`(`import type`)와 `price-as-of`(상수)만 가져온다 (서버 코드·가격표 JSON을 클라이언트 번들에 넣지 않음)

---

# Cost Radar UI Components (English)

## Role
UI for `/cost-radar`: monthly estimate of running resources (donut + per-category amounts) and cleanup recommendations (savings cards + detail panel). **Guidance only** — there is no button anywhere that changes an AWS resource.

## Files
- `CostRadarView.tsx` — page body (client). Fetches `GET /api/cost-radar?accountId=`; when the global account selector is All, account pills switch the view inside the page only; warnings banner (hidden while loading), loading skeleton, error with retry, empty state ("nothing bills you" only without warnings; $0 recommendations still get the right column), snapshot upper-bound hint on the disks & snapshots row, collapsed unpriced list, sticky estimate disclaimer (date from `PRICE_AS_OF`)
- `CostDonut.tsx` — CSS `conic-gradient` donut, `$X` + `.XX` total in the centre, week-over-week pill only when `trend` is present
- `SavingsCard.tsx` — one pill card per recommendation (lime/white/purple/pink rotation); `countedInTotal=false` shows a struck-through amount + "Not in total"
- `RecommendationPanel.tsx` — detail modal: reason, creator (fetched only when opened via `GET /api/cost-radar/creators?ids=`, cached per id), tags, "check with the creator before deleting", CLI copy (`navigator.clipboard`, graceful failure, multi-line commands keep their line breaks — snapshot/AMI first); when `cliCommand` is empty (office hours) a scheduling guide (`costRadar.officeHoursGuide`) replaces the copy box; console link (new tab)
- `format.ts` — pure helpers (palette, category colours, money formatting, donut gradient, display names, template splitting) + `__tests__/format.test.ts`
- Page wrapper `src/app/cost-radar/page.tsx` — server component that injects Archivo Black (400) and Caveat (700) from `next/font/google` as CSS variables (`--font-cr-display`, `--font-cr-hand`) on this page root only

## Rules
- The palette and the two fonts are page-only. The home summary card (`dashboard/CostRadarSummaryCard.tsx`) keeps the navy dashboard style
- Card list: saving > 0, a `note`, or an empty target group (0 USD but a cleanup target per spec §5.2) — definite waste (EIP, EBS, long-stopped EC2, empty LB/TG, old snapshot) first, then optimisations (office hours, gp3), each by saving desc; first 8 of the combined list visible with "Show all". Note text picks its i18n key via `noteKey()`
- Two columns from a 1140px viewport (≈ 900px of page once the 240px sidebar is subtracted), one column below
- i18n keys: `costRadar.*`, `sidebar.costRadar`, `dashboard.costRadar*` in ko/en/zh. Rule reason strings use the param names set in `recommend.ts` (`publicIp`, `sizeGb`, `volumeType`, `days`, `targetGroups`, `hoursPerWeek`, `monthly`)
- From `@/lib/cost-radar` import only `types` (`import type`) and the `price-as-of` constant (keeps server code and the price-table JSON out of the client bundle)
