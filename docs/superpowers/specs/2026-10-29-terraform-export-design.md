# 콘솔에서 만든 리소스를 Terraform 코드로 변환 — 설계

> 상태: 기본안으로 진행. 사용자가 "기본안 ㄱㄱ"로 요청했다. 아래 "내 판단"은 모두 빌더(나)의 결정이다.
> 빌더 검토 반영: 6장 (자격 증명 갱신, 안전 근거, user_data, 작업 폴더 비밀, 참조 순환, 리전, 시드, 큐) — 모두 내 판단.
> 관련: ADR-012 (의존성 그래프), 신규 ADR-014 (diff-0 관문 + 규칙 우선·AI 보조 수정)

## 1. 왜 만드나

팀 프로젝트 리소스는 대부분 콘솔에서 손으로 만들었다. 인수인계나 IaC 학습을 하려면 "지금 있는 그대로"를 코드로 옮겨야 한다. 손으로 옮기면 빠뜨리거나 틀리기 쉽다. 틀린 코드를 `apply`하면 실제 리소스가 바뀐다.

이 기능은 다음을 한다.
1. 고른 리소스의 원본 설정을 `terraform plan -generate-config-out`으로 뽑는다.
2. 규칙으로 고치고, 그래도 안 되면 AI로 고친다.
3. 하드코딩된 ID를 참조로 바꾸고 레이어별 파일로 정리한다.
4. **`terraform plan`이 "가져오기만 있고 바꿀 것 0개"(diff 0)일 때만 통과**시킨다.

통과율이 그대로 이 기능의 품질 지표다.

### 서버에서 미리 해 본 결과 (2026-10-29, 읽기 전용)
조건: Terraform 1.9.8, AWS provider 5.100.0, 샌드박스 계정에서 종류마다 1개씩 14개.
- 그대로: plan 오류 18개, 통과 0개.
- null 값 지우기 + 오류 줄 규칙 수정 4회: 오류 5개로 줄었다. 남은 것은 로드밸런서 `subnet_mapping`/`subnets` 충돌, Lambda 코드 파일 없음.
- 위 두 가지를 종류별 규칙으로 고치기: 오류 0개. **14개 중 13개 diff 0.** 남은 1개는 EC2 `user_data` 해시가 다른 경우.

결론: 대부분은 규칙만으로 되고, AI는 남은 꼬리를 맡으면 된다.

### 목표
- 리소스 고르기: 의존성 그래프의 프로젝트 미리보기(태그·이름 접두어·VPC)를 재사용한다. 개별 리소스를 검색해서 고를 수도 있다.
- 변환 파이프라인: 원본 뽑기 → 규칙 수정 → AI 수정(최대 3회) → diff 검사 → 참조로 바꾸기·이름 정리 → 다시 diff 검사.
- 결과:
  - `.zip` 내려받기
  - 화면에서 파일 보기
  - 리소스별 통과 여부와 이유
- 지표:
  - 규칙만으로 통과한 비율, AI 수정 후 통과한 비율
  - 순수 diff 0과 `ignore_changes`를 쓴 diff 0을 따로 센다
  - 종류별 통과율
- `/terraform-export` 화면, `/api/terraform-export`, 설치 스크립트 `scripts/18-setup-terraform.sh`, ADR-014.

### 하지 않는 것
- **`terraform apply`, `import`, `state`, `destroy`는 절대 실행하지 않는다.** 실행 허용 목록은 `version`, `init`, `plan`, `show`, `validate`, `fmt`뿐이다.
- 원격 backend, state 파일 만들기.
- 자식 모듈 만들기. v1은 레이어별 파일 분리(`network.tf`, `security.tf`, `compute.tf`, `data.tf`, `iam.tf`, `edge.tf`)까지만 한다. 자식 모듈은 후속 과제다.
- 한 번에 여러 계정 섞기. 작업 하나는 계정 하나다.
- Slack 연동.
- 그래프 15종 + 로드밸런서 리스너 밖의 리소스. ECS, EKS, Route 53, 라우팅 테이블, NACL, VPC 엔드포인트는 다루지 않는다.

### 반대 목표 (기술적으로는 돌아가도 실패인 것)
- **diff가 0이 아닌 코드를 "통과"로 내주는 것.** 통과하지 못한 리소스는 결과 코드에서 빼고 이유를 보여 준다. 결과 묶음 전체에 대한 마지막 plan도 diff 0이어야 한다.
- **비밀 값이 새는 것.** 대상은 Lambda 환경 변수 값, EC2 `user_data`, 그리고 이름에 `password|secret|token|credential|privatekey|apikey`가 들어간 값이다.
  - AI에게 보내지 않는다.
  - 내려받는 파일에 넣지 않는다. 대신 `sensitive` 변수와 `terraform.tfvars.example`(값 `CHANGE_ME`)로 바꾼다.
  - diff 검사에 필요한 실제 값은 작업 폴더 안 `secrets.auto.tfvars`에만 잠시 두고, 작업이 끝나면 지운다.
- **AI가 위험한 코드를 끼워 넣는 것.** AI 출력에는 다음이 있으면 안 되고, 있으면 그 수정을 버린다.
  - `provisioner`, `local-exec`, `remote-exec`, `external`/`http` data source
  - 새 `provider`, `module`, `terraform` 블록
  - 원래 없던 리소스 주소
- **서버를 느리게 만드는 것.** 작업은 프로세스 전체에서 한 번에 하나만, 낮은 우선순위(`nice -n 10`)로 돌린다.

## 2. 내 판단 (기본값)

### 이름
- 모듈 `src/lib/tf-export/`, 화면 `/terraform-export`. 사이드바 "네트워크/CDN"의 의존성 그래프 다음에 둔다. 이름은 "Terraform 코드 변환"이다.
- API `/api/terraform-export`, 데이터 `data/tf-export/`(git 제외).

### 도구 설치 (`scripts/18-setup-terraform.sh`, 서버에서 실행)
- Terraform **1.9.8**, `linux_arm64` 또는 `linux_amd64`(uname으로 고름).
- `releases.hashicorp.com`에서 zip과 `SHA256SUMS`를 받아 체크섬을 확인한다. 체크섬이 다르면 중단한다.
- 설치 위치: `/home/ec2-user/awsops/.tools/terraform` (git 제외).
- AWS provider **5.100.0** 고정. 플러그인 캐시는 `data/tf-export/plugin-cache`이고, 스크립트가 미리 `init`해 둔다.
- 앱은 `.tools/terraform`이 없으면 화면·API에서 "설치가 필요해요: scripts/18-setup-terraform.sh"를 보여 주고 아무것도 실행하지 않는다.
- `03-build-deploy.sh`는 바꾸지 않는다. 설치는 사용자가 한 번만 직접 실행한다.

### 리소스 → Terraform 종류와 가져오기 ID
| 그래프 종류 | Terraform 종류 | import id |
|---|---|---|
| vpc | aws_vpc | vpc id |
| subnet | aws_subnet | subnet id |
| sg | aws_security_group | sg id (규칙은 인라인으로 생성됨) |
| instance | aws_instance | instance id |
| lb (application/network) | aws_lb | ARN |
| (lb의 리스너) | aws_lb_listener | 리스너 ARN (Steampipe `aws_ec2_load_balancer_listener`로 조회) |
| tg | aws_lb_target_group | ARN |
| rds | aws_db_instance | identifier |
| lambda | aws_lambda_function | 함수 이름 |
| role | aws_iam_role | 역할 이름 |
| nat | aws_nat_gateway | nat id |
| eip | aws_eip | allocation id |
| ebs | aws_ebs_volume | volume id |
| s3 | aws_s3_bucket | 버킷 이름 |
| cloudfront | aws_cloudfront_distribution | distribution id |

- 빼는 것: ENI(서버·로드밸런서에 딸림), 서버에 붙은 EBS 볼륨("서버에 포함됨"으로 표시), classic LB(`clb`), AWS 서비스 연결 역할(path `/aws-service-role/`).
- 작업 하나에 최대 60개(리스너 포함). 넘으면 앞에서부터 60개까지 하고 나머지는 "개수 초과"로 표시한다.

### 파이프라인 (작업 하나)
작업 폴더는 `data/tf-export/jobs/<id>/`다. 단계 이름은 화면 진행 표시에 그대로 쓴다.

1. **`prepare`**: 다음 파일을 쓴다.
   - `providers.tf`: `required_version = "= 1.9.8"`, aws `= 5.100.0`, `provider "aws" { region = var.region }`
   - `variables.tf`: `region` 기본값 = 계정 리전
   - `imports.tf`: `import { to = <주소> id = "<id>" }` 블록들
   - 초기 주소 이름은 `<종류>_<번호>`(예: `aws_subnet.r3`)
   - 이어서 `terraform init`(플러그인 캐시 사용)을 실행한다.
2. **`generate`**: `terraform plan -generate-config-out=generated.tf`.
3. **`rules`**: 규칙 수정을 최대 4회 반복한다. 오류 수가 더 줄지 않으면 멈춘다.
   - null 값 줄 지우기.
   - 오류가 가리키는 줄이 기본값(`0`, `false`, `""`, `[]`, `{}`)이면 그 줄을 지운다.
   - 알려진 충돌 쌍에서 계산되는 쪽을 지운다: `availability_zone_id`, `secondary_private_ip_address_count`, `ipv6_address_count`, `cpu_core_count`, `cpu_threads_per_core`.
   - 필수 인자가 빠진 중첩 블록을 통째로 지운다.
   - `aws_lb`에 `subnets`가 있으면 `subnet_mapping` 블록을 지운다.
   - `aws_lambda_function`에 코드 출처가 없으면 `filename = "lambda-placeholder.zip"`(빈 zip을 같이 만듦)과 `lifecycle { ignore_changes = [filename, source_code_hash] }`를 넣는다. 이 리소스는 "ignore 사용"으로 센다.
   - 규칙 표는 코드 한 곳(`rules.ts`)에 모으고, 규칙마다 테스트를 둔다.
4. **`ai-fix`**: 오류가 남은 리소스만 다룬다. 최대 3회.
   - AI에게 그 리소스 블록(비밀 가림)과 오류 메시지를 주고, 고친 블록만 돌려받는다.
   - 같은 주소의 `resource` 블록 하나인지, 금지 구문이 없는지 확인한 뒤 바꿔 끼운다.
   - 3회 뒤에도 오류면 그 리소스와 import 블록을 빼고 "자동 수정 실패"로 표시한다.
5. **`diff`**: `terraform plan -out=plan.bin` 다음 `terraform show -json plan.bin`.
   - 리소스별 `change.actions`가 `["no-op"]`이고 `importing`이 있으면 통과다.
   - `update`, `replace`, `create`, `delete`가 있으면 실패다.
   - 실패한 리소스는 바뀌는 속성 경로와 원격 값을 AI에게 주고 최대 3회 고친다.
     - 허용하는 고침: 속성을 원격 값으로 맞추기, 속성 지우기.
     - `ignore_changes`는 허용 목록 속성(`user_data`, `user_data_base64`, `tags_all`)에만 쓸 수 있고, 쓰면 "ignore 사용"으로 센다.
   - 그래도 실패면 빼고 "diff가 남음(<속성들>)"으로 표시한다.
6. **`refactor`**: 결정적 단계이고 AI를 쓰지 않는다.
   - **참조 바꾸기**: 속성 값이 결과 묶음 안 다른 리소스의 ID나 ARN과 같으면 참조로 바꾼다. 예: `vpc_id = "vpc-0ab"` → `aws_vpc.main.id`, `role = "arn:…:role/x"` → `aws_iam_role.x.arn`, `target_group_arn` → `.arn`. 목록 안의 값도 바꾼다. 자기 자신은 참조하지 않는다.
   - **이름**: Name 태그나 리소스 이름으로 snake_case 이름을 만든다. 영문·숫자·밑줄만 쓰고, 숫자로 시작하면 `r_`를 붙이고, 겹치면 `_2`, `_3`을 붙인다. `imports.tf`의 `to`도 함께 바꾼다.
   - **레이어별 파일**:
     - `network.tf`: vpc, subnet, nat, eip
     - `security.tf`: sg
     - `compute.tf`: instance, ebs, lambda
     - `data.tf`: rds, s3
     - `iam.tf`: role
     - `edge.tf`: lb, listener, tg, cloudfront
   - **비밀 값 → 변수**: `variable "<이름>" { sensitive = true }`로 바꾸고, 실제 값은 `secrets.auto.tfvars`(작업 폴더 전용)에 쓴다.
   - `terraform fmt`.
7. **`verify`**: 정리된 묶음으로 `plan` + `show -json`을 다시 돌린다.
   - 모든 리소스가 통과해야 한다.
   - 실패한 리소스가 있으면 그 리소스의 참조 바꾸기를 되돌리고 한 번 더 확인한다.
   - 그래도 실패면 빼고 "정리 뒤 diff"로 표시한다. 최종 묶음은 항상 diff 0이다.
8. **`package`**: 묶음을 만들고 `secrets.auto.tfvars`를 지운다.
   - zip 안 파일: `providers.tf`, `variables.tf`, `imports.tf`, 레이어 파일들, `terraform.tfvars.example`, `lambda-placeholder.zip`(필요할 때), `README.md`, `report.json`.
   - `README.md`(한국어)에 들어갈 것:
     - 쓰는 법: `init` → `plan` 결과가 "N to import, 0 to add, 0 to change, 0 to destroy"인지 확인 → 그다음에만 `apply`로 state에 가져오기.
     - 빠진 리소스와 이유.
     - ignore 사용 목록.
     - Lambda 코드는 따로 받아야 한다는 안내.
   - zip은 의존성 없이 직접 만든다(저장 방식 zip, CRC32 직접 계산).

### AI 호출
- 모델 `getBedrockModelId()`, `invokeText`, `maxTokens: 4000`.
- 입력은 리소스 블록 하나 + 오류나 diff + 규칙 설명만 담는다. 상한 16,000자.
- 출력은 HCL 코드 블록 하나. 첫 번째 ```hcl 또는 ``` 블록만 쓴다.
- 사용량은 `recordAndSave`로 라우트 `terraform-export`에 기록한다.
- AI가 실패하거나 타임아웃이 나도 작업은 계속된다. 그 리소스만 실패로 표시한다.

### 실행
- Terraform은 `execFile`로만 부르고, 하위 명령 허용 목록을 코드에서 검사한다.
- 공통 플래그: `-input=false -no-color`.
- 환경 변수: `TF_IN_AUTOMATION=1`, `TF_INPUT=0`, `CHECKPOINT_DISABLE=1`, `TF_PLUGIN_CACHE_DIR`.
- 명령 하나에 10분 제한, 작업 전체에 30분 제한.
- 자격 증명:
  - 호스트 계정은 서버 기본 역할을 쓴다. 이 역할은 ReadOnlyAccess 외에 일부 쓰기 권한(리스너 수정, S3 PutObject 등)도 있으므로, **안전은 하위 명령 허용 목록과 인자 검사에 달려 있다**(아래 6장).
  - 다른 계정은 `accountCredentials(accountId, 'awsops-tf-export')`(읽기 전용 역할)의 키를 자식 프로세스 환경 변수로만 넘긴다. 로그에 남기지 않는다.
- 작업은 프로세스 전체에서 하나씩 돈다(promise 큐). 실행 중에 새로 시작하려 하면 429.
- 작업 폴더는 최근 20개만 남긴다. 서버를 재시작해서 중단된 작업은 `failed`(사유 "서버 재시작")로 표시한다.

### 지표 (`data/tf-export/stats.json`)
작업마다 다음을 저장하고 누적한다. 화면에 카드로 보여 준다.

- 전체 리소스 수.
- 단계별 통과 수:
  - `rules`까지: 규칙만으로 diff 0
  - `ai`까지: AI 수정 포함
  - `final`: 정리 뒤
- 순수 diff 0 / ignore 사용 / 실패.
- 종류별 통과율.
- AI 호출 수와 토큰.

### API (`/api/terraform-export`)
- `GET ?op=status` → `{ installed, version, running: jobId|null }`.
- `POST {op:'preview', accountId, seed}` → 고를 리소스 목록(종류, 이름, 포함/제외와 이유). `seed`는 `{tag:{key,value}}` | `{prefix}` | `{vpc:arn}` | `{arns:[...]}`(최대 60).
- `POST {op:'start', accountId, seed}` → 202 `{jobId}`. 실행 중이면 429, 미설치면 409.
- `GET ?op=job&id=` → 작업 상태(단계, 리소스별 결과, 지표).
- `GET ?op=list` → 최근 작업 20개.
- `GET ?op=file&id=&name=` → 결과 파일 하나(텍스트, 허용된 이름만).
- `GET ?op=download&id=` → zip(`Content-Disposition: attachment`).
- `GET ?op=stats` → 누적 지표.
- 공통: `force-dynamic`, `Cache-Control: no-store`. 500은 오류 이름만 돌려준다. 입력 검증 실패는 한국어 400 메시지.

### 화면 (`/terraform-export`)
- 위쪽에는 설치 상태를 보여 준다. 미설치면 안내 상자만 보인다.
- **1단계 고르기**: 탭(태그 / 이름 접두어 / VPC / 개별 검색).
  - "미리 보기"를 누르면 포함·제외 목록이 나온다.
  - 제외에는 이유가 붙는다: 서버에 포함됨, 지원 안 함, 개수 초과.
- **2단계 만들기**: "코드 만들기" 버튼을 누르면 단계 진행 표시가 나온다. 3초마다 상태를 확인한다.
- **3단계 결과**:
  - 지표 카드: 규칙만 / AI 후 / 최종 통과율, 순수·ignore·실패 수.
  - 리소스 표: 종류, 이름, 결과(✅ diff 0 / 🟡 ignore 사용 / ❌ 이유), 어느 단계에서 통과했는지.
  - 파일 보기: 파일 탭 + 코드.
  - 내려받기 버튼.
- 아래쪽: 지난 작업 목록, 누적 지표.
- 항상 보이는 안내: "이 코드는 지금 AWS 상태를 그대로 옮긴 거예요. `plan`에서 바꿀 것이 0개인지 꼭 확인한 뒤에만 `apply`하세요."

## 3. 평가
- **단위 테스트**:
  - 규칙 수정 하나하나
  - 참조 바꾸기, 이름 만들기, 레이어 나누기
  - 금지 구문 검사
  - plan JSON 해석(통과·실패 판정)
  - 비밀 값 가리기
  - zip 만들기(풀어서 내용 확인)
  - 실행 허용 목록
- 실제 Terraform은 테스트에서 부르지 않는다. 실행기는 주입식이다.
- **고정 입력 시험**: 서버에서 실제로 받은 `generated.tf`와 오류 로그 모양을 본뜬 고정 파일(계정 ID·이름은 가짜)로, 규칙 단계가 오류를 0으로 만드는지 확인한다.
- **실제 평가**: 배포 뒤(사용자 승인 필요) 샌드박스 계정에서 15종 전부를 60개씩 묶어 돌린다. 단계별·종류별 통과율을 ADR-014에 추가한다. 그전까지 ADR에는 1장의 사전 시험 수치(14개 중 규칙만으로 13개)만 적는다.

## 4. 빌더에게 남기는 것
- HCL을 다루는 방법. 줄·블록 단위 문자열 처리면 충분하다. 파서 의존성은 추가하지 않는다.
- 화면 세부 배치와 문구 다듬기.
- 규칙 표의 정확한 정규식.

## 5. 문서
- ADR-014: diff-0 관문, 규칙 우선·AI 보조, 실행 허용 목록, 비밀 처리.
  - 대안과 비교: AI가 처음부터 코드 작성, Terraformer, former2, 사람이 직접 작성.
  - 사전 시험 수치.
- `src/lib/tf-export/CLAUDE.md`, `src/components/tf-export/CLAUDE.md`.
- 루트 `CLAUDE.md`: 페이지, API, 컴포넌트, ADR 숫자와 18번 스크립트.
- `src/lib/CLAUDE.md`, `src/app/CLAUDE.md`, `src/components/CLAUDE.md`, `.gitignore`(`data/tf-export/`, `.tools/`).

## 6. 빌더 검토 반영 (내 판단, 위 내용보다 우선)

1. **다른 계정 자격 증명**: `accountCredentials`는 15분짜리 키를 캐시해서 다시 쓴다. 그래서 terraform 명령마다 **새로** AssumeRole한 키를 쓴다. `cloudtrail-access.ts`에 캐시를 거치지 않는 `freshCredentials(accountId, sessionName)`를 추가한다(DurationSeconds 900, 20초 abort). 다른 계정의 명령 제한은 12분이다.
2. **안전 근거**: 서버 역할이 완전한 읽기 전용은 아니다. 그래서 실행기는 다음을 지킨다.
   - 하위 명령은 `version|init|plan|show|validate|fmt`만 쓴다.
   - `plan`에는 `-out`, `-input=false`, `-no-color`, `-generate-config-out`, `-detailed-exitcode`, `-refresh=true`만 허용한다.
   - `apply`, `import`, `state`, `destroy`, `-auto-approve`, `-target`이 들어간 호출은 코드에서 거부하고, 테스트로 고정한다.
   - state 파일은 만들지 않는다. plan은 state를 쓰지 않는다.
   - ADR-014에도 이 사실을 그대로 적는다.
3. **user_data**: provider는 SHA1 해시만 돌려준다. 그래서 `user_data` 값이 40자리 16진수면 그 줄을 지우고 `lifecycle { ignore_changes = [user_data] }`를 넣는다("ignore 사용"으로 셈). 실제 스크립트 내용 가져오기(`DescribeInstanceAttribute`)는 후속 과제다.
4. **작업 폴더 비밀**: `package` 단계 끝에 지운다.
   - 대상: `generated.tf`, `plan.bin`, plan JSON, 명령 로그, `secrets.auto.tfvars`.
   - 남기는 것: 비밀이 변수로 바뀐 최종 묶음과 `report.json`.
   - AI에게 보내는 diff 값과 `report.json`에서는 비밀 패턴 키와 Lambda 환경 변수 값을 `[숨김]`으로 바꾼다.
5. **참조 순환·plan 전체 오류**: `verify`에서 plan 자체가 오류이면(순환 등) 참조 바꾸기를 **전부** 되돌리고 다시 확인한다. 그래도 오류면 `refactor` 전(이름·파일만 정리, ID 그대로) 묶음을 내준다. 그것도 실패하면 `generate`+`rules`+`ai`까지 통과한 원본 모양 묶음을 내준다. 내주는 묶음은 언제나 마지막 plan이 diff 0인 것이다.
6. **리전**: 작업 하나 = 계정 설정의 리전 하나. 전역 종류(role, cloudfront)는 그대로 쓴다. 그 밖에 리전이 다른 리소스(S3 포함)는 미리 보기에서 "다른 리전"으로 뺀다.
7. **시드**:
   - `tag`/`prefix`/`vpc`는 `previewProject`의 `{kind:'tag',key,value}` / `{kind:'prefix',prefix}` / `{kind:'vpc',arn}`로 그대로 넘긴다.
   - 포함 = `members`에서 ENI와 managed를 뺀 것.
   - `shared`는 "다른 곳에서도 씀 — 포함 안 함, ID 그대로 남음"으로 보여 준다.
   - `{arns:[...]}`는 그래프에서 직접 찾고 의존성을 끌어오지 않는다.
8. **동시 실행**: 큐 없이 한 번에 하나만 돈다. 실행 중이면 429. AI 호출은 `withCap` 120초로 감싼다(대기만 끊고 요청 자체는 남을 수 있음).
9. **Terraform 동작 메모**:
   - `-generate-config-out`은 `generate` 단계에서 한 번만 쓰고, 이후 plan에는 붙이지 않는다(파일이 있으면 거부함).
   - 리소스를 뺄 때는 import 블록도 같이 뺀다.
   - 바뀌는 속성은 plan JSON의 `before`/`after`를 직접 비교해서 구한다(`after_unknown` 값은 제외).
   - 이름을 바꿀 때는 state가 없으므로 `moved` 블록이 필요 없다. `imports.tf`의 `to`만 함께 바꾼다.
10. **sensitive 변수**: 내려받은 묶음은 `CHANGE_ME`를 실제 값으로 채우기 전까지 plan에 diff가 나온다. README에 그렇게 적는다.
11. **사용량 기록**: `recordAndSave({ route: 'terraform-export', gateway: 'bedrock', via: 'tf-export', question: '<종류> <주소> 수정', summary: '<결과>', userId: 요청자 이메일 또는 'system', usedTools: [], success, responseTimeMs, inputTokens, outputTokens, model: getBedrockModelLabel() })`.
