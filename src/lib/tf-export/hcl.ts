// HCL text utilities without a parser: brace matching that skips strings, heredocs and comments / 파서 없이 다루는 HCL 텍스트 도구: 문자열·heredoc·주석을 건너뛰는 중괄호 짝 맞추기

// Open delimiter kinds: block brace, expression brace, list, call / 여는 구분자 종류: 블록 중괄호, 식 중괄호, 목록, 호출
type Delim = 'B' | 'E' | '[' | '(';
// Per-line state at the line start / 줄 시작 시점의 상태
interface LineInfo { start: number; end: number; code: boolean; stack: Array<{ d: Delim; at: number }> }
interface Scan { lines: LineInfo[]; mask: Uint8Array; match: Map<number, number> }
// String-ish context stack entries / 문자열 계열 문맥 스택 항목
type Ctx = { k: 'str' } | { k: 'heredoc'; marker: string } | { k: 'interp'; depth: number };

export interface ResourceBlock { address: string; type: string; name: string; start: number; end: number; body: string; startLine: number; endLine: number }

const IDENT = /^[A-Za-z_][\w-]*$/;
// Block header prefix before `{`: identifier plus optional labels, no `=` / `{` 앞의 블록 머리: 식별자와 라벨, `=` 없음
const BLOCK_HEAD = /^\s*[A-Za-z_][\w-]*(\s+("[^"]*"|[A-Za-z_][\w-]*))*\s*$/;
const RESOURCE_HEAD = /^\s*resource\s+"([^"\\]+)"\s+"([^"\\]+)"\s*\{/;

// Scan once: mask (1 code, 2 interpolation, 0 literal/comment), per-line state, delimiter pairs / 한 번 훑기: 마스크, 줄별 상태, 구분자 짝
function scan(text: string): Scan {
  const n = text.length;
  const mask = new Uint8Array(n);
  const match = new Map<number, number>();
  const lines: LineInfo[] = [];
  const starts: number[] = [0];
  for (let k = 0; k < n; k++) if (text[k] === '\n') starts.push(k + 1);
  const delims: Array<{ d: Delim; at: number }> = [];
  const ctx: Ctx[] = [];
  let lineComment = false;
  let blockComment = false;
  let li = 0;
  let i = 0;
  const lineEnd = (s: number) => { const e = text.indexOf('\n', s); return e < 0 ? n : e; };
  while (i <= n) {
    // Record line start state / 줄 시작 상태 기록
    while (li < starts.length && starts[li] <= i) {
      const st = starts[li++];
      lines.push({ start: st, end: lineEnd(st), code: ctx.length === 0 && !blockComment && !lineComment, stack: delims.slice() });
      const top = ctx[ctx.length - 1];
      // Heredoc terminator line / heredoc 끝 표시 줄
      if (st === i && top && top.k === 'heredoc' && text.slice(i, lineEnd(i)).trim() === top.marker) {
        ctx.pop();
        i = lineEnd(i);
      }
    }
    if (i >= n) break;
    const c = text[i];
    const c2 = text[i + 1];
    const top = ctx[ctx.length - 1];
    if (lineComment) { if (c === '\n') lineComment = false; i++; continue; }
    if (blockComment) { if (c === '*' && c2 === '/') { blockComment = false; i += 2; } else i++; continue; }
    if (top && (top.k === 'str' || top.k === 'heredoc')) {
      if (top.k === 'str' && c === '\\') { i += 2; continue; }
      if ((c === '$' || c === '%') && c2 === c && text[i + 2] === '{') { i += 3; continue; }
      if ((c === '$' || c === '%') && c2 === '{') { ctx.push({ k: 'interp', depth: 0 }); i += 2; continue; }
      if (top.k === 'str' && (c === '"' || c === '\n')) { ctx.pop(); if (c === '"') i++; continue; }
      i++;
      continue;
    }
    // Code or interpolation / 코드 또는 보간
    const v = top ? 2 : 1;
    if (c === '#' || (c === '/' && c2 === '/')) { lineComment = true; i++; continue; }
    if (c === '/' && c2 === '*') { blockComment = true; i += 2; continue; }
    if (c === '"') { ctx.push({ k: 'str' }); i++; continue; }
    if (c === '<' && c2 === '<') {
      const m = /^<<-?([A-Za-z_][\w-]*)[ \t]*\r?\n/.exec(text.slice(i, i + 200));
      if (m) { ctx.push({ k: 'heredoc', marker: m[1] }); i += m[0].length; continue; }
    }
    mask[i] = v;
    if (top && top.k === 'interp') {
      if (c === '{') top.depth++;
      else if (c === '}') { if (top.depth === 0) { ctx.pop(); mask[i] = 0; } else top.depth--; }
      i++;
      continue;
    }
    if (c === '{') {
      const ls = text.lastIndexOf('\n', i - 1) + 1;
      const t = delims[delims.length - 1];
      const isBlock = (!t || t.d === 'B') && BLOCK_HEAD.test(text.slice(ls, i));
      delims.push({ d: isBlock ? 'B' : 'E', at: i });
    } else if (c === '[' || c === '(') {
      delims.push({ d: c, at: i });
    } else if (c === '}' || c === ']' || c === ')') {
      const want: Delim[] = c === '}' ? ['B', 'E'] : c === ']' ? ['['] : ['('];
      for (let k = delims.length - 1; k >= 0; k--) {
        if (want.includes(delims[k].d)) { match.set(delims[k].at, i); delims.length = k; break; }
      }
    }
    i++;
  }
  return { lines, mask, match };
}

// 1-based line number of a character offset / 문자 위치의 1부터 세는 줄 번호
function lineOf(s: Scan, offset: number): number {
  let lo = 0, hi = s.lines.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (s.lines[mid].start <= offset) lo = mid; else hi = mid - 1; }
  return lo + 1;
}

function resourcesOf(text: string, s: Scan): ResourceBlock[] {
  const out: ResourceBlock[] = [];
  for (const ln of s.lines) {
    if (!ln.code || ln.stack.length !== 0) continue;
    const m = RESOURCE_HEAD.exec(text.slice(ln.start, ln.end));
    if (!m) continue;
    const open = ln.start + m[0].length - 1;
    const close = s.match.get(open);
    if (close === undefined) continue;
    const start = ln.start + (m[0].length - m[0].trimStart().length);
    out.push({ address: `${m[1]}.${m[2]}`, type: m[1], name: m[2], start, end: close + 1, body: text.slice(start, close + 1), startLine: lineOf(s, start), endLine: lineOf(s, close) });
  }
  return out;
}

// Top-level `resource "<t>" "<n>" { … }` blocks; start/end are char offsets (end exclusive), body is the whole block / 최상위 resource 블록 목록; start/end는 문자 위치, body는 블록 전체
export function splitResources(text: string): ResourceBlock[] {
  return resourcesOf(text, scan(text));
}

// Address without an instance key like [0] / [0] 같은 인스턴스 키를 뺀 주소
const bareAddress = (a: string) => a.replace(/\[[^\]]*\]$/, '');

function findResource(text: string, address: string): { s: Scan; r: ResourceBlock } | null {
  const s = scan(text);
  const r = resourcesOf(text, s).find(x => x.address === bareAddress(address));
  return r ? { s, r } : null;
}

// Direct child blocks named `name` inside the brace pair opened at `open` / `open`에서 열린 중괄호 안의 직접 자식 블록
function childBlocks(text: string, s: Scan, open: number, name: string): Array<{ headLine: number; closeLine: number; open: number; close: number }> {
  const close = s.match.get(open)!;
  const depth = s.lines[lineOf(s, open) - 1].stack.length + 1;
  const re = new RegExp(`^\\s*${name.replace(/[-]/g, '\\-')}\\s*\\{`);
  const out: Array<{ headLine: number; closeLine: number; open: number; close: number }> = [];
  for (let k = lineOf(s, open); k < s.lines.length; k++) {
    const ln = s.lines[k];
    if (ln.start > close) break;
    if (!ln.code || ln.stack.length !== depth || ln.stack[depth - 1].at !== open) continue;
    const m = re.exec(text.slice(ln.start, ln.end));
    if (!m) continue;
    const o = ln.start + m[0].length - 1;
    const c = s.match.get(o);
    if (c === undefined) continue;
    out.push({ headLine: k + 1, closeLine: lineOf(s, c), open: o, close: c });
  }
  return out;
}

// Blocks at a dotted path (e.g. "outer.inner") inside a resource / 리소스 안 점 경로의 블록들
export function nestedBlocks(text: string, address: string, blockPath: string): Array<{ headLine: number; closeLine: number; body: string }> {
  const f = findResource(text, address);
  if (!f) return [];
  let opens = [f.r.start + f.r.body.indexOf('{')];
  let found: ReturnType<typeof childBlocks> = [];
  for (const part of blockPath.split('.')) {
    if (!IDENT.test(part)) return [];
    found = opens.flatMap(o => childBlocks(text, f.s, o, part));
    opens = found.map(b => b.open);
  }
  return found.map(b => ({ headLine: b.headLine, closeLine: b.closeLine, body: text.slice(b.open + 1, b.close) }));
}

// Direct attribute lines (1-based) of a resource, by attribute name / 리소스의 직접 속성 줄 (1부터), 속성 이름별
export function attributeLines(text: string, address: string): Array<{ line: number; name: string; text: string }> {
  const f = findResource(text, address);
  if (!f) return [];
  const open = f.r.start + f.r.body.indexOf('{');
  const out: Array<{ line: number; name: string; text: string }> = [];
  for (let k = f.r.startLine; k < f.r.endLine; k++) {
    const ln = f.s.lines[k];
    if (!ln.code || ln.stack.length !== 1 || ln.stack[0].at !== open) continue;
    const t = text.slice(ln.start, ln.end);
    const m = /^\s*([A-Za-z_][\w-]*)\s*=(?!=)/.exec(t);
    if (m) out.push({ line: k + 1, name: m[1], text: t });
  }
  return out;
}

// Line facts for rules: code start and whether it is a direct attribute of a block / 규칙용 줄 정보: 코드 시작 여부, 블록의 직접 속성인지
export function lineFacts(text: string): Array<{ code: boolean; blockAttr: boolean }> {
  const s = scan(text);
  return s.lines.map(ln => {
    const top = ln.stack[ln.stack.length - 1];
    return { code: ln.code, blockAttr: ln.code && !!top && top.d === 'B' && /^\s*[A-Za-z_][\w-]*\s*=(?!=)/.test(text.slice(ln.start, ln.end)) };
  });
}

// Replace a whole resource block / 리소스 블록 통째로 바꾸기
export function replaceResource(text: string, address: string, newBlock: string): string {
  const f = findResource(text, address);
  if (!f) return text;
  return text.slice(0, f.r.start) + newBlock.replace(/\s+$/, '') + text.slice(f.r.end);
}

// Remove a resource block, its comment lines right above, and a doubled blank line / 리소스 블록과 바로 위 주석 줄, 겹친 빈 줄 지우기
export function removeResource(text: string, address: string): string {
  const f = findResource(text, address);
  if (!f) return text;
  const lines = text.split('\n');
  let a = f.r.startLine - 1;
  while (a > 0 && /^\s*(#|\/\/)/.test(lines[a - 1])) a--;
  lines.splice(a, f.r.endLine - a);
  if (lines[a] !== undefined && lines[a].trim() === '' && (a === 0 || lines[a - 1].trim() === '') && a < lines.length - 1) lines.splice(a, 1);
  return lines.join('\n');
}

// Remove lines by 1-based number / 1부터 세는 줄 번호로 줄 지우기
export function removeLines(text: string, lineNumbers1Based: number[]): string {
  const drop = new Set(lineNumbers1Based);
  return text.split('\n').filter((_, k) => !drop.has(k + 1)).join('\n');
}

// Remove every occurrence of a nested block (dotted path allowed) inside one resource / 한 리소스 안의 중첩 블록을 모두 지우기 (점 경로 허용)
export function removeNestedBlock(text: string, address: string, blockName: string): string {
  const drop: number[] = [];
  for (const b of nestedBlocks(text, address, blockName)) for (let k = b.headLine; k <= b.closeLine; k++) drop.push(k);
  return drop.length ? removeLines(text, drop) : text;
}

// Dedent a snippet and indent it by `pad` / 조각의 공통 들여쓰기를 없애고 `pad`만큼 들여쓰기
function indent(snippet: string, pad: string): string {
  const ls = snippet.replace(/\s+$/, '').split('\n');
  const common = Math.min(...ls.filter(l => l.trim()).map(l => l.match(/^\s*/)![0].length));
  return ls.map(l => (l.trim() ? pad + l.slice(Number.isFinite(common) ? common : 0) : '')).join('\n');
}

// Insert a snippet right after the resource's opening line / 리소스 여는 줄 바로 뒤에 조각 넣기
export function insertIntoResource(text: string, address: string, snippet: string): string {
  const f = findResource(text, address);
  if (!f) return text;
  const open = f.r.start + f.r.body.indexOf('{');
  const body = indent(snippet, '  ');
  const eol = /^[ \t]*\r?\n/.exec(text.slice(open + 1));
  if (eol) { const at = open + 1 + eol[0].length; return text.slice(0, at) + body + '\n' + text.slice(at); }
  return text.slice(0, open + 1) + '\n' + body + '\n' + text.slice(open + 1).replace(/^[ \t]*/, '');
}

// Create or merge `lifecycle { ignore_changes = [...] }` / `lifecycle { ignore_changes = [...] }` 만들기 또는 합치기
export function setLifecycleIgnore(text: string, address: string, attrs: string[]): string {
  const f = findResource(text, address);
  if (!f || attrs.length === 0) return text;
  const { s, r } = f;
  const open = r.start + r.body.indexOf('{');
  const lc = childBlocks(text, s, open, 'lifecycle')[0];
  if (!lc) {
    const close = r.end - 1;
    const block = `  lifecycle {\n    ignore_changes = [${attrs.join(', ')}]\n  }\n`;
    const ls = text.lastIndexOf('\n', close - 1) + 1;
    if (text.slice(ls, close).trim() === '') return text.slice(0, ls) + block + text.slice(ls);
    return text.slice(0, close) + '\n' + block + text.slice(close);
  }
  const mergeList = (vStart: number): string => {
    const vEnd = s.match.get(vStart)!;
    const existing = text.slice(vStart + 1, vEnd).split('\n').map(l => l.replace(/(#|\/\/).*$/, '')).join(' ')
      .split(',').map(x => x.trim()).filter(Boolean);
    const merged = [...existing];
    for (const a of attrs) if (!merged.includes(a)) merged.push(a);
    return `[${merged.join(', ')}]`;
  };
  // Single-line `lifecycle { … }`: merge in place or rewrite multi-line / 한 줄 lifecycle: 그 자리에서 합치거나 여러 줄로 다시 씀
  if (lc.headLine === lc.closeLine) {
    const re = /ignore_changes\s*=\s*/g;
    const inner = text.slice(lc.open + 1, lc.close);
    for (let m = re.exec(inner); m; m = re.exec(inner)) {
      const at = lc.open + 1 + m.index;
      if (s.mask[at] !== 1 || /[\w-]/.test(text[at - 1])) continue;
      const vStart = at + m[0].length;
      if (text[vStart] !== '[' || s.match.get(vStart) === undefined) return text; // `all` or an expression / `all` 또는 식
      return text.slice(0, vStart) + mergeList(vStart) + text.slice(s.match.get(vStart)! + 1);
    }
    const pad = text.slice(s.lines[lc.headLine - 1].start, s.lines[lc.headLine - 1].end).match(/^\s*/)![0];
    const body = inner.trim();
    return text.slice(0, lc.open + 1) + '\n' + (body ? `${pad}  ${body}\n` : '') + `${pad}  ignore_changes = [${attrs.join(', ')}]\n${pad}` + text.slice(lc.close);
  }
  // Find ignore_changes inside lifecycle / lifecycle 안의 ignore_changes 찾기
  for (let k = lc.headLine; k < lc.closeLine - 1; k++) {
    const ln = s.lines[k];
    const t = text.slice(ln.start, ln.end);
    const m = /^(\s*)ignore_changes\s*=\s*/.exec(t);
    if (!m || !ln.code) continue;
    const vStart = ln.start + m[0].length;
    if (text[vStart] !== '[') return text; // `all` or an expression: leave as is / `all` 또는 식이면 그대로
    const vEnd = s.match.get(vStart);
    if (vEnd === undefined) return text;
    const existing = text.slice(vStart + 1, vEnd).split('\n').map(l => l.replace(/(#|\/\/).*$/, '')).join(' ')
      .split(',').map(x => x.trim()).filter(Boolean);
    const merged = [...existing];
    for (const a of attrs) if (!merged.includes(a)) merged.push(a);
    return text.slice(0, ln.start) + `${m[1]}ignore_changes = [${merged.join(', ')}]` + text.slice(vEnd + 1);
  }
  const headEnd = s.lines[lc.headLine - 1].end;
  const pad = (text.slice(s.lines[lc.headLine - 1].start, headEnd).match(/^\s*/)![0]) + '  ';
  return text.slice(0, headEnd + 1) + `${pad}ignore_changes = [${attrs.join(', ')}]\n` + text.slice(headEnd + 1);
}

const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Remove `import { to = <address> … }` blocks for an exact address / 정확히 그 주소의 import 블록 지우기
export function removeImport(importsText: string, address: string): string {
  const s = scan(importsText);
  const to = new RegExp(`^\\s*to\\s*=\\s*${esc(address)}\\s*((#|//).*)?$`);
  const drop: number[] = [];
  s.lines.forEach((ln, k) => {
    if (!ln.code || ln.stack.length !== 0) return;
    const m = /^\s*import\s*\{/.exec(importsText.slice(ln.start, ln.end));
    if (!m) return;
    const close = s.match.get(ln.start + m[0].length - 1);
    if (close === undefined) return;
    const last = lineOf(s, close);
    let hit = false;
    for (let j = k; j < last; j++) if (to.test(importsText.slice(s.lines[j].start, s.lines[j].end).replace(/^\s*import\s*\{/, ''))) hit = true;
    if (!hit) return;
    for (let j = k + 1; j <= last; j++) drop.push(j);
    if (s.lines[last] && importsText.slice(s.lines[last].start, s.lines[last].end).trim() === '' && last + 1 < s.lines.length) drop.push(last + 1);
  });
  return drop.length ? removeLines(importsText, drop) : importsText;
}

// Rename a resource address: its label and every `<type>.<name>` reference in code / 리소스 주소 바꾸기: 라벨과 코드 안의 모든 참조
export function renameAddress(text: string, from: string, to: string): string {
  const [fType, fName] = [from.slice(0, from.indexOf('.')), from.slice(from.indexOf('.') + 1)];
  const [tType, tName] = [to.slice(0, to.indexOf('.')), to.slice(to.indexOf('.') + 1)];
  if (!fType || !fName || !tType || !tName) return text;
  const s = scan(text);
  const edits: Array<{ at: number; len: number; rep: string }> = [];
  for (const r of resourcesOf(text, s)) {
    if (r.address !== from) continue;
    const head = /^resource\s+"([^"]+)"\s+"([^"]+)"/.exec(r.body)!;
    edits.push({ at: r.start, len: head[0].length, rep: `resource "${tType}" "${tName}"` });
  }
  const re = new RegExp(`(?<![\\w.-])${esc(from)}(?![\\w-])`, 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) if (s.mask[m.index] !== 0) edits.push({ at: m.index, len: m[0].length, rep: to });
  edits.sort((a, b) => b.at - a.at);
  let out = text;
  for (const e of edits) out = out.slice(0, e.at) + e.rep + out.slice(e.at + e.len);
  return out;
}
