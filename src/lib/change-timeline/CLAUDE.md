# 변경 기록 (Change Timeline) 모듈

## 역할
연결된 계정들에서 **누가 어떤 리소스를 만들고 지웠는지**를 CloudTrail에서 모아 저장하고 조회한다. 결과는 `/changes` 페이지, S3·EC2·RDS 목록의 "만든 사람", Slack 질문과 아침 요약에 쓰인다. 조회만 하는 기능이다. 설계 문서: `docs/superpowers/specs/2026-10-26-change-timeline-design.md`.

## 주요 파일
- `types.ts` — 공용 계약 타입: `ChangeRecord`(id는 항상 `${eventId}:${index}`), `IngestState`, `ChangesQuery`/`ChangesResponse`, `CreatorLookup`.
- `catalog.ts` — 추적 대상 생성·삭제 이벤트 목록 `TRACKED`(ECS와 EKS의 `CreateCluster`는 `eventSource`로 구분, IAM은 `us-east-1`), `findTracked`, `eventNamesFor(region)`. 목록에 없는 이벤트는 저장하지 않는다(노이즈 방지).
- `parse.ts` — `toRecords(raw, accountId)`는 CloudTrail 이벤트를 리소스마다 한 줄씩 기록으로 바꾼다.
  - `classifyActor`: IAM 사용자는 사람이다. `invokedBy`가 있어도 사람을 유지하고 `via`에 "CloudFormation"이나 "Auto Scaling"을 넣는다. 서비스 연결 역할과 CDK 실행 역할은 자동, AWSops 역할은 `awsops`(SourceIdentity 보존), SSO 세션은 사람, Root는 `root`다.
  - `detectTool`: `invokedBy`와 userAgent로 도구를 판별한다. 브라우저 UA는 콘솔로 본다.
- `store.ts` — `data/change-timeline/records-YYYY-MM.json`(월별, `Record<id, ChangeRecord>`)과 `state.json`을 쓴다.
  - 원자적으로 쓰고, 쓰기는 하나의 체인으로 직렬화한다. `appendRecords`는 id로 중복을 없앤다.
  - 월 파일이 깨졌으면 `.corrupt-<ts>`로 옮겨 보존한다. 파일이 없을 때(ENOENT)가 아닌 다른 읽기 오류면 덮어쓰지 않고 예외를 던진다.
  - `CHANGE_TIMELINE_DATA_DIR`로 경로를 바꿀 수 있다.
- `query.ts` — `queryChanges`(필터, 요약, facet, 상태), `findCreators`(found / too-old / none, 이후 삭제 여부), `searchByText`, `isBackfillComplete`.
  - "작업한 사람" 수는 `person`과 `root`만 센다. 자동과 AWSops 줄은 생성·삭제 숫자에만 넣는다.
- `ingest.ts` — `ingestOnce`는 계정마다 `ap-northeast-2`, `us-east-1` 순서로 돈다.
  - 처음에는 이벤트 이름마다 90일치를 채운다. 이름 하나가 끝날 때마다 상태를 저장해서 중간에 멈춰도 이어서 한다.
  - 이후에는 증분으로, 이름마다 `lastTo − 60분`부터 지금까지 끝까지 페이지를 넘긴다(잘림 없음).
  - 모든 호출은 `src/lib/cloudtrail-access.ts`의 `cloudTrailSlot`(계정·리전당 초당 1회(1 request/s per account+region, 공유 limiter), 비용 레이더와 공유)을 거친다. 다른 계정은 `accountCredentials`로 AssumeRole한다.
  - 계정이나 리전 하나가 실패해도 나머지는 계속 돌고, 실패는 `lastError`에 남는다.
- `loop.ts` — `ensureChangeTimelineStarted()`: `globalThis` 싱글턴으로 30초 뒤 첫 실행, 이후 10분마다 돈다. 실행이 겹치지 않고 프로덕션에서만 동작한다. `instrumentation.ts`와 `/api/changes*`가 기동한다. `setDailySummaryHook`으로 Slack 요약을 매 tick 호출한다.
- `slack.ts` — `detectWhoQuestion`, `answerWho`, `maybeHandleChangeQuestion`(봇의 `tryChangeQuestion`, AI 앞에서 규칙으로 처리), `buildDailySummary`, `maybeSendDailySummary`(KST 09:00 이후 어제 요약을 하루 1번, 0건이면 보내지 않음, 실패하면 다음 tick에 재시도, 메모리 가드로 이중 발송 방지).

## 규칙
- AWS를 바꾸는 API를 호출하지 않는다. CloudTrail 내용·IP·자격 증명을 로그에 남기지 않고, 오류 이름만 남긴다.
- CloudTrail 호출은 반드시 `cloudTrailSlot`을 거친다(계정·리전당 초당 1회로 비용 레이더와 공유 — AWS 한도 2회 중 나머지는 /cloudtrail 페이지·AI Lambda 몫).
- 새 리소스 종류를 추적하려면 `catalog.ts`에 이벤트를, `parse.ts`에 이름 추출을, `src/components/changes/format.ts`에 라벨을 함께 추가한다.
- "누가" 질문 해석에 LLM을 쓰지 않는다. 생성·삭제 동사도 없고 기록도 없으면 AI로 넘긴다(일반 질문을 가로채지 않는다).
- 깨진 월 파일은 `.corrupt-*`로 남으므로 복구는 수동으로 한다.

---

# Change Timeline Module (English)

## Role
Collects **who created and deleted which resources** across the connected accounts from CloudTrail, stores it, and serves it to the `/changes` page, the "Created by" badges on the S3/EC2/RDS lists, and Slack (questions plus a morning summary). It is read-only. Spec: `docs/superpowers/specs/2026-10-26-change-timeline-design.md`.

## Key Files
- `types.ts` — contract types. Record id is `${eventId}:${index}`.
- `catalog.ts` — the tracked create/delete events. Untracked events are never stored.
- `parse.ts` — CloudTrail event → one record per resource.
  - Actor rules: an IAM user stays the person even with `invokedBy` (set as `via`). Service-linked and CDK roles are auto, AWSops roles are `awsops`, SSO sessions are people, Root is `root`.
  - Tool detection.
- `store.ts` — monthly JSON files plus `state.json`. Writes are atomic and serialized, and records are deduped by id. A corrupt month file is moved aside. Read errors other than ENOENT never overwrite.
- `query.ts` — `queryChanges`, `findCreators`, `searchByText`. People = `person` and `root` only.
- `ingest.ts` — a resumable per-name 90-day backfill, then a per-name incremental with a 60-minute overlap and no truncation. Calls go through the shared pacer. Failures are isolated per account and region.
- `loop.ts` — the globalThis singleton loop: 30 s first run, then 10 minutes, no overlap, production only, with a daily-summary hook.
- `slack.ts` — the rule-based who-question (falls through to the AI when there is no verb and no record) and the once-a-day 09:00 KST summary.

## Rules
- Read-only. Never log payloads, IPs or credentials.
- All CloudTrail calls go through `cloudTrailSlot`.
- A new resource type needs catalog, parse and format changes together.
- No LLM in the who-question parsing.

## Operating notes
- Steady state is about 46 CloudTrail calls per account per tick (1 request/s per account+region, shared limiter).
- Incremental overlap is 60 minutes (CloudTrail delivery can lag past 15 minutes; dedupe makes re-reads free).
- Accepted limitation: EC2 "만든 사람" uses `launch_time` as the createdAt hint, so a restarted old instance may show "기록 없음" instead of "90일보다 오래돼서".
