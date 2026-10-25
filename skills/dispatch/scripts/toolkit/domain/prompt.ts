// Prompt template extraction, frame assembly, and fill. Pure: callers
// pass Markdown they read. Declared variables are the backtick-quoted `<Name>` bullets between the section
// heading and its first fence; substitution is single-pass over declared names, so undeclared grammar
// placeholders (`<file>:L<line>`, `<tag>`) pass through and a value's own text is never re-scanned.

export type Template = { variables: readonly string[]; template: string };

export type Settled = { id: string; locus: string; defect: string; ruling: string; reason: string; revision?: string };

export function settledSection(settled: readonly Settled[], revisions = false): string {
  if (!settled.length) return '';
  const clip = (value: string) => value.length > 200 ? `${value.slice(0, 199)}…` : value;
  const rows = settled.map((entry) => `- ${entry.id} ${entry.locus}: ${clip(entry.defect)} — ${entry.ruling}: ${entry.reason || 'no reason recorded'}${revisions && entry.revision ? ` (reviewed revision ${entry.revision})` : ''}`);
  return `\n\n### Settled in earlier rounds\nRe-raise a settled point only with new evidence that the ruling missed.\n${rows.join('\n')}\n`;
}

export function askPrompt(question: string, context: string): string {
  return [
    '# Ask', '', '### Objective', question.trim() || '(empty question)', '',
    ...(context.trim() ? ['### Context', context.trim(), ''] : []),
    '### Evidence', 'Read the workspace read-only. Cite each claim with `<file>:L<line>` or a command you ran.', '',
    '### Stop condition', 'Stop once the objective is answered or evidence is exhausted; say what remains unknown.', '',
    '### Output', 'Plain text: a short answer first, then the supporting claims, one per line.', '',
  ].join('\n');
}

export const DESIGN_REVISION_CONTEXT_PREFIX = 'Review the governed design delta. ';

const DEFAULT_SECTION = 'Prompt template';
const SLOT_PATTERN = /<<slot:([A-Za-z0-9_-]+)>>/g;
const VARIABLE_BULLET = /^-\s+`<([^>]+)>`/;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// SECTION: Extraction

/** Declared variables and fenced body of one `#… <section>` block. */
export function extractTemplate(markdown: string, section = DEFAULT_SECTION): Template {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const heading = new RegExp(`^#{1,6}\\s+${escapeRegExp(section)}\\s*$`);
  const headingIndex = lines.findIndex((line) => heading.test(line));
  if (headingIndex === -1) throw new Error(`Section "${section}" not found`);

  const variables: string[] = [];
  let open = -1;
  let marker = '';
  for (let index = headingIndex + 1; index < lines.length; index++) {
    const line = lines[index] ?? '';
    const fence = /^(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) { open = index; marker = fence; break; }
    const variable = VARIABLE_BULLET.exec(line)?.[1];
    if (variable) variables.push(variable);
  }
  if (open === -1) throw new Error(`No fenced block found under section "${section}"`);

  // The closer must repeat the marker character at least as long, so shorter inner fences survive.
  const closer = new RegExp(`^${escapeRegExp(marker[0] ?? '`')}{${marker.length},}\\s*$`);
  const close = lines.findIndex((line, index) => index > open && closer.test(line));
  if (close === -1) throw new Error(`Unterminated fenced block under section "${section}"`);
  return { variables, template: lines.slice(open + 1, close).join('\n') };
}

// SECTION: Frame assembly

/** Leading `<Name>` bullets and `## NAME` sections of a kind block; fences never open a section. */
function parseKindBlock(markdown: string): { variables: string[]; sections: Map<string, string> } {
  const variables: string[] = [];
  const raw = new Map<string, string[]>();
  let current: string[] | null = null;
  let fence: string | null = null;
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const fenceMarker = /^(`{3,}|~{3,})\s*\S*\s*$/.exec(line)?.[1];
    if (fenceMarker) {
      if (fence === null) fence = fenceMarker;
      else if (fenceMarker[0] === fence[0] && fenceMarker.length >= fence.length && /^(`+|~+)\s*$/.test(line)) fence = null;
    }
    const heading = fence !== null || fenceMarker ? null : /^##\s+(\S.*?)\s*$/.exec(line)?.[1];
    if (heading) {
      if (raw.has(heading)) throw new Error(`Kind block declares section "${heading}" twice`);
      current = [];
      raw.set(heading, current);
      continue;
    }
    if (current === null) {
      const variable = VARIABLE_BULLET.exec(line)?.[1];
      if (variable) variables.push(variable);
    } else current.push(line);
  }
  const sections = new Map<string, string>();
  for (const [name, body] of raw) sections.set(name, body.join('\n').replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, ''));
  return { variables, sections };
}

export type QualityConsumer = 'code' | 'plan' | 'design' | 'writer';
export const qualitySections = {
  code: ['shared', 'code'],
  writer: ['shared', 'code'],
  plan: ['shared', 'spec', 'plan', 'code'],
  design: ['shared', 'spec', 'design'],
} as const satisfies Record<QualityConsumer, readonly string[]>;

/** Selects the consumer's criteria as the frame's single quality block. */
export function qualityBar(markdown: string, consumer: QualityConsumer): string {
  if (!Object.hasOwn(qualitySections, consumer)) throw new Error(`Unknown quality consumer: ${consumer}`);
  const { sections } = parseKindBlock(markdown);
  const bodies = qualitySections[consumer].map((section) => {
    const body = sections.get(section);
    if (body === undefined) throw new Error(`Missing quality section: ${section}`);
    if (!body.trim()) throw new Error(`Empty quality section: ${section}`);
    return body.trim();
  });
  return `## quality\n\n${bodies.join('\n\n')}`;
}

/**
 * Fills every `<<slot:NAME>>` of the frame's template with the `## NAME` body of the kind block or a shared
 * kind block; variables are the union of all declarations. A slot without a section, a section without a
 * slot, or a section declared by more than one input throws.
 */
export function assembleTemplate(frameMarkdown: string, kindMarkdown: string, section = DEFAULT_SECTION, shared: readonly string[] = []): Template {
  const frame = extractTemplate(frameMarkdown, section);
  const kind = parseKindBlock(kindMarkdown);
  // Shared blocks parse separately so each file's title line stays out of the previous input's last section.
  for (const block of shared.map(parseKindBlock)) {
    kind.variables.push(...block.variables);
    for (const [name, body] of block.sections) {
      if (kind.sections.has(name)) throw new Error(`Kind block declares section "${name}" twice`);
      kind.sections.set(name, body);
    }
  }
  const slots = new Set([...frame.template.matchAll(SLOT_PATTERN)].map((match) => match[1] ?? ''));
  const missing = [...slots].filter((name) => !kind.sections.has(name));
  if (missing.length) throw new Error(`Kind block has no section for slot(s): ${missing.join(', ')}`);
  const unused = [...kind.sections.keys()].filter((name) => !slots.has(name));
  if (unused.length) throw new Error(`Kind block declares section(s) with no frame slot: ${unused.join(', ')}`);
  // An empty section removes its whole slot line so assembly adds no phantom blank line.
  const template = frame.template
    .replace(/^[ \t]*<<slot:([A-Za-z0-9_-]+)>>[ \t]*\n/gm, (line, name: string) => (kind.sections.get(name) ? line : ''))
    .replace(SLOT_PATTERN, (_match, name: string) => kind.sections.get(name) ?? '');
  return { variables: [...new Set([...frame.variables, ...kind.variables])], template };
}

// SECTION: Substitution

/** Substitutes declared placeholders; a missing declared value or an undeclared value name throws. */
export function fillTemplate(template: string, variables: readonly string[], values: Readonly<Record<string, string>>): string {
  const declared = new Set(variables);
  const missing = variables.filter((name) => !Object.hasOwn(values, name));
  if (missing.length) throw new Error(`Missing value(s) for declared variable(s): ${missing.join(', ')}`);
  const unknown = Object.keys(values).filter((name) => !declared.has(name));
  if (unknown.length) throw new Error(`Unknown variable(s) not declared by this template: ${unknown.join(', ')}`);
  if (!variables.length) return template;
  const pattern = new RegExp(`<(${variables.map(escapeRegExp).join('|')})>`, 'g');
  return template.replace(pattern, (_match, name: string) => values[name] ?? '');
}
