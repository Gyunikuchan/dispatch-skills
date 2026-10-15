import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from '../helpers/e2e.ts';
import { SPEC_SOURCE, specHash } from '../helpers/spec-fixture.ts';

const startArgs = (verb: string, session: string, argument: string, flags: string[] = []) =>
  ['start', verb, '--session-dir', session, '--orchestrator', 'codex', '--level', 'medium', '--level-source', 'explicit', ...flags, '--', argument];

test('spec stage e2e: a session without a spec authors one, gates it at medium, and then authors the plan', async () => {
  const f = fixture();
  try {
    const session = await f.initialize({ spec: false });
    const authoring = await f.cli(startArgs('plan', session, 'Add a cache'));
    assert.equal(authoring.await, 'author', JSON.stringify(authoring));
    assert.equal(authoring.data['artifact'], 'spec');
    const specPath = path.resolve(f.repo, String(authoring.data['path']));
    assert.equal(path.dirname(specPath), path.resolve(session));
    assert.match(path.basename(specPath), /\.spec\.md$/);
    fs.writeFileSync(specPath, SPEC_SOURCE);
    const gate = await f.reply(authoring.run, { type: 'AUTHORED', path: specPath });
    assert.equal(gate.await, 'decide', JSON.stringify(gate));
    assert.equal(gate.data['kind'], 'spec-approval');
    assert.equal(gate.data['hash'], specHash());
    const plan = await f.reply(authoring.run, { type: 'DECISION', kind: 'spec-approval', answer: { by: 'user', quote: 'approve', hash: specHash() } });
    assert.equal(plan.at, 'plan › author', JSON.stringify(plan));
  } finally { f.cleanup(); }
});

test('spec stage e2e: two session-root specs exit 1 with ambiguous-spec and no stdout', async () => {
  const f = fixture();
  try {
    const session = await f.initialize();
    fs.writeFileSync(path.join(session, 'second.spec.md'), SPEC_SOURCE);
    const result = await f.launch(startArgs('plan', session, 'Add a cache')).done;
    assert.equal(result.exit, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /ambiguous-spec/);
  } finally { f.cleanup(); }
});

test('spec stage e2e: a --spec that conflicts with a reviewed plan governing spec exits 1', async () => {
  const f = fixture();
  try {
    const session = await f.initialize();
    fs.mkdirSync(path.join(f.repo, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(f.repo, 'docs/x.spec.md'), SPEC_SOURCE);
    fs.writeFileSync(path.join(f.repo, 'docs/y.spec.md'), SPEC_SOURCE);
    fs.writeFileSync(path.join(f.repo, 'docs/x.plan.md'), `# Plan\n\n> **TL;DR:** fixture\n> **Parent:** \`docs/x.spec.md\` · ${specHash()}\n`);
    const result = await f.launch(startArgs('review', session, 'docs/x.plan.md', ['--spec', 'docs/y.spec.md'])).done;
    assert.equal(result.exit, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /spec-conflict/);
  } finally { f.cleanup(); }
});
