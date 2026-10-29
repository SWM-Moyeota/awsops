// Secrets → sensitive variables, and scrubbing for the AI / 비밀 값 → sensitive 변수, AI에 보내기 전 가리기
import { analyze, applyEdits, decodeHeredoc, decodeStr, hclString, type ValueLit } from './_scan';

// Key words that mark a secret value (spec) / 비밀 값을 뜻하는 키 단어 (설계서)
export const SECRET_KEY = /password|secret|token|credential|privatekey|apikey/i;
// Keys that match SECRET_KEY but hold references/settings, not secrets / SECRET_KEY에 걸리지만 비밀이 아닌 키 (ARN·ID·설정)
const NOT_SECRET_KEY = /(?:_arns?|_ids?)$|^http_tokens$/i;
// Placeholder shown instead of a secret / 비밀 대신 보여 줄 표시
export const HIDDEN = '[숨김]';

export interface SecretVar { name: string; value: string; address: string; path: string }

// True when a key names a secret (also `api_key`, `private-key`) / 키가 비밀을 뜻하면 true (`api_key`, `private-key` 포함)
export function isSecretKey(key: string): boolean {
  if (NOT_SECRET_KEY.test(key)) return false;
  return SECRET_KEY.test(key) || SECRET_KEY.test(key.replace(/[^A-Za-z0-9]/g, ''));
}

// True when a key chain is a secret spot (secret key or Lambda env) / 키 경로가 비밀 자리면 true (비밀 키 또는 Lambda 환경 변수)
function isSecretChain(chain: string[]): boolean {
  for (let i = 0; i < chain.length; i++) {
    if (isSecretKey(chain[i])) return true;
    if (chain[i] === 'environment' && chain[i + 1] === 'variables' && chain.length > i + 2) return true;
  }
  return false;
}

// Secret literals in the text / 텍스트 안의 비밀 리터럴
function secretLiterals(text: string): ValueLit[] {
  return analyze(text).values.filter(v => isSecretChain(v.chain));
}

// Literal token → its value / 리터럴 토큰 → 실제 값
const valueOf = (v: ValueLit) => (v.tok.k === 'heredoc' ? decodeHeredoc(v.tok.v) : decodeStr(v.tok.v));

// snake_case for variable names / 변수 이름용 snake_case
const snake = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

// Move secret values into `var.<name>` references / 비밀 값을 `var.<이름>` 참조로 옮기기
export function extractSecrets(text: string): { text: string; vars: SecretVar[] } {
  const used = new Set<string>(['region']);
  const vars: SecretVar[] = [];
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const v of secretLiterals(text)) {
    const value = valueOf(v);
    if (value === '') continue; // nothing to hide / 숨길 값 없음
    const address = v.address ?? '';
    const label = address ? address.slice(address.indexOf('.') + 1) : 'secret';
    const env = v.chain.length >= 3 && v.chain[0] === 'environment' && v.chain[1] === 'variables';
    let base = snake(env ? `${label}_env_${v.chain.slice(2).join('_')}` : `${label}_${v.chain.join('_')}`) || 'secret';
    if (!/^[a-z]/.test(base)) base = `v_${base}`;
    let name = base;
    for (let k = 2; used.has(name); k++) name = `${base}_${k}`;
    used.add(name);
    vars.push({ name, value, address, path: v.chain.join('.') });
    edits.push({ start: v.tok.start, end: v.tok.end, text: `var.${name}` });
  }
  return { text: applyEdits(text, edits), vars };
}

// variable blocks for secrets (sensitive, no default) / 비밀 변수 블록 (sensitive, 기본값 없음)
export function variablesTf(vars: SecretVar[]): string {
  return vars.map(v => [
    `variable "${v.name}" {`,
    `  description = ${hclString(`${v.address} ${v.path}`)}`,
    '  type        = string',
    '  sensitive   = true',
    '}',
    '',
  ].join('\n')).join('\n');
}

// terraform.tfvars.example with CHANGE_ME placeholders / CHANGE_ME 자리표시가 든 terraform.tfvars.example
export function tfvarsExample(vars: SecretVar[]): string {
  if (!vars.length) return '';
  return '# Fill in the real values, then rename to terraform.tfvars / 실제 값을 채운 뒤 terraform.tfvars로 이름을 바꾸세요\n'
    + vars.map(v => `${v.name} = "CHANGE_ME"`).join('\n') + '\n';
}

// secrets.auto.tfvars with real values (job folder only) / 실제 값이 든 secrets.auto.tfvars (작업 폴더 전용)
export function secretsTfvars(vars: SecretVar[]): string {
  if (!vars.length) return '';
  return vars.map(v => `${v.name} = ${hclString(v.value)}`).join('\n') + '\n';
}

// Hide secret values before sending text to the AI / AI에 보내기 전에 비밀 값 가리기
export function scrubForAi(text: string): string {
  const edits = secretLiterals(text).map(v => ({ start: v.tok.start, end: v.tok.end, text: `"${HIDDEN}"` }));
  return applyEdits(text, edits);
}

// Hide every leaf of a secret value / 비밀 값의 모든 잎 가리기
function hideAll(value: unknown): unknown {
  if (value === null || value === undefined || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(hideAll);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, hideAll(v)]));
  return HIDDEN;
}

// Scrub a report/diff value at a plan path like `environment.0.variables` / `environment.0.variables` 같은 경로의 리포트·diff 값 가리기
export function scrubValue(path: string, value: unknown): unknown {
  const chain = path.split(/[.[\]]+/).filter(s => s && !/^\d+$/.test(s));
  if (isSecretChain(chain)) return hideAll(value);
  if (Array.isArray(value)) return value.map(v => scrubValue(path, v));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrubValue(path ? `${path}.${k}` : k, v)]));
  }
  return value;
}
