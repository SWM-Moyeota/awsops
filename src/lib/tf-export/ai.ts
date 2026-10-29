// AI fixer: asks Bedrock for a replacement block, then validates it strictly / AI 수정기: 대체 블록을 받고 엄격히 검증
import { invokeText } from '@/lib/ai/bedrock';
import { recordAndSave } from '@/lib/ai/stats';
import { getBedrockModelId, getBedrockModelLabel } from '@/lib/app-config';
import { withCap } from '@/lib/with-cap';
import { scrubForAi } from './secrets';

const PROMPT_CAP = 16_000;
const PROBLEM_CAP = 4_000;
const CALL_CAP_MS = 120_000;
const ALLOWED_IGNORE = ['user_data', 'user_data_base64', 'tags_all'];
// Extra ignore_changes entries per resource type (the lambda placeholder rule) / 종류별 추가 허용 (Lambda 자리표시 규칙)
const TYPE_IGNORE: { [type: string]: string[] } = { aws_lambda_function: ['filename', 'source_code_hash'] };

// System prompt with the fixing rules / 수정 규칙을 담은 시스템 프롬프트
export const FIX_SYSTEM_PROMPT = `You fix ONE Terraform resource block so that "terraform plan" shows no changes. / Terraform 리소스 블록 하나를 고쳐 plan에 변경이 없게 만든다.
Rules / 규칙:
- Fix only this block. Keep the same resource "<type>" "<name>" label. / 이 블록만 고치고 resource "<type>" "<name>" 라벨은 그대로 둔다.
- Return exactly one \`\`\`hcl code block and nothing else of value. / \`\`\`hcl 코드 블록 하나만 돌려준다.
- Never add provisioners, providers, modules, terraform blocks or data sources. / provisioner, provider, module, terraform 블록, data source는 추가하지 않는다.
- Prefer deleting computed or conflicting attributes, or matching the remote value. / 계산되는 속성이나 충돌하는 속성을 지우거나 원격 값에 맞추는 쪽을 택한다.
- lifecycle.ignore_changes may list only user_data, user_data_base64, tags_all (plus filename, source_code_hash for aws_lambda_function) and entries already in the given block; keep those existing entries. / lifecycle.ignore_changes에는 user_data, user_data_base64, tags_all(aws_lambda_function은 filename, source_code_hash도)과 받은 블록에 이미 있던 항목만 쓸 수 있고, 있던 항목은 그대로 둔다.
- Values shown as [숨김] are redacted; keep references or leave them out. / [숨김]은 가려진 값이다.`;

// Take the first ```hcl (or plain ```) block / 첫 번째 ```hcl 또는 ``` 블록만 꺼낸다
export function extractHcl(answer: string): string | null {
  const m = answer.match(/```(?:hcl|terraform)?[ \t]*\r?\n([\s\S]*?)```/);
  return m ? m[1].trim() : null;
}

// Split top-level blocks by brace depth, skipping strings and comments / 문자열·주석을 건너뛰며 최상위 블록을 나눈다
function topLevelHeaders(src: string): string[] | null {
  const heads: string[] = [];
  let depth = 0, i = 0, start = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') { i++; while (i < src.length && src[i] !== '"') { if (src[i] === '\\') i++; else if (src[i] === '$' && src[i + 1] === '{') { let d = 1; i += 2; while (i < src.length && d) { if (src[i] === '{') d++; else if (src[i] === '}') d--; i++; } continue; } i++; } i++; continue; }
    if (c === '#' || (c === '/' && src[i + 1] === '/')) { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); if (e < 0) return null; i = e + 2; continue; }
    if (c === '<' && src[i + 1] === '<' && depth > 0) {
      const h = src.slice(i).match(/^<<-?\s*([A-Za-z_][A-Za-z0-9_]*)\r?\n/);
      if (h) { const e = src.indexOf('\n', i + h[0].length); let p = i + h[0].length; let found = -1; while (p <= src.length) { const nl = src.indexOf('\n', p); const line = src.slice(p, nl < 0 ? src.length : nl); if (line.trim() === h[1]) { found = p + line.length; break; } if (nl < 0) break; p = nl + 1; } void e; if (found < 0) return null; i = found; continue; }
    }
    if (c === '{') { if (depth === 0) heads.push(src.slice(start, i).trim()); depth++; }
    else if (c === '}') { depth--; if (depth < 0) return null; if (depth === 0) start = i + 1; }
    i++;
  }
  if (depth !== 0) return null;
  if (src.slice(start).trim()) return null; // trailing junk / 뒤에 남은 내용
  return heads;
}

// Blank out string literals and comments so only code remains / 문자열·주석을 비워 코드만 남긴다
function stripStrings(src: string): string {
  return src.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/(#|\/\/)[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

// ignore_changes lists in a block: attribute names, or null for a non-list form / 블록의 ignore_changes 목록 (목록이 아니면 null)
function ignoreLists(text: string): string[][] | null {
  const out: string[][] = [];
  const re = /ignore_changes\s*=\s*(\[[^\]]*\]|[^\n]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const list = m[1].trim().match(/^\[([^\]]*)\]/);
    if (!list) return null;
    out.push(list[1].split(/[,\s]+/).map((s: string) => s.trim().replace(/^"|"$/g, '')).filter(Boolean));
  }
  return out;
}

// Validate an AI block for the given address; `original` is the block we sent / 주소에 대한 AI 블록 검증; original은 보낸 블록
export function validateFix(block: string, address: string, original?: string): { ok: true; block: string } | { ok: false; reason: string } {
  const text = block.normalize('NFKC').trim();
  if (!text) return { ok: false, reason: '빈 응답' };
  if (/provisioner|local-exec|remote-exec/.test(text)) return { ok: false, reason: '금지된 구문(provisioner)' };
  if (/data\s+"(external|http)"/.test(text)) return { ok: false, reason: '금지된 데이터 소스' };
  if (/^\s*(provider|module|terraform)\b/m.test(text)) return { ok: false, reason: '금지된 블록(provider/module/terraform)' };
  if (/[^\x00-\x7F]/.test(stripStrings(text))) return { ok: false, reason: '식별자에 비ASCII 문자' };
  if (/^\s*(count|for_each)\s*=/m.test(text)) return { ok: false, reason: 'count/for_each 불허' };
  if (/prevent_destroy/.test(text)) return { ok: false, reason: 'prevent_destroy 불허' };
  const heads = topLevelHeaders(text);
  if (!heads) return { ok: false, reason: 'HCL 구조 오류' };
  if (heads.length !== 1) return { ok: false, reason: '리소스 블록이 정확히 하나여야 함' };
  const h = heads[0].match(/^resource\s+"([^"]+)"\s+"([^"]+)"$/);
  if (!h) return { ok: false, reason: 'resource 블록이 아님' };
  if (`${h[1]}.${h[2]}` !== address) return { ok: false, reason: '다른 리소스 주소' };
  const lists = ignoreLists(text);
  if (!lists) return { ok: false, reason: 'ignore_changes 형식 불허' };
  // Allowed: the base list, per-type extras, and entries the original block already had / 기본 목록, 종류별 추가, 원래 블록에 있던 항목
  const allowed = new Set([...ALLOWED_IGNORE, ...(TYPE_IGNORE[h[1]] ?? []), ...(original ? (ignoreLists(original.normalize('NFKC')) ?? []).flat() : [])]);
  const bad = lists.flat().find((a: string) => !allowed.has(a));
  if (bad) return { ok: false, reason: `ignore_changes 불허 속성: ${bad}` };
  return { ok: true, block: text };
}

export interface AiFixInput {
  address: string; block: string;
  problem: { kind: 'error'; messages: string[] } | { kind: 'diff'; changes: Array<{ path: string; remote: unknown }> };
  userId?: string;
}
export interface AiFixResult { ok: boolean; block?: string; reason?: string; inputTokens: number; outputTokens: number }
type Invoke = typeof invokeText;
type Record = typeof recordAndSave;

// Build the scrubbed prompt: problem kept whole (cap 4,000), block truncated first, total <= 16,000 / 문제 부분은 보존, 블록을 먼저 줄임
function buildPrompt(i: AiFixInput): string {
  const problemRaw = i.problem.kind === 'error'
    ? `Plan errors / plan 오류:\n${i.problem.messages.join('\n')}`
    : `Attributes that differ (remote value) / 달라지는 속성(원격 값):\n${i.problem.changes.map((c) => `- ${c.path}: ${JSON.stringify(c.remote) ?? 'null'}`).join('\n')}`;
  const problem = scrubForAi(problemRaw).slice(0, PROBLEM_CAP);
  const head = `Address: ${i.address}\n\nCurrent block:\n\`\`\`hcl\n`;
  const tail = `\n\`\`\`\n\n${problem}`;
  const room = Math.max(0, PROMPT_CAP - head.length - tail.length);
  return head + scrubForAi(i.block).slice(0, room) + tail;
}

// Ask the AI for one validated replacement block / 검증된 대체 블록 하나를 AI에 요청
export async function aiFix(input: AiFixInput, deps: { invoke?: Invoke; record?: Record } = {}): Promise<AiFixResult> {
  const invoke = deps.invoke ?? invokeText;
  const record = deps.record ?? recordAndSave;
  const t0 = Date.now();
  const finish = (ok: boolean, reason: string, tokens: { inputTokens: number; outputTokens: number }, block?: string): AiFixResult => {
    try {
      record({ route: 'terraform-export', gateway: 'bedrock', via: 'tf-export', question: `${input.address.split('.')[0]} ${input.address} 수정`, summary: ok ? 'ok' : reason, userId: input.userId || 'system', usedTools: [], success: ok, responseTimeMs: Date.now() - t0, inputTokens: tokens.inputTokens, outputTokens: tokens.outputTokens, model: getBedrockModelLabel() });
    } catch { console.error('[tf-export] RecordFailed'); }
    return ok ? { ok, block, ...tokens } : { ok, reason, ...tokens };
  };
  let res;
  try {
    const prompt = buildPrompt(input);
    res = await withCap(() => invoke({ modelId: getBedrockModelId(), system: FIX_SYSTEM_PROMPT, messages: [{ role: 'user', content: prompt }], maxTokens: 4000 }), CALL_CAP_MS);
  } catch (e) {
    console.error('[tf-export] AiFixFailed', e instanceof Error ? e.name : 'Error');
    return finish(false, e instanceof Error && e.name === 'Timeout' ? 'AI 시간 초과' : 'AI 호출 실패', { inputTokens: 0, outputTokens: 0 });
  }
  const tokens = { inputTokens: res.inputTokens, outputTokens: res.outputTokens };
  const hcl = extractHcl(res.content);
  if (!hcl) return finish(false, 'AI 응답에 코드 블록 없음', tokens);
  const v = validateFix(hcl, input.address, input.block);
  return v.ok ? finish(true, '', tokens, v.block) : finish(false, v.reason, tokens);
}
