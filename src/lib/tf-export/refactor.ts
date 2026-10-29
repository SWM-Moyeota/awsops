// Deterministic refactor: references, names, layer files, secrets (no AI) / 결정적 정리: 참조·이름·레이어 파일·비밀 (AI 안 씀)
import type { ExportItem, TfType } from './types';
import { analyze, applyEdits, decodeStr, tokenize } from './_scan';
import { extractSecrets } from './secrets';

// Types whose plain AWS id is the Terraform `.id` / AWS ID가 그대로 Terraform `.id`인 타입
const ID_TYPES = new Set<TfType>(['aws_vpc', 'aws_subnet', 'aws_security_group', 'aws_instance', 'aws_nat_gateway', 'aws_ebs_volume', 'aws_cloudfront_distribution']);
// Attributes holding a non-unique name: the key must hint the kind / 고유하지 않은 이름 속성: 키 이름이 종류를 암시해야 함
const NAME_HINT: Record<string, RegExp> = { name: /role/i, function_name: /function|lambda/i, bucket: /bucket/i };
// Frames where references are never written / 참조로 바꾸지 않는 위치
const NO_REF_FRAMES = new Set(['tags', 'tags_all', 'lifecycle']);

// Map id/ARN/name → `<address>.<attr>` for exported resources / 내보내는 리소스의 id·ARN·이름 → `<주소>.<속성>`
export function buildRefIndex(items: ExportItem[]): Map<string, string> {
  const map = new Map<string, string>();
  const ambiguous = new Set<string>();
  const add = (v: string | undefined, target: string) => {
    if (!v) return;
    const prev = map.get(v);
    if (prev !== undefined && prev !== target) ambiguous.add(v);
    else map.set(v, target);
  };
  for (const it of items) {
    const a = it.address;
    const vals = [it.importId, it.id, it.nodeArn].filter(Boolean);
    const isArn = (v: string) => v.startsWith('arn:');
    switch (it.tfType) {
      case 'aws_eip':
        for (const v of [it.importId, it.id]) if (v?.startsWith('eipalloc-')) add(v, `${a}.id`);
        break;
      case 'aws_lb_listener':
        for (const v of vals) add(v, `${a}.id`);
        break;
      case 'aws_lb':
      case 'aws_lb_target_group':
        for (const v of vals) if (isArn(v)) add(v, `${a}.arn`);
        break;
      case 'aws_iam_role':
        for (const v of vals) if (isArn(v)) add(v, `${a}.arn`);
        if (it.importId && !isArn(it.importId)) add(it.importId, `${a}.name`);
        break;
      case 'aws_lambda_function':
        for (const v of vals) if (isArn(v)) add(v, `${a}.arn`);
        if (it.importId && !isArn(it.importId)) add(it.importId, `${a}.function_name`);
        break;
      case 'aws_s3_bucket':
        if (it.importId && !isArn(it.importId)) add(it.importId, `${a}.bucket`);
        break;
      default:
        if (ID_TYPES.has(it.tfType)) for (const v of [it.importId, it.id]) if (v && !isArn(v)) add(v, `${a}.id`);
    }
  }
  ambiguous.forEach(v => map.delete(v));
  return map;
}

// Address part of `<type>.<name>.<attr>` / `<타입>.<이름>.<속성>`의 주소 부분
const addrOf = (target: string) => target.slice(0, target.lastIndexOf('.'));

// Replace quoted values equal to an exported id/ARN with references / 내보낸 리소스의 id·ARN과 같은 따옴표 값을 참조로 바꾸기
export function applyReferences(
  text: string,
  index: Map<string, string>,
  selfAddressOf?: (line: number) => string | null | undefined,
  opts: { skip?: Iterable<string> } = {},
): string {
  const skip = new Set(opts.skip ?? []);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const v of analyze(text).values) {
    if (v.tok.k !== 'str' || !v.address) continue;
    if (v.chain.some(c => NO_REF_FRAMES.has(c))) continue;
    const target = index.get(decodeStr(v.tok.v));
    if (!target) continue;
    const self = selfAddressOf ? selfAddressOf(v.tok.line) : v.address;
    if (addrOf(target) === self || skip.has(v.address)) continue;
    const hint = NAME_HINT[target.slice(target.lastIndexOf('.') + 1)];
    if (hint && !hint.test(v.chain[v.chain.length - 1] ?? '')) continue;
    edits.push({ start: v.tok.start, end: v.tok.end, text: target });
  }
  return applyEdits(text, edits);
}

// snake_case limited to [a-z0-9_] / [a-z0-9_]만 쓰는 snake_case
const snake = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
// Cut to a max length without a trailing underscore / 최대 길이로 자르고 끝 밑줄 제거
const clip = (s: string, max: number) => s.slice(0, max).replace(/_+$/, '');
const MAX_NAME = 48;

// Readable unique names from Name tag / resource name / Name 태그·리소스 이름으로 읽기 쉬운 고유 이름 만들기
export function makeNames(items: ExportItem[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Map<string, Set<string>>();
  for (const it of items) {
    const type = it.address.slice(0, it.address.indexOf('.')) || it.tfType;
    let base = snake(it.name ?? '') || snake(type.replace(/^aws_/, ''));
    if (/^[0-9]/.test(base)) base = `r_${base}`;
    base = clip(base, MAX_NAME);
    const seen = used.get(type) ?? new Set<string>();
    used.set(type, seen);
    let name = base;
    for (let k = 2; seen.has(name); k++) name = clip(base, MAX_NAME - `_${k}`.length) + `_${k}`;
    seen.add(name);
    out.set(it.address, `${type}.${name}`);
  }
  return out;
}

// Rename resource labels and `<type>.<name>` references (not inside strings) / 리소스 라벨과 `<타입>.<이름>` 참조 바꾸기 (문자열 안은 제외)
export function renameAddresses(text: string, map: Map<string, string>): string {
  const toks = tokenize(text);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const newName = (addr: string) => { const n = map.get(addr); return n && n !== addr ? n.slice(n.indexOf('.') + 1) : null; };
  let depth = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k === 'punct' && '{[('.includes(t.v)) depth++;
    else if (t.k === 'punct' && '}])'.includes(t.v)) depth--;
    if (depth === 0 && t.k === 'ident' && t.v === 'resource' && toks[i + 1]?.k === 'str' && toks[i + 2]?.k === 'str') {
      const n = newName(`${decodeStr(toks[i + 1].v)}.${decodeStr(toks[i + 2].v)}`);
      if (n) edits.push({ start: toks[i + 2].start, end: toks[i + 2].end, text: `"${n}"` });
      continue;
    }
    if (t.k === 'ident' && toks[i + 1]?.v === '.' && toks[i + 2]?.k === 'ident' && toks[i - 1]?.v !== '.'
      && toks[i + 1].start === t.end && toks[i + 2].start === toks[i + 1].end) {
      const n = newName(`${t.v}.${toks[i + 2].v}`);
      if (n) edits.push({ start: toks[i + 2].start, end: toks[i + 2].end, text: n });
    }
  }
  return applyEdits(text, edits);
}

// Layer file for each Terraform type (spec table) / Terraform 타입별 레이어 파일 (설계서 표)
const LAYER: Record<TfType, string> = {
  aws_vpc: 'network.tf', aws_subnet: 'network.tf', aws_nat_gateway: 'network.tf', aws_eip: 'network.tf',
  aws_security_group: 'security.tf',
  aws_instance: 'compute.tf', aws_ebs_volume: 'compute.tf', aws_lambda_function: 'compute.tf',
  aws_db_instance: 'data.tf', aws_s3_bucket: 'data.tf',
  aws_iam_role: 'iam.tf',
  aws_lb: 'edge.tf', aws_lb_listener: 'edge.tf', aws_lb_target_group: 'edge.tf', aws_cloudfront_distribution: 'edge.tf',
};
const LAYER_ORDER = ['network.tf', 'security.tf', 'compute.tf', 'data.tf', 'iam.tf', 'edge.tf', 'main.tf'];

// Split resource blocks into layer files; empty layers omitted / resource 블록을 레이어 파일로 나누기 (빈 레이어는 뺌)
export function splitLayers(text: string): Record<string, string> {
  const { resources } = analyze(text);
  const buckets: Record<string, string[]> = {};
  const put = (file: string, block: string) => { (buckets[file] ??= []).push(block); };
  let rest = '';
  let pos = 0;
  for (const r of resources) {
    rest += text.slice(pos, r.start);
    pos = r.end;
    put(LAYER[r.type as TfType] ?? 'main.tf', text.slice(r.start, r.end));
  }
  rest += text.slice(pos);
  // Keep non-resource code (not generator comments) in main.tf / resource가 아닌 코드는 main.tf에 남김 (생성 주석 제외)
  const leftover = rest.split('\n').filter(l => !/^\s*(#|\/\/)/.test(l)).join('\n').trim();
  if (leftover) put('main.tf', leftover);
  const out: Record<string, string> = {};
  for (const f of LAYER_ORDER) if (buckets[f]) out[f] = buckets[f].join('\n\n') + '\n';
  return out;
}

// Full refactor of a diff-0 bundle at a level / diff 0 묶음을 단계별로 정리
export function refactorBundle(input: { generated: string; imports: string; items: ExportItem[]; level: 'refactored' | 'named'; noRefs?: string[] }): {
  files: Record<string, string>;
  secrets: ReturnType<typeof extractSecrets>['vars'];
  addresses: Record<string, string>;
} {
  const present = new Set(analyze(input.generated).resources.map(r => r.address));
  const items = input.items.filter(i => present.has(i.address));
  const names = makeNames(items);
  let text = renameAddresses(input.generated, names);
  const imports = renameAddresses(input.imports, names);
  if (input.level === 'refactored') {
    const renamed = items.map(i => ({ ...i, address: names.get(i.address) ?? i.address }));
    // noRefs are original addresses; the text is already renamed / noRefs는 원래 주소, 텍스트는 이미 이름이 바뀜
    const skip = (input.noRefs ?? []).map(a => names.get(a) ?? a);
    text = applyReferences(text, buildRefIndex(renamed), undefined, { skip });
  }
  const { text: clean, vars } = extractSecrets(text);
  return { files: { 'imports.tf': imports, ...splitLayers(clean) }, secrets: vars, addresses: Object.fromEntries(names) };
}
