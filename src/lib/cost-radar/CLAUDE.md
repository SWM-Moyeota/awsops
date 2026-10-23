# 비용 레이더 모듈

## 역할
Steampipe 리소스로부터 고정 비용(월 730h 환산)을 추정하는 "비용 레이더"의 기반. 서울 리전(ap-northeast-2) 온디맨드 가격표를 앱에 내장하고(Pricing API는 SCP로 차단), 순수 함수로 월 비용을 계산한다.

## 주요 파일
- `types.ts` — 공용 타입 (`CategoryId`, `UnpricedReason`, `PricedResource`, `Estimate`, `Recommendation`, `RadarResponse`, `CreatorInfo`, `Row`, `RawInventory` 등)
- `pricing.ts` — `HOURS_PER_MONTH=730`, `priceAsOf()`, `priceEc2/Ebs/Snapshot/PublicIp/Nat/Lb/VpcEndpoint/Rds/ElastiCache` — 반환은 `{monthly}` 또는 `{monthly:null, reason}`
- `prices.ap-northeast-2.json` — 생성된 가격표 (직접 수정 금지)
- `recommend.ts` — 정리 추천 규칙 7종 (`recommend`, `summarizeSavings`, `parseStateTransitionTime`). 리소스 ID 기준 중복 제거(큰 절약액만 합계 포함), 멈춘 EC2에 붙은 EBS의 gp2→gp3는 합계 제외, 타겟 그룹 조회 실패 시 TG/LB 규칙 생략, 연말 비교는 KST 오늘~12/31 일수(오늘 제외) ÷ 30.4
- `__tests__/pricing.test.ts`, `__tests__/recommend.test.ts` — 단위 테스트 (vitest)
- 생성 스크립트: `scripts/tools/build-price-table.py` (AWS 공개 일괄 가격표 CSV, 표준 라이브러리만, 로컬 실행 후 JSON 커밋)

## 규칙
- 서울 외 리전 → `other-region`, 가격표에 없는 타입/엔진 → `unknown-type`, 리눅스 아닌 EC2 → `non-linux`, 전용 테넌시 → `dedicated` (합계에서 제외하고 화면에 표시)
- gp3는 기본 3000 IOPS / 125 MB/s 초과분만 과금. 스냅샷은 볼륨 크기 기준 상한값. LB는 LCU 제외. RDS Aurora 스토리지는 사용량 기반이라 미포함. ElastiCache는 Redis 단가 기준(Valkey는 약 20% 저렴)
- 가격표 갱신: `python3 scripts/tools/build-price-table.py` 실행 후 JSON 커밋. CSV는 저장소 밖 임시 폴더에 두고 커밋하지 않는다
- 런타임 산출물은 `data/cost-radar/` (git 제외)

---

# Cost Radar Module (English)

## Role
Foundation of Cost Radar: estimates fixed monthly cost (730 h) of running resources. A Seoul on-demand price table is bundled in the app (the Pricing API is SCP-blocked) and pure functions compute monthly cost.

## Files
- `types.ts` — shared types (incl. `Row`, `RawInventory`)
- `pricing.ts` — `HOURS_PER_MONTH`, `priceAsOf()` and nine `price*` functions returning `{monthly}` or `{monthly:null, reason}`
- `prices.ap-northeast-2.json` — generated price table (do not edit by hand)
- `recommend.ts` — seven cleanup rules (`recommend`, `summarizeSavings`, `parseStateTransitionTime`). De-duplicated by resource id (only the larger saving counts), gp2->gp3 on a long-stopped instance's EBS is excluded from the total, TG/LB rules are skipped when the target-group query failed, year-end compare uses KST today to Dec 31 (today excluded) / 30.4
- `__tests__/pricing.test.ts`, `__tests__/recommend.test.ts` — unit tests
- Generator: `scripts/tools/build-price-table.py` (public bulk price-list CSVs, stdlib only, run locally and commit the JSON)

## Rules
- Non-Seoul region -> `other-region`; unknown type/engine -> `unknown-type`; non-Linux EC2 -> `non-linux`; dedicated tenancy -> `dedicated` (excluded from totals and surfaced in the UI)
- gp3 bills only IOPS/throughput above the 3000 / 125 MB/s baseline. Snapshots use volume size (upper bound). LB excludes LCU. Aurora storage (usage-based) is not added. ElastiCache uses Redis rates (Valkey is ~20% cheaper)
- Refresh: run the script and commit the JSON; keep the CSVs in a temp dir outside the repo
- Runtime data lives in `data/cost-radar/` (git-ignored)
