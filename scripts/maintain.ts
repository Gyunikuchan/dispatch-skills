import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ACTION_CONTRACTS,
  GENERATED_MARKER,
  SESSION_CONTRACTS,
  renderCallTable,
} from '../skills/dispatch/scripts/toolkit/contracts.ts';
import { slug, validatePathLinks } from './path-bytes.ts';

const TOOLKIT = 'references/toolkit.md';
const TABLE_HEADING = '### call table';
const COMMAND_PREFIX = /^(?:\r?\n)*/;

type ContractRegion = { heading: string; text: string; prefix: string };

function contractRegions(): Map<string, ContractRegion> {
  return new Map([
    ['call-table', { heading: TABLE_HEADING, text: renderCallTable().slice(TABLE_HEADING.length + 1), prefix: '' }],
    ...Object.entries(ACTION_CONTRACTS).map(([heading, { arguments: args }]): [string, ContractRegion] => [
      `action:${slug(heading)}`,
      { heading: `### ${heading}`, text: `\`${args}\``, prefix: 'Arguments: ' },
    ]),
    ...Object.entries(SESSION_CONTRACTS).map(([action, { arguments: args }]): [string, ContractRegion] => [
      `session:${action}`,
      { heading: `### session ${action}`, text: `\`${args}\``, prefix: '' },
    ]),
  ]);
}

/** Validates governed delimiters and replaces only the content between each pair. */
export function renderContractRegions(markdown: string): { text: string; errors: string[]; drift: string[] } {
  const regions = contractRegions();
  const errors: string[] = [],
    drift: string[] = [];
  const headings = [...markdown.matchAll(/^(#{1,3} [^\r\n]+)\r?\n/gm)];
  const seen = new Set<string>();
  let open: { id: string; index: number; end: number } | undefined;
  let text = '',
    cursor = 0;
  for (const marker of markdown.matchAll(GENERATED_MARKER)) {
    const [token, closing, markerId] = marker;
    const id = markerId!;
    const index = marker.index;
    const end = index + token!.length;
    const region = regions.get(id);
    const label = `${TOOLKIT}: ${region?.heading ?? id}`;
    if (!region) errors.push(`${label}: unknown generated marker`);
    if (!closing) {
      if (seen.has(id)) errors.push(`${label}: duplicate opening marker`);
      seen.add(id);
      if (open) errors.push(`${TOOLKIT}: ${open.id}: opening marker before closing marker`);
      open = { id, index, end };
      continue;
    }
    if (open?.id !== id) {
      errors.push(`${label}: unmatched closing marker`);
      continue;
    }
    if (region) {
      const headingIndex = headings.findIndex((heading) => heading[1] === region.heading);
      const heading = headings[headingIndex];
      const sectionStart = heading ? heading.index + heading[0].length : -1;
      const sectionEnd = headings[headingIndex + 1]?.index ?? markdown.length;
      const table = id === 'call-table';
      // A session opener needs its own line so Markdown parses the command paragraph.
      const standalone = table || id.startsWith('session:');
      const delimiterNewline = standalone ? (/^\r?\n/.exec(markdown.slice(open.end))?.[0] ?? '') : '';
      const bodyStart = open.end + delimiterNewline.length;
      const before = markdown.slice(sectionStart, open.index);
      const current = markdown.slice(bodyStart, index);
      const correct =
        sectionStart >= 0 &&
        open.index >= sectionStart &&
        index < sectionEnd &&
        (!standalone || delimiterNewline !== '') &&
        (table
          ? before === '' &&
            (current === '' || current.endsWith('\n')) &&
            /^(?:\r?\n)+$/.test(markdown.slice(end, sectionEnd))
          : before.replace(COMMAND_PREFIX, '') === region.prefix && /^`[^`\r\n]+`$/.test(current));
      if (!correct) errors.push(`${label}: generated markers at the wrong boundary`);
      else {
        const expected = delimiterNewline === '\r\n' ? region.text.replaceAll('\n', '\r\n') : region.text;
        if (current !== expected) drift.push(`${label}: generated content differs`);
        text += markdown.slice(cursor, bodyStart) + expected;
        cursor = index;
      }
    }
    open = undefined;
  }
  if (open) errors.push(`${TOOLKIT}: ${open.id}: missing closing marker`);
  for (const [id, { heading }] of regions)
    if (!seen.has(id)) errors.push(`${TOOLKIT}: ${heading}: missing opening marker`);
  return { text: errors.length ? markdown : text + markdown.slice(cursor), errors, drift };
}

/** Checks the checkout, writing only an updated contract in generation mode. */
export function maintain(skillDir: string, check: boolean): string[] {
  const read = (relative: string) => fs.readFileSync(path.join(skillDir, relative), 'utf8');
  const markdown = read(TOOLKIT);
  const result = renderContractRegions(markdown);
  const errors = [...result.errors, ...validatePathLinks(read), ...(check ? result.drift : [])];
  if (errors.length === 0 && !check && result.text !== markdown) {
    fs.writeFileSync(path.join(skillDir, TOOLKIT), result.text);
  }
  return errors;
}

function main(args: readonly string[]): number {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    process.stderr.write('Usage: node scripts/maintain.ts [--check]\n');
    return 2;
  }
  try {
    const skillDir = fileURLToPath(new URL('../skills/dispatch/', import.meta.url));
    const errors = maintain(skillDir, args[0] === '--check');
    for (const error of errors) process.stderr.write(`${error}\n`);
    return errors.length ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}
