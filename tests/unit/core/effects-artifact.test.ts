import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ResultEvent } from '../../../skills/dispatch/scripts/core/types.ts';
import { writeRendered } from '../../../skills/dispatch/scripts/effects/artifacts.ts';
import { createGit } from '../../../skills/dispatch/scripts/effects/git.ts';
import { createParseArtifact, sha256, parseArtifact } from '../../../skills/dispatch/scripts/effects/parse-artifact.ts';
import { createPrepareReview } from '../../../skills/dispatch/scripts/effects/prepare-review.ts';
import { createWriteBrief } from '../../../skills/dispatch/scripts/effects/write-brief.ts';
import { planMachine } from '../../../skills/dispatch/scripts/machines/plan.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';
import { memoryRunFs } from '../../helpers/memory-run-fs.ts';
import { DESIGN_REVISION_CONTEXT_PREFIX } from '../../../skills/dispatch/scripts/domain/prompt.ts';

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../skills/dispatch');
const only = (events: readonly ResultEvent[]) => { assert.equal(events.length, 1); return events[0] as ResultEvent; };
const gitWith = (names: string) => createGit({ run: async (args) => (args[0] === 'rev-parse' ? '/repo\n' : args[0] === 'diff' ? names : '') });

test('parse-artifact hashes authored Task Map metadata, excludes review history, and reports map defects', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'a.plan.md');
  const row = '| T1 | Task | Deliver task output. | none | SC1 |';
  const source = `# Plan

> **TL;DR:** deliver the task.
> **Parent:** \`governing.spec.md\` · sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
> **Decide:** none
> **Risk:** low — isolated fixture
> **Scope:** src/a.ts

## Key Decisions & Context
- Keep the fixture bounded.

## Task Map
| ID | Title | Outcome | Prerequisites | Criteria |
| --- | --- | --- | --- | --- |
${row}

## Proposed Changes
### T1 — Task
#### [MODIFY] src/a.ts
- Changes: deliver the task output.

## Success Criteria
- [SC1] Task output works
  - Satisfies: REQ-1
  - Changes: src/a.ts
  - Verify: \`node --test tests/a.test.ts\`
  - Evidence: verify
  - Test rationale: exercise the task output.

## Verification Plan
### Automated Tests
- \`npm test\`
`;
  const ports = fakePorts();
  memoryRunFs(ports, dir);
  const ctx = { runDir: dir, attempt: 1 };
  const parse = async (id: string, text: string) => {
    ports.fs.writeAtomic(file, text);
    return only(await parseArtifact({ kind: 'parse-artifact', id, path: file, artifact: 'plan' }, ports, ctx));
  };
  const first = await parse('e.1', source);
  const second = await parse('e.2', `${source}\n## Review Findings & Resolutions\n\n- R1-F001 fixed\n`);
  const changedMap = await parse('e.3', source.replace('Deliver task output.', 'Deliver the changed task output.'));
  const invalidMap = await parse('e.4', source.replace(`${row}\n`, ''));
  assert.ok(first.type === 'ARTIFACT_PARSED' && second.type === 'ARTIFACT_PARSED' && changedMap.type === 'ARTIFACT_PARSED' && invalidMap.type === 'ARTIFACT_PARSED');
  assert.equal(first.hash, second.hash);
  assert.notEqual(first.hash, changedMap.hash, 'map-only edits change the artifact hash');
  assert.match(first.hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.kind, 'plan');
  assert.deepEqual(first.defects, []);
  assert.ok(invalidMap.defects.some(({ code }) => code === 'task-map'));
});

test('parse-artifact reports a missing file as EFFECT_FAILED io', async () => {
  const dir = tempDir();
  const missing = only(await parseArtifact({ kind: 'parse-artifact', id: 'e.3', path: path.join(dir, 'nope.plan.md'), artifact: 'plan' }, fakePorts(), { runDir: dir, attempt: 1 }));
  assert.deepEqual(missing.type === 'EFFECT_FAILED' && missing.cls, 'io');
});

test('seam advisory reaches the host and enters review', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'seams.plan.md');
  const source = '# Plan\n\n> **TL;DR:** expose the existing command.\n> **Parent:** \`governing.spec.md\` · sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n> **Decide:** none\n> **Risk:** low — local helper\n> **Scope:** src/a.ts\n\n## Task Map\n| ID | Title | Outcome | Prerequisites | Criteria |\n| --- | --- | --- | --- | --- |\n| T1 | Expose command | The existing command becomes public. | none | SC1 |\n\n## Proposed Changes\n### T1 — Expose command\n#### [MODIFY] src/a.ts\n- Changes: export the command.\n\n## Success Criteria\n- [SC1] Command is available\n  - Satisfies: REQ-1\n  - Changes: src/a.ts\n  - Verify: `node --test tests/a.test.ts`\n  - Evidence: verify\n  - Test rationale: exercise the public command.\n\n## Verification Plan\n### Automated Tests\n- `npm test`\n';
  const ports = fakePorts();
  const started = planMachine.step(planMachine.initial(), { type: 'RUN_STARTED', verb: 'plan', argument: file,
    level: 'low', levelSource: 'explicit', pins: null, orchestrator: 'codex', orchestratorModel: null,
    overrides: {}, config: { 'read-delegates': { codex: { targets: [{ low: { model: 'gpt-5' } }] } } }, repo: {} });
  const author = planMachine.step(started.state, { type: 'AUTHORED', path: file });
  for (const [declaration, expected] of [['', 1], ['- Seams: none\n', 0]] as const) {
    ports.stderrLines.length = 0;
    fs.writeFileSync(file, source.replace('## Verification Plan\n', `## Verification Plan\n${declaration}`));
    const effect = author.effects[0];
    assert.ok(effect?.kind === 'parse-artifact');
    const event = only(await parseArtifact(effect, ports, { runDir: dir, attempt: 1 }));
    assert.ok(event.type === 'ARTIFACT_PARSED');
    assert.deepEqual(event.defects, []);
    assert.equal(ports.stderrLines.length, expected);
    if (expected) {
      assert.ok(ports.stderrLines[0]?.includes(file));
      assert.match(ports.stderrLines[0] ?? '', /warning.*missing-seams.*Seams:/);
    }
    assert.equal(planMachine.step(author.state, event).state.tag, 'review');
  }
});

test('governing spec default replaces context while effect folders retain slot affinity and empty scope', async () => {
  const runDir = tempDir();
  const roster = [{ slot: 'codex[0]', provider: 'codex', index: 0, native: false, reserve: false }, { slot: 'agy[0]', provider: 'agy', index: 0, native: false, reserve: false }];
  const review = { kind: 'code', target: 'main..HEAD', cap: 2, breadth: 2, context: 'check the lock', roster, timeoutMs: 1000 };
  const carried = [{ id: 'R1-F001', slot: 'agy[0]', locus: 'src/a.ts:L3', defect: 'null deref', reason: 'guarded upstream' }];
  const handler = createPrepareReview({ skillRoot: SKILL_ROOT, cwd: '/repo', git: gitWith('src/a.ts\n') });
  const result = only(await handler({ kind: 'prepare-review', id: 'review.prepare-review.2', review, round: 2, scope: { scope: 'disputes-only', carried } }, fakePorts(), { runDir, attempt: 1 }));
  assert.ok(result.type === 'REVIEW_PREPARED');
  assert.deepEqual(Object.keys(result.promptPaths), ['codex[0]', 'agy[0]']);
  assert.equal(path.basename(result.promptPaths['agy[0]'] ?? ''), 'agy-0.prompt.md');
  // Effect folder: each slot's prompt and the scope manifest sit together under the effect id.
  for (const file of [...Object.values(result.promptPaths), String(result.scope['manifestPath'])]) assert.equal(path.dirname(file), path.join(runDir, 'review.prepare-review.2'));
  const agy = fs.readFileSync(result.promptPaths['agy[0]'] ?? '', 'utf8');
  const codex = fs.readFileSync(result.promptPaths['codex[0]'] ?? '', 'utf8');
  assert.match(agy, /R1-F001 src\/a\.ts:L3: null deref — orchestrator rejection: guarded upstream/);
  assert.doesNotMatch(codex, /R1-F001/);
  assert.doesNotMatch(codex, /check the lock/);
  assert.match(codex, /- Task: Review the selected changes\./);
  assert.deepEqual(result.scope['paths'], ['src/a.ts']);
  const empty = only(await createPrepareReview({ skillRoot: SKILL_ROOT, cwd: '/repo', git: gitWith('') })(
    { kind: 'prepare-review', id: 'review.prepare-review.1', review, round: 1, scope: { scope: 'full', carried: [] } }, fakePorts(), { runDir, attempt: 1 }));
  assert.deepEqual(empty.type === 'REVIEW_PREPARED' && [empty.scope['empty'], empty.promptPaths], [true, {}]);
});

test('settled section lists prior rulings', async () => {
  const roster = [{ slot: 'codex[0]', provider: 'codex', index: 0, native: false, reserve: false }];
  const review = { kind: 'code', target: 'main..HEAD', cap: 3, breadth: 1, context: 'check the lock', roster, timeoutMs: 1000 };
  const carried = [{ id: 'R1-F003', slot: null, locus: 'src/b.ts:L9', defect: 'race', reason: 'single writer' }];
  const settled = [
    { id: 'R1-F001', locus: 'src/a.ts:L3', defect: 'null deref', ruling: 'fixed', reason: 'guard added' },
    { id: 'R1-F002', locus: 'Scope', defect: 'x'.repeat(300), ruling: 'rejected', reason: 'user: keep .md only' },
  ];
  const handler = createPrepareReview({ skillRoot: SKILL_ROOT, cwd: '/repo', git: gitWith('src/a.ts\n') });
  const prompt = async (round: number, scope: Record<string, unknown>) => {
    const result = only(await handler({ kind: 'prepare-review', id: `review.prepare-review.${round}`, review, round, scope: { scope: 'full', carried, ...scope } }, fakePorts(), { runDir: tempDir(), attempt: 1 }));
    return result.type === 'REVIEW_PREPARED' ? fs.readFileSync(result.promptPaths['codex[0]'] ?? '', 'utf8') : JSON.stringify(result);
  };
  const second = await prompt(2, { settled });
  assert.match(second, /### Settled in earlier rounds\nRe-raise a settled point only with new evidence that the ruling missed\.\n/);
  assert.match(second, /^- R1-F001 src\/a\.ts:L3: null deref — fixed: guard added$/m);
  const long = /^- R1-F002 Scope: (x+…?) — rejected: user: keep \.md only$/m.exec(second);
  assert.ok(long && long[1]!.length <= 200, 'defect is capped at 200 characters');
  assert.ok(second.indexOf('### Settled in earlier rounds') < second.indexOf('### Pending rejections'), 'settled precedes pending rejections');
  // Round 1 never carries settled rows, so its prompt stays byte-identical to the prompt without them.
  const first = await prompt(1, {});
  assert.equal(await prompt(1, { settled }), first);
  assert.doesNotMatch(first, /Settled in earlier rounds/);
});

test('prepare-review: ask builds a bounded inline prompt', async () => {
  const runDir = tempDir();
  const review = { kind: 'ask', target: 'Where is the lock released?', breadth: 1, context: '', roster: [{ slot: 'codex[0]' }], timeoutMs: 1 };
  const result = only(await createPrepareReview({ skillRoot: SKILL_ROOT, cwd: '/repo', git: gitWith('') })(
    { kind: 'prepare-review', id: 'ask.prepare-review.1', review, round: 1, scope: { scope: 'full', carried: [] } }, fakePorts(), { runDir, attempt: 1 }));
  const text = result.type === 'REVIEW_PREPARED' ? fs.readFileSync(result.promptPaths['codex[0]'] ?? '', 'utf8') : '';
  for (const heading of ['### Objective', '### Evidence', '### Stop condition', '### Output']) assert.ok(text.includes(heading), heading);
});

test('write-brief: brief written with its sha256 and the envelope path', async () => {
  const runDir = tempDir();
  const result = only(await createWriteBrief({ skillRoot: SKILL_ROOT })({ kind: 'write-brief', id: 'implement.write-brief.1', stage: 'task', input: {} }, fakePorts(), { runDir, attempt: 1 }));
  assert.ok(result.type === 'BRIEF_READY');
  const text = fs.readFileSync(result.path, 'utf8');
  assert.equal(result.sha256, `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`);
  assert.equal(result.stage, 'task');
  assert.ok(text.includes(result.envelopePath));
  assert.equal(fs.existsSync(result.envelopePath), false);
});

test('writeRendered skips identical content and overwrites changes', () => {
  const file = path.join(tempDir(), 'x.md');
  const ports = fakePorts();
  assert.equal(writeRendered(ports, file, 'a'), true);
  assert.equal(writeRendered(ports, file, 'a'), false);
  assert.equal(writeRendered(ports, file, 'b'), true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'b');
});

test('prepare-review and write-brief: a write failure is one EFFECT_FAILED io', async () => {
  const ports = fakePorts();
  ports.fs = { ...ports.fs, writeAtomic: () => { throw new Error('disk full'); } };
  const ctx = { runDir: tempDir(), attempt: 1 };
  const review = { kind: 'ask', target: 'q', breadth: 1, context: '', roster: [{ slot: 'codex[0]' }], timeoutMs: 1 };
  const prep = only(await createPrepareReview({ skillRoot: SKILL_ROOT, cwd: '/repo', git: gitWith('') })(
    { kind: 'prepare-review', id: 'ask.prepare-review.1', review, round: 1, scope: { scope: 'full', carried: [] } }, ports, ctx));
  const brief = only(await createWriteBrief({ skillRoot: SKILL_ROOT })({ kind: 'write-brief', id: 'implement.write-brief.1', stage: 'task', input: {} }, ports, ctx));
  for (const result of [prep, brief]) assert.ok(result.type === 'EFFECT_FAILED' && result.cls === 'io' && /disk full/.test(result.detail));
});

const LOW_SPEC = '# Spec\r\n\r\n## Intent & Problem\r\nWhy.\r\n\r\n## Requirements\r\n### REQ-1 — Lint\r\n- Acceptance: lint runs.\r\n\r\n## Non-goals\r\n- none\r\n\r\n## Constraints\r\n- portable\r\n';

test('parse-artifact: spec hashes raw bytes and lints by level', async () => {
  const dir = tempDir();
  const file = path.join(dir, 's.spec.md');
  fs.writeFileSync(file, LOW_SPEC);
  const hash = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
  const low = only(await parseArtifact({ kind: 'parse-artifact', id: 'spec.parse-artifact.1', path: file, artifact: 'spec', level: 'low' }, fakePorts(), { runDir: dir, attempt: 1 }));
  assert.ok(low.type === 'ARTIFACT_PARSED' && low.kind === 'spec');
  assert.equal(low.hash, hash);
  assert.deepEqual(low.defects, []);
  assert.deepEqual((low.parsed as { reqIds: string[] }).reqIds, ['REQ-1']);
  const medium = only(await parseArtifact({ kind: 'parse-artifact', id: 'spec.parse-artifact.2', path: file, artifact: 'spec', level: 'medium' }, fakePorts(), { runDir: dir, attempt: 1 }));
  assert.ok(medium.type === 'ARTIFACT_PARSED');
  assert.equal(medium.hash, hash);
  assert.deepEqual(medium.parsed, {});
  assert.ok(medium.defects.length > 0 && medium.defects.every((d) => d['code'] === 'missing-section'));
});

test('parse-artifact: spec reports a missing file as EFFECT_FAILED io', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'nope.spec.md');
  const missing = only(await parseArtifact({ kind: 'parse-artifact', id: 'spec.parse-artifact.1', path: file, artifact: 'spec', level: 'low' }, fakePorts(), { runDir: dir, attempt: 1 }));
  assert.deepEqual(missing, { type: 'EFFECT_FAILED', effectId: 'spec.parse-artifact.1', cls: 'io', detail: `spec not found: ${file}` });
});

const GOVERNED_PLAN = `# Plan

> **TL;DR:** deliver the task.
> **Parent:** \`governing.spec.md\` · sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
> **Decide:** none
> **Risk:** low — isolated fixture
> **Scope:** src/a.ts

## Key Decisions & Context
- Keep the fixture bounded.

## Task Map
| ID | Title | Outcome | Prerequisites | Criteria |
| --- | --- | --- | --- | --- |
| T1 | Task | Deliver task output. | none | SC1 |

## Proposed Changes
### T1 — Task
#### [MODIFY] src/a.ts
- Changes: deliver the task output.

## Success Criteria
- [SC1] Task output works
  - Satisfies: REQ-1
  - Changes: src/a.ts
  - Verify: \`node --test tests/a.test.ts\`
  - Evidence: verify
  - Test rationale: exercise the task output.

## Verification Plan
### Automated Tests
- \`npm test\`
`;

import { SPEC_SOURCE, specHash } from '../../helpers/spec-fixture.ts';
const GOVERNED_DESIGN = `# Design

> **TL;DR:** Deliver behavior.
> **Parent:** \`governing.spec.md\` · ${specHash()}
> **Decide:** none
> **Risk:** low — fixture
> **Increments:** 1

## Approach
REQ-1 maps to I01.
## Alternatives & Decisions
Keep one increment.
## Risks, Security & Operations
Bounded.
## Architecture & Boundaries
One module.
## Increment Dependency Graph
| ID | Priority | Summary | Prerequisites | Paths |
| --- | --- | --- | --- | --- |
| I01 | 1 | Deliver | none | src/a.ts |
## Increment Details
### I01 Deliver
- Outcome: behavior delivered
- Scope: src/a.ts
- Non-scope: other modules
- Observable behavior: behavior works
- Affected contracts: module API
- Validation: npm test
- Rollback boundary: revert increment
- Parallel safety: unsafe beside others
## Final Integration
Run all checks.
`;

test('prepare-review rejects mutated settled spec for code, plan, and design', async () => {
  for (const kind of ['code', 'plan', 'design'] as const) {
    const ports = fakePorts(), dir = tempDir(); memoryRunFs(ports, dir);
    const target = path.join(dir, `${kind}.md`), specPath = path.join(dir, 'governing.spec.md');
    ports.fs.writeAtomic(target, kind === 'design' ? GOVERNED_DESIGN : GOVERNED_PLAN);
    const governingSpec = { path: specPath, hash: specHash() };
    ports.fs.writeAtomic(specPath, SPEC_SOURCE + '\nChanged after settlement.');
    const handler = createPrepareReview({ skillRoot: SKILL_ROOT, cwd: dir, git: gitWith('src/a.ts\n') });
    const result = only(await handler({ kind: 'prepare-review', id: 'stale.1', review: { kind, target, governingSpec, roster: [{ slot: 'codex[0]' }] }, round: 1, scope: { scope: 'full' } }, ports, { runDir: dir, attempt: 1 }));
    assert.ok(result.type === 'EFFECT_FAILED');
    assert.match(result.detail, /stale-spec/);
  }
});

test('prepare-review preserves internal design and plan provenance under governing spec', async () => {
  for (const kind of ['design', 'plan'] as const) {
    const ports = fakePorts(), dir = tempDir(); memoryRunFs(ports, dir);
    const target = path.join(dir, `${kind}.md`), specPath = path.join(dir, 'governing.spec.md');
    ports.fs.writeAtomic(target, kind === 'design' ? GOVERNED_DESIGN : GOVERNED_PLAN);
    ports.fs.writeAtomic(specPath, SPEC_SOURCE);
    const provenance = kind === 'design'
      ? { before: 'OLD_FULL_ARTIFACT', after: 'NEW_FULL_ARTIFACT', delta: { changed: ['I02'], invalidated: ['I02'], removed: [] }, reason: 'Correct dependency ordering', evidence: 'dependency.log:L7' }
      : { invocationContext: null, invocationLevel: 'high', invocationLevelSource: 'explicit' };
    const context = `${kind === 'design' ? DESIGN_REVISION_CONTEXT_PREFIX : ''}${JSON.stringify(provenance)}`;
    const handler = createPrepareReview({ skillRoot: SKILL_ROOT, cwd: dir, git: gitWith('') });
    const result = only(await handler({ kind: 'prepare-review', id: 'provenance.1', review: { kind, target, context, governingSpec: { path: specPath, hash: specHash() }, roster: [{ slot: 'codex[0]' }] }, round: 1, scope: { scope: 'full' } }, ports, { runDir: dir, attempt: 1 }));
    assert.ok(result.type === 'REVIEW_PREPARED');
    const prompt = ports.fs.readText(result.promptPaths['codex[0]']!)!;
    assert.match(prompt, /### Internal review provenance\nStructural driver context; subject to the governing spec\./);
    const section = prompt.split('### Internal review provenance\n')[1]!;
    const rendered = JSON.parse(section.split('\n')[1]!) as Record<string, unknown>;
    if (kind === 'design') {
      assert.deepEqual(rendered, { delta: provenance.delta, reason: provenance.reason, evidence: provenance.evidence });
      assert.doesNotMatch(prompt, /OLD_FULL_ARTIFACT|NEW_FULL_ARTIFACT/);
    } else assert.deepEqual(rendered, provenance);
  }
});

function governingFixture() {
  const ports = fakePorts(), dir = tempDir(); memoryRunFs(ports, dir);
  const file = path.join(dir, 'a.plan.md'), spec = path.join(dir, 'governing.spec.md');
  ports.fs.writeAtomic(spec, SPEC_SOURCE);
  const source = GOVERNED_PLAN.replace(/sha256:a{64}/, specHash());
  const parse = async (text = source, artifact: 'plan' | 'design' = 'plan', governing: string | undefined = spec) => {
    ports.fs.writeAtomic(file, text);
    return only(await createParseArtifact({ cwd: dir })({ kind: 'parse-artifact', id: 'pin.1', path: file, artifact, ...(governing ? { governing } : {}) }, ports, { runDir: dir, attempt: 1 }));
  };
  return { ports, dir, spec, source, parse };
}
test('governing pin rejects a different spec path despite equal hashes', async () => {
 for (const transitive of [false, true]) for (const exists of [false, true]) {
 const f = governingFixture(); if (exists) f.ports.fs.writeAtomic(path.join(f.dir, 'other.spec.md'), SPEC_SOURCE);
 f.ports.fs.writeAtomic(path.join(f.dir, 'child.design.md'), GOVERNED_DESIGN.replace('`governing.spec.md`', '`other.spec.md`'));
 const source = transitive ? f.source.replace(/`governing.spec.md` · sha256:[a-f0-9]{64}/, '`child.design.md` · I01') : f.source.replace('`governing.spec.md`', '`other.spec.md`');
 const result = await f.parse(source);
 assert.ok(result.type === 'EFFECT_FAILED', JSON.stringify({ transitive, exists, result }));
 assert.match(result.detail, /spec pin path conflicts/);
 }
});
test('governing pin accepts normalized spec path identity', async () => {
 for (const transitive of [false, true]) {
 const f = governingFixture();
 f.ports.fs.writeAtomic(path.join(f.dir, 'child.design.md'), GOVERNED_DESIGN.replace('`governing.spec.md`', '`nested/../governing.spec.md`'));
 const source = transitive ? f.source.replace(/`governing.spec.md` · sha256:[a-f0-9]{64}/, '`child.design.md` · I01') : f.source.replace('`governing.spec.md`', '`nested/../governing.spec.md`');
 const result = await f.parse(source);
 assert.ok(result.type === 'ARTIFACT_PARSED'); assert.deepEqual(result.defects, []);
 }
});
test('governing pin resolves standalone plan, increment plan, and design', async () => {
  for (const kind of ['standalone plan', 'increment plan', 'design'] as const) {
    const f = governingFixture();
    f.ports.fs.writeAtomic(path.join(f.dir, 'child.design.md'), GOVERNED_DESIGN);
    const result = await f.parse(kind === 'design' ? GOVERNED_DESIGN : kind === 'increment plan' ? f.source.replace(/`governing.spec.md` · sha256:[a-f0-9]{64}/, '`child.design.md` · I01') : f.source, kind === 'design' ? 'design' : 'plan');
    assert.ok(result.type === 'ARTIFACT_PARSED', JSON.stringify(result));
    assert.deepEqual(result.defects, []);
    assert.deepEqual(result.governing, { pinned: specHash(), current: specHash(), design: kind === 'increment plan' ? 'child.design.md' : null, reqIds: ['REQ-1'] });
  }
});
test('governing spec warns about unknown requirement', async () => {
  const f = governingFixture(), result = await f.parse(f.source.replace('Satisfies: REQ-1', 'Satisfies: REQ-9'));
  assert.ok(result.type === 'ARTIFACT_PARSED'); assert.deepEqual(result.defects, []);
  assert.ok(f.ports.stderrLines.some(line => line.includes('warning unknown-requirement:')));
});
test('governing pin fails on missing design', async () => {
  const f = governingFixture(), result = await f.parse(f.source.replace(/`governing.spec.md` · sha256:[a-f0-9]{64}/, '`missing.design.md` · I01'));
  assert.ok(result.type === 'EFFECT_FAILED' && result.cls === 'io'); assert.match(result.detail, /^design pin target unreadable:/); assert.doesNotMatch(result.detail, /not found/);
});
test('governing pin fails on design without spec pin', async () => {
  for (const parent of ['', '> **Parent:** user request', '> **Parent:** `notes.txt` · sha256:' + 'a'.repeat(64)]) {
    const f = governingFixture(); f.ports.fs.writeAtomic(path.join(f.dir, 'child.design.md'), '# Design\n' + parent);
    const result = await f.parse(f.source.replace(/`governing.spec.md` · sha256:[a-f0-9]{64}/, '`child.design.md` · I01'));
    assert.ok(result.type === 'EFFECT_FAILED' && result.cls === 'io'); assert.match(result.detail, /has no spec pin/);
  }
});
test('governing spec fails lint with current pin', async () => {
  const f = governingFixture(); f.ports.fs.writeAtomic(f.spec, '# Invalid');
  const result = await f.parse(f.source.replace(specHash(), `sha256:${sha256('# Invalid')}`));
  assert.ok(result.type === 'EFFECT_FAILED' && result.cls === 'io'); assert.match(result.detail, /governing spec fails lint/);
});
test('governing spec stale malformed bytes skip traceability', async () => {
  const f = governingFixture(); f.ports.fs.writeAtomic(f.spec, '# Invalid');
  const result = await f.parse(f.source.replace('Satisfies: REQ-1', 'Satisfies: REQ-9'));
  assert.ok(result.type === 'ARTIFACT_PARSED'); assert.deepEqual(result.governing, { pinned: specHash(), current: `sha256:${sha256('# Invalid')}`, design: null, reqIds: [] }); assert.deepEqual(result.defects, []);
});
test('governing omitted without field', async () => {
  const f = governingFixture(), result = await f.parse(f.source, 'plan', '');
  assert.ok(result.type === 'ARTIFACT_PARSED'); assert.equal('governing' in result, false);
});

test('downgraded plan and design findings are reported as warnings without blocking', async () => {
  for (const kind of ['plan', 'design'] as const) {
    const f = governingFixture();
    const source = (kind === 'plan' ? f.source.replace('Satisfies: REQ-1', 'Satisfies: REQ-9') : GOVERNED_DESIGN.replace('REQ-1 maps', 'REQ-9 maps')).replace(/> \*\*Risk:\*\*.*\n/, '');
    const result = await f.parse(source, kind);
    assert.ok(result.type === 'ARTIFACT_PARSED');
    assert.deepEqual(result.defects, []);
    for (const code of ['unknown-requirement', 'summary-label']) assert.ok(f.ports.stderrLines.some(line => line.includes(`warning ${code}:`)), code);
  }
});

test('governing spec warns about unknown approach requirement', async () => {
  const f = governingFixture(), result = await f.parse(GOVERNED_DESIGN.replace('REQ-1 maps', 'REQ-9 maps'), 'design');
  assert.ok(result.type === 'ARTIFACT_PARSED');
  assert.deepEqual(result.defects, []);
  assert.ok(f.ports.stderrLines.some(line => line.includes('warning unknown-requirement:')));
});
test('governing pin preserves lint warnings for malformed Parent', async () => {
  const f = governingFixture(), result = await f.parse(f.source.replace(/`governing.spec.md` \u00b7 sha256:[a-f0-9]{64}/, 'user request'));
  assert.ok(result.type === 'ARTIFACT_PARSED');
  assert.equal(result.governing?.pinned, null);
  assert.deepEqual(result.defects, []);
  assert.ok(f.ports.stderrLines.some(line => line.includes('warning summary-label:')));
});
