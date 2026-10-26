// Canonical Markdown form used as the hash input. Formatter-only differences collapse;
// differences that change CommonMark/GFM structure or literal text stay distinct.

type BlockKind = 'blank' | 'verbatim' | 'html' | 'para' | 'setextText' | 'list' | 'heading' | 'thematic' | 'setext' | 'table' | 'fence';

interface Block {
  kind: BlockKind;
  level: number; // blockquote depth
  width: number; // leading whitespace width of the opening line (tab = 4)
  lines: string[];
  head: string; // prose: leading whitespace plus list marker
  text: string; // prose: source after the head
  brk: 'spaces' | 'backslash' | null; // trailing hard-break marker candidate
  hard: boolean;
  interrupts: boolean; // list item that can interrupt a paragraph
  closed: boolean;
  closeWidth: number;
  closeWs: string;
  fenceChar: string;
  fenceLen: number;
  info: string;
  code: string[];
}

const QUOTE = /^ {0,3}>[ \t]?/;
const SETEXT = /^(=+|-+)[ \t]*$/;
const THEMATIC = /^([-*_])([ \t]*\1){2,}[ \t]*$/;
const ATX = /^(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const LIST = /^([-*+]|\d{1,9}[.)])(?=[ \t]|$)([ \t]*)(.*)$/;
// CommonMark HTML block starts: types 1-6 may interrupt a paragraph; type 7 (a lone complete tag) may not.
const HTML_RAW = /^<(pre|script|style|textarea)(?=[\s>]|$)/i;
const HTML_SPECIAL = /^<(?:!--|\?|![A-Za-z]|!\[CDATA\[)/;
const HTML_BLOCK_TAG = /^<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?=[\s>]|\/>|$)/i;
const HTML_LONE_TAG = /^(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)[ \t]*$/;
const FENCE = /^(`{3,}|~{3,})(.*)$/;
const DELIM_CELL = /^:?-+:?$/;

// SECTION: helpers

function make(kind: BlockKind, level: number, width: number, extra: Partial<Block> = {}): Block {
  return {
    kind, level, width, lines: [], head: '', text: '', brk: null, hard: false, interrupts: false,
    closed: false, closeWidth: 0, closeWs: '', fenceChar: '', fenceLen: 0, info: '', code: [],
    ...extra,
  };
}

// NOTE: a blockquote line with no text renders as bare `>` so it stays a distinct empty quote line.
function wrap(level: number, body: string): string {
  if (level === 0) return body;
  return body === '' ? '>'.repeat(level) : `${'>'.repeat(level)} ${body}`;
}

function indentWidth(ws: string): number {
  let width = 0;
  for (const ch of ws) width += ch === '\t' ? 4 : 1;
  return width;
}

function leading(text: string): string {
  return /^[ \t]*/.exec(text)?.[0] ?? '';
}

function stripAllQuotes(line: string): { level: number; rest: string } {
  let rest = line;
  let level = 0;
  for (let m = QUOTE.exec(rest); m; m = QUOTE.exec(rest)) {
    rest = rest.slice(m[0].length);
    level++;
  }
  return { level, rest };
}

// Strips exactly `count` blockquote markers; null when the line has fewer, so the quote ended.
function stripQuotes(line: string, count: number): string | null {
  let rest = line;
  for (let k = 0; k < count; k++) {
    const m = QUOTE.exec(rest);
    if (!m) return null;
    rest = rest.slice(m[0].length);
  }
  return rest;
}

function runLength(s: string, at: number, ch: string): number {
  let end = at;
  while (end < s.length && s[end] === ch) end++;
  return end - at;
}

// Index of the next run of exactly `len` `ch` at or after `from`, or -1.
function findRun(s: string, from: number, ch: string, len: number): number {
  for (let p = from; p < s.length;) {
    if (s[p] !== ch) {
      p++;
      continue;
    }
    const run = runLength(s, p, ch);
    if (run === len) return p;
    p += run;
  }
  return -1;
}

function isEscaped(s: string, index: number): boolean {
  let slashes = 0;
  while (index - 1 - slashes >= 0 && s[index - 1 - slashes] === '\\') slashes++;
  return slashes % 2 === 1;
}

function isBoundary(ch: string): boolean {
  return /[\s\p{P}\p{S}]/u.test(ch);
}

function trailingBreak(text: string): 'spaces' | 'backslash' | null {
  if (/ {2,}$/.test(text)) return 'spaces';
  if (text.endsWith('\\') && !isEscaped(text, text.length - 1)) return 'backslash';
  return null;
}

function fenceOpener(content: string): { char: string; len: number; info: string } | null {
  const m = FENCE.exec(content);
  const run = m?.[1] ?? '';
  const info = m?.[2] ?? '';
  if (!run || (run[0] === '`' && info.includes('`'))) return null;
  return { char: run[0] ?? '`', len: run.length, info: info.trim() };
}

function startsBlock(content: string, width: number): boolean {
  if (width >= 4) return false;
  return ATX.test(content) || THEMATIC.test(content) || LIST.test(content) || fenceOpener(content) !== null;
}

// SECTION: inline

// Keeps code spans, escapes, autolinks, inline HTML and link destinations verbatim;
// rewrites flanking `_`/`__` emphasis to `*`/`**`, collapses whitespace and trims the end.
function inline(s: string): string {
  return inlineSpan(s, 0, '').out;
}

// NOTE: code spans may span lines. `open` carries an unclosed backtick run length from the previous
// paragraph line; `later` holds the paragraph's later lines. A run closed only in `later` keeps the rest
// of the line verbatim so whitespace inside stays distinct; a run never closed is literal prose.
function inlineSpan(s: string, open: number, later: string): { out: string; open: number } {
  const n = s.length;
  const verb = new Array<boolean>(n).fill(false);
  const mark = (from: number, to: number): void => {
    for (let q = from; q < to; q++) verb[q] = true;
  };
  let pending = 0;
  let start = 0;
  if (open > 0) {
    const close = findRun(s, 0, '`', open);
    if (close < 0) return { out: s, open };
    start = close + open;
    mark(0, start);
  }
  for (let i = start; i < n;) {
    const c = s[i];
    if (c === '\\' && i + 1 < n) {
      mark(i, i + 2);
      i += 2;
      continue;
    }
    if (c === '`') {
      const run = runLength(s, i, '`');
      const close = findRun(s, i + run, '`', run);
      if (close >= 0) {
        mark(i, close + run);
        i = close + run;
      } else if (findRun(later, 0, '`', run) < 0) {
        mark(i, i + run);
        i += run;
      } else {
        mark(i, n);
        pending = run;
        i = n;
      }
      continue;
    }
    if (c === '<') {
      const end = s.indexOf('>', i + 1);
      if (end > i + 1 && !/\s/.test(s[i + 1] ?? '')) {
        mark(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    if (c === ']' && s[i + 1] === '(') {
      let depth = 0;
      let j = i + 1;
      for (; j < n; j++) {
        if (s[j] === '(') depth++;
        else if (s[j] === ')' && --depth === 0) break;
      }
      if (j < n) {
        mark(i, j + 1);
        i = j + 1;
        continue;
      }
    }
    i++;
  }

  const underscoreRun = (at: number): number => {
    let e = at;
    while (e < n && s[e] === '_' && !verb[e]) e++;
    return e - at;
  };
  const emphasis = new Array<boolean>(n).fill(false);
  for (let k = 0; k < n;) {
    if (verb[k] || s[k] !== '_') {
      k++;
      continue;
    }
    const run = underscoreRun(k);
    const before = k === 0 ? ' ' : (s[k - 1] ?? ' ');
    if (run <= 2 && isBoundary(before) && !/\s/.test(s[k + run] ?? ' ')) {
      let found = -1;
      for (let p = k + run; p < n;) {
        if (verb[p] || s[p] !== '_') {
          p++;
          continue;
        }
        const q = underscoreRun(p);
        if (q === run && !/\s/.test(s[p - 1] ?? ' ') && isBoundary(s[p + q] ?? ' ')) {
          found = p;
          break;
        }
        p += q;
      }
      if (found >= 0) {
        for (let x = 0; x < run; x++) {
          emphasis[k + x] = true;
          emphasis[found + x] = true;
        }
        k = found + run;
        continue;
      }
    }
    k += run;
  }

  let end = n;
  while (end > 0 && !verb[end - 1] && (s[end - 1] === ' ' || s[end - 1] === '\t')) end--;
  let out = '';
  for (let q = 0; q < end; q++) {
    const ch = s[q] ?? '';
    if (verb[q]) {
      out += ch;
    } else if (ch === ' ' || ch === '\t') {
      if (!(q > 0 && !verb[q - 1] && (s[q - 1] === ' ' || s[q - 1] === '\t'))) out += ' ';
    } else {
      out += emphasis[q] ? '*' : ch;
    }
  }
  return { out, open: pending };
}

// SECTION: tables

// Splits on unescaped pipes outside code spans; cells are trimmed.
function splitCells(body: string): string[] {
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < body.length;) {
    const c = body[i] ?? '';
    if (c === '\\' && i + 1 < body.length) {
      cur += body.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === '`') {
      const run = runLength(body, i, '`');
      const close = findRun(body, i + run, '`', run);
      const stop = close >= 0 ? close + run : i + run;
      cur += body.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '|') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
    i++;
  }
  cells.push(cur.trim());
  return cells;
}

function tableCells(content: string): { cells: string[]; piped: boolean } {
  let body = content.replace(/[ \t]+$/, '');
  let piped = false;
  if (body.startsWith('|')) {
    body = body.slice(1);
    piped = true;
  }
  if (body.endsWith('|') && !isEscaped(body, body.length - 1)) {
    body = body.slice(0, -1);
    piped = true;
  }
  const cells = splitCells(body);
  // NOTE: a row with no pipe at all keeps its bare form; it is distinct from a piped row.
  return { cells, piped: piped || cells.length > 1 };
}

function isDelimiter(content: string): boolean {
  return content.includes('|') && tableCells(content).cells.every(cell => DELIM_CELL.test(cell));
}

function delimiterCell(cell: string): string {
  return `${cell.startsWith(':') ? ':' : ''}-${cell.endsWith(':') ? ':' : ''}`;
}

function tableLine(lead: string, content: string, delimiter: boolean): string {
  const { cells, piped } = tableCells(content);
  if (!piped) return lead + inline(cells[0] ?? '');
  const body = cells.map(cell => (delimiter ? delimiterCell(cell) : inline(cell))).join('|');
  return `${lead}|${body}|`;
}

// SECTION: fences

function renderFence(b: Block): string[] {
  const char = b.info.includes('`') ? '~' : '`';
  const runs = b.code.join('\n').match(char === '`' ? /`+/g : /~+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  const marker = char.repeat(Math.max(3, longest + 1));
  const out = [wrap(b.level, `${b.head}${marker}${b.info ? ` ${b.info}` : ''}`)];
  for (const line of b.code) out.push(wrap(b.level, line));
  if (b.closed) out.push(wrap(b.level, b.closeWs + marker));
  return out;
}

// SECTION: prose and block-run rules

function renderProse(b: Block, open: number, later: string): { line: string; open: number } {
  const whole = inlineSpan(b.text, open, later);
  // NOTE: a line ending inside a code span has no hard break; its trailing spaces or backslash are code.
  const hard = b.hard && b.brk && whole.open === 0;
  if (!hard) return { line: wrap(b.level, b.head + whole.out), open: whole.open };
  const source = b.brk === 'spaces' ? b.text.replace(/ +$/, '') : b.text.slice(0, -1);
  return { line: wrap(b.level, `${b.head}${inlineSpan(source, open, later).out}\\`), open: 0 };
}

// Index of the first block of the paragraph run containing blocks[index] (same blockquote level).
function paragraphRunStart(blocks: Block[], index: number): number {
  const level = blocks[index]?.level;
  let j = index;
  while (j > 0 && blocks[j - 1]?.kind === 'para' && blocks[j - 1]?.level === level) j--;
  return j;
}

function edgeWidth(b: Block, side: 'start' | 'end'): number {
  return b.kind === 'fence' && side === 'end' ? b.closeWidth : b.width;
}

function isPlain(b: Block, side: 'start' | 'end'): boolean {
  return b.level === 0 && edgeWidth(b, side) === 0;
}

function isSpecial(b: Block, side: 'start' | 'end'): boolean {
  if (b.kind === 'fence') return b.level === 0 && (side === 'start' || b.closed) && isPlain(b, side);
  return (b.kind === 'heading' || b.kind === 'thematic') && isPlain(b, side);
}

// True when a top-level blank line between blocks p and n has no structural effect.
function dropBlank(items: Block[], k: number): boolean {
  let p = k - 1;
  while (p >= 0 && items[p]?.kind === 'blank') p--;
  let n = k + 1;
  while (n < items.length && items[n]?.kind === 'blank') n++;
  const before = items[p];
  const after = items[n];
  if (!before || !after) return true;
  const ruleA = (isSpecial(before, 'end') && isPlain(after, 'start')) || (isSpecial(after, 'start') && isPlain(before, 'end'));
  if (ruleA) return true;
  const start = paragraphRunStart(items, p);
  const first = items[start];
  const ruleB = after.kind === 'list' && after.level === 0 && after.width === 0 && after.interrupts
    && before.kind === 'para' && before.level === 0 && first !== undefined && first.kind === 'para'
    && first.width === 0 && first.level === 0 && items[start - 1]?.kind !== 'list';
  return ruleB;
}

// SECTION: canonicalization

export function canonicalMarkdown(text: string): string {
  const raw = text.split(/\r\n|\r|\n/);
  const full = raw.map(stripAllQuotes);
  const blocks: Block[] = [];
  let fence: Block | null = null;
  let html: { level: number; end: RegExp | null } | null = null;

  for (let i = 0; i < raw.length;) {
    const line = raw[i] ?? '';

    if (html) {
      const inner = stripQuotes(line, html.level);
      if (inner !== null && (html.end !== null || inner.trim() !== '')) {
        blocks.push(make('html', html.level, 0, { lines: [wrap(html.level, inner)] }));
        if (html.end?.test(inner)) html = null;
        i++;
        continue;
      }
      html = null;
    }

    if (fence) {
      const inner = stripQuotes(line, fence.level);
      if (inner !== null) {
        const closer = new RegExp(`^([ \\t]*)(${fence.fenceChar}{${fence.fenceLen},})[ \\t]*$`).exec(inner);
        if (closer) {
          fence.closed = true;
          fence.closeWs = closer[1] ?? '';
          fence.closeWidth = indentWidth(fence.closeWs);
          fence = null;
        } else {
          fence.code.push(inner);
        }
        i++;
        continue;
      }
      fence = null;
    }

    const { level, rest } = full[i] ?? { level: 0, rest: line };
    const lead = leading(rest);
    const content = rest.slice(lead.length);
    const width = indentWidth(lead);
    const prev = blocks.at(-1);

    if (content === '') {
      if (prev?.kind === 'verbatim' && prev.level === level && nextIndentedAt(full, i + 1, level)) {
        blocks.push(make('verbatim', level, width, { lines: [wrap(level, rest)] }));
      } else {
        blocks.push(make('blank', level, 0));
      }
      i++;
      continue;
    }

    if (prev?.kind === 'verbatim' && prev.level === level && width >= 4) {
      blocks.push(make('verbatim', level, width, { lines: [wrap(level, rest)] }));
      i++;
      continue;
    }

    if (prev?.kind === 'table' && prev.level === level && !startsBlock(content, width)) {
      blocks.push(make('table', level, width, { lines: [wrap(level, tableLine(lead, content, false))] }));
      i++;
      continue;
    }

    if (width >= 4) {
      const canStart = !prev || !['para', 'setextText', 'list', 'table'].includes(prev.kind);
      if (canStart) blocks.push(make('verbatim', level, width, { lines: [wrap(level, rest)] }));
      else blocks.push(make('para', level, width, { head: lead, text: content, brk: trailingBreak(content) }));
      i++;
      continue;
    }

    const opener = fenceOpener(content);
    if (opener) {
      fence = make('fence', level, width, {
        head: lead, fenceChar: opener.char, fenceLen: opener.len, info: opener.info,
      });
      blocks.push(fence);
      i++;
      continue;
    }

    if (prev?.kind === 'para' && prev.level === level && SETEXT.test(content)) {
      const owner = blocks[paragraphRunStart(blocks, blocks.length - 1) - 1];
      if (owner?.kind !== 'list') {
        prev.kind = 'setextText';
        blocks.push(make('setext', level, width, { lines: [wrap(level, `${lead}${content[0] === '=' ? '===' : '---'}`)] }));
        i++;
        continue;
      }
    }

    // NOTE: HTML block bodies pass verbatim, so whitespace inside `<pre>` and similar stays distinct.
    const lone = HTML_LONE_TAG.test(content) && !(prev?.kind === 'para' && prev.level === level);
    if (HTML_RAW.test(content) || HTML_SPECIAL.test(content) || HTML_BLOCK_TAG.test(content) || lone) {
      const tag = HTML_RAW.exec(content)?.[1];
      const end = tag ? new RegExp(`</${tag}>`, 'i') : content.startsWith('<!--') ? /-->/ : null;
      blocks.push(make('html', level, width, { lines: [wrap(level, rest)] }));
      if (!end?.test(content.slice(1))) html = { level, end };
      i++;
      continue;
    }

    if (THEMATIC.test(content)) {
      blocks.push(make('thematic', level, width, { lines: [wrap(level, `${lead}***`)] }));
      i++;
      continue;
    }

    const heading = ATX.exec(content);
    if (heading) {
      const title = heading[2] ? ` ${inline(heading[2])}` : '';
      blocks.push(make('heading', level, width, { lines: [wrap(level, `${lead}${heading[1] ?? ''}${title}`)] }));
      i++;
      continue;
    }

    const item = LIST.exec(content);
    if (item) {
      const marker = item[1] ?? '';
      const body = item[3] ?? '';
      const numeric = /^\d/.test(marker);
      blocks.push(make('list', level, width, {
        // NOTE: the gap after the marker passes verbatim; its width sets content indent and indented code.
        head: lead + marker + (item[2] ?? ''),
        text: body,
        brk: trailingBreak(body),
        interrupts: body.trim() !== '' && (!numeric || Number.parseInt(marker, 10) === 1),
      }));
      i++;
      continue;
    }

    const next = full[i + 1];
    if (next && next.level === level) {
      const nextLead = leading(next.rest);
      const nextContent = next.rest.slice(nextLead.length);
      if (indentWidth(nextLead) < 4 && isDelimiter(nextContent)
        && tableCells(content).cells.length === tableCells(nextContent).cells.length) {
        blocks.push(make('table', level, width, { lines: [wrap(level, tableLine(lead, content, false))] }));
        blocks.push(make('table', level, indentWidth(nextLead), { lines: [wrap(level, tableLine(nextLead, nextContent, true))] }));
        i += 2;
        continue;
      }
    }

    blocks.push(make('para', level, width, { head: lead, text: content, brk: trailingBreak(content) }));
    i++;
  }

  return finish(blocks);
}

// True when the next non-blank line at `level` is indented by 4 or more (indented code continues).
function nextIndentedAt(full: Array<{ level: number; rest: string }>, from: number, level: number): boolean {
  let j = from;
  while (j < full.length && (full[j]?.rest.trim() ?? '') === '') j++;
  const target = full[j];
  return target !== undefined && target.level === level && indentWidth(leading(target.rest)) >= 4;
}

function finish(blocks: Block[]): string {
  // A prose line followed by a paragraph line of the same level keeps a trailing hard break.
  blocks.forEach((b, index) => {
    const after = blocks[index + 1];
    if (b.brk && after?.kind === 'para' && after.level === b.level) b.hard = true;
  });

  // A code span left open continues only into later lines of the same paragraph.
  let open = 0;
  blocks.forEach((b, index) => {
    if (b.kind !== 'para' && b.kind !== 'setextText') open = 0;
    if (b.kind === 'fence') b.lines = renderFence(b);
    else if (b.kind === 'para' || b.kind === 'setextText' || b.kind === 'list') {
      const later: string[] = [];
      for (let j = index + 1; blocks[j]?.kind === 'para' || blocks[j]?.kind === 'setextText'; j++) {
        if (blocks[j]?.level !== b.level) break;
        later.push(blocks[j]?.text ?? '');
      }
      const r = renderProse(b, open, later.join('\n'));
      b.lines = [r.line];
      open = r.open;
    }
    else if (b.kind === 'blank') b.lines = [wrap(b.level, '')];
  });

  // Collapse runs of blank lines at the same blockquote level into one.
  const items: Block[] = [];
  for (const b of blocks) {
    const last = items.at(-1);
    if (b.kind === 'blank' && last?.kind === 'blank' && last.level === b.level) continue;
    items.push(b);
  }

  const out: string[] = [];
  items.forEach((b, k) => {
    if (b.kind === 'blank' && b.level === 0 && dropBlank(items, k)) return;
    out.push(...b.lines);
  });
  return out.join('\n');
}
