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
