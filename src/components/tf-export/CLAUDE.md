# Terraform 코드 변환 화면 컴포넌트

## 역할
`/terraform-export` 페이지 UI. 콘솔에서 손으로 만든 리소스를 골라 Terraform 코드로 옮긴다. 서버가 `terraform plan`으로 "가져오기만 있고 바꿀 것 0개"(diff 0)인 리소스만 코드에 넣고, 이 화면은 고르기 → 만들기(진행 표시) → 결과(통과율·리소스별 결과·파일·zip)를 보여 준다. AWS는 읽기만 한다 — `apply`는 서버도 화면도 하지 않는다. 데이터는 `GET/POST /api/terraform-export`, 리소스 검색은 `GET /api/graph?op=search`(dep-graph `SearchBox` 재사용).

## 주요 파일
- `TfExportView.tsx` — 페이지 본문 (클라이언트). `Header` + **항상 보이는 주의 문구 `tfExport.caution`**(백틱 부분은 `<code>`). `?op=status`로 설치 확인: 미설치면 "설치가 필요해요: scripts/18-setup-terraform.sh" 안내 상자만 보인다. 계정은 `useAccountContext().currentAccountId` — "전체 계정"이면 계정이 하나뿐일 때만 그 계정을 쓰고, 아니면 `tfExport.account.pickOne`으로 하나를 고르라고 한다(`effectiveAccount`). 1단계 `SeedPicker` → "미리 보기"(`POST op=preview`, 404 → 그래프 만드는 중, 400 → 서버의 한국어 메시지) → `PreviewList` → "코드 만들기"(`POST op=start`, 202 → 그 작업을 보여 줌, 429 → 다른 작업이 도는 중, 409 → 미설치, 400 → 서버 메시지). 입력이 미리 보기 뒤에 바뀌면 시작 버튼을 막고 다시 미리 보라고 한다(`seedKey` 비교). 서버에 이미 도는 작업(`status.running`)이 있으면 그 작업을 따라간다. 아래쪽: 지난 작업 표(최근 20개, "보기"로 열기)와 누적 지표(`?op=stats`, 카드 + 종류별 통과율 + AI 사용량). 새로고침 중에는 마지막 값을 유지한다(`useLast`). 계정이 바뀌거나 화면을 떠나면 진행 중인 미리 보기·시작 요청을 abort
- `SeedPicker.tsx` — 탭 4개: 태그(키·값) / 이름 접두어 / VPC(`SearchBox onlyType="vpc"` 또는 ARN 붙여넣기) / 개별 검색(`SearchBox`로 하나씩 골라 칩으로, 최대 60개, 칩마다 빼기, 모두 지우기). 씨앗이 바뀔 때마다 `onChange(seed|null)`(키로 비교해 같은 씨앗은 다시 알리지 않음). 계정이 바뀌면 고른 것을 비운다
- `PreviewList.tsx` — "N개 포함 · M개 제외", 리전 안내, 포함 표(종류·이름·Terraform 종류·ID), 제외 목록(접이식, 이유 배지 + 종류 + 이름; `shared`가 있으면 "코드에는 ID가 그대로 남아요" 안내), "코드 만들기 (N개)" 버튼과 막힌 이유
- `JobProgress.tsx` — 단계 8개 진행 표시: 준비 · 원본 뽑기 · 규칙으로 고치기 · AI로 고치기 · 바뀌는 것 확인 · 참조·이름 정리 · 다시 확인 · 묶기. 지난 단계 초록 체크, 지금 단계 cyan 회전, 실패하면 이 화면이 마지막으로 본 단계를 빨간 X로. 걸린 시간(1초마다), "3초마다 확인해요", 실패 상자(`job.error`)
- `JobResult.tsx` — `stage === 'done'`일 때만. `.zip 내려받기`(`/api/terraform-export?op=download&id=`), StatsCard 6장(규칙만 / AI 후 / 최종 통과율 + 순수 diff 0 / ignore 사용 / 실패 수, 색은 이름), AI 호출·토큰, 묶음 수준 안내(`bundle.refactored|named|raw`), `terraform.tfvars.example`이 있으면 "비밀 값은 CHANGE_ME로 바뀌어 있어요. 채운 뒤에 plan을 돌리세요.", Lambda가 있으면 코드는 따로 받으라는 안내, 리소스 표(Terraform 종류·이름·주소·결과 배지 ✅ diff 0 / 🟡 ignore 사용 / ❌ 실패·통과한 단계·이유·ignore_changes 속성), 종류별 통과율, `FileViewer`
- `FileViewer.tsx` — 파일 탭(`job.files`에서 `.zip` 제외) + `<pre>` 코드(`?op=file&id=&name=`). 다른 작업이면 첫 파일부터
- `api.ts` — `getStatus`, `previewSeed`, `startJob`(202 → jobId), `getJob`, `listJobs`, `getStats`, `getFile`; 실패는 `TfExportError{status,message}`. 훅 `useStatus`, `useJobs`, `useStats`, `useFile`(키가 바뀌면 abort, 다른 키의 데이터는 돌려주지 않음), `useJobPoll(id, onSettled)` — 3초마다 다시 읽고 done/failed면 멈춤, 404면 그만, 언마운트·id 변경 시 abort + 타이머 정리, `lastStage`(마지막으로 본 진행 단계)
- `format.ts` — 순수 함수 + `__tests__/format.test.ts`. `STEPS`, `stageLabel`, `isSettled`, `stepStates`, `outcomeLabel`, `outcomeColor`, `passedAtLabel`, `excludeReasonLabel`, `percent`(정수 %, 0개면 "—"), `passRates`, `byTypeRows`, `buildSeed`(API와 같은 제한: 태그 1–128, 접두어 1–64, VPC `arn:aws:ec2:`, ARN 1–60개), `addArn`, `seedKey`, `seedLabel`, `arnTail`, `viewableFiles`, `hasSecretVars`, `fileUrl`, `downloadUrl`, `effectiveAccount`, `splitCode`, `localDateTime`, `elapsed`, `typeLabel`
- 페이지 래퍼 `src/app/terraform-export/page.tsx` — 서버 컴포넌트. 변경 기록과 같은 Pretendard(`../changes/fonts/PretendardVariable.woff2`)를 `--font-pretendard`로 주입
- 사이드바: "네트워크/CDN"의 의존성 그래프 다음, 아이콘 `FileCode`, 키 `sidebar.tfExport`
- 테스트에는 i18n 짝 맞추기 검사도 있다: ko.json의 `tfExport.*`·`sidebar.tfExport` 키가 en/zh에 모두 있고, en/zh에만 있는 키가 없으며, `{자리표시}`가 언어마다 같아야 한다. 정해진 문구(`caution`, `result.changeMe`, `notInstalled`)와 단계·결과·제외 이유 문구도 확인한다

## 규칙
- `@/lib/tf-export`에서는 `types`만 `import type`으로 가져온다 — 서버 코드(Terraform 실행기·Bedrock·저장소)를 클라이언트 번들에 넣지 않는다. 검색은 `@/components/dep-graph/SearchBox`를 재사용
- 화면은 서버의 판정을 그대로 보여 준다 — diff 0이 아닌 것을 통과로 바꾸지 않는다. 결과 이유 문구(`reason`)는 서버가 한국어로 준다
- 비밀 값은 화면에 오지 않는다 — 파일 보기는 서버가 내준 묶음 파일(비밀은 변수 + `CHANGE_ME`)만 보여 준다
- `fetch`는 `/api/...`만. 작업 하나 = 계정 하나
- 문구는 초보자용 쉬운 한국어 먼저, `tfExport.*`·`sidebar.tfExport` 키를 ko/en/zh 모두에 추가
- 테마는 navy 배경 + 강조색(cyan·purple·orange·red·green). 좁은 화면에서는 카드가 2열, 표는 가로 스크롤

---

# Terraform Export UI Components (English)

## Role
UI for `/terraform-export`: pick resources that were made by hand in the console and turn them into Terraform code. The server puts a resource in the code only when `terraform plan` shows "import only, 0 changes" (diff 0); this screen shows pick → make (stepper) → result (pass rates, per-resource results, files, zip). AWS is only read — neither the server nor the screen runs `apply`. Data comes from `GET/POST /api/terraform-export`; resource search uses `GET /api/graph?op=search` (reusing the dep-graph `SearchBox`).

## Files
- `TfExportView.tsx` — page body (client). `Header` + **the always-visible caution `tfExport.caution`** (backtick parts render as `<code>`). Install check via `?op=status`: when not installed only the "Setup needed: scripts/18-setup-terraform.sh" box shows. The account is `useAccountContext().currentAccountId` — under "all accounts" the only account is used when there is exactly one, otherwise `tfExport.account.pickOne` asks for one (`effectiveAccount`). Step 1 `SeedPicker` → "Preview" (`POST op=preview`; 404 → graph still building, 400 → the server's Korean message) → `PreviewList` → "Make code" (`POST op=start`; 202 → shows that job, 429 → another job is running, 409 → not installed, 400 → server message). If the form changes after a preview, the start button is blocked until previewed again (`seedKey` compare). A job already running on the server (`status.running`) is followed. Below: past-jobs table (last 20, "Open") and totals (`?op=stats`: cards, per-type pass rates, AI usage). The last values are kept while refreshing (`useLast`). Pending preview/start requests abort on account change and unmount
- `SeedPicker.tsx` — 4 tabs: tag (key + value) / name prefix / VPC (`SearchBox onlyType="vpc"` or paste an ARN) / one-by-one search (`SearchBox` picks become chips, up to 60, remove per chip, clear all). Calls `onChange(seed|null)` whenever the seed changes (compared by key so the same seed is not re-sent). Picks are cleared on account change
- `PreviewList.tsx` — "N included · M left out", region note, included table (kind, name, Terraform type, ID), collapsible exclusion list (reason badge + kind + name; with `shared`, a note that the ID stays in the code), the "Make code (N)" button and why it is blocked
- `JobProgress.tsx` — 8-stage stepper: Prepare · Pull the original · Fix with rules · Fix with AI · Check for changes · Tidy references and names · Check again · Bundle. Past stages green check, current cyan spinner, on failure the last stage this screen saw gets a red X. Elapsed time (every second), "Checking every 3 s", failure box (`job.error`)
- `JobResult.tsx` — only for `stage === 'done'`. `Download .zip` (`/api/terraform-export?op=download&id=`), 6 StatsCards (pass rate after rules / after AI / final + pure diff 0 / uses ignore / failed counts; color names), AI calls and tokens, bundle-level note (`bundle.refactored|named|raw`), the CHANGE_ME note when `terraform.tfvars.example` exists, a Lambda-code note, the per-resource table (Terraform type, name, address, badge ✅ diff 0 / 🟡 uses ignore / ❌ failed, passed-at stage, reason, ignore_changes attributes), per-type pass rates, `FileViewer`
- `FileViewer.tsx` — file tabs (`job.files` minus `.zip`) + `<pre>` code (`?op=file&id=&name=`); a different job starts on its first file
- `api.ts` — `getStatus`, `previewSeed`, `startJob` (202 → jobId), `getJob`, `listJobs`, `getStats`, `getFile`; failures throw `TfExportError{status,message}`. Hooks `useStatus`, `useJobs`, `useStats`, `useFile` (abort on key change, never return another key's data) and `useJobPoll(id, onSettled)` — re-reads every 3 s and stops at done/failed, stops on 404, aborts and clears its timer on unmount/id change, exposes `lastStage` (last running stage seen)
- `format.ts` — pure + `__tests__/format.test.ts`: `STEPS`, `stageLabel`, `isSettled`, `stepStates`, `outcomeLabel`, `outcomeColor`, `passedAtLabel`, `excludeReasonLabel`, `percent` (whole %, "—" for 0 total), `passRates`, `byTypeRows`, `buildSeed` (same limits as the API: tag 1–128, prefix 1–64, VPC `arn:aws:ec2:`, 1–60 ARNs), `addArn`, `seedKey`, `seedLabel`, `arnTail`, `viewableFiles`, `hasSecretVars`, `fileUrl`, `downloadUrl`, `effectiveAccount`, `splitCode`, `localDateTime`, `elapsed`, `typeLabel`
- Page wrapper `src/app/terraform-export/page.tsx` — server component; injects the same Pretendard font as the change timeline (`../changes/fonts/PretendardVariable.woff2`) as `--font-pretendard`
- Sidebar: under "Network/CDN" right after the dependency graph, icon `FileCode`, key `sidebar.tfExport`
- The test file also checks i18n parity: every `tfExport.*` / `sidebar.tfExport` key in ko.json exists in en/zh, en/zh have no extra ones, and `{placeholders}` match across languages; it also pins the agreed copy (`caution`, `result.changeMe`, `notInstalled`) and the stage, outcome and exclusion labels

## Rules
- Import only types (`import type`) from `@/lib/tf-export` — never pull server code (Terraform runner, Bedrock, store) into the client bundle. Search reuses `@/components/dep-graph/SearchBox`
- The screen shows the server's verdict as-is — nothing that is not diff 0 is shown as passed. Result reasons (`reason`) come from the server in Korean
- Secret values never reach the screen — the viewer only shows bundle files from the server (secrets are variables + `CHANGE_ME`)
- `fetch` only `/api/...`. One job = one account
- Plain beginner-friendly Korean first; add `tfExport.*` / `sidebar.tfExport` to ko/en/zh
- Navy theme + accents (cyan, purple, orange, red, green); cards go 2 columns on narrow screens, tables scroll horizontally
