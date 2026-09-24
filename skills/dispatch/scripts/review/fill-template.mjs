// @ts-check
/**
 * Extracts, assembles, and fills the `#### Prompt template` fenced block of a review template — a
 * shared frame under `references/templates/`, optionally assembled with a per-kind block.
 *
 * Declared variables are the backtick-quoted `<Name>` bullets (`` - `<Name>` — ... ``) between the
 * heading (any level, exact text) and the first fenced block; the template body is that fence's
 * contents. The fence scanner accepts any fence of 3+ backticks/tildes and closes only on a fence of
 * the same character with length >= the opener's, so an inner 3-backtick example survives inside a
 * 4-backtick outer fence. Substitution is single-pass over declared names only: a supplied value
 * containing another placeholder's literal text is not re-substituted, and undeclared grammar
 * placeholders (`<file>:L<line>`, `<tag>`, `<axis>`, `<Section>`) are left untouched.
 */

import fs from 'node:fs';

const DEFAULT_SECTION = 'Prompt template';

// SECTION: Extraction

/**
 * Extracts the declared variable names and template body for one `#### <section>` block.
 *
 * @param {string} markdown
 * @param {string} [section]
 * @returns {{ variables: string[], template: string }}
 */
export function extractTemplate(markdown, section = DEFAULT_SECTION) {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  const escapedSection = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingPattern = new RegExp(`^#{1,6}\\s+${escapedSection}\\s*$`);

  let headingIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingPattern.test(lines[i])) {
      headingIndex = i;
      break;
    }
  }
  if (headingIndex === -1) {
    throw new Error(`Section "${section}" not found`);
  }

  const varBulletPattern = /^-\s+`<([^>]+)>`/;
  const variables = [];

  let fenceOpenIndex = -1;
  let fenceChar = null;
  let fenceLen = 0;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = /^(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      fenceOpenIndex = i;
      fenceChar = fenceMatch[1][0];
      fenceLen = fenceMatch[1].length;
      break;
    }
    const varMatch = varBulletPattern.exec(line);
    if (varMatch) {
      variables.push(varMatch[1]);
    }
  }
  if (fenceOpenIndex === -1) {
    throw new Error(`No fenced block found under section "${section}"`);
  }

  // The closer must match the marker and may be longer, preserving nested shorter fences.
  const closePattern = new RegExp(`^${fenceChar}{${fenceLen},}\\s*$`);
  let fenceCloseIndex = -1;
  for (let i = fenceOpenIndex + 1; i < lines.length; i++) {
    if (closePattern.test(lines[i])) {
      fenceCloseIndex = i;
      break;
    }
  }
  if (fenceCloseIndex === -1) {
    throw new Error(`Unterminated fenced block under section "${section}"`);
  }

  const template = lines.slice(fenceOpenIndex + 1, fenceCloseIndex).join('\n');
  return { variables, template };
}

// SECTION: Frame assembly

const SLOT_PATTERN = /<<slot:([A-Za-z0-9_-]+)>>/g;

/**
 * Splits a kind block into its leading `<Name>` variable bullets and its `## NAME` sections.
 * Only level-2 headings open a section, so section bodies may carry deeper headings or fences.
 */
function parseKindBlock(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const variables = [];
  const sections = new Map();
  let current = null;
  let fence = null;
  for (const line of lines) {
    const fenceMatch = /^(`{3,}|~{3,})\s*\S*\s*$/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && /^(`+|~+)\s*$/.test(line)) fence = null;
    }
    const heading = fence || fenceMatch ? null : /^##\s+(\S.*?)\s*$/.exec(line);
    if (heading) {
      current = heading[1];
      if (sections.has(current)) throw new Error(`Kind block declares section "${current}" twice`);
      sections.set(current, []);
      continue;
    }
    if (current === null) {
      const varMatch = /^-\s+`<([^>]+)>`/.exec(line);
      if (varMatch) variables.push(varMatch[1]);
    } else {
      sections.get(current).push(line);
    }
  }
  const trimmed = new Map();
  for (const [name, body] of sections) {
    trimmed.set(name, body.join('\n').replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, ''));
  }
  return { variables, sections: trimmed };
}

/**
 * Assembles a shared frame template with one kind block: every `<<slot:NAME>>` in the frame's
 * fenced template becomes the kind block's `## NAME` section body, and the declared variables are
 * the union of both files' bullets. A slot without a section, or a section without a slot, throws.
 *
 * @param {string} framePath
 * @param {string} kindPath
 * @param {string} [section]
 * @returns {{ variables: string[], template: string }}
 */
export function assembleTemplate(framePath, kindPath, section = DEFAULT_SECTION) {
  const frame = extractTemplate(fs.readFileSync(framePath, 'utf8'), section);
  const kind = parseKindBlock(fs.readFileSync(kindPath, 'utf8'));
  const slots = new Set([...frame.template.matchAll(SLOT_PATTERN)].map((match) => match[1]));
  const missing = [...slots].filter((name) => !kind.sections.has(name));
  if (missing.length > 0) {
    throw new Error(`Kind block ${kindPath} has no section for slot(s): ${missing.join(', ')}`);
  }
  const unused = [...kind.sections.keys()].filter((name) => !slots.has(name));
  if (unused.length > 0) {
    throw new Error(`Kind block ${kindPath} declares section(s) with no frame slot: ${unused.join(', ')}`);
  }
  // Empty sections remove their slot line so assembly adds no phantom whitespace.
  const template = frame.template
    .replace(/^[ \t]*<<slot:([A-Za-z0-9_-]+)>>[ \t]*\n/gm, (line, name) => (kind.sections.get(name) ? line : ''))
    .replace(SLOT_PATTERN, (_, name) => kind.sections.get(name));
  const variables = [...new Set([...frame.variables, ...kind.variables])];
  return { variables, template };
}

// SECTION: Substitution

/**
 * Fills declared placeholders in `template` with `values`. Single-pass over declared names
 * only: a substituted value's own text is never re-scanned, and undeclared placeholders in the
 * template body (e.g. `<file>:L<line>`) are left as-is.
 *
 * @param {string} template
 * @param {string[]} variables
 * @param {Record<string, string>} values
 * @returns {string}
 */
export function fillTemplate(template, variables, values) {
  const declared = new Set(variables);

  const missing = variables.filter((name) => !Object.prototype.hasOwnProperty.call(values, name));
  if (missing.length > 0) {
    throw new Error(`Missing value(s) for declared variable(s): ${missing.join(', ')}`);
  }
  const unknown = Object.keys(values).filter((name) => !declared.has(name));
  if (unknown.length > 0) {
    throw new Error(`Unknown variable(s) not declared by this template: ${unknown.join(', ')}`);
  }

  if (variables.length === 0) return template;

  const alternation = variables
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const placeholderPattern = new RegExp(`<(${alternation})>`, 'g');

  return template.replace(placeholderPattern, (match, name) => values[name]);
}
