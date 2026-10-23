// Vendored from domain/spec.ts at 63420d16 (AD-5).
// Spec parse + lint (governing spec, KD-8). Pure: callers supply the source text.

import { CRITERION_ID_SOURCE } from './criterion-id.ts';
import { documentTitle, lintSectionOrder, sectionRanges, structuralLines, type StructuralLine } from './plan.ts';
import type { Level } from '../types.ts';

export const SPEC_SECTION_ORDER = [
  '## Intent & Problem', '## Background', '## Requirements', '## Non-goals', '## Constraints', '## Decisions',
  '## Discussion Record', '## Open Questions',
] as const;

const LOW_SECTIONS: readonly string[] = ['## Intent & Problem', '## Requirements', '## Non-goals', '## Constraints'];

export type SpecDefectCode =
  | 'missing-section' | 'section-order' | 'missing-requirement' | 'malformed-id' | 'colliding-id' | 'id-sequence' | 'missing-acceptance' | 'duplicate-section';
export type SpecDefect = { code: SpecDefectCode; severity: 'defect' | 'warning'; line: number | null; message: string };
export type ParsedSpec = { title: string | null; reqIds: readonly string[]; decIds: readonly string[]; sections: readonly string[] };
export type SpecResult = { ok: true; spec: ParsedSpec; warnings: SpecDefect[] } | { ok: false; defects: SpecDefect[]; warnings: SpecDefect[] };

const defect = (code: SpecDefectCode, line: number | null, message: string, blocking = false): SpecDefect => ({ code, severity: blocking ? 'defect' : 'warning', line, message });

/** Required `##` headings for `level`, in template order. */
export function requiredSpecSections(level: Level): readonly string[] {
  return level === 'low' ? LOW_SECTIONS : SPEC_SECTION_ORDER;
}

/** Hashing input: the raw source; design Parent pins already hash spec bytes unchanged. */
export function governedSpecText(source: string): string {
  return source;
}

// NOTE: plan, criterion, increment, and finding ID shapes; a spec heading using one would collide with downstream IDs.
const COLLIDING = new RegExp(`^(?:T\\d+|${CRITERION_ID_SOURCE}|I\\d{2}|R\\d+(?:-F\\d+)?)\\b`, 'i');

type Block = { id: number; heading: StructuralLine; body: StructuralLine[] };

/** Lints every `heading` section; a repeat is a defect, and its blocks still lint so no ID or acceptance gap hides. */
function lintIds(lines: readonly StructuralLine[], heading: string, prefix: 'REQ' | 'DEC', out: SpecDefect[]): Block[] {
  const idDefect = (code: SpecDefectCode, line: number | null, message: string) => defect(code, line, message, prefix === 'REQ' && ['malformed-id', 'colliding-id', 'id-sequence'].includes(code));
  const ranges = sectionRanges(lines, heading);
  for (const extra of ranges.slice(1)) out.push(idDefect('duplicate-section', lines[extra.start]!.line, `${heading} appears more than once; merge it into one section.`));
  const pattern = new RegExp(`^${prefix}-([1-9]\\d*) — \\S`);
  const blocks: Block[] = [];
  for (const range of ranges) {
    let current: Block | null = null;
    for (const entry of lines.slice(range.start + 1, range.end)) {
      const sub = /^###\s+(.*)$/.exec(entry.text.trimEnd())?.[1];
      if (sub === undefined) { current?.body.push(entry); continue; }
      const match = pattern.exec(sub);
      if (match) { current = { id: Number(match[1]), heading: entry, body: [] }; blocks.push(current); continue; }
      current = null;
      if (COLLIDING.test(sub)) out.push(idDefect('colliding-id', entry.line, `Heading "${sub}" uses a plan, criterion, increment, or finding ID; use ${prefix}-<n>.`));
      else out.push(idDefect('malformed-id', entry.line, `Heading "${sub}" under ${heading} must be "### ${prefix}-<n> — <title>".`));
    }
  }
  const seen = new Set<number>();
  blocks.forEach((block, index) => {
    if (seen.has(block.id)) out.push(idDefect('id-sequence', block.heading.line, `${prefix}-${block.id} appears more than once.`));
    else if (block.id !== index + 1) out.push(idDefect('id-sequence', block.heading.line, `${prefix}-${block.id} is out of sequence; expected ${prefix}-${index + 1}.`));
    seen.add(block.id);
  });
  return blocks;
}

/** Parses and lints a spec at `level`; any defect fails the parse. Prose is not scanned for IDs. */
export function parseSpec(source: string, options: { level: Level }): SpecResult {
  const lines = structuralLines(source);
  const defects: SpecDefect[] = [];
  for (const heading of requiredSpecSections(options.level)) {
    if (!sectionRanges(lines, heading).length) defects.push(defect('missing-section', null, `Spec at level ${options.level} requires ${heading}.`, heading === '## Requirements'));
  }
  for (const item of lintSectionOrder(lines, SPEC_SECTION_ORDER)) defects.push(defect('section-order', item.line, item.message));
  const reqs = lintIds(lines, '## Requirements', 'REQ', defects);
  const decs = lintIds(lines, '## Decisions', 'DEC', defects);
  if (sectionRanges(lines, '## Requirements').length && !reqs.length) defects.push(defect('missing-requirement', null, 'Requirements needs at least one ### REQ-<n> — <title> block.', true));
  for (const block of reqs) {
    if (!block.body.some(({ text }) => /^\s*[-*]\s+Acceptance:\s*\S/.test(text))) {
      defects.push(defect('missing-acceptance', block.heading.line, `REQ-${block.id} needs at least one "- Acceptance:" bullet.`));
    }
  }
  const warnings = defects.filter(item => item.severity === 'warning');
  const blocking = defects.filter(item => item.severity === 'defect');
  if (blocking.length) return { ok: false, defects: blocking, warnings };
  const sections = lines.map((entry) => entry.text.trimEnd()).filter((text) => /^##\s+\S/.test(text) && !text.startsWith('###'));
  return {
    ok: true,
    warnings,
    spec: { title: documentTitle(source), reqIds: reqs.map((block) => `REQ-${block.id}`), decIds: decs.map((block) => `DEC-${block.id}`), sections },
  };
}
