import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { resolveFlow } from '../../implement-dispatch/scripts/resolve-flow.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const SCRATCH_PREFIX = '.scratch/plan/';

/**
 * The two canonical artifact shapes, as placeholder form (`<yyyy-mm-dd>-<slug>.md`)
 * or as a concrete dated kebab-case filename. The resolver generates these; skill
 * prose repeats them in locations that cannot import the resolver, so this suite is
 * the drift guard across both.
 */
const PLAN_SHAPES = [
  /^<yyyy-mm-dd>-<slug>\.md$/,
  // Concrete dated plan filename; the lookbehind keeps walkthroughs out, since
  // `-walkthrough` is otherwise just another kebab segment. A plan whose slug is
  // literally `walkthrough` matches neither list and is reported as an offender —
  // intentional, because that filename is genuinely ambiguous with a walkthrough.
  /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(-[a-z0-9]+)*(?<!-walkthrough)\.md$/,
];

const WALKTHROUGH_SHAPES = [
  /^<yyyy-mm-dd>-<slug>-walkthrough\.md$/,
  /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(-[a-z0-9]+)*-walkthrough\.md$/,
];

const CANONICAL = [...PLAN_SHAPES, ...WALKTHROUGH_SHAPES];

/**
 * The files whose prose repeats the canonical artifact paths. Enumerated rather than
 * counted so that deleting a guarded file fails this suite instead of silently
 * shrinking its coverage.
 */
const GUARDED = [
  'dispatch/SKILL.md',
  'dispatch/README.md',
  'dispatch-plan-review/SKILL.md',
  'dispatch-plan-review/README.md',
  'dispatch-code-review/SKILL.md',
  'dispatch-code-review/README.md',
  'implement-dispatch/SKILL.md',
  'implement-dispatch/README.md',
];

/** The review skills must keep naming the convention; they cannot import the resolver. */
const MUST_NAME_CONVENTION = ['dispatch-plan-review/SKILL.md', 'dispatch-code-review/SKILL.md'];

/**
 * Mentions of the scratch directory that name no artifact: the bare directory and the
 * abbreviated diagram label.
 */
const ALLOWLIST = ['', '...'];

const TRAILING = new Set(['`', "'", '"', ')', ']', ',', ';', ':', '.', '*']);

function trimTrailing(token) {
  let end = token.length;
  while (end > 0 && TRAILING.has(token[end - 1])) end--;
  return token.slice(0, end);
}

function skillMarkdownFiles() {
  return readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .flatMap(entry =>
      // Forward slashes, so the result compares against GUARDED on every platform.
      ['SKILL.md', 'README.md']
        .map(name => `${entry.name}/${name}`)
        .filter(rel => {
          try {
            readFileSync(path.join(REPO_ROOT, rel), 'utf8');
            return true;
          } catch {
            return false;
          }
        })
    );
}

/** Every `.scratch/plan/` mention in a file, as `{ rel, line, token }`. */
function scratchMentions(rel) {
  const text = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
  const mentions = [];
  text.split('\n').forEach((line, index) => {
    let from = 0;
    for (;;) {
      const at = line.indexOf(SCRATCH_PREFIX, from);
      if (at === -1) break;
      const rest = line.slice(at + SCRATCH_PREFIX.length);
      const raw = rest.split(/\s/)[0] ?? '';
      mentions.push({ rel, line: index + 1, token: trimTrailing(raw) });
      from = at + SCRATCH_PREFIX.length;
    }
  });
  return mentions;
}

describe('artifact path convention', () => {
  it('generates paths matching the canonical shapes', () => {
    const flow = resolveFlow(
      { platform: 'claude', level: 'low', slug: 'auth-v2', date: '2026-09-10' },
      { claude: true },
      minimalConfig()
    );
    for (const [generated, shapes] of [
      [flow.paths.plan, PLAN_SHAPES],
      [flow.paths.walkthrough, WALKTHROUGH_SHAPES],
    ]) {
      assert.ok(generated.startsWith(SCRATCH_PREFIX), `${generated} lives under ${SCRATCH_PREFIX}`);
      const token = generated.slice(SCRATCH_PREFIX.length);
      assert.ok(
        shapes.some(shape => shape.test(token)),
        `${generated} matches its canonical shape`
      );
    }
    assert.ok(flow.paths.walkthrough.endsWith('-walkthrough.md'));
  });

  it('rejects a slug that would escape the scratch directory', () => {
    assert.throws(
      () =>
        resolveFlow(
          { platform: 'claude', level: 'low', slug: '../evil', date: '2026-09-10' },
          { claude: true },
          minimalConfig()
        ),
      /must be kebab-case/
    );
  });

  it('still finds every enumerated skill markdown file', () => {
    // A subset check, not equality: deleting a guarded file must fail here, while the
    // canonical-shape assertion below already covers any newly added skill directory.
    const discovered = new Set(skillMarkdownFiles());
    assert.deepEqual(GUARDED.filter(rel => !discovered.has(rel)), []);
  });

  it('keeps the review skills naming the convention', () => {
    for (const rel of MUST_NAME_CONVENTION) {
      const mentions = scratchMentions(rel).filter(m => CANONICAL.some(s => s.test(m.token)));
      assert.ok(
        mentions.length > 0,
        `${rel} no longer names a canonical ${SCRATCH_PREFIX} artifact path`
      );
    }
  });

  it('keeps every skill markdown mention on a canonical shape', () => {
    const offenders = skillMarkdownFiles()
      .flatMap(scratchMentions)
      .filter(m => !ALLOWLIST.includes(m.token) && !CANONICAL.some(shape => shape.test(m.token)))
      .map(m => `${m.rel}:L${m.line} — ${SCRATCH_PREFIX}${m.token}`);
    assert.deepEqual(offenders, []);
  });
});

/** Smallest config satisfying validation, so this suite tests paths and nothing else. */
function minimalConfig() {
  const knobs = {
    maxRounds: { low: 1 },
    targetCount: { low: 1 },
    consensus: { low: false },
    toolTurns: { low: 3 },
  };
  const platforms = { claude: { model: 'claude-opus-5' } };
  return {
    'plan-review': { ...knobs, platforms },
    implementation: { platforms },
    'code-review': { ...knobs, platforms },
  };
}
