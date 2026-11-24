// mend: the CLI SPEC.md specifies (MIT). It reads a patch in one of four formats -- a unified diff (often with
// wrong line numbers), SEARCH/REPLACE blocks, a V4A patch, or text-editor JSON edits -- finds the lines an edit
// names at the first of three matching tiers, and writes every change or none. Node 22, the standard library
// alone; run it as: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//
// In a trial the grader runs node /bot/main.ts with MAKEFUN_ENV_URL set, and the last lines below hand over to
// runner.ts: keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS: string[] = ['auto', 'unified', 'search-replace', 'v4a', 'json'];
const LEADING = /^[ \t]*/;
const TRAILING = /[ \t]+$/;
const EDGES = /^[ \t]+|[ \t]+$/g;
const FENCE = String.fromCharCode(96).repeat(3);

let STRICT = false;

const blank = (s: string): boolean => s.trim() === '';

class ParseFail {
  line: number;
  constructor(line: number) {
    this.line = line;
  }
}

class Fail {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

interface Item {
  kind: string;
  text: string;
  noEol: boolean;
}

interface NElem {
  ctx: number;
  text: string;
}

interface Hunk {
  a: number;
  items: Item[];
  noEol: boolean;
}

interface FileText {
  lines: string[];
  finalBreak: boolean;
  br: string;
}

interface Hit {
  pos: number;
  tier: number;
}

interface Found {
  tier: number;
  occ: number[];
}

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    p.indexOf('\\') < 0 &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

function parseText(text: string): FileText {
  if (text === '') return { lines: [], finalBreak: false, br: '\n' };
  const nl = text.indexOf('\n');
  const crlf = nl > 0 && text.charAt(nl - 1) === '\r';
  const br = crlf ? '\r\n' : '\n';
  const lines = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) lines.pop();
  return { lines, finalBreak, br };
}

function serialize(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

function leadOf(s: string): string {
  const m = LEADING.exec(s);
  return m === null ? '' : m[0];
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(TRAILING, '');
  return s.replace(EDGES, '');
}

function occursAt(file: string[], pos: number, pat: string[], tier: number): boolean {
  for (let j = 0; j < pat.length; j += 1) {
    const f = file[pos + j];
    if (f === undefined) return false;
    if (normLine(f, tier) !== normLine(pat[j], tier)) return false;
  }
  return true;
}

function occurrences(file: string[], pat: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + pat.length <= file.length; i += 1) {
    if (occursAt(file, i, pat, tier)) out.push(i);
  }
  return out;
}

function theTiers(): number[] {
  return STRICT ? [0] : [0, 1, 2];
}

function findTier(file: string[], pat: string[]): Found | null {
  for (const t of theTiers()) {
    const occ = occurrences(file, pat, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

function findLineTier(file: string[], want: string, from: number): Hit | null {
  for (const t of theTiers()) {
    const n = normLine(want, t);
    for (let j = from; j < file.length; j += 1) {
      if (normLine(file[j], t) === n) return { pos: j, tier: t };
    }
  }
  return null;
}

function findFrom(file: string[], pat: string[], from: number, atEof: boolean): Hit | null {
  for (const t of theTiers()) {
    for (let j = from; j + pat.length <= file.length; j += 1) {
      if (atEof && j + pat.length !== file.length) continue;
      if (occursAt(file, j, pat, t)) return { pos: j, tier: t };
    }
  }
  return null;
}

function renderN(n: NElem[], file: string[], pos: number, oTexts: string[], tier: number): string[] {
  const first = file[pos] === undefined ? '' : file[pos];
  const f = leadOf(first);
  const p = oTexts.length > 0 ? leadOf(oTexts[0]) : '';
  return n.map((el) => {
    if (el.ctx >= 0) {
      const line = file[pos + el.ctx];
      return line === undefined ? '' : line;
    }
    let s = el.text;
    if (tier === 2 && s.trim() !== '' && s.startsWith(p)) s = f + s.slice(p.length);
    return s;
  });
}

function splitItems(items: Item[]): { o: string[]; n: NElem[] } {
  const o: string[] = [];
  const n: NElem[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      n.push({ ctx: o.length, text: '' });
      o.push(it.text);
    } else if (it.kind === 'old') {
      o.push(it.text);
    } else {
      n.push({ ctx: -1, text: it.text });
    }
  }
  return { o, n };
}

class Tree {
  orig: Map<string, string | null> = new Map();
  now: Map<string, string | null> = new Map();
  moves: Array<{ from: string; to: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    const v = this.orig.get(p);
    return v === undefined ? null : v;
  }
  get(p: string): string | null {
    if (this.now.has(p)) {
      const v = this.now.get(p);
      return v === undefined ? null : v;
    }
    return this.original(p);
  }
  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  const head = lines[first];
  if (head.trim() === '*** Begin Patch') return 'v4a';
  const c = head.trimStart().charAt(0);
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.replace(TRAILING, '') === '<<<<<<< SEARCH')) return 'search-replace';
  const dash = lines.some((l, i) => {
    if (l.startsWith('diff --git ')) return true;
    const next = lines[i + 1] === undefined ? '' : lines[i + 1];
    return l.startsWith('--- ') && next.startsWith('+++ ');
  });
  if (dash) return 'unified';
  return null;
}

interface USection {
  gitOld: string | null;
  gitNew: string | null;
  hasDash: boolean;
  dashOld: string | null;
  dashNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFileMode: boolean;
  delFileMode: boolean;
  hunks: Hunk[];
}

function dashPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  if (p === '/dev/null') return null;
  return p;
}

function scanBody(lines: string[], start: number): { items: Item[]; end: number; noEol: boolean } {
  const items: Item[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j];
    const next = lines[j + 1] === undefined ? '' : lines[j + 1];
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && next.startsWith('+++ ')) break;
    if (l === '') {
      items.push({ kind: 'ctx', text: '', noEol: false });
      j += 1;
      continue;
    }
    const c = l.charAt(0);
    if (c === ' ') {
      items.push({ kind: 'ctx', text: l.slice(1), noEol: false });
    } else if (c === '-') {
      items.push({ kind: 'old', text: l.slice(1), noEol: false });
    } else if (c === '+') {
      items.push({ kind: 'new', text: l.slice(1), noEol: false });
    } else if (c === '\\') {
      if (items.length > 0) items[items.length - 1].noEol = true;
      j += 1;
      continue;
    } else {
      break;
    }
    j += 1;
  }
  while (items.length > 0) {
    const last = items[items.length - 1];
    if (last.kind === 'ctx' && last.text === '' && !last.noEol) items.pop();
    else break;
  }
  let noEol = false;
  for (let k = items.length - 1; k >= 0; k -= 1) {
    const it = items[k];
    if (it.kind === 'ctx' || it.kind === 'new') {
      noEol = it.noEol;
      break;
    }
  }
  return { items, end: j, noEol };
}

function freshSection(): USection {
  return {
    gitOld: null,
    gitNew: null,
    hasDash: false,
    dashOld: null,
    dashNew: null,
    renameFrom: null,
    renameTo: null,
    newFileMode: false,
    delFileMode: false,
    hunks: [],
  };
}

function parseUnified(lines: string[]): Edit[] {
  const secs: USection[] = [];
  let cur: USection | null = null;
  let inBody = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    const next = lines[i + 1] === undefined ? '' : lines[i + 1];
    if (l.startsWith('diff --git ')) {
      const rest = l.slice('diff --git '.length);
      if (!rest.startsWith('a/')) throw new ParseFail(i + 1);
      const k = rest.indexOf(' b/');
      if (k < 0) throw new ParseFail(i + 1);
      cur = freshSection();
      const go = rest.slice(2, k);
      const gn = rest.slice(k + 3);
      cur.gitOld = go === '/dev/null' ? null : go;
      cur.gitNew = gn === '/dev/null' ? null : gn;
      secs.push(cur);
      inBody = false;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && next.startsWith('+++ ')) {
      if (cur === null || inBody) {
        cur = freshSection();
        secs.push(cur);
      }
      cur.hasDash = true;
      cur.dashOld = dashPath(l);
      cur.dashNew = dashPath(next);
      inBody = false;
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new ParseFail(i + 1);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (m === null) throw new ParseFail(i + 1);
      const body = scanBody(lines, i + 1);
      cur.hunks.push({ a: Number(m[1]), items: body.items, noEol: body.noEol });
      inBody = true;
      i = body.end;
      continue;
    }
    if (cur === null) {
      i += 1;
      continue;
    }
    if (!inBody) {
      if (l.startsWith('--- ')) throw new ParseFail(i + 2);
      if (l.startsWith('rename from ')) {
        cur.renameFrom = l.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameTo = l.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (l === 'new file mode' || l.startsWith('new file mode ')) {
        cur.newFileMode = true;
        i += 1;
        continue;
      }
      if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) {
        cur.delFileMode = true;
        i += 1;
        continue;
      }
    }
    i += 1;
  }
  if (secs.length === 0) throw new ParseFail(1);
  return secs.map(unifiedEdit);
}

function unifiedEdit(sec: USection): Edit {
  let oldPath: string | null = null;
  let newPath: string | null = null;
  if (sec.hasDash) {
    oldPath = sec.dashOld;
    newPath = sec.dashNew;
  } else {
    oldPath = sec.renameFrom !== null ? sec.renameFrom : sec.gitOld;
    newPath = sec.renameTo !== null ? sec.renameTo : sec.gitNew;
  }
  const create = sec.newFileMode || (oldPath === null && newPath !== null);
  const del = !create && (sec.delFileMode || (newPath === null && oldPath !== null));
  return (tree: Tree) => {
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (create) {
      if (newPath === null) return;
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const out: string[] = [];
      let noEol = false;
      for (const h of sec.hunks) {
        for (const it of h.items) {
          if (it.kind === 'new') {
            out.push(it.text);
            noEol = it.noEol;
          }
        }
      }
      tree.set(newPath, serialize({ lines: out, finalBreak: !noEol, br: '\n' }));
      return;
    }
    if (del) {
      if (oldPath === null) return;
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.set(oldPath, null);
      return;
    }
    if (oldPath === null) return;
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    const to = newPath !== null && newPath !== oldPath ? newPath : null;
    if (to !== null && tree.get(to) !== null) throw new Fail('exists', to);
    const f = parseText(before);
    const lines = f.lines.slice();
    let finalBreak = f.finalBreak;
    let d = 0;
    for (const h of sec.hunks) {
      const parts = splitItems(h.items);
      const o = parts.o;
      const n = parts.n;
      if (o.length === 0) {
        const at = Math.min(h.a + d, lines.length);
        const rendered = renderN(n, lines, at, o, 0);
        const atEof = at === lines.length;
        lines.splice(at, 0, ...rendered);
        if (atEof) finalBreak = !h.noEol;
        d += n.length;
        continue;
      }
      const found = findTier(lines, o);
      if (found === null) throw new Fail('no-match', oldPath);
      const target = h.a - 1 + d;
      let best = found.occ[0];
      for (const p of found.occ) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const rendered = renderN(n, lines, best, o, found.tier);
      const atEof = best + o.length === lines.length;
      lines.splice(best, o.length, ...rendered);
      if (atEof) finalBreak = !h.noEol;
      d += n.length - o.length;
    }
    const text = serialize({ lines, finalBreak, br: f.br });
    if (to !== null) {
      tree.set(oldPath, null);
      tree.set(to, text);
      tree.moves.push({ from: oldPath, to });
    } else {
      tree.set(oldPath, text);
    }
  };
}

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): Edit[] {
  const blocks: SRBlock[] = [];
  let prevPath: string | null = null;
  let after = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].replace(TRAILING, '') !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    let path: string | null = null;
    for (let k = searchAt - 1; k > after; k -= 1) {
      const t = lines[k].trim();
      if (t === '') continue;
      if (t.startsWith(FENCE)) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseFail(searchAt + 1);
    let sep = -1;
    let end = -1;
    for (let k = searchAt + 1; k < lines.length; k += 1) {
      const t = lines[k].replace(TRAILING, '');
      if (t === '>>>>>>> REPLACE') {
        if (sep < 0) throw new ParseFail(searchAt + 1);
        end = k;
        break;
      }
      if (t === '=======' && sep < 0) sep = k;
    }
    if (sep < 0 || end < 0) throw new ParseFail(searchAt + 1);
    blocks.push({
      path,
      oldLines: lines.slice(searchAt + 1, sep),
      newLines: lines.slice(sep + 1, end),
    });
    prevPath = path;
    after = end;
    i = end + 1;
  }
  if (blocks.length === 0) throw new ParseFail(1);
  return blocks.map(srEdit);
}

function srEdit(b: SRBlock): Edit {
  const path = b.path;
  return (tree: Tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (b.oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.set(path, serialize({ lines: b.newLines.slice(), finalBreak: b.newLines.length > 0, br: '\n' }));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = parseText(before);
    const found = findTier(f.lines, b.oldLines);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0];
    const rendered = renderN(
      b.newLines.map((t) => ({ ctx: -1, text: t })),
      f.lines,
      pos,
      b.oldLines,
      found.tier,
    );
    const lines = f.lines.slice();
    lines.splice(pos, b.oldLines.length, ...rendered);
    tree.set(path, serialize({ lines, finalBreak: f.finalBreak, br: f.br }));
  };
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: Item[];
}

interface VSection {
  type: string;
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: VChunk[];
  line: number;
}

function parseV4a(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new ParseFail(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseFail(first + 1);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last])) last -= 1;
  if (last < 0 || lines[last].trim() !== '*** End Patch') throw new ParseFail(lines.length + 1);
  const isStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const secs: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i];
    if (blank(l)) {
      i += 1;
      continue;
    }
    let kind = '';
    let cut = 0;
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      cut = '*** Add File: '.length;
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      cut = '*** Delete File: '.length;
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      cut = '*** Update File: '.length;
    } else {
      throw new ParseFail(i + 1);
    }
    const sec: VSection = {
      type: kind,
      path: l.slice(cut).trim(),
      moveTo: null,
      addLines: [],
      chunks: [],
      line: i + 1,
    };
    i += 1;
    const raw: Array<{ text: string; idx: number }> = [];
    while (i < last && !isStart(lines[i])) {
      raw.push({ text: lines[i], idx: i });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1].text)) raw.pop();
    if (kind === 'add') {
      for (const r of raw) {
        if (r.text === '') {
          sec.addLines.push('');
          continue;
        }
        if (r.text.charAt(0) === '+') {
          sec.addLines.push(r.text.slice(1));
          continue;
        }
        throw new ParseFail(r.idx + 1);
      }
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new ParseFail(raw[0].idx + 1);
    } else {
      let start = 0;
      if (raw.length > 0 && raw[0].text.startsWith('*** Move to: ')) {
        sec.moveTo = raw[0].text.slice('*** Move to: '.length).trim();
        start = 1;
      }
      let cur: VChunk | null = null;
      for (let k = start; k < raw.length; k += 1) {
        const r = raw[k];
        const t = r.text;
        if (t.startsWith('@@')) {
          const a = t.slice(2).trim();
          cur = { anchor: a === '' ? null : a, eof: false, items: [] };
          sec.chunks.push(cur);
          continue;
        }
        if (t === '*** End of File') {
          if (cur === null) throw new ParseFail(r.idx + 1);
          cur.eof = true;
          cur = null;
          continue;
        }
        if (t === '') {
          if (cur === null) {
            cur = { anchor: null, eof: false, items: [] };
            sec.chunks.push(cur);
          }
          cur.items.push({ kind: 'ctx', text: '', noEol: false });
          continue;
        }
        const c = t.charAt(0);
        if (c === ' ' || c === '-' || c === '+') {
          if (cur === null) {
            cur = { anchor: null, eof: false, items: [] };
            sec.chunks.push(cur);
          }
          cur.items.push({ kind: c === ' ' ? 'ctx' : c === '-' ? 'old' : 'new', text: t.slice(1), noEol: false });
          continue;
        }
        throw new ParseFail(r.idx + 1);
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new ParseFail(sec.line);
    }
    secs.push(sec);
  }
  if (secs.length === 0) throw new ParseFail(1);
  return secs.map(v4aEdit);
}

function v4aEdit(sec: VSection): Edit {
  return (tree: Tree) => {
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    if (sec.type === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.set(p, serialize({ lines: sec.addLines.slice(), finalBreak: sec.addLines.length > 0, br: '\n' }));
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (sec.type === 'delete') {
      tree.set(p, null);
      return;
    }
    const to = sec.moveTo;
    if (to !== null && tree.get(to) !== null) throw new Fail('exists', to);
    const f = parseText(before);
    const lines = f.lines.slice();
    let cursor = 0;
    for (const c of sec.chunks) {
      if (c.anchor !== null) {
        const hitAnchor = findLineTier(lines, c.anchor, cursor);
        if (hitAnchor === null) throw new Fail('no-match', p);
        cursor = hitAnchor.pos + 1;
      }
      const parts = splitItems(c.items);
      const o = parts.o;
      const n = parts.n;
      if (o.length === 0) {
        const at = c.eof ? lines.length : cursor;
        const rendered = renderN(n, lines, at, o, 0);
        lines.splice(at, 0, ...rendered);
        cursor = at + n.length;
        continue;
      }
      const hit = findFrom(lines, o, cursor, c.eof);
      if (hit === null) throw new Fail('no-match', p);
      const rendered = renderN(n, lines, hit.pos, o, hit.tier);
      lines.splice(hit.pos, o.length, ...rendered);
      cursor = hit.pos + n.length;
    }
    const text = serialize({ lines, finalBreak: f.finalBreak, br: f.br });
    if (to !== null) {
      tree.set(p, null);
      tree.set(to, text);
      tree.moves.push({ from: p, to });
    } else {
      tree.set(p, text);
    }
  };
}

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = o.new_str === undefined ? '' : (o.new_str as string);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before.charAt(nl - 1) === '\r';
      const lf = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.split('\n').join('\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before.charAt(nl - 1) === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new ParseFail(1);
  const edits: Edit[] = [];
  if (lines[first].trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseFail(first + 1);
    }
    if (!Array.isArray(v)) throw new ParseFail(first + 1);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new ParseFail(first + 1);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseFail(i + 1);
    edits.push(e);
  });
  return edits;
}

function usage(): { code: number; out: string[] } {
  return { code: 2, out: ['error: usage'] };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
      continue;
    }
    if (!ended && a !== '-' && a.startsWith('-')) {
      if (a.startsWith('--format=')) {
        if (format !== null) return usage();
        const v = a.slice('--format='.length);
        if (!FORMATS.includes(v)) return usage();
        format = v;
      } else if (a === '--check') {
        if (check) return usage();
        check = true;
      } else if (a === '--strict') {
        if (strict) return usage();
        strict = true;
      } else {
        return usage();
      }
      continue;
    }
    pos.push(a);
  }
  if (pos.length > 1) return usage();
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0];
  let text = '';
  if (file !== null) {
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return { code: 2, out: ['error: no-patch'] };
    }
  } else {
    try {
      text = readFileSync(0, 'utf8');
    } catch {
      text = '';
    }
  }
  STRICT = strict;
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[] = [];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines);
    else edits = parseV4a(lines);
    if (edits.length === 0) throw new ParseFail(1);
  } catch (e) {
    if (e instanceof ParseFail) return { code: 2, out: ['error: parse ' + e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now = before;
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    const out = fails.map((f) => 'error: ' + f.code + ' ' + f.path);
    out.push('failed: ' + fails.length + ' of ' + edits.length + ' edits');
    return { code: 1, out };
  }
  const state = new Map<string, string>();
  for (const [p, v] of tree.now) {
    const was = tree.original(p);
    if (v === null) {
      if (was !== null) state.set(p, 'D');
    } else if (was === null) {
      state.set(p, 'A');
    } else if (was !== v) {
      state.set(p, 'M');
    }
  }
  const rows: Array<{ key: string; line: string }> = [];
  for (const mv of tree.moves) {
    if (
      state.get(mv.from) === 'D' &&
      state.get(mv.to) === 'A' &&
      tree.original(mv.from) !== null &&
      tree.original(mv.to) === null
    ) {
      state.delete(mv.from);
      state.delete(mv.to);
      rows.push({ key: mv.to, line: 'R ' + mv.from + ' -> ' + mv.to });
    }
  }
  for (const [p, s] of state) rows.push({ key: p, line: s + ' ' + p });
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key, 'utf8'), Buffer.from(y.key, 'utf8')));
  const out = rows.map((r) => r.line);
  if (!check) {
    for (const [p, v] of tree.now) {
      if (v === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, v);
      }
    }
  }
  out.push('ok: ' + rows.length + (rows.length === 1 ? ' file' : ' files'));
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => l + '\n').join(''));
  process.exitCode = r.code;
}
