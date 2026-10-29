// Korean README for the downloaded bundle / 내려받는 묶음의 한국어 README
import type { ExcludeReason, JobRecord } from './types';
import { LAMBDA_PLACEHOLDER } from './rules';

// Korean label for each exclusion reason / 제외 이유별 한국어 문구
export const EXCLUDE_LABEL: Record<ExcludeReason, string> = {
  'attached-to-instance': '서버에 포함됨',
  unsupported: '지원 안 함',
  'over-limit': '개수 초과',
  'other-region': '다른 리전',
  shared: '다른 곳에서도 씀 — 포함 안 함, ID 그대로 남음',
  managed: 'AWS가 관리하는 리소스',
  'service-role': 'AWS 서비스 연결 역할',
};

const LEVEL_LABEL = {
  refactored: '참조·이름·레이어 정리까지 끝난 묶음',
  named: '이름과 파일만 정리한 묶음 (참조 바꾸기를 적용하면 plan이 통과하지 않아 ID를 그대로 둠)',
  raw: '생성된 원본 모양 묶음 (정리하면 plan이 통과하지 않아 원본 모양 그대로 둠)',
} as const;

// Build README.md text / README.md 내용 만들기
export function buildReadme(job: JobRecord, files: string[]): string {
  const passed = job.results.filter(r => r.outcome !== 'failed');
  const failed = job.results.filter(r => r.outcome === 'failed');
  const ignored = job.results.filter(r => r.outcome === 'pass-ignore');
  const hasSecrets = files.includes('terraform.tfvars.example');
  const L: string[] = [];
  L.push('# Terraform 코드 변환 결과', '');
  L.push(`- 계정: ${job.accountId}`, `- 리전: ${job.region}`, `- 만든 시각: ${job.finishedAt ?? job.startedAt}`);
  if (job.bundleLevel) L.push(`- 묶음 단계: ${job.bundleLevel} — ${LEVEL_LABEL[job.bundleLevel]}`);
  L.push(`- 가져올 리소스: ${passed.length}개`, '');
  L.push('> 이 코드는 지금 AWS 상태를 그대로 옮긴 거예요. `plan`에서 바꿀 것이 0개인지 꼭 확인한 뒤에만 `apply`하세요.', '');

  L.push('## 쓰는 법', '');
  let n = 1;
  if (hasSecrets) L.push(`${n++}. \`terraform.tfvars.example\`을 \`terraform.tfvars\`로 복사하고 \`CHANGE_ME\`를 실제 값으로 채웁니다.`);
  L.push(`${n++}. \`terraform init\``);
  L.push(`${n++}. \`terraform plan\` 결과의 마지막 줄이 다음과 같은지 확인합니다.`, '', '   ```', `   Plan: ${passed.length} to import, 0 to add, 0 to change, 0 to destroy.`, '   ```', '');
  L.push(`${n++}. 위와 같을 때만 \`terraform apply\`로 리소스를 state에 가져옵니다. AWS 리소스는 바뀌지 않습니다.`, '');
  L.push('`add`, `change`, `destroy` 중 하나라도 0이 아니면 `apply`하지 마세요.', '');
  if (hasSecrets) {
    L.push('## 비밀 값 (CHANGE_ME)', '');
    L.push('비밀번호·토큰 같은 값과 Lambda 환경 변수 값은 묶음에 넣지 않았습니다. `sensitive = true` 변수로 바뀌어 있습니다.');
    L.push('`CHANGE_ME`를 실제 값으로 채우기 전까지는 `plan`에 그 속성의 변경이 나옵니다. 그 상태로 `apply`하면 실제 값이 `CHANGE_ME`로 바뀌니 꼭 먼저 채우세요.', '');
  }

  L.push('## 파일', '');
  for (const f of files) L.push(`- \`${f}\``);
  L.push('');

  L.push('## 빠진 리소스', '');
  if (!job.excluded.length && !failed.length) L.push('없음');
  for (const e of job.excluded) L.push(`- ${e.nodeType} \`${e.name}\` — ${EXCLUDE_LABEL[e.reason] ?? e.reason}`);
  for (const r of failed) L.push(`- ${r.tfType} \`${r.name}\` — ${r.reason ?? '실패'}`);
  L.push('');

  L.push('## ignore 사용 목록', '');
  L.push('아래 속성은 `lifecycle { ignore_changes = [...] }`로 비교에서 뺐습니다. 이 속성은 Terraform이 관리하지 않습니다.', '');
  if (!ignored.length) L.push('없음');
  for (const r of ignored) L.push(`- \`${r.address}\`: ${(r.ignored ?? []).join(', ')}`);
  L.push('');

  if (files.includes(LAMBDA_PLACEHOLDER)) {
    L.push('## Lambda 코드', '');
    L.push(`\`${LAMBDA_PLACEHOLDER}\`는 빈 자리표시 파일입니다. 함수 코드는 이 묶음에 들어 있지 않습니다.`);
    L.push('실제 코드는 콘솔이나 `aws lambda get-function`의 `Code.Location`에서 따로 받아야 합니다. `filename`과 `source_code_hash`는 ignore 처리되어 있어 코드는 바뀌지 않습니다.', '');
  }
  return L.join('\n');
}
