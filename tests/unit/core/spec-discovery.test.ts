import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { discoverSpecCandidate, type SpecDiscoveryInput } from '../../../skills/dispatch/scripts/core/spec-discovery.ts';
import { fakePorts, tempDir } from '../../helpers/fake-ports.ts';
import { SPEC_SOURCE, specHash } from '../../helpers/spec-fixture.ts';

const PIN = `sha256:${'a'.repeat(64)}`;
function setup() {
  const ports = fakePorts(), repoRoot = tempDir(), sessionDir = path.join(repoRoot, 'session');
  const write = (relative: string, text: string) => { const file = path.join(repoRoot, relative); ports.fs.writeAtomic(file, text); return file; };
  const discover = (input: Partial<SpecDiscoveryInput>) => discoverSpecCandidate(ports.fs, { verb: 'plan', argument: 'Objective', specFlag: null, sessionDir, repoRoot, ...input });
  return { ports, repoRoot, sessionDir, write, discover };
}
const artifact = (parent: string) => `# Artifact\n\n> **TL;DR:** fixture\n> **Parent:** ${parent}\n\n## Body\nText.\n`;

test('spec discovery: a design or standalone plan Parent pins the spec, including from another session folder', () => {
  const { write, discover, repoRoot } = setup();
  const spec = write('other/x.spec.md', SPEC_SOURCE);
  write('session/a.spec.md', SPEC_SOURCE);
  write('other/x.design.md', artifact(`\`other/x.spec.md\` · ${specHash()}`));
  write('other/x.plan.md', artifact(`\`other/x.spec.md\` · ${PIN}`));
  assert.deepEqual(discover({ verb: 'implement', argument: path.join(repoRoot, 'other/x.design.md') }), { ok: true, candidate: spec });
  assert.deepEqual(discover({ verb: 'review', argument: 'other/x.plan.md' }), { ok: true, candidate: spec });
});

test('spec discovery: an increment plan resolves through its design Parent', () => {
  const { write, discover } = setup();
  const spec = write('docs/x.spec.md', SPEC_SOURCE);
  write('docs/x.design.md', artifact(`\`docs/x.spec.md\` · ${PIN}`));
  write('docs/x-i01.plan.md', artifact('`docs/x.design.md` · I01'));
  assert.deepEqual(discover({ verb: 'implement', argument: 'docs/x-i01.plan.md' }), { ok: true, candidate: spec });
});

test('spec discovery: --spec applies without a chain candidate and a user request Parent is ignored', () => {
  const { write, discover } = setup();
  const flagged = write('docs/y.spec.md', SPEC_SOURCE);
  write('session/a.spec.md', SPEC_SOURCE);
  write('docs/z.plan.md', artifact('user request'));
  assert.deepEqual(discover({ specFlag: 'docs/y.spec.md' }), { ok: true, candidate: flagged });
  assert.deepEqual(discover({ verb: 'review', argument: 'docs/z.plan.md', specFlag: 'docs/y.spec.md' }), { ok: true, candidate: flagged });
});

test('spec discovery: the single session-root spec is the candidate, and none yields null', () => {
  const { write, discover, sessionDir } = setup();
  assert.deepEqual(discover({}), { ok: true, candidate: null });
  write('session/.state/runs/001/nested.spec.md', SPEC_SOURCE);
  assert.deepEqual(discover({}), { ok: true, candidate: null });
  write('session/a.spec.md', SPEC_SOURCE);
  assert.deepEqual(discover({}), { ok: true, candidate: path.join(sessionDir, 'a.spec.md') });
});

test('spec discovery: two session-root specs fail ambiguous-spec naming --spec', () => {
  const { write, discover } = setup();
  write('session/a.spec.md', SPEC_SOURCE); write('session/b.spec.md', SPEC_SOURCE);
  const result = discover({});
  assert.ok(!result.ok && result.code === 'ambiguous-spec');
  assert.match(result.message, /--spec/);
});

test('spec discovery: a --spec that differs from the chain candidate fails spec-conflict', () => {
  const { write, discover } = setup();
  write('docs/x.spec.md', SPEC_SOURCE); write('docs/y.spec.md', SPEC_SOURCE);
  write('docs/x.plan.md', artifact(`\`docs/x.spec.md\` · ${PIN}`));
  const result = discover({ verb: 'implement', argument: 'docs/x.plan.md', specFlag: 'docs/y.spec.md' });
  assert.equal(result.ok ? null : result.code, 'spec-conflict');
});

test('spec discovery: a missing --spec fails spec-not-found', () => {
  const { discover } = setup();
  const result = discover({ specFlag: 'docs/missing.spec.md' });
  assert.equal(result.ok ? null : result.code, 'spec-not-found');
});

test('spec discovery: a missing spec pinned by a design Parent fails spec-not-found', () => {
  const { write, discover } = setup();
  write('docs/x.design.md', artifact(`\`docs/missing.spec.md\` · ${PIN}`));
  const result = discover({ verb: 'implement', argument: 'docs/x.design.md' });
  assert.equal(result.ok ? null : result.code, 'spec-not-found');
  assert.match(result.ok ? '' : result.message, /missing\.spec\.md/);
});

test('spec discovery: a missing spec pinned through an increment plan design fails spec-not-found', () => {
  const { write, discover } = setup();
  write('docs/x.design.md', artifact(`\`docs/missing.spec.md\` · ${PIN}`));
  write('docs/x-i01.plan.md', artifact('`docs/x.design.md` · I01'));
  const result = discover({ verb: 'implement', argument: 'docs/x-i01.plan.md' });
  assert.equal(result.ok ? null : result.code, 'spec-not-found');
  assert.match(result.ok ? '' : result.message, /missing\.spec\.md/);
});

test('spec discovery: a missing design pinned by an increment plan fails spec-not-found naming the design', () => {
  const { write, discover } = setup();
  write('docs/x-i01.plan.md', artifact('`docs/missing.design.md` · I01'));
  const result = discover({ verb: 'review', argument: 'docs/x-i01.plan.md' });
  assert.equal(result.ok ? null : result.code, 'spec-not-found');
  assert.match(result.ok ? '' : result.message, /missing\.design\.md/);
});

/** Asserts that a --spec spelling reaching the chain spec through a dot segment is not a conflict. */
function assertDotSegmentSpecFlag(specFlag: string) {
  const { write, discover } = setup();
  const spec = write('docs/x.spec.md', SPEC_SOURCE);
  write('docs/x.plan.md', artifact(`\`docs/x.spec.md\` · ${PIN}`));
  const result = discover({ verb: 'review', argument: 'docs/x.plan.md', specFlag });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(path.normalize(result.candidate ?? ''), path.normalize(spec));
}

test('spec discovery: a --spec naming the chain spec through dot segments is not a conflict', () => {
  assertDotSegmentSpecFlag(['docs', 'sub', '..', 'x.spec.md'].join(path.sep));
});

test('spec discovery: a --spec naming the chain spec with backslashes is not a conflict on Windows', { skip: process.platform !== 'win32' && 'backslash separators are Windows-only' }, () => {
  assertDotSegmentSpecFlag('docs\\sub\\..\\x.spec.md');
});

test('discovery follows increment pin through design', () => {
  const { write, discover } = setup(); const spec = write('docs/x.spec.md', SPEC_SOURCE);
  write('docs/x.design.md', artifact('`docs/x.spec.md` · ' + PIN));
  write('docs/x.plan.md', artifact('`docs/x.design.md` · I01'));
  assert.deepEqual(discover({ verb: 'implement', argument: 'docs/x.plan.md' }), { ok: true, candidate: spec });
});
test('discovery ignores non-spec pin', () => {
  for (const parent of ['`notes.txt` · ' + PIN, '`docs/x.spec.md` · sha256:abc', '`docs/x.spec.md` · sha256:' + 'A'.repeat(64)]) {
    const { write, discover } = setup(); write('docs/x.spec.md', SPEC_SOURCE); write('docs/x.plan.md', artifact(parent));
    assert.deepEqual(discover({ verb: 'review', argument: 'docs/x.plan.md' }), { ok: true, candidate: null });
  }
});
