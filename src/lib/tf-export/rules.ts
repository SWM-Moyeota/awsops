// Deterministic cleanup rules for `plan -generate-config-out` output (spec §2 step 3, §6.3) / 생성된 설정을 고치는 결정적 규칙 (설계 §2 3단계, §6.3)
import {
  splitResources, removeLines, nestedBlocks, attributeLines, lineFacts,
  removeNestedBlock, insertIntoResource, setLifecycleIgnore,
} from './hcl';

// One parsed `Error:` block; `relative` = line counts from the resource's opening line (generate step) / 파싱된 오류 하나; relative면 줄 번호가 리소스 여는 줄 기준 (generate 단계)
export interface PlanError { title: string; address?: string; line?: number; file?: string; relative?: boolean; detail: string }

// Every rule, in the order applied / 모든 규칙 (적용 순서)
export const RULE_IDS = [
  'drop-null', 'default-value', 'conflict-computed', 'empty-required-block',
  'lb-subnet-mapping', 'lambda-placeholder', 'instance-user-data-hash', 'instance-replace-flag',
] as const;
export type RuleId = typeof RULE_IDS[number];

// Placeholder code file for Lambda functions without a code source / 코드 출처가 없는 Lambda용 자리표시 파일
export const LAMBDA_PLACEHOLDER = 'lambda-placeholder.zip';
// Computed side of known conflict pairs / 알려진 충돌 쌍에서 계산되는 쪽
const COMPUTED_CONFLICT = ['availability_zone_id', 'secondary_private_ip_address_count', 'ipv6_address_count', 'cpu_core_count', 'cpu_threads_per_core'];
const CODE_SOURCES = ['filename', 'image_uri', 's3_bucket'];

const NULL_LINE = /^\s*[A-Za-z_][\w-]*\s*=\s*null\s*((#|\/\/).*)?$/;
const DEFAULT_LINE = /^\s*[A-Za-z_][\w-]*\s*=\s*(0|false|""|\[\]|\{\})\s*((#|\/\/).*)?$/;
const HASH_USER_DATA = /^\s*user_data\s*=\s*"[0-9a-fA-F]{40}"\s*((#|\/\/).*)?$/;
const EMPTY_LIST = /=\s*\[\s*\]\s*((#|\/\/).*)?$/;
const REPLACE_FLAG_IGNORED = /ignore_changes\s*=\s*\[[^\]]*\buser_data_replace_on_change\b/;

// Parse `Error:` blocks from plan output (plain or box-drawn, ANSI stripped) / plan 출력에서 오류 블록 파싱 (일반·상자 형식, ANSI 제거)
export function parsePlanErrors(log: string): PlanError[] {
  const out: PlanError[] = [];
  let cur: string[] | null = null;
  const flush = () => { if (cur) out.push(parseBlock(cur)); cur = null; };
  for (const rawLine of log.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) {
    if (/^\s*╵/.test(rawLine)) { flush(); continue; }
    const l = rawLine.replace(/^[│╷]\s?/, '');
    const m = /^Error: (.*)$/.exec(l);
    if (m) { flush(); cur = [m[1]]; continue; }
    if (/^Warning: /.test(l)) { flush(); continue; }
    if (cur) cur.push(l);
  }
  flush();
  return out;
}

function parseBlock(lines: string[]): PlanError {
  const e: PlanError = { title: lines[0].trim(), detail: '' };
  const paras: string[][] = [[]];
  for (const l of lines.slice(1)) { if (l.trim() === '') paras.push([]); else paras[paras.length - 1].push(l); }
  const detail: string[] = [];
  for (const p of paras.filter(x => x.length)) {
    const withL = p.map(l => /^\s*with ([^\s,]+),?\s*$/.exec(l)).find(Boolean);
    const onL = p.map(l => /^\s*on (\S+) line (\d+)(,\s*in .*)?:\s*$/.exec(l)).find(Boolean);
    if (!withL && !onL) { detail.push(p.map(l => l.trimEnd()).join('\n')); continue; }
    if (withL) e.address = withL[1];
    if (onL) {
      e.file = onL[1];
      e.line = Number(onL[2]);
      e.relative = p.some(l => l.includes('(source code not available)'));
    }
  }
  e.detail = detail.join('\n\n').trim();
  return e;
}

const msgOf = (e: PlanError) => `${e.title} ${e.detail}`.replace(/\s+/g, ' ');
const isEmptyBody = (body: string) => body.split('\n').every(l => { const t = l.trim(); return t === '' || t.startsWith('#') || t.startsWith('//'); });

// Apply all rules once; `ignored` holds attrs this call put under ignore_changes / 규칙을 한 번 적용; ignored는 이번 호출이 ignore_changes에 넣은 속성
export function applyRules(generated: string, errors: PlanError[]): { text: string; applied: string[]; ignored: Record<string, string[]> } {
  const applied = new Set<string>();
  const ignored: Record<string, string[]> = {};
  const mark = (id: RuleId, address?: string) => applied.add(address ? `${id}:${address}` : id);
  const addIgnored = (address: string, attrs: string[]) => {
    const cur = ignored[address] ?? (ignored[address] = []);
    for (const a of attrs) if (!cur.includes(a)) cur.push(a);
  };

  // Line rules work on the input text so resource-relative lines still resolve / 줄 규칙은 입력 원문 기준이라 리소스 기준 줄 번호도 맞음
  const lines = generated.split('\n');
  const facts = lineFacts(generated);
  const res = splitResources(generated);
  const owner = (ln: number) => res.find(r => r.startLine <= ln && ln <= r.endLine)?.address;
  const absLine = (e: PlanError): number | undefined => {
    if (e.line === undefined || !e.address) return undefined; // never act on an error without an address / 주소 없는 오류로는 지우지 않음
    if (e.file && !/(^|\/)generated\.tf$/.test(e.file)) return undefined;
    const r = e.address ? res.find(x => x.address === e.address!.replace(/\[[^\]]*\]$/, '')) : undefined;
    if (e.relative) return r ? r.startLine + e.line : undefined;
    if (e.address && (!r || e.line < r.startLine || e.line > r.endLine)) return undefined;
    return e.line;
  };
  const drop = new Set<number>();

  // drop-null: block attributes set to null (never inside heredocs or object values) / null 속성 줄 지우기 (heredoc·객체 값 안은 제외)
  facts.forEach((f, k) => { if (f.blockAttr && NULL_LINE.test(lines[k])) { drop.add(k + 1); mark('drop-null', owner(k + 1)); } });

  // default-value: an error points at a line holding 0/false/""/[]/{} / 오류가 가리킨 줄이 기본값이면 지우기
  for (const e of errors) {
    const ln = absLine(e);
    if (!ln || ln > lines.length || drop.has(ln)) continue;
    if (facts[ln - 1].blockAttr && DEFAULT_LINE.test(lines[ln - 1])) { drop.add(ln); mark('default-value', owner(ln)); }
  }

  // conflict-computed: remove the computed side named in "X": conflicts with Y / 충돌 쌍에서 계산되는 쪽 지우기
  for (const e of errors) {
    if (!e.address) continue;
    const names = new Set<string>();
    const re = /"([\w-]+)": conflicts with ([\w-]+)/g;
    const msg = msgOf(e);
    for (let m = re.exec(msg); m; m = re.exec(msg)) { names.add(m[1]); names.add(m[2]); }
    const computed = Array.from(names).filter(n => COMPUTED_CONFLICT.includes(n));
    if (!computed.length) continue;
    for (const a of attributeLines(generated, e.address)) {
      if (computed.includes(a.name) && !drop.has(a.line)) { drop.add(a.line); mark('conflict-computed', e.address.replace(/\[[^\]]*\]$/, '')); }
    }
  }

  let text = drop.size ? removeLines(generated, Array.from(drop)) : generated;

  // empty-required-block: a nested block whose argument "is required" and that is now empty / 필수 인자가 빠지고 비어 있는 중첩 블록 지우기
  for (const e of errors) {
    if (!e.address) continue;
    const re = /The argument "([\w.-]+)" is required/g;
    const msg = msgOf(e);
    for (let m = re.exec(msg); m; m = re.exec(msg)) {
      const parts = m[1].split('.').filter((p: string) => !/^\d+$/.test(p));
      if (parts.length < 2) continue;
      const empty = nestedBlocks(text, e.address, parts.slice(0, -1).join('.')).filter(b => isEmptyBody(b.body));
      if (!empty.length) continue;
      const ls: number[] = [];
      for (const b of empty) for (let k = b.headLine; k <= b.closeLine; k++) ls.push(k);
      text = removeLines(text, ls);
      mark('empty-required-block', e.address.replace(/\[[^\]]*\]$/, ''));
    }
  }

  for (const r of splitResources(text)) {
    const attrs = attributeLines(text, r.address);
    // lb-subnet-mapping: `subnets` set → drop the duplicate subnet_mapping blocks / subnets가 있으면 subnet_mapping 블록 지우기
    if (r.type === 'aws_lb') {
      const subnets = attrs.find(a => a.name === 'subnets');
      if (subnets && !EMPTY_LIST.test(subnets.text) && nestedBlocks(text, r.address, 'subnet_mapping').length) {
        text = removeNestedBlock(text, r.address, 'subnet_mapping');
        mark('lb-subnet-mapping', r.address);
      }
    }
    // lambda-placeholder: no code source → placeholder file + ignore / 코드 출처가 없으면 자리표시 파일과 ignore
    if (r.type === 'aws_lambda_function' && !attrs.some(a => CODE_SOURCES.includes(a.name))) {
      text = insertIntoResource(text, r.address, `filename = "${LAMBDA_PLACEHOLDER}"`);
      text = setLifecycleIgnore(text, r.address, ['filename', 'source_code_hash']);
      addIgnored(r.address, ['filename', 'source_code_hash']);
      mark('lambda-placeholder', r.address);
    }
    // instance-user-data-hash: provider returns only a SHA1 of user_data → drop + ignore / provider가 user_data의 SHA1만 주므로 지우고 ignore
    if (r.type === 'aws_instance') {
      const ud = attrs.find(a => a.name === 'user_data' && HASH_USER_DATA.test(a.text));
      if (ud) {
        text = removeLines(text, [ud.line]);
        text = setLifecycleIgnore(text, r.address, ['user_data']);
        addIgnored(r.address, ['user_data']);
        mark('instance-user-data-hash', r.address);
      }
      // instance-replace-flag: import leaves this Terraform-only flag null while config defaults it to false / 가져오기는 이 Terraform 전용 설정을 null로 두고 설정은 기본값 false라 ignore
      const now = splitResources(text).find(x => x.address === r.address);
      if (now && !REPLACE_FLAG_IGNORED.test(now.body)) {
        text = setLifecycleIgnore(text, r.address, ['user_data_replace_on_change']);
        addIgnored(r.address, ['user_data_replace_on_change']);
        mark('instance-replace-flag', r.address);
      }
    }
  }

  return { text, applied: Array.from(applied), ignored };
}
