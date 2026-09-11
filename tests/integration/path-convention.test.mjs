import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { resolveArtifacts } from '../../skills/dispatch/scripts/resolve-artifact-paths.mjs';

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
  'skills/dispatch/SKILL.md',
  'skills/dispatch/README.md',
  'skills/dispatch-plan-review/SKILL.md',
  'skills/dispatch-plan-review/README.md',
  'skills/dispatch-code-review/SKILL.md',
  'skills/dispatch-code-review/README.md',
  'skills/implement-dispatch/SKILL.md',
  'skills/implement-dispatch/README.md',
];

/**
 * The review skills must keep pointing at the shared resolver (script + reference
 * doc) rather than restating the naming convention inline, so there is exactly one
 * place — `skills/dispatch/references/alignment.md` — that can drift.
 */
const MUST_REFERENCE_RESOLVER = ['skills/dispatch-plan-review/SKILL.md', 'skills/dispatch-code-review/SKILL.md'];
const RESOLVER_MENTIONS = ['resolve-artifact-paths.mjs', 'alignment.md'];

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
  const skillsDir = path.join(REPO_ROOT, 'skills');
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .flatMap(entry =>
      // Forward slashes, so the result compares against GUARDED on every platform.
      ['SKILL.md', 'README.md']
        .map(name => `skills/${entry.name}/${name}`)
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
    const result = resolveArtifacts({ slug: 'auth-v2', date: '2026-09-10' });
    for (const [generated, shapes] of [
      [result.plan.path, PLAN_SHAPES],
      [result.walkthrough.path, WALKTHROUGH_SHAPES],
    ]) {
      assert.ok(generated.startsWith(SCRATCH_PREFIX), `${generated} lives under ${SCRATCH_PREFIX}`);
      const token = generated.slice(SCRATCH_PREFIX.length);
      assert.ok(
        shapes.some(shape => shape.test(token)),
        `${generated} matches its canonical shape`
      );
    }
    assert.ok(result.walkthrough.path.endsWith('-walkthrough.md'));
  });

  it('rejects a slug that would escape the scratch directory', () => {
    assert.throws(
      () => resolveArtifacts({ slug: '../evil', date: '2026-09-10' }),
      /must be kebab-case/
    );
  });

  it('still finds every enumerated skill markdown file', () => {
    // A subset check, not equality: deleting a guarded file must fail here, while the
    // canonical-shape assertion below already covers any newly added skill directory.
    const discovered = new Set(skillMarkdownFiles());
    assert.deepEqual(GUARDED.filter(rel => !discovered.has(rel)), []);
  });

  it('keeps the review skills pointing at the shared resolver', () => {
    for (const rel of MUST_REFERENCE_RESOLVER) {
      const text = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      assert.ok(
        RESOLVER_MENTIONS.some(mention => text.includes(mention)),
        `${rel} no longer references the shared artifact resolver (${RESOLVER_MENTIONS.join(' or ')})`
      );
    }
  });

  it('keeps the shared reference doc naming the convention', () => {
    const mentions = scratchMentions('skills/dispatch/references/alignment.md').filter(m =>
      CANONICAL.some(s => s.test(m.token))
    );
    assert.ok(mentions.length > 0, 'skills/dispatch/references/alignment.md no longer names a canonical artifact path');
  });

  it('keeps every skill markdown mention on a canonical shape', () => {
    const offenders = skillMarkdownFiles()
      .flatMap(scratchMentions)
      .filter(m => !ALLOWLIST.includes(m.token) && !CANONICAL.some(shape => shape.test(m.token)))
      .map(m => `${m.rel}:L${m.line} — ${SCRATCH_PREFIX}${m.token}`);
    assert.deepEqual(offenders, []);
  });
});
