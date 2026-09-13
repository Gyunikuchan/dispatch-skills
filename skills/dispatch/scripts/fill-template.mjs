#!/usr/bin/env node
/**
 * Extracts and fills the `#### Prompt template` fenced block from a template file — each review
 * skill's own `references/prompt-template.md` — so orchestrators stop hand-rolling an
 * extraction/substitution script per dispatch and stop piping a multi-line, backtick-heavy prompt
 * through shell quoting. The template stays in the skill that owns it; this script reads it, and
 * never relocates it (see `references/alignment.md` § Prompt Template Filling).
 *
 * NOTE: the flag is spelled `--skill` for callers' sake, but its value is the template file's
 * path, not a SKILL.md.
 *
 * Usage:
 *   node fill-template.mjs --skill <template path> [--section "Prompt template"]
 *                           (--var Name=Value)... [--vars <json file>] [--out <path>] [--list]
 *
 * `--section` defaults to "Prompt template" and matches any heading level (`#`-`######`) with
 * that exact text. Declared variables are the backtick-quoted `<Name>` bullets (`` - `<Name>` —
 * ... ``) between the heading and the first fenced block; the template body is that fence's
 * contents. The outer fence in review SKILL.md files is 4 backticks (` ```` `) wrapping an inner
 * 3-backtick fence example inside the template body — the fence scanner accepts any fence of 3+
 * backticks/tildes and closes only on a fence of the same character with length >= the opener's,
 * so the inner fence stays intact as template content.
 *
 * `--list` prints the declared variable names as a JSON array and exits before filling.
 * `--var Name=Value` and `--vars <json file>` (a JSON object of strings; multi-line values
 * supported) supply substitutions; `--var` wins over `--vars` on a name collision. Every
 * declared variable must be supplied and no undeclared name may be; substitution is single-pass
 * over declared names only, so a supplied value containing another placeholder's literal text
 * (e.g. a `<Plan Path>`-shaped string) is not re-substituted, and ungoverned grammar placeholders
 * in the template body (`<file>:L<line>`, `<tag>`, `<axis>`, `<Section>`) are left untouched
 * because they were never declared.
 *
 * Before filling, the owning skill's `skill-hashes.json` (one directory up from a
 * `references/` template) is checked when present: drift in the template itself aborts the
 * fill, drift elsewhere in the skill only warns. This detects an unnoticed or accidental
 * modification before the prompt reaches a delegate — it is not tamper resistance, since
 * whoever can edit the template can also rewrite the unhashed manifest. A skill with no
 * manifest is filled without a check.
 *
 * `--out <path>` writes the filled prompt as UTF-8 (creating parent directories) and prints the
 * path; omitted, the filled prompt is printed to stdout.
 */

import fs from 'node:fs';
import path from 'node:path';

import { hashFile, isMainModule, verifySkillIntegrity } from './common.mjs';

const DEFAULT_SECTION = 'Prompt template';

// ============================================================================
// SECTION: Extraction
// ============================================================================

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

  // Declared variables: backtick-quoted `<Name>` at the start of a bullet, collected from the
  // heading down to the fence opener.
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

  // Closing fence: same character, length >= opener's — so an inner 3-backtick example fence
  // nested inside a 4-backtick outer fence doesn't prematurely close the block.
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

// ============================================================================
// SECTION: Substitution
// ============================================================================

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

// ============================================================================
// SECTION: CLI entry point
// ============================================================================

/**
 * Resolves the skill root owning a template path: `<skill>/references/x.md` and
 * `<skill>/SKILL.md` both resolve to `<skill>`.
 */
export function resolveSkillRoot(templatePath) {
  const dir = path.dirname(path.resolve(templatePath));
  return path.basename(dir) === 'references' ? path.dirname(dir) : dir;
}

/**
 * Aborts when the template being filled drifted from its recorded hash, or when the manifest
 * that would record it is unreadable — the decisive check hashes the template directly rather
 * than reading a verdict off the whole skill, so a corrupt manifest cannot pass as "some other
 * file drifted". Drift in a sibling file only warns: editing a sibling `SKILL.md` is the normal
 * way these skills get tuned and must not block a review. Skills without a manifest (a
 * standalone template, or one outside the hashed skills) fill unchecked — the absence is a
 * packaging choice, not a violation.
 */
function assertTemplateIntegrity(templatePath) {
  const skillRoot = resolveSkillRoot(templatePath);
  const manifestPath = path.join(skillRoot, 'skill-hashes.json');
  if (!fs.existsSync(manifestPath)) return;

  const abort = (reason) => {
    process.stderr.write(`Error: ${reason} Refusing to fill the template.\n`);
    process.exit(1);
  };

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    abort(`${manifestPath} is not readable JSON (${err.message}).`);
  }

  const templateKey = path.relative(skillRoot, path.resolve(templatePath)).split(path.sep).join('/');
  const expected = manifest?.[templateKey];
  if (typeof expected !== 'string') {
    // An unlisted template is drift in the manifest, not in the template: warn, don't block a
    // host repo that added its own template file next to the shipped ones.
    process.stderr.write(
      `[fill-template] WARNING: ${templateKey} is not listed in ${manifestPath}; ` +
        'filling it unverified.\n',
    );
    return;
  }
  if (hashFile(path.resolve(templatePath)) !== expected) {
    abort(`${templateKey} no longer matches its recorded hash in ${manifestPath}.`);
  }

  // Decisive check passed; report the rest of the skill as advisory only.
  const integrity = verifySkillIntegrity(skillRoot);
  const others = integrity.violations.filter((v) => v !== templateKey);
  if (others.length > 0) {
    process.stderr.write(
      `[fill-template] WARNING: ${skillRoot} has modified files not covered by this fill: ` +
        `${others.join(', ')}. Run \`node scripts/generate-hashes.mjs\` if the change was intended.\n`,
    );
  }
}

function parseArgs(args) {
  const opts = { section: DEFAULT_SECTION, vars: [], varsFile: null, out: null, list: false };

  const value = (i) => {
    const next = args[i + 1];
    if (next === undefined) {
      throw new Error(`Missing value for ${args[i]}`);
    }
    return next;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--skill') { opts.skill = value(i); i++; }
    else if (arg === '--section') { opts.section = value(i); i++; }
    else if (arg === '--var') {
      const raw = value(i); i++;
      const eq = raw.indexOf('=');
      if (eq === -1) {
        throw new Error(`Malformed --var "${raw}" (expected Name=Value)`);
      }
      opts.vars.push([raw.slice(0, eq), raw.slice(eq + 1)]);
    }
    else if (arg === '--vars') { opts.varsFile = value(i); i++; }
    else if (arg === '--out') { opts.out = value(i); i++; }
    else if (arg === '--list') { opts.list = true; }
    else {
      throw new Error(`Unrecognized argument "${arg}"`);
    }
  }
  return opts;
}

function loadVarsFile(varsFile) {
  let raw;
  try {
    raw = fs.readFileSync(varsFile, 'utf8');
  } catch {
    throw new Error(`--vars file not found: ${varsFile}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`--vars file is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--vars file must contain a JSON object of strings');
  }
  for (const [key, val] of Object.entries(parsed)) {
    if (typeof val !== 'string') {
      throw new Error(`--vars file value for "${key}" must be a string`);
    }
  }
  return parsed;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }

  if (!opts.skill) {
    process.stderr.write('Error: --skill <template path> is required\n');
    process.exit(1);
  }
  if (!fs.existsSync(opts.skill)) {
    process.stderr.write(`Error: Template file not found: ${opts.skill}\n`);
    process.exit(1);
  }

  assertTemplateIntegrity(opts.skill);

  const markdown = fs.readFileSync(opts.skill, 'utf8');

  let extracted;
  try {
    extracted = extractTemplate(markdown, opts.section);
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }

  if (opts.list) {
    process.stdout.write(`${JSON.stringify(extracted.variables)}\n`);
    return;
  }

  let values = {};
  if (opts.varsFile) {
    try {
      values = loadVarsFile(opts.varsFile);
    } catch (err) {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exit(1);
    }
  }
  // --var wins over --vars on a name collision.
  for (const [name, val] of opts.vars) {
    values[name] = val;
  }

  let filled;
  try {
    filled = fillTemplate(extracted.template, extracted.variables, values);
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }

  if (opts.out) {
    fs.mkdirSync(path.dirname(opts.out), { recursive: true });
    fs.writeFileSync(opts.out, filled, 'utf8');
    process.stdout.write(`${opts.out}\n`);
  } else {
    process.stdout.write(`${filled}\n`);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
