import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Guards the repo's unidirectional dependency flow (`.agents/AGENTS.md` §
 * Architecture & Dependency Invariants):
 *   implement-dispatch -> dispatch-plan-review, dispatch-code-review, dispatch
 *   dispatch-plan-review, dispatch-code-review -> dispatch
 *   dispatch -> (nothing)
 * `dispatch` never names a downstream skill, except its own
 * `references/alignment.md` and the gated "## Skill Alignment" section of
 * `dispatch/SKILL.md` (up to the next `## ` heading) — those conventions exist
 * specifically to serve the three downstream skills. One further exception: the v0.4
 * rejection probe in `dispatch/scripts/config.mjs` must name the retired sibling config
 * directory, so only lines there carrying the `v0.4 config probe` marker may name it.
 * Review skills never name `implement-dispatch` (their sibling, not their dependency).
 */

const DOWNSTREAM_NAMES = ['implement-dispatch', 'dispatch-plan-review', 'dispatch-code-review', 'dispatch-design-review'];
const DOWNSTREAM_PATTERN = new RegExp(`\\b(${DOWNSTREAM_NAMES.join('|')})\\b`, 'g');

const DISPATCH_DIR = path.join(REPO_ROOT, 'skills', 'dispatch');
const ALIGNMENT_DOC = path.join(DISPATCH_DIR, 'references', 'alignment.md');
const DISPATCH_SKILL_MD = path.join(DISPATCH_DIR, 'SKILL.md');
const CONFIG_MODULE = path.join(DISPATCH_DIR, 'scripts', 'config.mjs');
const LEGACY_PROBE_MARKER = 'v0.4 config probe';

const TEXT_EXTENSIONS = new Set(['.md', '.mjs', '.json', '.jsonc']);

/** Walks a directory, returning every text file's absolute path. */
function walkTextFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkTextFiles(full);
    return TEXT_EXTENSIONS.has(path.extname(entry.name)) ? [full] : [];
  });
}

/** Finds every line in `file` matching `pattern`, as `{ file, line, text }`. */
function findMatches(file, pattern) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const matches = [];
  lines.forEach((line, index) => {
    if (pattern.test(line)) matches.push({ file, line: index + 1, text: line.trim() });
    pattern.lastIndex = 0;
  });
  return matches;
}

/** The `## Skill Alignment ...` section of dispatch/SKILL.md, up to the next `## ` heading. */
function skillAlignmentSectionLines(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^## Skill Alignment/.test(l));
  if (start === -1) return new Set();
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  const included = new Set();
  for (let i = start; i < end; i++) included.add(i + 1);
  return included;
}

function formatOffenders(offenders) {
  return offenders.map((m) => `${path.relative(REPO_ROOT, m.file).split(path.sep).join('/')}:${m.line} — ${m.text}`);
}

describe('dependency direction guard', () => {
  it('dispatch/ never names a downstream skill outside the allowlisted alignment references', () => {
    const skillMdText = readFileSync(DISPATCH_SKILL_MD, 'utf8');
    const allowedSkillMdLines = skillAlignmentSectionLines(skillMdText);

    const offenders = walkTextFiles(DISPATCH_DIR).flatMap((file) => {
      if (file === ALIGNMENT_DOC) return []; // Fully allowlisted: exists to serve the three downstream skills.
      const matches = findMatches(file, new RegExp(DOWNSTREAM_PATTERN.source, 'g'));
      if (file === DISPATCH_SKILL_MD) {
        return matches.filter((m) => !allowedSkillMdLines.has(m.line));
      }
      if (file === CONFIG_MODULE) {
        // Only the marked probe lines may name the retired skill, and only that one name.
        return matches.filter(
          (m) => !(m.text.includes(LEGACY_PROBE_MARKER) && !/\bdispatch-(plan|code|design)-review\b/.test(m.text)),
        );
      }
      return matches;
    });

    assert.deepEqual(formatOffenders(offenders), []);
  });

  it('config.mjs carries the marked v0.4 config probe that the allowlist depends on', () => {
    const text = readFileSync(CONFIG_MODULE, 'utf8');
    const probeLines = text.split(/\r?\n/).filter((line) => line.includes(LEGACY_PROBE_MARKER));
    assert.ok(probeLines.length > 0, `expected a line marked "${LEGACY_PROBE_MARKER}" in config.mjs`);
    assert.ok(probeLines.some((line) => /\bimplement-dispatch\b/.test(line)), 'the marked probe names the retired sibling directory');
  });

  it('no shipped skill markdown hard-codes a host install path', () => {
    // `.agents/AGENTS.md` § Architecture permits a relative link to a sibling inside the one
    // skills directory, but never a host-specific install path: those break the moment the skill
    // is installed under a different host's directory name.
    const hostPaths = /(?:\.claude|\.agents|\.github)\/skills\/|\.opencode\/skill\//g;
    const offenders = walkTextFiles(path.join(REPO_ROOT, 'skills'))
      .filter((file) => file.endsWith('.md'))
      .flatMap((file) => findMatches(file, new RegExp(hostPaths.source, 'g')))
      // Defining `<skill-path>` / `<skills-dir>` means naming the per-host directories they stand
      // in for. That is the portable mechanism, not a breach of it — the breach is *resolving* a
      // path through one host's layout instead of through those variables.
      .filter((m) => !/<skill-path>|<skills-dir>/.test(m.text));

    assert.deepEqual(formatOffenders(offenders), []);
  });

  it('dispatch-plan-review/ and dispatch-code-review/ never name implement-dispatch', () => {
    const reviewSkillDirs = ['dispatch-plan-review', 'dispatch-code-review', 'dispatch-design-review'].map((name) =>
      path.join(REPO_ROOT, 'skills', name),
    );
    const offenders = reviewSkillDirs.flatMap((dir) =>
      walkTextFiles(dir).flatMap((file) => findMatches(file, /\bimplement-dispatch\b/g)),
    );
    assert.deepEqual(formatOffenders(offenders), []);
  });
});
