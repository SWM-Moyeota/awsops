# 비용 레이더 모듈

## 역할
Steampipe 리소스로부터 고정 비용(월 730h 환산)을 추정하고 정리 추천을 만드는 "비용 레이더"의 서버 로직. 서울 리전(ap-northeast-2) 온디맨드 가격표를 앱에 내장하고(Pricing API는 SCP로 차단), 순수 함수로 월 비용을 계산한다. 안내만 한다 — AWS 리소스를 바꾸는 코드는 없다.

## 주요 파일
- `types.ts` — 공용 타입 (`CategoryId`, `UnpricedReason`, `PricedResource`, `Estimate`, `Recommendation`(note: `maybe-scaled-to-zero` | `managed-instance`), `RadarResponse`, `CreatorInfo`, `Row`, `RawInventory`)
- `pricing.ts` — `HOURS_PER_MONTH=730`, `priceAsOf()`, `priceEc2/Ebs/Snapshot/PublicIp/Nat/Lb/VpcEndpoint/Rds/ElastiCache` — 반환은 `{monthly}` 또는 `{monthly:null, reason}`. `priceRds({stopped:true})`는 스토리지만
- `prices.ap-northeast-2.json` — 생성된 가격표 (직접 수정 금지)
- `price-as-of.ts` — 생성된 `PRICE_AS_OF` 상수 (가격표 기준일). 클라이언트는 JSON 대신 이것만 import
- `collect.ts` — `collectInventory(accountId, {runQuery?})`: 테이블당 Steampipe 쿼리 1건(11건), 계정당 동시 4건 제한(`MAX_CONCURRENT_QUERIES`), 실패는 `errors`에 기록하고 throw하지 않음. `runQuery`는 테스트용 주입
- `estimate.ts` — `buildEstimate(invs, scope)`: 원본 행 → 가격 리소스·카테고리 합계·경고. 자동 할당 퍼블릭 IPv4(EIP와 같은 IP는 제외)와 인터넷 연결 ALB/NLB의 AZ당 IPv4를 `public-ip`로 계산, 중지된 RDS는 스토리지만, 타겟 그룹 조회 실패는 `loadbalancer` 경고. `collectionFailed(inv)`(8개 카테고리 전부 실패)
- `recommend.ts` — 정리 추천 규칙 7종 (`recommend`, `summarizeSavings`, `parseStateTransitionTime`). 리소스 ID 기준 중복 제거(큰 절약액만 합계 포함), 멈춘 EC2에 붙은 EBS의 gp2→gp3는 합계 제외, 타겟 그룹 조회 실패 시 TG/LB 규칙 생략, LB 연결을 읽을 수 없는 TG가 있으면 그 계정의 빈 LB 판정 생략, ASG/EKS/ECS 소유 EC2의 업무시간 추천은 `managed-instance`로 합계 제외, 삭제/종료 명령 앞에 스냅샷/AMI 생성 명령, 업무시간 추천은 명령 없음(화면이 스케줄 안내 표시). 연말 비교는 KST 오늘~12/31 일수(오늘 제외) ÷ 30.4
- `creators.ts` — `lookupCreators(items)`: CloudTrail `LookupEvents`로 생성자 조회. ID 형태별 생성 이벤트만 인정(`vol-`→CreateVolume 등), 계정당 초당 1회, 대상 계정은 `AWSopsReadOnlyRole` + External ID, 캐시 `creators.json`(found 영구, unknown 24시간 후 재시도), 예외 없음
- `history.ts` — 일별 이력(`history.json`, 계정·KST 일당 1건, 90일 보관). 경고가 있던 기록은 `partial`(같은 날 다시 기록 가능, 추세 기준으로 안 씀). `trendFor(hist, 현재 계정별 월 추정, now)`는 정확히 7일 전 기록과 비교. `recordDailyIfMissing(now?, deps?)`: 완전한 오늘 기록이 없는 계정만 한 계정씩 수집·기록, 예외 없음·중복 실행 방지·전 카테고리 실패 계정은 기록 안 함. 헬스 모니터 5분 루프에서 fire-and-forget(60초 제한)으로 호출
- `store.ts` — `data/cost-radar/` JSON 읽기/원자적 쓰기 (`COST_RADAR_DATA_DIR`로 재정의, 테스트용)
- `radar.ts` — `buildRadarResponse(accountId, deps)`(의존성 주입, 계정 순차 수집, 전 계정 전 카테고리 실패 시 `RadarCollectionError` → 500·미캐시, 경고가 있으면 추세 숨김), `getRadarResponse`(계정별 5분 캐시, 실패 미캐시), `parseCreatorIds`(최대 50개, 첫 두 콜론만 분리), `RadarInputError`(400)
- `__tests__/*.test.ts` — 단위 테스트 (vitest: pricing, collect, estimate, recommend, creators, history, api)
- 생성 스크립트: `scripts/tools/build-price-table.py` (AWS 공개 일괄 가격표 CSV, 표준 라이브러리만, 로컬 실행 후 JSON과 `price-as-of.ts` 커밋)

## 규칙
- 서울 외 리전 → `other-region`, 가격표에 없는 타입/엔진 → `unknown-type`, 리눅스 아닌 EC2 → `non-linux`, 전용 테넌시 → `dedicated` (합계에서 제외하고 화면에 표시)
- gp3는 기본 3000 IOPS / 125 MB/s 초과분만 과금. 스냅샷은 볼륨 크기 기준 상한값. LB는 LCU 제외. RDS Aurora 스토리지는 사용량 기반이라 미포함. ElastiCache는 Redis 단가 기준(Valkey는 약 20% 저렴)
- DB 접근은 `@/lib/steampipe`의 `runQuery`만, SQL에 `$` 금지. 대시보드 캐시 워머에는 넣지 않는다
- 가격표 갱신: `python3 scripts/tools/build-price-table.py` 실행 후 JSON·`price-as-of.ts` 커밋. CSV는 저장소 밖 임시 폴더에 두고 커밋하지 않는다
- 런타임 산출물은 `data/cost-radar/` (git 제외)

---

# Cost Radar Module (English)

## Role
Server logic of Cost Radar: estimates the fixed monthly cost (730 h) of switched-on resources and builds cleanup recommendations. A Seoul on-demand price table is bundled in the app (the Pricing API is SCP-blocked) and pure functions compute monthly cost. Guidance only — nothing here changes an AWS resource.

## Files
- `types.ts` — shared types (incl. `Recommendation.note`: `maybe-scaled-to-zero` | `managed-instance`, `Row`, `RawInventory`)
- `pricing.ts` — `HOURS_PER_MONTH`, `priceAsOf()` and nine `price*` functions returning `{monthly}` or `{monthly:null, reason}`; `priceRds({stopped:true})` prices storage only
- `prices.ap-northeast-2.json` — generated price table (do not edit by hand)
- `price-as-of.ts` — generated `PRICE_AS_OF` constant (price list date); client code imports this, not the JSON
- `collect.ts` — `collectInventory(accountId, {runQuery?})`: one Steampipe query per table (11), at most 4 in flight per account (`MAX_CONCURRENT_QUERIES`), failures recorded in `errors`, never throws; `runQuery` injectable for tests
- `estimate.ts` — `buildEstimate(invs, scope)`: raw rows -> priced resources, category totals and warnings. Auto-assigned public IPv4 (skipped when it is an EIP) and one IPv4 per AZ of internet-facing ALB/NLB are priced as `public-ip`; stopped RDS pays storage only; a target-group query failure becomes a `loadbalancer` warning. `collectionFailed(inv)` (all 8 categories failed)
- `recommend.ts` — seven cleanup rules (`recommend`, `summarizeSavings`, `parseStateTransitionTime`). De-duplicated by resource id (only the larger saving counts); gp2->gp3 on a long-stopped instance's EBS is excluded from the total; TG/LB rules are skipped when the target-group query failed; no LB in an account is flagged empty if any TG there has an unreadable LB link; office hours on ASG/EKS/ECS-owned EC2 gets `managed-instance` and is not counted; delete/terminate commands are preceded by a snapshot/AMI command; office hours has no command (the page shows a scheduling guide). Year-end compare uses KST today to Dec 31 (today excluded) / 30.4
- `creators.ts` — `lookupCreators(items)`: creator via CloudTrail `LookupEvents`; only the create event matching the id shape counts (`vol-` -> CreateVolume, ...); 1 request/s per account; target accounts via `AWSopsReadOnlyRole` + External ID; cache `creators.json` (found forever, unknown retried after 24 h); never throws
- `history.ts` — daily history (`history.json`, one entry per account per KST day, 90 days). An entry recorded with warnings is `partial` (may be replaced the same day, never a trend baseline). `trendFor(hist, live per-account monthly, now)` compares with the entries exactly 7 days earlier. `recordDailyIfMissing(now?, deps?)`: collects only accounts lacking a complete entry for today, one account at a time; never throws, de-duplicates overlapping runs, skips accounts whose every category failed. Called fire-and-forget (60 s cap) from the health monitor's 5-min loop
- `store.ts` — JSON read / atomic write under `data/cost-radar/` (`COST_RADAR_DATA_DIR` overrides it in tests)
- `radar.ts` — `buildRadarResponse(accountId, deps)` (injected deps, accounts collected sequentially, `RadarCollectionError` -> 500 and not cached when every category of every account failed, no trend while there are warnings), `getRadarResponse` (5-min per-account cache, failures not cached), `parseCreatorIds` (max 50, splits on first two colons only), `RadarInputError` (400)
- `__tests__/*.test.ts` — unit tests (vitest: pricing, collect, estimate, recommend, creators, history, api)
- Generator: `scripts/tools/build-price-table.py` (public bulk price-list CSVs, stdlib only, run locally and commit the JSON and `price-as-of.ts`)

## Rules
- Non-Seoul region -> `other-region`; unknown type/engine -> `unknown-type`; non-Linux EC2 -> `non-linux`; dedicated tenancy -> `dedicated` (excluded from totals and surfaced in the UI)
- gp3 bills only IOPS/throughput above the 3000 / 125 MB/s baseline. Snapshots use volume size (upper bound). LB excludes LCU. Aurora storage (usage-based) is not added. ElastiCache uses Redis rates (Valkey is ~20% cheaper)
- DB access only via `runQuery` from `@/lib/steampipe`; no `$` in SQL. Not part of the dashboard cache warmer
- Refresh: run the script and commit the JSON and `price-as-of.ts`; keep the CSVs in a temp dir outside the repo
- Runtime data lives in `data/cost-radar/` (git-ignored)
