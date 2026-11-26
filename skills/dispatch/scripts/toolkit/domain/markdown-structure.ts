export interface StructuralLine {
  line: number;
  text: string;
  original: string;
  fenced: boolean;
}

export const FENCE = /^ {0,3}(?<cap1>`{3,}|~{3,})/u;

export const commentOpenOutsideCode = (original: string, from: number) => {
  const run = /`+/gu;
  let cursor = from;

  for (;;) {
    const open = original.indexOf("<!--", cursor);

    if (open === -1) {
      return -1;
    }

    run.lastIndex = cursor;
    const opener = run.exec(original);

    if (!opener || opener.index > open) {
      return open;
    }

    cursor = run.lastIndex;
    let closer: RegExpExecArray | null;

    while (
      (closer = run.exec(original)) &&
      closer[0].length !== opener[0].length
    ) {
      void 0;
    }

    if (closer) {
      cursor = run.lastIndex;
    }
  }
};

/** Lines with blockquotes, HTML comments, and fenced content blanked; loci are 1-based source lines. */
export const structuralLines = (source: string) => {
  let fence: string | null = null;
  let inComment = false;

  return source.split(/\r?\n/u).map((original, index) => {
    const line = index + 1;
    const marker = inComment ? undefined : FENCE.exec(original)?.[1];

    if (marker !== undefined) {
      if (fence === null) {
        fence = marker;
      } else if (
        marker.startsWith(fence.charAt(0)) &&
        marker.length >= fence.length &&
        /^ {0,3}(?<cap1>`+|~+)\s*$/u.test(original)
      ) {
        fence = null;
      }

      return { line, text: "", original, fenced: true };
    }

    if (fence !== null) {
      return { line, text: "", original, fenced: true };
    }

    let text = "";
    let cursor = 0;

    while (cursor < original.length) {
      if (inComment) {
        const close = original.indexOf("-->", cursor);

        if (close === -1) {
          break;
        }

        inComment = false;
        cursor = close + 3;
        continue;
      }

      const open = commentOpenOutsideCode(original, cursor);

      if (open === -1) {
        text += original.slice(cursor);
        break;
      }

      text += original.slice(cursor, open);
      inComment = true;
      cursor = open + 4;
    }

    return {
      line,
      text: /^\s*>/u.test(text) ? "" : text,
      original,
      fenced: false,
    };
  });
};

export const isDetailWrapper = (text: string) =>
  /^(?:<details>|<\/details>|<summary>.*<\/summary>)$/u.test(text.trim());

/** Index ranges of each exact `heading` line up to the next `##` heading. */
export const sectionRanges = (
  lines: readonly StructuralLine[],
  heading: string
) =>
  lines.flatMap((entry, index) => {
    if (entry.text.trimEnd() !== heading) {
      return [];
    }

    const next = lines.findIndex(
      (later, laterIndex) => laterIndex > index && /^##\s+/u.test(later.text)
    );

    return [{ start: index, end: next === -1 ? lines.length : next }];
  });

/** Source with each exact `## <heading>` section (heading through the next `##`) removed. */
export const withoutSections = (
  source: string,
  headings: readonly string[]
) => {
  const lines = structuralLines(source);
  const raw = source.split(/\r?\n/u);
  const drop = new Set<number>();

  for (const heading of headings) {
    for (const { start, end } of sectionRanges(lines, heading)) {
      for (let index = start; index < end; index += 1) {
        drop.add(index);
      }
    }
  }

  return raw
    .filter((_line, index) => !drop.has(index))
    .join("\n")
    .replace(/\s+$/u, "\n");
};
