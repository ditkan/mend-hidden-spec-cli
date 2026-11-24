// mend: applies an AI-written edit to a tree of text files, exactly as SPEC.md says.
// Four patch formats: unified diff, SEARCH/REPLACE blocks, V4A patches, JSON tool calls.
// Every file changes or nothing does. Node 22, standard library only; run as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and this
// file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Thrown to end the run with exit 2 and one output line. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit that failed: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, not absolute, holds no backslash, and none of its
 *  segments is empty, `.` or `..`. */
function safe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's text broken into lines, its line break, and whether it ends with one. */
interface Split {
  lines: string[];
  br: string;
  final: boolean;
}

function splitText(text: string): Split {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinText(s: Split): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.final ? s.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null means deleted),
 *  the rest read from disk. `moves` records successful move edits as [old, new]. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];

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
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// ---- Section 5: matching lines ---------------------------------------------

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;

/** One line of O or N. A context line also occurs in the other side, and is written
 *  as the file's own matched line, never the patch's. */
interface Seg {
  text: string;
  ctx: boolean;
}

/** Positions i where O matches the file's lines starting at i, at one tier. */
function occurrencesAt(file: string[], o: string[], tier: number): number[] {
  const eq =
    tier === 0
      ? (a: string, b: string): boolean => a === b
      : tier === 1
        ? (a: string, b: string): boolean => trimEndWs(a) === trimEndWs(b)
        : (a: string, b: string): boolean => trimBothWs(a) === trimBothWs(b);
  const out: number[] = [];
  for (let i = 0; i + o.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!eq(file[i + j]!, o[j]!)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2; only 0 when strict) at which O occurs at least once,
 *  and every position there, or null when O occurs at no tier. */
function firstTier(file: string[], o: string[], strict: boolean): { tier: number; at: number[] } | null {
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier++) {
    const at = occurrencesAt(file, o, tier);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** The lines N writes when it replaces O matched at position `pos` in `file`.
 *  Context lines come from the file; at tier 2 the other lines are re-indented. */
function replacedLines(file: string[], o: Seg[], n: Seg[], tier: number, pos: number): string[] {
  const oCtx = o.map((s, i) => (s.ctx ? i : -1)).filter((i) => i >= 0);
  let seenCtx = -1;
  const p = o.length > 0 ? leadWs(o[0]!.text) : '';
  const f = o.length > 0 ? leadWs(file[pos]!) : '';
  return n.map((s) => {
    if (s.ctx) {
      seenCtx += 1;
      return file[pos + oCtx[seenCtx]!]!;
    }
    if (tier === 2 && s.text !== '' && s.text.trim() !== '' && s.text.startsWith(p)) {
      return f + s.text.slice(p.length);
    }
    return s.text;
  });
}

/** Positions at or after `from` where the single line `want` matches, at the first
 *  tier with one, or null. Used for V4A anchors. */
function anchorAt(file: string[], want: string, from: number, strict: boolean): number | null {
  const found = firstTier(file.slice(from), [want], strict);
  if (found === null) return null;
  return from + found.at[0]!;
}

// ---- Section 4: detecting the format ---------------------------------------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- Section 9: JSON edits --------------------------------------------------

/** One JSON edit object, or null when the value is not a valid edit object. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;

  /** The file's text, after the safety and existence checks. */
  const read = (tree: Tree): string => {
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

  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = read(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + norm(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }

  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = read(tree);
      const s = splitText(before);
      if (line < 0 || line > s.lines.length) throw new Fail('no-match', p);
      s.lines.splice(line, 0, ...add);
      tree.now.set(p, joinText(s));
    };
  }

  return null;
}

/** The edits of a JSON patch: one array, or one edit object per line. */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
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
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Section 6: unified diffs ------------------------------------------------

/** One hunk: A is the old start line from its header, O and N its old and new lines. */
interface Hunk {
  a: number;
  o: Seg[];
  n: Seg[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noNewline: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  plusNoNewline: boolean;
}

/** One section of a unified diff, as parsed. A path is undefined when not named,
 *  null when named as /dev/null. */
interface Section {
  diffOld?: string;
  diffNew?: string;
  dashOld?: string | null;
  plusNew?: string | null;
  renFrom?: string;
  renTo?: string;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
  seenHunk: boolean;
}

/** The path of a `--- ` or `+++ ` line: text after the four characters, up to the
 *  first tab, surrounding spaces removed, a leading a/ or b/ removed. */
function diffPath(raw: string): string | null {
  let t = raw.slice(4).split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const L = lines[i]!;
    if (L.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(L);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { diffOld: m[1]!.trim(), diffNew: m[2]!.trim(), create: false, del: false, hunks: [], seenHunk: false };
      sections.push(cur);
      i += 1;
      continue;
    }
    if (L.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(L);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: string[] = [];
      let j = i + 1;
      while (j < n) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          body.push(b);
          j += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const o: Seg[] = [];
      const nn: Seg[] = [];
      let lastCtxPlus = -1;
      let lastPlus = -1;
      for (let k = 0; k < body.length; k++) {
        const b = body[k]!;
        if (b.startsWith('\\')) continue;
        if (b.startsWith(' ')) {
          o.push({ text: b.slice(1), ctx: true });
          nn.push({ text: b.slice(1), ctx: true });
          lastCtxPlus = k;
        } else if (b.startsWith('-')) {
          o.push({ text: b.slice(1), ctx: false });
        } else if (b.startsWith('+')) {
          nn.push({ text: b.slice(1), ctx: false });
          lastCtxPlus = k;
          lastPlus = k;
        } else {
          o.push({ text: '', ctx: true });
          nn.push({ text: '', ctx: true });
          lastCtxPlus = k;
        }
      }
      const after = (k: number): boolean => k >= 0 && k + 1 < body.length && body[k + 1]!.startsWith('\\');
      cur.hunks.push({ a: Number(m[1]), o, n: nn, noNewline: after(lastCtxPlus), plusNoNewline: after(lastPlus) });
      cur.seenHunk = true;
      i = j;
      continue;
    }
    if (L.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        if (cur !== null && !cur.seenHunk) {
          cur.dashOld = diffPath(L);
          cur.plusNew = diffPath(next);
          i += 2;
          continue;
        }
        cur = { dashOld: diffPath(L), plusNew: diffPath(next), create: false, del: false, hunks: [], seenHunk: false };
        sections.push(cur);
        i += 2;
        continue;
      }
      if (cur !== null && !cur.seenHunk) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (cur !== null && !cur.seenHunk) {
      if (L.startsWith('+++ ')) cur.plusNew = diffPath(L);
      else if (L.startsWith('rename from ')) cur.renFrom = L.slice(12).trim();
      else if (L.startsWith('rename to ')) cur.renTo = L.slice(10).trim();
      else if (L.startsWith('new file mode')) cur.create = true;
      else if (L.startsWith('deleted file mode')) cur.del = true;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => sectionEdit(s, strict));
}

/** Apply one hunk to the file's split text, at offset d from earlier hunks. */
function applyHunk(st: Split, h: Hunk, strict: boolean, path: string, d: number): void {
  if (h.o.length === 0) {
    const pos = Math.min(Math.max(h.a + d, 0), st.lines.length);
    const atEnd = pos === st.lines.length;
    st.lines.splice(pos, 0, ...h.n.map((s) => s.text));
    if (atEnd) st.final = !h.noNewline;
    return;
  }
  const oTexts = h.o.map((s) => s.text);
  const found = firstTier(st.lines, oTexts, strict);
  if (found === null) throw new Fail('no-match', path);
  const want = h.a - 1 + d;
  let best = found.at[0]!;
  for (const p of found.at) {
    if (Math.abs(p - want) < Math.abs(best - want)) best = p;
  }
  const pos = best;
  const toEnd = pos + h.o.length === st.lines.length;
  const out = replacedLines(st.lines, h.o, h.n, found.tier, pos);
  st.lines.splice(pos, h.o.length, ...out);
  if (toEnd) st.final = !h.noNewline;
}

/** Apply a section's hunks in order, each to the result of the ones before it. */
function applyHunks(st: Split, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    applyHunk(st, h, strict, path, d);
    d += h.n.length - h.o.length;
  }
}

/** One section is one edit: a creation, a deletion, a move, or a change. */
function sectionEdit(s: Section, strict: boolean): Edit {
  const oldP = s.dashOld !== undefined ? s.dashOld : s.renFrom !== undefined ? s.renFrom : s.diffOld;
  const newP = s.plusNew !== undefined ? s.plusNew : s.renTo !== undefined ? s.renTo : s.diffNew;
  if (oldP === null || s.create) {
    const target = newP;
    return (tree) => {
      if (target === null || target === undefined) return;
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const made: string[] = [];
      for (const h of s.hunks) made.push(...h.n.filter((x) => !x.ctx).map((x) => x.text));
      let noNl = false;
      for (let k = s.hunks.length - 1; k >= 0; k--) {
        if (s.hunks[k]!.n.some((x) => !x.ctx)) {
          noNl = s.hunks[k]!.plusNoNewline;
          break;
        }
      }
      tree.now.set(target, made.length === 0 ? '' : made.join('\n') + (noNl ? '' : '\n'));
    };
  }
  if (newP === null || s.del) {
    const target = oldP;
    return (tree) => {
      if (target === undefined) return;
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
    };
  }
  if (oldP !== undefined && newP !== undefined && oldP !== newP) {
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const st = splitText(before);
      applyHunks(st, s.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, joinText(st));
      tree.moves.push([oldP, newP]);
    };
  }
  const target = oldP;
  return (tree) => {
    if (target === undefined) return;
    if (!safe(target)) throw new Fail('unsafe', target);
    const before = tree.get(target);
    if (before === null) throw new Fail('missing', target);
    const st = splitText(before);
    applyHunks(st, s.hunks, strict, target);
    tree.now.set(target, joinText(st));
  };
}

// ---- Section 7: SEARCH/REPLACE blocks ---------------------------------------

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const st = splitText(before);
    const found = firstTier(st.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.at.length > 1) throw new Fail('ambiguous', path);
    const pos = found.at[0]!;
    const o: Seg[] = oldLines.map((t) => ({ text: t, ctx: false }));
    const nn: Seg[] = newLines.map((t) => ({ text: t, ctx: false }));
    const out = replacedLines(st.lines, o, nn, found.tier, pos);
    st.lines.splice(pos, oldLines.length, ...out);
    tree.now.set(path, joinText(st));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let k = searchLine - 1; k > prevEnd; k--) {
      const t = lines[k]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    let eq = -1;
    for (let k = searchLine + 1; k < n; k++) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let k = eq + 1; k < n; k++) {
        if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') break;
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = k;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(srEdit(path, lines.slice(searchLine + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---- Section 8: V4A patches --------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  o: Seg[];
  n: Seg[];
  eof: boolean;
}

interface VSection {
  kind: string;
  path: string;
  lineNo: number;
  raw: Array<{ text: string; no: number }>;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  for (let k = first + 1; k < last; k++) {
    const L = lines[k]!;
    let kind: string | null = null;
    let path = '';
    if (L.startsWith('*** Add File: ')) {
      kind = 'add';
      path = L.slice(14).trim();
    } else if (L.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = L.slice(17).trim();
    } else if (L.startsWith('*** Update File: ')) {
      kind = 'update';
      path = L.slice(17).trim();
    }
    if (kind !== null) {
      cur = { kind, path, lineNo: k + 1, raw: [] };
      sections.push(cur);
      continue;
    }
    if (cur === null) {
      if (blank(L)) continue;
      throw new Exit2(`error: parse ${k + 1}`);
    }
    cur.raw.push({ text: L, no: k + 1 });
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  for (const s of sections) {
    while (s.raw.length > 0 && blank(s.raw[s.raw.length - 1]!.text)) s.raw.pop();
    if (s.kind === 'add') {
      const made: string[] = [];
      for (const r of s.raw) {
        if (r.text.startsWith('+')) made.push(r.text.slice(1));
        else if (r.text === '') made.push('');
        else throw new Exit2(`error: parse ${r.no}`);
      }
      edits.push(v4aAdd(s.path, made));
    } else if (s.kind === 'delete') {
      const bad = s.raw.find((r) => !blank(r.text));
      if (bad !== undefined) throw new Exit2(`error: parse ${bad.no}`);
      edits.push(v4aDelete(s.path));
    } else {
      edits.push(v4aUpdateEdit(s, strict));
    }
  }
  return edits;
}

function v4aAdd(path: string, made: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, made.length === 0 ? '' : made.join('\n') + '\n');
  };
}

function v4aDelete(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

/** Apply one V4A chunk at the cursor; returns the cursor after the lines written. */
function applyV4aChunk(st: Split, c: V4aChunk, strict: boolean, path: string, cursor: number): number {
  if (c.anchor !== null) {
    const at = anchorAt(st.lines, c.anchor, cursor, strict);
    if (at === null) throw new Fail('no-match', path);
    cursor = at + 1;
  }
  const oTexts = c.o.map((s) => s.text);
  if (c.o.length === 0) {
    const pos = c.eof ? st.lines.length : cursor;
    st.lines.splice(pos, 0, ...c.n.map((s) => s.text));
    return pos + c.n.length;
  }
  let found: { tier: number; at: number[] } | null = null;
  for (let tier = 0; tier <= (strict ? 0 : 2); tier++) {
    let at = occurrencesAt(st.lines, oTexts, tier).filter((p) => p >= cursor);
    if (c.eof) at = at.filter((p) => p + oTexts.length === st.lines.length);
    if (at.length > 0) {
      found = { tier, at };
      break;
    }
  }
  if (found === null) throw new Fail('no-match', path);
  const pos = found.at[0]!;
  const out = replacedLines(st.lines, c.o, c.n, found.tier, pos);
  st.lines.splice(pos, c.o.length, ...out);
  return pos + out.length;
}

function v4aUpdate(path: string, moveTo: string | undefined, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== undefined && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== undefined && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const st = splitText(before);
    let cursor = 0;
    for (const c of chunks) cursor = applyV4aChunk(st, c, strict, path, cursor);
    const out = joinText(st);
    if (moveTo !== undefined) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

/** Parse an Update File section's chunks from its raw lines. */
function v4aUpdateEdit(s: VSection, strict: boolean): Edit {
  let idx = 0;
  let moveTo: string | undefined;
  if (s.raw.length > 0 && s.raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = s.raw[0]!.text.slice(13).trim();
    idx = 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  for (; idx < s.raw.length; idx++) {
    const r = s.raw[idx]!;
    const L = r.text;
    if (L.startsWith('@@')) {
      const anchor = L.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, o: [], n: [], eof: false };
      chunks.push(cur);
      continue;
    }
    if (L === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${r.no}`);
      cur.eof = true;
      cur = null;
      continue;
    }
    if (L.startsWith('***')) throw new Exit2(`error: parse ${r.no}`);
    if (L.startsWith(' ') || L.startsWith('-') || L.startsWith('+') || L === '') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${r.no}`);
        cur = { anchor: null, o: [], n: [], eof: false };
        chunks.push(cur);
      }
      if (L.startsWith(' ')) {
        cur.o.push({ text: L.slice(1), ctx: true });
        cur.n.push({ text: L.slice(1), ctx: true });
      } else if (L.startsWith('-')) {
        cur.o.push({ text: L.slice(1), ctx: false });
      } else if (L.startsWith('+')) {
        cur.n.push({ text: L.slice(1), ctx: false });
      } else {
        cur.o.push({ text: '', ctx: true });
        cur.n.push({ text: '', ctx: true });
      }
      continue;
    }
    throw new Exit2(`error: parse ${r.no}`);
  }
  if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${s.lineNo}`);
  return v4aUpdate(s.path, moveTo, chunks, strict);
}

// ---- Sections 1, 2, 10: invocation, output, order and atomicity -------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
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
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows: Array<{ key: string; line: string }> = [];
  const hidden = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      hidden.add(oldP);
      hidden.add(newP);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (hidden.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now || now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
