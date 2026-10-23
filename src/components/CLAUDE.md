# 컴포넌트 모듈

## 역할
페이지 전반에 걸쳐 사용되는 공유 React 컴포넌트. 레이아웃, 카드, 차트, 테이블, K8s UI.

## 주요 파일 (22개)

### layout/ — 레이아웃 (3)
- `layout/Sidebar.tsx` — 메인 네비게이션 (6개 그룹, Bedrock·비용 레이더 포함, 활성 표시는 경로 세그먼트 단위) + Sign Out 버튼 (로고 우측) + AccountSelector + 계정별 기능 필터링
- `layout/Header.tsx` — 페이지 헤더 (새로고침, ONLINE 상태)
- `layout/AccountSelector.tsx` — 어카운트 선택 드롭다운 (멀티 어카운트 모드에서만 표시)

### providers/ — 프로바이더 (1)
- `providers/ClientProviders.tsx` — 클라이언트 프로바이더 래퍼 (LanguageProvider + AccountProvider)

### dashboard/ — 대시보드 카드 (7)
- `dashboard/StatsCard.tsx` — 통계 카드 (color prop: 이름 문자열)
- `dashboard/LiveResourceCard.tsx` — 실시간 리소스 카드
- `dashboard/CategoryCard.tsx` — 카테고리 카드
- `dashboard/StatusBadge.tsx` — 상태 배지 (`status` prop만 받음 — `text` prop 없음)
- `dashboard/AccountBadge.tsx` — 어카운트 배지 (accountId로 alias + 컬러 도트 표시)
- `dashboard/SystemHealthCard.tsx` — 시스템 상태 카드 (/api/health 60초 폴링, 항목별 상태 패널, admin 테스트 알림 버튼)
- `dashboard/CostRadarSummaryCard.tsx` — 홈 비용 레이더 요약 카드 (`/api/cost-radar` 월 예상 + 절약 가능액, 실패 시 흐린 한 줄, 네이비 스타일)

### cost-radar/ — 비용 레이더 (4 + 헬퍼) — 자세한 내용은 `cost-radar/CLAUDE.md`
- `cost-radar/CostRadarView.tsx` — `/cost-radar` 본문 (도넛·항목, 절약 카드, 계정 알약, 경고·빈·오류·로딩 상태, 고정 추정 안내)
- `cost-radar/CostDonut.tsx` — CSS conic-gradient 도넛 + 총액 + 지난주 대비 배지
- `cost-radar/SavingsCard.tsx` — 추천 1건 알약 카드 (클릭 시 상세)
- `cost-radar/RecommendationPanel.tsx` — 추천 상세 모달 (만든 사람 지연 조회, CLI 복사, 콘솔 링크, **실행 버튼 없음**)

### charts/ — Recharts 차트 래퍼 (3)
- `charts/BarChartCard.tsx` — 바 차트
- `charts/LineChartCard.tsx` — 라인 차트
- `charts/PieChartCard.tsx` — 파이 차트

### table/ — 데이터 테이블 (1)
- `table/DataTable.tsx` — 범용 데이터 테이블 (정렬, render 함수, 멀티어카운트 시 Account 컬럼 자동 추가)

### report/ — 리포트 (1)
- `ReportMarkdown.tsx` — 진단 리포트 마크다운 렌더러 (ReactMarkdown + remarkGfm, 다크 테마, 섹션별 강조색)

### k8s/ — K8s 전용 (4)
- `k8s/K9sResourceTable.tsx`, `K9sDetailPanel.tsx`, `K9sClusterHeader.tsx`, `NamespaceFilter.tsx`

## 규칙
- 모든 컴포넌트는 `export default`
- Tailwind 클래스는 테마 토큰 사용: navy-*, accent-*
- color 속성은 hex가 아닌 이름 문자열: 'cyan', 'green', 'purple', 'orange', 'red', 'pink'
- Sign Out: Sidebar 상단 로고 옆에 위치 → `POST /api/auth` (HttpOnly 쿠키 서버 사이드 삭제)

---

# Components Module (English)

## Role
Shared React components across pages: layout, cards, charts, tables, K8s UI.

## Key Files (22)

### layout/ — Layout (3)
- `layout/Sidebar.tsx` — Main navigation (6 groups, incl. Bedrock and Cost Radar; active state matches whole path segments) + Sign Out button (next to logo) + AccountSelector + account feature filtering
- `layout/Header.tsx` — Page header (refresh, ONLINE status)
- `layout/AccountSelector.tsx` — Account selector dropdown (only visible in multi-account mode)

### providers/ — Providers (1)
- `providers/ClientProviders.tsx` — Client provider wrapper (LanguageProvider + AccountProvider)

### dashboard/ — Dashboard Cards (7)
- `dashboard/StatsCard.tsx` — Stats card (color prop: name strings)
- `dashboard/LiveResourceCard.tsx` — Live resource card
- `dashboard/CategoryCard.tsx` — Category card
- `dashboard/StatusBadge.tsx` — Status badge (`status` prop only — no `text` prop)
- `dashboard/AccountBadge.tsx` — Account badge (shows alias + colored dot from accountId)
- `dashboard/SystemHealthCard.tsx` — System health card (polls /api/health every 60s, per-item status panel, admin test-alert button)
- `dashboard/CostRadarSummaryCard.tsx` — Home Cost Radar summary card (`/api/cost-radar` monthly estimate + possible saving, muted line on error, navy style)

### cost-radar/ — Cost Radar (4 + helpers) — see `cost-radar/CLAUDE.md`
- `cost-radar/CostRadarView.tsx` — `/cost-radar` body (donut + categories, savings cards, account pills, warning/empty/error/loading states, fixed estimate disclaimer)
- `cost-radar/CostDonut.tsx` — CSS conic-gradient donut + total + week-over-week pill
- `cost-radar/SavingsCard.tsx` — pill card per recommendation (click opens detail)
- `cost-radar/RecommendationPanel.tsx` — recommendation detail modal (lazy creator lookup, CLI copy, console link, **no action buttons**)

### charts/ — Recharts Chart Wrappers (3)
- `charts/BarChartCard.tsx` — Bar chart
- `charts/LineChartCard.tsx` — Line chart
- `charts/PieChartCard.tsx` — Pie chart

### table/ — Data Table (1)
- `table/DataTable.tsx` — Generic data table (sorting, render functions, auto Account column in multi-account mode)

### report/ — Report (1)
- `ReportMarkdown.tsx` — Diagnosis report markdown renderer (ReactMarkdown + remarkGfm, dark theme, per-section accent colors)

### k8s/ — K8s Components (4)
- `k8s/K9sResourceTable.tsx`, `K9sDetailPanel.tsx`, `K9sClusterHeader.tsx`, `NamespaceFilter.tsx`

## Rules
- All components use `export default`
- Tailwind classes use theme tokens: navy-*, accent-*
- Color prop: name strings ('cyan', 'green', 'purple') not hex values
- Sign Out: in Sidebar next to logo → `POST /api/auth` (server-side HttpOnly cookie deletion)
