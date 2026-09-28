import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { resolveArtifacts } from '../../skills/dispatch/scripts/artifacts/resolve-paths.mjs';
import { initializeSession } from '../../skills/dispatch/scripts/lib/session-lifecycle.mjs';
import { RUN_ENV, SESSION_ENV } from '../../skills/dispatch/scripts/lib/session-temp.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const WORKSPACE_SESSION_PREFIX = '.scratch/dispatch-skills/';
const ACTIVE_ARTIFACT_PREFIX = '<sessionDir>/artifacts/';

/**
 * The canonical artifact filename shapes, as placeholder form (`<slug>.md`)
 * or as a concrete kebab-case filename. The resolver generates these; skill
 * prose repeats them in locations that cannot import the resolver, so this suite is
 * the drift guard across both.
 */
const PLAN_SHAPES = [
  /^<slug>\.md$/,
  // Concrete plan filename; the lookbehind keeps walkthroughs out, since
  // `-walkthrough` is otherwise just another kebab segment. A plan whose slug is
  // literally `walkthrough` matches neither list and is reported as an offender —
  // intentional, because that filename is genuinely ambiguous with a walkthrough.
  /^[a-z0-9]+(-[a-z0-9]+)*(?<!-walkthrough)\.md$/,
  // Phased artifacts: technical designs, increment plans, integration walkthroughs.
  /^<design-slug>-design\.md$/,
  /^<design-slug>-i<nn>-<increment-slug>-plan\.md$/,
  /^<design-slug>-integration-walkthrough\.md$/,
];

const WALKTHROUGH_SHAPES = [
  /^<slug>-walkthrough\.md$/,
  /^[a-z0-9]+(-[a-z0-9]+)*-walkthrough\.md$/,
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
  'skills/dispatch-code-review/SKILL.md',
  'skills/dispatch-design-review/SKILL.md',
  'skills/dispatch-implement/SKILL.md',
  'skills/dispatch/references/readme/configuration.md',
  'skills/dispatch/references/readme/verbs.md',
];

/**
 * Mentions of a session root that name no artifact: the bare directory and the
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
  const topLevel = readdirSync(skillsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .flatMap(entry => ['SKILL.md', 'README.md'].map(name => `skills/${entry.name}/${name}`));
  const disclosedHumanReferences = [
    'skills/dispatch/references/readme/configuration.md',
    'skills/dispatch/references/readme/verbs.md',
  ];
  return [...topLevel, ...disclosedHumanReferences].filter(rel => {
    try {
      readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      return true;
    } catch {
      return false;
    }
  });
}

/** Session artifact mentions in a file, as `{ rel, line, token }`. */
function sessionArtifactMentions(rel) {
  const text = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
  const mentions = [];
  text.split('\n').forEach((line, index) => {
    for (const [prefix, strip] of [
      [WORKSPACE_SESSION_PREFIX, raw => raw.startsWith('<folder>/artifacts/') ? raw.slice('<folder>/artifacts/'.length) : raw.startsWith('<folder>/') ? '' : raw],
      [ACTIVE_ARTIFACT_PREFIX, raw => raw],
    ]) {
      let from = 0;
      for (;;) {
        const at = line.indexOf(prefix, from);
        if (at === -1) break;
        const raw = trimTrailing(line.slice(at + prefix.length).split(/\s/)[0] ?? '');
        mentions.push({ rel, line: index + 1, token: strip(raw) });
        from = at + prefix.length;
      }
    }
  });
  return mentions;
}

// SECTION: Resolver safety and canonical output

describe('artifact resolver path contract', () => {
  it('generates paths matching the canonical shapes', () => {
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-path-contract-'));
    const keys = [SESSION_ENV, RUN_ENV, 'DISPATCH_CHAT_ID', 'DISPATCH_SESSION_TERMINAL'];
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    try {
      const sessionId = `path-contract-${process.pid}`;
      const sessionDir = initializeSession({ repositoryRoot, sessionId, sessionTitle: 'path contract', objective: 'path contract' });
      process.env[SESSION_ENV] = sessionDir;
      const result = resolveArtifacts({
        slug: 'auth-v2', projectRoot: repositoryRoot,
        repositoryRoot, native: { orchestrator: null },
      });
      const artifactRoot = path.join(sessionDir, 'artifacts');
      for (const [generated, shapes] of [
        [result.plan.path, PLAN_SHAPES],
        [result.walkthrough.path, WALKTHROUGH_SHAPES],
      ]) {
        const relative = path.relative(artifactRoot, generated).split(path.sep).join('/');
        assert.ok(!relative.startsWith('../') && !path.isAbsolute(relative), `${generated} lives in the bound session artifacts/`);
        assert.ok(shapes.some(shape => shape.test(relative)), `${generated} matches its canonical shape`);
      }
      assert.ok(result.walkthrough.path.endsWith('-walkthrough.md'));
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      fs.rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });

  it('rejects a slug that would escape the session artifact path', () => {
    assert.throws(
      () => resolveArtifacts({ slug: '../evil' }),
      /must be kebab-case/
    );
  });
});

// SECTION: Cross-skill documentation contract

describe('session artifact paths stay aligned across skill documentation', () => {
  it('discovers every guarded markdown file', () => {
    const discovered = new Set(skillMarkdownFiles());
    assert.deepEqual(GUARDED.filter(rel => !discovered.has(rel)), []);
  });

  it('keeps aliases routing through dispatch rather than shared internals', () => {
    for (const skill of ['dispatch-design-review', 'dispatch-plan-review', 'dispatch-code-review']) {
      const text = readFileSync(path.join(REPO_ROOT, 'skills', skill, 'SKILL.md'), 'utf8');
      assert.match(text, /dispatch review/);
      assert.doesNotMatch(text, /resolve-artifact-paths\.mjs|prepare-review\.mjs/);
    }
  });

  it('keeps the shared reference doc naming the convention', () => {
    const text = readFileSync(path.join(REPO_ROOT, 'skills/dispatch/references/review.md'), 'utf8');
    assert.match(text, /Active canonical artifacts live in `<sessionDir>\/artifacts\//);
    assert.match(text, /Terminal handoff moves the whole folder/);
  });

  it('keeps every skill markdown mention on a canonical shape', () => {
    const offenders = skillMarkdownFiles()
      .flatMap(sessionArtifactMentions)
      .filter(m => !ALLOWLIST.includes(m.token) && !CANONICAL.some(shape => shape.test(m.token)))
      .map(m => `${m.rel}:L${m.line} — session artifacts/${m.token}`);
    assert.deepEqual(offenders, []);
  });

  it('does not document a retired artifact root', () => {
    const retired = skillMarkdownFiles().flatMap(rel => {
      const lines = readFileSync(path.join(REPO_ROOT, rel), 'utf8').split('\n');
      return lines.flatMap((line, index) => line.includes(['.scratch', 'plan', ''].join('/')) ? [`${rel}:L${index + 1}`] : []);
    });
    assert.deepEqual(retired, []);
  });
});
