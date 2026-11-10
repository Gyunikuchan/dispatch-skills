// Prompt template extraction, frame assembly, and fill. Pure: callers
// pass Markdown they read. Declared variables are the backtick-quoted `<Name>` bullets between the section
// heading and its first fence; substitution is single-pass over declared names, so undeclared grammar
// placeholders (`<file>:L<line>`, `<tag>`) pass through and a value's own text is never re-scanned.

export type Template = { variables: readonly string[]; template: string };

export function extractDocumentLayers(specStageMarkdown: string): string {
  const lines = specStageMarkdown.replace(/\r\n/g, '\n').split('\n');
  const headingIndex = lines.findIndex((line) => /^##\s+Readers and document layers\s*$/.test(line));
  if (headingIndex === -1) throw new Error('Section "Readers and document layers" not found');
  const paragraph: string[] = [];
  let started = false;
  for (let index = headingIndex + 1; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (/^#{1,6}\s/.test(line)) break;
    if (!line.trim()) {
      if (started) break;
      continue;
    }
    started = true;
    paragraph.push(line.trim());
  }
  if (!paragraph.length) throw new Error('Section "Readers and document layers" has no paragraph');
  return paragraph.join(' ');
}

export type Settled = { id: string; locus: string; defect: string; ruling: string; reason: string; revision?: string; severity?: string; rejectionConfirmed?: boolean };

export function settledSection(settled: readonly Settled[], revisions = false): string {
  settled=settled.filter(entry=>entry.severity!=='MUST' || entry.rejectionConfirmed===true || entry.rejectionConfirmed===undefined && entry.ruling!=='rejected');
  if (!settled.length) return '';
  const clip = (value: string, limit: number) => value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
  // Reviewers must re-read rejected and deferred text in full; accepted and duplicate rows need only identity.
  const row = (entry: Settled) => {
    const suffix = revisions && entry.revision ? ` (reviewed revision ${entry.revision})` : '';
    const firstLine = entry.defect.split(/\r\n|\n|\r/)[0] ?? '';
    if (entry.ruling === 'accepted') return `- ${entry.id} ${entry.locus}: ${entry.severity === 'MUST' ? entry.defect : clip(firstLine, 120)} — accepted${suffix}`;
    if (entry.ruling === 'duplicate') {
      const reason = entry.reason || 'no reason recorded', clipped = clip(reason, 120), labeled = /duplicate\s+of\s+(R\d+-F\d+)/i.exec(reason)?.[1];
      const cited = [...reason.matchAll(/\bR\d+-F\d+\b/g)].map(match => match[0]!).filter(id => id !== entry.id);
      const target = labeled && labeled !== entry.id ? labeled : cited[0];
      const detail = target && !new RegExp(`\\b${target}\\b`).test(clipped) ? `${target}: ${clip(reason, 120 - target.length - 2)}` : clipped;
      return `- ${entry.id} ${entry.locus}: ${clip(firstLine, 120)} — duplicate: ${detail}${suffix}`;
    }
    return `- ${entry.id} ${entry.locus}: ${entry.defect} — ${entry.ruling}: ${entry.reason || 'no reason recorded'}${suffix}`;
  };
  return `\n\n### Settled in earlier rounds\n${settled.map(row).join('\n')}\n`;
}

export type InterRound = { diff: string; accepted: readonly { id: string; locus: string }[] };

/** The section's text serves both prompt builders; the compact confirmation prompt has no template to carry it. */
export function interRoundSection(info: InterRound): string {
  const list = info.accepted.length
    ? ['Check these accepted-finding loci and their interactions first:', ...info.accepted.map(entry => `- ${entry.id} ${entry.locus}`)]
    : ['No accepted findings since the previous round.'];
  return ['### Since the previous round', `Inter-round diff: ${info.diff}`, ...list].join('\n');
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

export type QualityConsumer = 'code' | 'plan' | 'design' | 'writer' | 'cleanup' | 'explorer';
export const qualitySections = {
  code: ['shared', 'code', 'testing'],
  writer: ['shared', 'code', 'testing'],
  plan: ['shared', 'spec', 'plan', 'testing'],
  design: ['shared', 'spec', 'design'],
  cleanup: ['shared', 'testing'],
  explorer: ['shared'],
} as const satisfies Record<QualityConsumer, readonly string[]>;

const REQUIRED_TAGGED = {
  code: 5,
  writer: 6,
  plan: 5,
  design: 4,
  cleanup: 6,
  explorer: 3,
} as const satisfies Record<QualityConsumer, number>;

const KNOWN_AUDIENCES = new Set(['code', 'plan', 'design', 'writer', 'cleanup', 'explorer', 'all', 'author']);
const FOR_TAG_PATTERN = /^\s*<!--\s*for:\s*([^>]+?)\s*-->\s*$/;
const DOCUMENT_LAYERS_LINK = '[document layers](../spec-stage.md#readers-and-document-layers); cite upstream IDs, not earlier layers.';

function parseAudienceTag(line: string): string[] {
  const match = FOR_TAG_PATTERN.exec(line);
  if (!match) return [];
  return match[1]!.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
}

function audienceAllows(tags: readonly string[] | null, consumer: QualityConsumer): boolean {
  if (tags === null) return consumer !== 'explorer';
  if (tags.includes('author')) return false;
  if (tags.includes('all') || tags.includes(consumer)) return true;
  return false;
}

export function rotate<T>(items: readonly T[], by: number): T[] {
  if (!items.length) return [];
  const shift = ((by % items.length) + items.length) % items.length;
  return [...items.slice(shift), ...items.slice(0, shift)];
}

function rotateLines(markdown: string, by: number, isRotated: (line: string) => boolean): string {
  const lines = markdown.split('\n');
  const positions = lines.flatMap((line, index) => isRotated(line) ? [index] : []);
  const rotated = rotate(positions.map((index) => lines[index]!), by);
  for (const [index, position] of positions.entries()) lines[position] = rotated[index]!;
  return lines.join('\n');
}

export function rotateTags(kindBlockTags: string, by: number): string {
  return rotateLines(kindBlockTags, by, (line) => line.startsWith('- '));
}

/** Joined bodies of the consumer's selected quality sections. */
export function qualityCriteria(markdown: string, consumer: QualityConsumer, rotation: number, specStageMarkdown: string): string {
  if (!Object.hasOwn(qualitySections, consumer)) throw new Error(`Unknown quality consumer: ${consumer}`);
  const { sections } = parseKindBlock(markdown);
  const layers = extractDocumentLayers(specStageMarkdown);
  let totalTagged = 0;
  const rendered = qualitySections[consumer].map((section) => {
    const raw = sections.get(section);
    if (raw === undefined) throw new Error(`Missing quality section: ${section}`);
    if (!raw.trim()) throw new Error(`Empty quality section: ${section}`);
    const { body, tagged } = filterSection(raw, consumer, section);
    totalTagged += tagged;
    let out = body;
    if (!out.trim()) throw new Error(`Empty quality section: ${section}`);
    if (section === 'shared' && consumer !== 'explorer') {
      if (!out.includes(DOCUMENT_LAYERS_LINK)) throw new Error(`Missing document layers link in shared section`);
      out = out.replace(DOCUMENT_LAYERS_LINK, () => `document layers (${layers})`);
    }
    return rotateLines(out.trim(), rotation, (line) => /^- \*\*[^*]+\*\* —/.test(line));
  }).join('\n\n');
  const expected = REQUIRED_TAGGED[consumer];
  if (totalTagged !== expected) throw new Error(`Tagged bullet count mismatch for consumer "${consumer}": expected ${expected}, got ${totalTagged}`);
  return rendered;
}

function filterSection(body: string, consumer: QualityConsumer, _section: string): { body: string; tagged: number } {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let tagged = 0;
  let pending: string[] | null = null;
  let active: string[] | null = null;
  for (const line of lines) {
    if (FOR_TAG_PATTERN.test(line)) {
      const tags = parseAudienceTag(line);
      for (const tag of tags) {
        if (!KNOWN_AUDIENCES.has(tag)) throw new Error(`Unknown audience tag: ${tag}`);
      }
      if (!tags.length) throw new Error(`Audience tag names no consumer: ${line.trim()}`);
      if (pending) throw new Error(`Audience tag without target: ${line.trim()}`);
      pending = tags;
      continue;
    }
    const subheading = /^###\s/.test(line);
    if (subheading) {
      if (pending) {
        active = pending;
        pending = null;
      } else {
        active = null;
      }
      const tags = active;
      const taggedHeading = tags !== null;
      if (!audienceAllows(tags, consumer)) continue;
      out.push(line);
      void taggedHeading;
      continue;
    }
    if (pending) {
      if (!line.startsWith('- ')) throw new Error(`Audience tag must precede a bullet or subsection: ${pending.join(',')}`);
      const tags = pending;
      pending = null;
      if (!audienceAllows(tags, consumer)) continue;
      out.push(line);
      tagged += 1;
      continue;
    }
    if (line.startsWith('- ')) {
      const tags = active;
      if (!audienceAllows(tags, consumer)) continue;
      out.push(line);
      if (tags !== null) tagged += 1;
      continue;
    }
    const tags = active;
    if (!audienceAllows(tags, consumer)) continue;
    out.push(line);
  }
  if (pending) throw new Error(`Audience tag without target: ${pending.join(',')}`);
  return { body: out.join('\n'), tagged };
}

/** Selects the consumer's criteria as the frame's single `quality` slot section. */
export function qualityBar(markdown: string, consumer: QualityConsumer, rotation: number, specStageMarkdown: string): string {
  return `## quality\n\n${qualityCriteria(markdown, consumer, rotation, specStageMarkdown)}`;
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
