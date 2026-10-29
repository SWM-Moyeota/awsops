// Private HCL token scanner for refactor/secrets (string-, comment- and heredoc-safe) / refactor·secrets 전용 HCL 토큰 스캐너 (문자열·주석·heredoc 안전)
// Kept self-contained on purpose; may later merge with hcl.ts / 일부러 독립 유지 — 나중에 hcl.ts와 합칠 수 있음

export type TokKind = 'str' | 'heredoc' | 'ident' | 'num' | 'punct';
// One token with its char range and 1-based line / 문자 범위와 1부터 시작하는 줄 번호를 가진 토큰
export interface Tok { k: TokKind; v: string; start: number; end: number; line: number }

// Find the end (exclusive) of an interpolation that starts after `${` / `${` 뒤에서 시작하는 보간의 끝(배타) 찾기
function scanInterp(text: string, j: number): number {
  let depth = 1;
  while (j < text.length) {
    const ch = text[j];
    if (ch === '"') { j = scanString(text, j); continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return j + 1;
    j++;
  }
  return text.length;
}

// Find the end (exclusive) of a quoted string starting at `i` / `i`에서 시작하는 따옴표 문자열의 끝(배타) 찾기
function scanString(text: string, i: number): number {
  let j = i + 1;
  while (j < text.length) {
    const ch = text[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === '"') return j + 1;
    if (ch === '\n') return j; // unterminated: stop at line end / 닫히지 않음: 줄 끝에서 멈춤
    if ((ch === '$' || ch === '%') && text[j + 1] === ch && text[j + 2] === '{') { j += 3; continue; }
    if ((ch === '$' || ch === '%') && text[j + 1] === '{') { j = scanInterp(text, j + 2); continue; }
    j++;
  }
  return text.length;
}

const HEREDOC = /^<<(-?)([A-Za-z_][\w-]*)[ \t]*\r?\n/;
const IDENT = /^[A-Za-z_][\w-]*/;
const NUM = /^[0-9][0-9.]*(?:[eE][+-]?[0-9]+)?/;
// Match a pattern anchored at `i` (ES5-safe, no sticky flag) / `i` 위치에 고정해 맞추기 (ES5 호환, sticky 미사용)
const at = (re: RegExp, text: string, i: number) => re.exec(text.slice(i, i + 256));

// Count newlines in a slice / 구간 안 줄바꿈 수 세기
const nl = (s: string) => { let c = 0; for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) c++; return c; };

// Tokenize HCL text, dropping whitespace and comments / 공백·주석을 버리고 HCL 텍스트를 토큰으로 나누기
export function tokenize(text: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let line = 1;
  const n = text.length;
  const push = (k: TokKind, end: number) => { toks.push({ k, v: text.slice(i, end), start: i, end, line }); line += nl(text.slice(i, end)); i = end; };
  while (i < n) {
    const c = text[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '#' || (c === '/' && text[i + 1] === '/')) { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      const stop = e < 0 ? n : e + 2;
      line += nl(text.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '"') { push('str', scanString(text, i)); continue; }
    if (c === '<' && text[i + 1] === '<') {
      const m = at(HEREDOC, text, i);
      if (m) {
        const tag = m[2];
        let pos = i + m[0].length;
        let end = n;
        while (pos < n) {
          const le = text.indexOf('\n', pos);
          const ln = text.slice(pos, le < 0 ? n : le);
          if (ln.trim() === tag) { end = pos + ln.replace(/\r$/, '').length; break; }
          if (le < 0) break;
          pos = le + 1;
        }
        push('heredoc', end);
        continue;
      }
    }
    const id = at(IDENT, text, i) ?? at(NUM, text, i);
    if (id) { push(/^[0-9]/.test(id[0]) ? 'num' : 'ident', i + id[0].length); continue; }
    push('punct', i + 1);
  }
  return toks;
}

// Decode a quoted HCL string literal to its value / 따옴표 HCL 문자열 리터럴을 실제 값으로 풀기
export function decodeStr(raw: string): string {
  const s = raw.startsWith('"') ? raw.slice(1, raw.endsWith('"') && raw.length > 1 ? -1 : undefined) : raw;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      const e = s[++i];
      if (e === 'n') out += '\n';
      else if (e === 'r') out += '\r';
      else if (e === 't') out += '\t';
      else if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 1, i + 5))) { out += String.fromCodePoint(parseInt(s.slice(i + 1, i + 5), 16)); i += 4; }
      else if (e === 'U' && /^[0-9a-fA-F]{8}$/.test(s.slice(i + 1, i + 9))) { out += String.fromCodePoint(parseInt(s.slice(i + 1, i + 9), 16)); i += 8; }
      else out += e;
      continue;
    }
    if ((ch === '$' || ch === '%') && s[i + 1] === ch && s[i + 2] === '{') { out += ch + '{'; i += 2; continue; }
    out += ch;
  }
  return out;
}

// Decode a heredoc token (`<<EOT` or indented `<<-EOT`) to its value / heredoc 토큰을 실제 값으로 풀기
export function decodeHeredoc(raw: string): string {
  const m = /^<<(-?)([A-Za-z_][\w-]*)[ \t]*\r?\n/.exec(raw);
  if (!m) return raw;
  const lines = raw.slice(m[0].length).split('\n').map(l => l.replace(/\r$/, ''));
  if (lines.length && lines[lines.length - 1].trim() === m[2]) lines.pop();
  let body = lines;
  if (m[1] === '-') {
    const ind = Math.min(...lines.filter(l => l.trim()).map(l => l.match(/^[ \t]*/)![0].length));
    if (Number.isFinite(ind)) body = lines.map(l => l.slice(Math.min(ind, l.match(/^[ \t]*/)![0].length)));
  }
  const text = body.length ? body.join('\n') + '\n' : '';
  return text.replace(/([$%])\1\{/g, '$1{');
}

// Escape a value as an HCL quoted string / 값을 HCL 따옴표 문자열로 이스케이프
export function hclString(v: string): string {
  let out = '"';
  for (let i = 0; i < v.length; i++) {
    const ch = v[i];
    const code = v.charCodeAt(i);
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if ((ch === '$' || ch === '%') && v[i + 1] === '{') out += ch + ch;
    else if (code < 0x20 || code === 0x7f) out += '\\u' + code.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}

// A top-level resource block / 최상위 resource 블록
export interface ResourceBlock { address: string; type: string; name: string; start: number; end: number; nameTok: number }
// A literal (string/heredoc) in value position, with its key chain / 값 자리의 리터럴과 키 경로
export interface ValueLit { tok: Tok; idx: number; address: string | null; chain: string[] }

interface Frame { open: string; name: string; key: string | null; res?: ResourceBlock }

const unq = (t: Tok) => (t.k === 'str' ? decodeStr(t.v) : t.v);
const isP = (t: Tok | undefined, v: string) => !!t && t.k === 'punct' && t.v === v;

// Walk tokens: resource blocks + value literals with key chains / 토큰을 따라가며 resource 블록과 값 리터럴(키 경로 포함) 수집
export function analyze(text: string): { toks: Tok[]; resources: ResourceBlock[]; values: ValueLit[] } {
  const toks = tokenize(text);
  const resources: ResourceBlock[] = [];
  const values: ValueLit[] = [];
  const stack: Frame[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const prev = toks[i - 1];
    const next = toks[i + 1];
    const top = stack[stack.length - 1];
    if (t.k === 'punct' && (t.v === '{' || t.v === '[' || t.v === '(')) {
      let name = '';
      let res: ResourceBlock | undefined;
      if (t.v === '(') {
        if (prev?.k === 'ident' && isP(toks[i - 2], '=')) name = top?.key ?? '';
      } else if (isP(prev, '=')) {
        name = top?.key ?? '';
      } else if (t.v === '{' && prev && (prev.k === 'ident' || prev.k === 'str') && prev.line === t.line) {
        let j = i - 1;
        while (j > 0 && toks[j - 1].line === t.line && (toks[j - 1].k === 'ident' || toks[j - 1].k === 'str')) j--;
        name = unq(toks[j]);
        const labels = toks.slice(j + 1, i);
        if (stack.length === 0 && toks[j].k === 'ident' && name === 'resource' && labels.length === 2 && labels.every(l => l.k === 'str')) {
          const type = decodeStr(labels[0].v);
          const rn = decodeStr(labels[1].v);
          res = { address: `${type}.${rn}`, type, name: rn, start: toks[j].start, end: text.length, nameTok: j + 2 };
          resources.push(res);
        }
      }
      stack.push({ open: t.v, name, key: null, res });
      continue;
    }
    if (t.k === 'punct' && (t.v === '}' || t.v === ']' || t.v === ')')) {
      const f = stack.pop();
      if (f?.res) f.res.end = t.end;
      continue;
    }
    if ((t.k === 'ident' || t.k === 'str') && isP(next, '=') && !isP(toks[i + 2], '=')) {
      if (top) top.key = unq(t);
      continue;
    }
    if (t.k === 'str' || t.k === 'heredoc') {
      if (next && next.line === t.line && (next.k === 'str' || isP(next, '{'))) continue; // block label / 블록 라벨
      let address: string | null = null;
      const chain: string[] = [];
      for (const f of stack) {
        if (f.res) { address = f.res.address; continue; }
        if (f.name) chain.push(f.name);
      }
      if (top?.key && top.open !== '[') chain.push(top.key);
      values.push({ tok: t, idx: i, address, chain });
    }
  }
  return { toks, resources, values };
}

// Apply non-overlapping text edits / 겹치지 않는 텍스트 수정 적용
export function applyEdits(text: string, edits: Array<{ start: number; end: number; text: string }>): string {
  if (!edits.length) return text;
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0;
  for (const e of sorted) {
    if (e.start < pos) continue;
    out += text.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  return out + text.slice(pos);
}
