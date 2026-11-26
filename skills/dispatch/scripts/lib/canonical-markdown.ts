// oxlint-disable-next-line eslint/complexity -- inline emphasis/code scanner state machine; refactor deferred to avoid behavior drift.
const inlineSpan = (s: string, open: number, later: string) => {
  const n = s.length;
  const verb = Array.from({ length: n }, () => false);

  const mark = (from: number, to: number) => {
    for (let q = from; q < to; q += 1) {
      verb[q] = true;
    }
  };

  let pending = 0;
  let start = 0;

  if (open > 0) {
    const close = findRun(s, 0, "`", open);

    if (close < 0) {
      return { out: s, open };
    }

    start = close + open;
    mark(0, start);
  }

  for (let i = start; i < n;) {
    const c = s[i];

    if (c === "\\" && i + 1 < n) {
      mark(i, i + 2);
      i += 2;
      continue;
    }

    if (c === "`") {
      const run = runLength(s, i, "`");
      const close = findRun(s, i + run, "`", run);

      if (close >= 0) {
        mark(i, close + run);
        i = close + run;
      } else if (findRun(later, 0, "`", run) < 0) {
        mark(i, i + run);
        i += run;
      } else {
        mark(i, n);
        pending = run;
        i = n;
      }

      continue;
    }

    if (c === "<") {
      const end = s.indexOf(">", i + 1);

      if (end > i + 1 && !/\s/u.test(s[i + 1] ?? "")) {
        mark(i, end + 1);
        i = end + 1;
        continue;
      }
    }

    if (c === "]" && s[i + 1] === "(") {
      let depth = 0;
      let j = i + 1;

      for (; j < n; j += 1) {
        if (s[j] === "(") {
          depth += 1;
        } else if (s[j] === ")") {
          depth -= 1;

          if (depth === 0) {
            break;
          }
        }
      }

      if (j < n) {
        mark(i, j + 1);
        i = j + 1;
        continue;
      }
    }

    i += 1;
  }

  const underscoreRun = (at: number) => {
    let e = at;

    while (e < n && s[e] === "_" && verb[e] !== true) {
      e += 1;
    }

    return e - at;
  };

  const emphasis = Array.from({ length: n }, () => false);

  for (let k = 0; k < n;) {
    if (verb[k] === true || s[k] !== "_") {
      k += 1;
      continue;
    }

    const run = underscoreRun(k);
    const before = k === 0 ? " " : (s[k - 1] ?? " ");

    if (run <= 2 && isBoundary(before) && !/\s/u.test(s[k + run] ?? " ")) {
      let found = -1;

      for (let p = k + run; p < n;) {
        if (verb[p] === true || s[p] !== "_") {
          p += 1;
          continue;
        }

        const q = underscoreRun(p);

        if (
          q === run &&
          !/\s/u.test(s[p - 1] ?? " ") &&
          isBoundary(s[p + q] ?? " ")
        ) {
          found = p;
          break;
        }

        p += q;
      }

      if (found >= 0) {
        for (let x = 0; x < run; x += 1) {
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

  while (
    end > 0 &&
    verb[end - 1] !== true &&
    (s[end - 1] === " " || s[end - 1] === "\t")
  ) {
    end -= 1;
  }

  let out = "";

  for (let q = 0; q < end; q += 1) {
    const ch = s[q] ?? "";

    if (verb[q] === true) {
      out += ch;
    } else if (ch === " " || ch === "\t") {
      if (
        !(
          q > 0 &&
          verb[q - 1] !== true &&
          (s[q - 1] === " " || s[q - 1] === "\t")
        )
      ) {
        out += " ";
      }
    } else {
      out += emphasis[q] === true ? "*" : ch;
    }
  }

  return { out, open: pending };
};

const nextIndentedAt = (
  full: { level: number; rest: string }[],
  from: number,
  level: number
) => {
  let j = from;

  while (j < full.length && (full[j]?.rest.trim() ?? "") === "") {
    j += 1;
  }

  const target = full[j];

  return (
    target !== undefined &&
    target.level === level &&
    indentWidth(leading(target.rest)) >= 4
  );
};

// oxlint-disable-next-line eslint/complexity -- block finalizer mirrors the canonical Markdown block table; refactor deferred.
const finish = (blocks: Block[]) => {
  for (const [index, b] of blocks.entries()) {
    const after = blocks[index + 1];

    if (b.brk && after?.kind === "para" && after.level === b.level) {
      b.hard = true;
    }
  }

  let open = 0;

  for (const [index, b] of blocks.entries()) {
    if (b.kind !== "para" && b.kind !== "setextText") {
      open = 0;
    }

    if (b.kind === "fence") {
      b.lines = renderFence(b);
    } else if (
      b.kind === "para" ||
      b.kind === "setextText" ||
      b.kind === "list"
    ) {
      const later: string[] = [];

      for (
        let j = index + 1;
        blocks[j]?.kind === "para" || blocks[j]?.kind === "setextText";
        j += 1
      ) {
        if (blocks[j]?.level !== b.level) {
          break;
        }

        later.push(blocks[j]?.text ?? "");
      }

      const r = renderProse(b, open, later.join("\n"));
      b.lines = [r.line];
      ({ open } = r);
    } else if (b.kind === "blank") {
      b.lines = [wrap(b.level, "")];
    }
  }

  const items: Block[] = [];

  for (const b of blocks) {
    const last = items.at(-1);

    if (
      b.kind === "blank" &&
      last?.kind === "blank" &&
      last.level === b.level
    ) {
      continue;
    }

    items.push(b);
  }

  const out: string[] = [];

  for (const [k, b] of items.entries()) {
    if (b.kind === "blank" && b.level === 0 && dropBlank(items, k)) {
      continue;
    }

    out.push(...b.lines);
  }

  return out.join("\n");
};

type BlockKind =
  | "blank"
  | "verbatim"
  | "html"
  | "para"
  | "setextText"
  | "list"
  | "heading"
  | "thematic"
  | "setext"
  | "table"
  | "fence";

interface Block {
  kind: BlockKind;
  level: number;
  width: number;
  lines: string[];
  head: string;
  text: string;
  brk: "spaces" | "backslash" | null;
  hard: boolean;
  interrupts: boolean;
  closed: boolean;
  closeWidth: number;
  closeWs: string;
  fenceChar: string;
  fenceLen: number;
  info: string;
  code: string[];
}

const QUOTE = /^ {0,3}>[ \t]?/u;
const SETEXT = /^(?<rg1>=+|-+)[ \t]*$/u;
const THEMATIC = /^(?<rg1>[-*_])(?<rg2>[ \t]*\1){2,}[ \t]*$/u;
const ATX = /^(?<rg1>#{1,6})(?:[ \t]+(?<rg2>.*?))?(?:[ \t]+#+)?[ \t]*$/u;
const LIST = /^(?<rg1>[-*+]|\d{1,9}[.)])(?=[ \t]|$)(?<rg2>[ \t]*)(?<rg3>.*)$/u;

// NOTE: tag regexes omit `u`; CommonMark tag names are ASCII and `iu` folds U+017F to `s`.
// oxlint-disable-next-line eslint/require-unicode-regexp -- see NOTE above.
const HTML_RAW = /^<(?<rg1>pre|script|style|textarea)(?=[\s>]|$)/i;
const HTML_SPECIAL = /^<(?:!--|\?|![A-Za-z]|!\[CDATA\[)/u;

const HTML_BLOCK_TAG =
  // oxlint-disable-next-line eslint/require-unicode-regexp -- see NOTE above HTML_RAW.
  /^<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?=[\s>]|\/>|$)/iu;

const HTML_LONE_TAG =
  /^(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)[ \t]*$/u;

const FENCE = /^(?<rg1>`{3,}|~{3,})(?<rg2>.*)$/u;
const DELIM_CELL = /^:?-+:?$/u;

const make = (
  kind: BlockKind,
  level: number,
  width: number,
  extra: Partial<Block> = {}
) => ({
  kind,
  level,
  width,
  lines: [],
  head: "",
  text: "",
  brk: null,
  hard: false,
  interrupts: false,
  closed: false,
  closeWidth: 0,
  closeWs: "",
  fenceChar: "",
  fenceLen: 0,
  info: "",
  code: [],
  ...extra,
});

const wrap = (level: number, body: string) => {
  if (level === 0) {
    return body;
  }

  return body === "" ? ">".repeat(level) : `${">".repeat(level)} ${body}`;
};

const indentWidth = (ws: string) => {
  let width = 0;

  for (const ch of ws) {
    width += ch === "\t" ? 4 : 1;
  }

  return width;
};

const leading = (text: string) => /^[ \t]*/u.exec(text)?.[0] ?? "";

const stripAllQuotes = (line: string) => {
  let rest = line;
  let level = 0;

  for (let m = QUOTE.exec(rest); m; m = QUOTE.exec(rest)) {
    rest = rest.slice(m[0].length);
    level += 1;
  }

  return { level, rest };
};

const stripQuotes = (line: string, count: number) => {
  let rest = line;

  for (let k = 0; k < count; k += 1) {
    const m = QUOTE.exec(rest);

    if (!m) {
      return null;
    }

    rest = rest.slice(m[0].length);
  }

  return rest;
};

const runLength = (s: string, at: number, ch: string) => {
  let end = at;

  while (end < s.length && s[end] === ch) {
    end += 1;
  }

  return end - at;
};

const findRun = (s: string, from: number, ch: string, len: number) => {
  for (let p = from; p < s.length;) {
    if (s[p] !== ch) {
      p += 1;
      continue;
    }

    const run = runLength(s, p, ch);

    if (run === len) {
      return p;
    }

    p += run;
  }

  return -1;
};

const isEscaped = (s: string, index: number) => {
  let slashes = 0;

  while (index - 1 - slashes >= 0 && s[index - 1 - slashes] === "\\") {
    slashes += 1;
  }

  return slashes % 2 === 1;
};

const isBoundary = (ch: string) => /[\s\p{P}\p{S}]/u.test(ch);

const trailingBreak = (text: string) => {
  if (/ {2,}$/u.test(text)) {
    return "spaces";
  }

  if (text.endsWith("\\") && !isEscaped(text, text.length - 1)) {
    return "backslash";
  }

  return null;
};

const fenceOpener = (content: string) => {
  const m = FENCE.exec(content);
  const run = m?.[1] ?? "";
  const info = m?.[2] ?? "";

  if (!run || (run.startsWith("`") && info.includes("`"))) {
    return null;
  }

  return { char: run[0] ?? "`", len: run.length, info: info.trim() };
};

const startsBlock = (content: string, width: number) => {
  if (width >= 4) {
    return false;
  }

  return (
    ATX.test(content) ||
    THEMATIC.test(content) ||
    LIST.test(content) ||
    fenceOpener(content) !== null
  );
};

const inline = (s: string) => inlineSpan(s, 0, "").out;

const splitCells = (body: string) => {
  const cells: string[] = [];
  let cur = "";

  for (let i = 0; i < body.length;) {
    const c = body[i] ?? "";

    if (c === "\\" && i + 1 < body.length) {
      cur += body.slice(i, i + 2);
      i += 2;
      continue;
    }

    if (c === "`") {
      const run = runLength(body, i, "`");
      const close = findRun(body, i + run, "`", run);
      const stop = close >= 0 ? close + run : i + run;
      cur += body.slice(i, stop);
      i = stop;
      continue;
    }

    if (c === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }

    i += 1;
  }

  cells.push(cur.trim());

  return cells;
};

const tableCells = (content: string) => {
  let body = content.replace(/[ \t]+$/u, "");
  let piped = false;

  if (body.startsWith("|")) {
    body = body.slice(1);
    piped = true;
  }

  if (body.endsWith("|") && !isEscaped(body, body.length - 1)) {
    body = body.slice(0, -1);
    piped = true;
  }

  const cells = splitCells(body);

  return { cells, piped: piped || cells.length > 1 };
};

const isDelimiter = (content: string) =>
  content.includes("|") &&
  tableCells(content).cells.every((cell) => DELIM_CELL.test(cell));

const delimiterCell = (cell: string) =>
  `${cell.startsWith(":") ? ":" : ""}-${cell.endsWith(":") ? ":" : ""}`;

const tableLine = (lead: string, content: string, delimiter: boolean) => {
  const { cells, piped } = tableCells(content);

  if (!piped) {
    return lead + inline(cells[0] ?? "");
  }

  const body = cells
    .map((cell) => (delimiter ? delimiterCell(cell) : inline(cell)))
    .join("|");

  return `${lead}|${body}|`;
};

const renderFence = (b: Block) => {
  const char = b.info.includes("`") ? "~" : "`";
  const runs = b.code.join("\n").match(char === "`" ? /`+/gu : /~+/gu) ?? [];
  let longest = 0;

  for (const run of runs) {
    longest = Math.max(longest, run.length);
  }

  const marker = char.repeat(Math.max(3, longest + 1));

  const out = [
    wrap(b.level, `${b.head}${marker}${b.info ? ` ${b.info}` : ""}`),
  ];

  for (const line of b.code) {
    out.push(wrap(b.level, line));
  }

  if (b.closed) {
    out.push(wrap(b.level, b.closeWs + marker));
  }

  return out;
};

const renderProse = (b: Block, open: number, later: string) => {
  const whole = inlineSpan(b.text, open, later);

  const hard = b.hard && b.brk !== null && whole.open === 0;

  if (!hard) {
    return { line: wrap(b.level, b.head + whole.out), open: whole.open };
  }

  const source =
    b.brk === "spaces" ? b.text.replace(/ +$/u, "") : b.text.slice(0, -1);

  return {
    line: wrap(b.level, `${b.head}${inlineSpan(source, open, later).out}\\`),
    open: 0,
  };
};

const paragraphRunStart = (blocks: Block[], index: number) => {
  const level = blocks[index]?.level;
  let j = index;

  while (
    j > 0 &&
    blocks[j - 1]?.kind === "para" &&
    blocks[j - 1]?.level === level
  ) {
    j -= 1;
  }

  return j;
};

const edgeWidth = (b: Block, side: "start" | "end") =>
  b.kind === "fence" && side === "end" ? b.closeWidth : b.width;

const isPlain = (b: Block, side: "start" | "end") =>
  b.level === 0 && edgeWidth(b, side) === 0;

const isSpecial = (b: Block, side: "start" | "end") => {
  if (b.kind === "fence") {
    return b.level === 0 && (side === "start" || b.closed) && isPlain(b, side);
  }

  return (b.kind === "heading" || b.kind === "thematic") && isPlain(b, side);
};

// oxlint-disable-next-line eslint/complexity -- blank-line cleanup walks adjacent block kinds; refactor deferred.
const dropBlank = (items: Block[], k: number) => {
  let p = k - 1;

  while (p >= 0 && items[p]?.kind === "blank") {
    p -= 1;
  }

  let n = k + 1;

  while (n < items.length && items[n]?.kind === "blank") {
    n += 1;
  }

  const before = items[p];
  const after = items[n];

  if (!before || !after) {
    return true;
  }

  const ruleA =
    (isSpecial(before, "end") && isPlain(after, "start")) ||
    (isSpecial(after, "start") && isPlain(before, "end"));

  if (ruleA) {
    return true;
  }

  const start = paragraphRunStart(items, p);
  const first = items[start];

  const ruleB =
    after.kind === "list" &&
    after.level === 0 &&
    after.width === 0 &&
    after.interrupts &&
    before.kind === "para" &&
    before.level === 0 &&
    first !== undefined &&
    first.kind === "para" &&
    first.width === 0 &&
    first.level === 0 &&
    items[start - 1]?.kind !== "list";

  return ruleB;
};

// oxlint-disable-next-line eslint/complexity -- canonicalizer dispatch has one branch per Markdown construct; refactor deferred.
export const canonicalMarkdown = (text: string) => {
  const raw = text.split(/\r\n|\r|\n/u);
  const full = raw.map(stripAllQuotes);
  const blocks: Block[] = [];
  let fence: Block | null = null;
  let html: { level: number; end: RegExp | null } | null = null;

  for (let i = 0; i < raw.length;) {
    const line = raw[i] ?? "";

    if (html) {
      const inner = stripQuotes(line, html.level);

      if (inner !== null && (html.end !== null || inner.trim() !== "")) {
        blocks.push(
          make("html", html.level, 0, { lines: [wrap(html.level, inner)] })
        );

        if (html.end?.test(inner) === true) {
          html = null;
        }

        i += 1;
        continue;
      }

      html = null;
    }

    if (fence) {
      const inner = stripQuotes(line, fence.level);

      if (inner !== null) {
        const closer = new RegExp(
          `^([ \\t]*)(${fence.fenceChar}{${fence.fenceLen},})[ \\t]*$`,
          "u"
        ).exec(inner);

        if (closer) {
          fence.closed = true;
          fence.closeWs = closer[1] ?? "";
          fence.closeWidth = indentWidth(fence.closeWs);
          fence = null;
        } else {
          fence.code.push(inner);
        }

        i += 1;
        continue;
      }

      fence = null;
    }

    const { level, rest } = full[i] ?? { level: 0, rest: line };
    const lead = leading(rest);
    const content = rest.slice(lead.length);
    const width = indentWidth(lead);
    const prev = blocks.at(-1);

    if (content === "") {
      if (
        prev?.kind === "verbatim" &&
        prev.level === level &&
        nextIndentedAt(full, i + 1, level)
      ) {
        blocks.push(
          make("verbatim", level, width, { lines: [wrap(level, rest)] })
        );
      } else {
        blocks.push(make("blank", level, 0));
      }

      i += 1;
      continue;
    }

    if (prev?.kind === "verbatim" && prev.level === level && width >= 4) {
      blocks.push(
        make("verbatim", level, width, { lines: [wrap(level, rest)] })
      );
      i += 1;
      continue;
    }

    if (
      prev?.kind === "table" &&
      prev.level === level &&
      !startsBlock(content, width)
    ) {
      blocks.push(
        make("table", level, width, {
          lines: [wrap(level, tableLine(lead, content, false))],
        })
      );
      i += 1;
      continue;
    }

    if (width >= 4) {
      const canStart =
        !prev || !["para", "setextText", "list", "table"].includes(prev.kind);

      if (canStart) {
        blocks.push(
          make("verbatim", level, width, { lines: [wrap(level, rest)] })
        );
      } else {
        blocks.push(
          make("para", level, width, {
            head: lead,
            text: content,
            brk: trailingBreak(content),
          })
        );
      }

      i += 1;
      continue;
    }

    const opener = fenceOpener(content);

    if (opener) {
      fence = make("fence", level, width, {
        head: lead,
        fenceChar: opener.char,
        fenceLen: opener.len,
        info: opener.info,
      });
      blocks.push(fence);
      i += 1;
      continue;
    }

    if (prev?.kind === "para" && prev.level === level && SETEXT.test(content)) {
      const owner = blocks[paragraphRunStart(blocks, blocks.length - 1) - 1];

      if (owner?.kind !== "list") {
        prev.kind = "setextText";
        blocks.push(
          make("setext", level, width, {
            lines: [
              wrap(level, `${lead}${content.startsWith("=") ? "===" : "---"}`),
            ],
          })
        );
        i += 1;
        continue;
      }
    }

    const lone =
      HTML_LONE_TAG.test(content) &&
      !(prev?.kind === "para" && prev.level === level);

    if (
      HTML_RAW.test(content) ||
      HTML_SPECIAL.test(content) ||
      HTML_BLOCK_TAG.test(content) ||
      lone
    ) {
      const tag = HTML_RAW.exec(content)?.[1];

      let end: RegExp | null;

      if (tag !== undefined && tag !== "") {
        // oxlint-disable-next-line eslint/require-unicode-regexp -- see NOTE above HTML_RAW.
        end = new RegExp(`</${tag}>`, "i");
      } else if (content.startsWith("<!--")) {
        end = /-->/u;
      } else {
        end = null;
      }

      blocks.push(make("html", level, width, { lines: [wrap(level, rest)] }));

      if (end?.test(content.slice(1)) !== true) {
        html = { level, end };
      }

      i += 1;
      continue;
    }

    if (THEMATIC.test(content)) {
      blocks.push(
        make("thematic", level, width, { lines: [wrap(level, `${lead}***`)] })
      );
      i += 1;
      continue;
    }

    const heading = ATX.exec(content);

    if (heading) {
      const headingText = heading.at(2);

      const title =
        headingText !== undefined && headingText !== ""
          ? ` ${inline(headingText)}`
          : "";

      blocks.push(
        make("heading", level, width, {
          lines: [wrap(level, `${lead}${heading[1] ?? ""}${title}`)],
        })
      );
      i += 1;
      continue;
    }

    const item = LIST.exec(content);

    if (item) {
      const marker = item[1] ?? "";
      const body = item[3] ?? "";
      const numeric = /^\d/u.test(marker);
      blocks.push(
        make("list", level, width, {
          head: lead + marker + (item[2] ?? ""),
          text: body,
          brk: trailingBreak(body),
          interrupts:
            body.trim() !== "" &&
            // oxlint-disable-next-line unicorn/prefer-number-coercion -- parseInt reads the leading digits of markers like "1)"; Number() rejects trailing delimiters.
            (!numeric || Number.parseInt(marker, 10) === 1),
        })
      );
      i += 1;
      continue;
    }

    const next = full[i + 1];

    if (next && next.level === level) {
      const nextLead = leading(next.rest);
      const nextContent = next.rest.slice(nextLead.length);

      if (
        indentWidth(nextLead) < 4 &&
        isDelimiter(nextContent) &&
        tableCells(content).cells.length ===
          tableCells(nextContent).cells.length
      ) {
        blocks.push(
          make("table", level, width, {
            lines: [wrap(level, tableLine(lead, content, false))],
          }),
          make("table", level, indentWidth(nextLead), {
            lines: [wrap(level, tableLine(nextLead, nextContent, true))],
          })
        );
        i += 2;
        continue;
      }
    }

    blocks.push(
      make("para", level, width, {
        head: lead,
        text: content,
        brk: trailingBreak(content),
      })
    );
    i += 1;
  }

  return finish(blocks);
};
