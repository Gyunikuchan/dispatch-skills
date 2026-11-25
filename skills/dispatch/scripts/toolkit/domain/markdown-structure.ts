export type StructuralLine = { line: number; text: string; original: string; fenced: boolean };

export const FENCE = /^ {0,3}(`{3,}|~{3,})/;

// NOTE: `<!--` inside a closed inline code span is literal (CommonMark); unmatched backticks stay literal too.
export function commentOpenOutsideCode(original: string, from: number): number {
  const run = /`+/g;
  let cursor = from;
  for (;;) {
    const open = original.indexOf('<!--', cursor);
    if (open === -1) return -1;
    run.lastIndex = cursor;
    const opener = run.exec(original);
    if (!opener || opener.index > open) return open;
    cursor = run.lastIndex;
    let closer: RegExpExecArray | null;
    while ((closer = run.exec(original)) && closer[0].length !== opener[0].length);
    if (closer) cursor = run.lastIndex;
  }
}

/** Lines with blockquotes, HTML comments, and fenced content blanked; loci are 1-based source lines. */
export function structuralLines(source: string): StructuralLine[] {
  let fence: string | null = null;
  let inComment = false;
  return source.split(/\r?\n/).map((original, index) => {
    const line = index + 1;
    // Fence state freezes inside an open HTML comment, so a commented-out example cannot swallow later sections.
    const marker = inComment ? undefined : FENCE.exec(original)?.[1];
    if (marker) {
      if (fence === null) fence = marker;
      // A closer is bare (no info string), same character, at least the opener's length (CommonMark).
      else if (marker[0] === fence[0] && marker.length >= fence.length && /^ {0,3}(`+|~+)\s*$/.test(original))
        fence = null;
      return { line, text: '', original, fenced: true };
    }
    if (fence !== null) return { line, text: '', original, fenced: true };
    let text = '';
    let cursor = 0;
    while (cursor < original.length) {
      if (inComment) {
        const close = original.indexOf('-->', cursor);
        if (close === -1) {
          cursor = original.length;
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
    return { line, text: /^\s*>/.test(text) ? '' : text, original, fenced: false };
  });
}

export const isDetailWrapper = (text: string): boolean =>
  /^(?:<details>|<\/details>|<summary>.*<\/summary>)$/.test(text.trim());

type SectionRange = { start: number; end: number };

/** Index ranges of each exact `heading` line up to the next `##` heading. */
export function sectionRanges(lines: readonly StructuralLine[], heading: string): SectionRange[] {
  return lines.flatMap((entry, index) => {
    if (entry.text.trimEnd() !== heading) return [];
    const next = lines.findIndex((later, laterIndex) => laterIndex > index && /^##\s+/.test(later.text));
    return [{ start: index, end: next === -1 ? lines.length : next }];
  });
}

/** Source with each exact `## <heading>` section (heading through the next `##`) removed. */
export function withoutSections(source: string, headings: readonly string[]): string {
  const lines = structuralLines(source);
  const raw = source.split(/\r?\n/);
  const drop = new Set<number>();
  for (const heading of headings) {
    for (const { start, end } of sectionRanges(lines, heading))
      for (let index = start; index < end; index++) drop.add(index);
  }
  return raw
    .filter((_line, index) => !drop.has(index))
    .join('\n')
    .replace(/\s+$/, '\n');
}
