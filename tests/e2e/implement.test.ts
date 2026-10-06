import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from '../helpers/e2e.ts';
import { governedPlanText } from '../../skills/dispatch/scripts/domain/plan.ts';
test('prewrite-level: CLI approval reaches classification before writer receipt, verification and handoff', async () => {
  const f = fixture();
  try {
    const session = await f.initialize();
    const plan = path.join(f.repo, 'fixture.plan.md');
    fs.writeFileSync(plan, `# Normalize values

> **TL;DR:** Normalize values before use.
> **Parent:** user request
> **Decide:** none
> **Risk:** low — isolated helper
> **Scope:** src/a.ts

## Key Decisions & Context
- Preserve case.

## Technical-Design Traceability
- Approved revision: none

## Success Criteria
- [SC1] Values are normalized
  - Changes: src/a.ts
  - Verify: \`node -e "process.exit(0)"\`
  - Evidence: verify
  - Test rationale: Run the isolated verification command to establish the scoped gate behavior.

## Proposed Changes
### T1 — Normalize values
Values are normalized before use so downstream comparisons agree.
- Prerequisites: none
- Criteria: SC1

#### [MODIFY] src/a.ts
- Normalize the value.

## Verification Plan
### Automated Tests
- \`node -e "console.log('final gate')"\`
### Manual Verification
- Observe normalized output.

## Review Findings & Resolutions
*No reviews conducted yet.*
`);
    f.git('add', 'fixture.plan.md'); f.git('commit', '-qm', 'plan');
    let frame = await f.begin('implement', session, plan); const run = f.absoluteRun(frame.run);
    assert.equal(frame.await, 'decide', JSON.stringify(frame)); assert.equal(frame.data['kind'], 'approval', JSON.stringify(frame));
    frame = await f.reply(run, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed with implementation' } });
    assert.equal(frame.data['kind'], 'level-classification', JSON.stringify(frame));
    frame = await f.reply(run, { type: 'DECISION', kind: 'level-classification', answer: { evaluatedLevel: 'low', rationale: 'This is one bounded, reversible helper change.', gateScope: frame.data['gateScope'] } });
    assert.equal(frame.await, 'write', JSON.stringify(frame));
    const [slot] = frame.data['tasks'] as { task: string; action: string; attempt: number; signature: string; briefPath: string; briefSha256: string; envelopePath: string; worktree: string }[];
    assert.deepEqual([slot?.task, slot?.action], ['T1', 'launch']);
    const brief = fs.readFileSync(slot!.briefPath); assert.equal(`sha256:${crypto.createHash('sha256').update(brief).digest('hex')}`, slot!.briefSha256);
    frame = await f.reply(run, { type: 'WRITE_LAUNCHED', tasks: [{ task: 'T1', attempt: slot!.attempt, signature: slot!.signature, handle: 'agent-1', model: (slot as unknown as { model: string }).model, ...(typeof frame.data['effort'] === 'string' ? { effort: frame.data['effort'] as string } : {}) }] });
    assert.equal((frame.data['tasks'] as { action: string }[])[0]?.action, 'running', JSON.stringify(frame));
    fs.writeFileSync(path.join(slot!.worktree, 'src/a.ts'), 'export const value = 2;\n');
    assert.notEqual(fs.readFileSync(path.join(f.repo, 'src/a.ts'), 'utf8'), 'export const value = 2;\n');
    const envelopePath = slot!.envelopePath;
    const previewEvent = fs.readdirSync(run).find((file) => file.endsWith('.self-check.event.json'))!;
    assert.match(brief.toString('utf8'), /send --run .*--event .*self-check.event.json.*--dry-run/);
    const beforePreview = fs.readFileSync(path.join(run, 'events.jsonl'), 'utf8');
    const previewPath = path.join(run, previewEvent);
    const preview = JSON.parse(fs.readFileSync(previewPath, 'utf8')) as Record<string, unknown>;
    assert.deepEqual([preview['task'], preview['attempt'], preview['signature']], ['T1', slot!.attempt, slot!.signature]);
    fs.writeFileSync(previewPath, JSON.stringify({ ...preview, handle: 'agent-1' }));
    fs.writeFileSync(envelopePath, '{"schemaVersion":1,"status":"DONE","stage":"COMPLETE","summary":""}');
    const invalidReceipt = await f.cli(['send', '--run', run, '--event', `@${path.join(run, previewEvent)}`, '--dry-run']);
    assert.match(invalidReceipt.error ?? '', /summary|evidence/i); assert.equal(fs.readFileSync(path.join(run, 'events.jsonl'), 'utf8'), beforePreview);
    fs.writeFileSync(envelopePath, JSON.stringify({ schemaVersion: 1, status: 'DONE', stage: 'COMPLETE', summary: 'Values normalized', evidence: ['CRITERION SC1 | src/a.ts | normalizes value before use'], files: [{ path: 'src/a.ts', note: 'Normalizes values.' }] }));
    const validReceipt = await f.cli(['send', '--run', run, '--event', `@${path.join(run, previewEvent)}`, '--dry-run']); assert.equal(validReceipt.error, undefined);
    frame = await f.reply(run, { type: 'WRITE_ENVELOPE', task: 'T1', attempt: slot!.attempt, signature: slot!.signature, handle: 'agent-1', envelopePath }); assert.equal(frame.await, 'evidence', JSON.stringify(frame));
    assert.equal(fs.readFileSync(path.join(f.repo, 'src/a.ts'), 'utf8').replace(/\r\n/g, '\n'), 'export const value = 2;\n');
    assert.equal(fs.existsSync(slot!.worktree), false);
    frame = await f.reply(run, { type: 'EVIDENCE', criteria: { SC1: { outcome: 'pass', evidence: 'The scoped verification passed after mutation.' } } });
    assert.equal(frame.await, 'done', JSON.stringify(frame)); assert.equal(frame.data['outcome'], 'complete');
    const published = String(frame.data['handoff']); assert.equal(published, session); assert.ok(fs.existsSync(session));
    assert.ok(fs.readdirSync(published).some((file) => file.endsWith('.walkthrough.md')));
    const journal = fs.readFileSync(path.join(frame.run, 'events.jsonl'), 'utf8'); const launches = f.launches().length;
    const replay = await f.cli(['send', '--run', frame.run, '--dry-run']); assert.equal(replay.data['outcome'], 'complete');
    assert.equal(fs.readFileSync(path.join(frame.run, 'events.jsonl'), 'utf8'), journal); assert.equal(f.launches().length, launches);
    fs.rmSync(published, { recursive: true, force: true });
  } finally { f.cleanup(); }
});

test('level-journal: hotfix scope request has public dry-run and send parity for an approved path', async () => {
  const f = fixture();
  try {
    const session = await f.initialize();
    const plan = path.join(f.repo, 'hotfix.plan.md');
    const source = `# Repair a value

> **TL;DR:** Preserve the accepted value contract.
> **Parent:** user request
> **Decide:** none
> **Risk:** low — one local value
> **Scope:** src/a.ts

## Key Decisions & Context
- Keep the value contract stable.

## Technical-Design Traceability
- Approved revision: none

## Success Criteria
- [SC1] The value contract remains stable
  - Changes: src/a.ts
  - Verify: \`node -e "const fs=require('node:fs');process.exit(fs.readFileSync('src/a.ts','utf8').includes('value = 2') ? 1 : 0)"\` [FINAL]
  - Evidence: verify
  - Pre-existing: no
  - Test rationale: Check that implementation preserves the accepted value contract.

## Proposed Changes
### T1 — Preserve the value contract
Keep the public value contract intact.
- Prerequisites: none
- Criteria: SC1

#### [MODIFY] src/a.ts
- Preserve the accepted value.

## Verification Plan
### Automated Tests
- \`node -e "process.exit(0)"\`
### Manual Verification
- Inspect the public value.

## Review Findings & Resolutions
*No reviews conducted yet.*
`;
    fs.writeFileSync(plan, source);
    f.git('add', 'hotfix.plan.md'); f.git('commit', '-qm', 'hotfix plan');
    let frame = await f.begin('implement', session, plan);
    const run = f.absoluteRun(frame.run);
    frame = await f.reply(run, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Approve this scope.' } });
    frame = await f.reply(run, { type: 'DECISION', kind: 'level-classification', answer: { evaluatedLevel: 'low', rationale: 'One bounded local value change.', gateScope: frame.data['gateScope'] } });
    const [slot] = frame.data['tasks'] as { task: string; attempt: number; signature: string; handle: string | null; envelopePath: string; worktree: string }[];
    assert.equal(slot?.task, 'T1', JSON.stringify(frame));
    frame = await f.reply(run, { type: 'WRITE_LAUNCHED', tasks: [{ task: 'T1', attempt: slot!.attempt, signature: slot!.signature, handle: 'writer-1', model: (slot as unknown as { model: string }).model, ...(typeof frame.data['effort'] === 'string' ? { effort: frame.data['effort'] as string } : {}) }] });
    fs.writeFileSync(path.join(slot!.worktree, 'src/a.ts'), 'export const value = 2;\n');
    fs.writeFileSync(slot!.envelopePath, JSON.stringify({ schemaVersion: 1, status: 'DONE', stage: 'COMPLETE', summary: 'The scoped change is delivered.', evidence: ['CRITERION SC1 | src/a.ts | Preserved the value contract.'], files: [{ path: 'src/a.ts', note: 'Updated the value implementation.' }] }));
    frame = await f.reply(run, { type: 'WRITE_ENVELOPE', task: 'T1', attempt: slot!.attempt, signature: slot!.signature, handle: 'writer-1', envelopePath: slot!.envelopePath });
    assert.equal(frame.await, 'decide', JSON.stringify(frame));
    assert.equal(frame.data['kind'], 'failure', JSON.stringify(frame));
    frame = await f.reply(run, { type: 'DECISION', kind: 'failure', answer: { action: 'hotfix', rootCause: 'The final value contract check exposed the change.' } });
    assert.equal(frame.await, 'write', JSON.stringify(frame));
    const envelopePath = String(frame.data['envelopePath']);
    assert.ok(envelopePath);
    const baseArtifactHash = `sha256:${crypto.createHash('sha256').update(governedPlanText(source)).digest('hex')}`;
    const requestEnvelope = {
      schemaVersion: 1, status: 'SCOPE_REQUEST', stage: 'COMPLETE', summary: 'The repair needs a companion path.', evidence: [],
      scopeRequest: {
        requestId: 'hotfix-companion', source: 'hotfix', baseArtifactHash,
        writerRationale: 'The repair requires a companion module.',
        delta: { paths: ['src/extra.ts'], criteria: [], obligations: [], commands: [], phaseDuties: [], increments: [] },
      },
    };
    fs.writeFileSync(envelopePath, JSON.stringify(requestEnvelope));
    const beforeRequest = fs.readFileSync(path.join(run, 'events.jsonl'), 'utf8');
    frame = await f.reply(run, { type: 'WRITE_ENVELOPE', envelopePath }, true);
    assert.equal(frame.error, undefined, JSON.stringify(frame));
    assert.equal(fs.readFileSync(path.join(run, 'events.jsonl'), 'utf8'), beforeRequest);
    frame = await f.reply(run, { type: 'WRITE_ENVELOPE', envelopePath });
    assert.equal(frame.data['kind'], 'scope-deviation', JSON.stringify(frame));
    const request = frame.data['pendingProposal'];
    frame = await f.reply(run, { type: 'DECISION', kind: 'scope-deviation', answer: { by: 'orchestrator', request, ruling: 'approve', rationale: 'The companion path is necessary for the accepted repair.' } });
    assert.equal(frame.await, 'write', JSON.stringify(frame));
    const expandedEnvelopePath = String(frame.data['envelopePath']);
    fs.writeFileSync(path.join(f.repo, 'src/extra.ts'), 'export const companion = true;\n');
    fs.writeFileSync(expandedEnvelopePath, JSON.stringify({
      schemaVersion: 1, status: 'DONE', stage: 'COMPLETE', summary: 'The approved repair is delivered.',
      evidence: ['HOTFIX src/extra.ts | Added the required companion module.'],
      files: [{ path: 'src/extra.ts', note: 'Added the approved companion module.' }],
    }));
    const beforeExpanded = fs.readFileSync(path.join(run, 'events.jsonl'), 'utf8');
    frame = await f.reply(run, { type: 'WRITE_ENVELOPE', envelopePath: expandedEnvelopePath }, true);
    assert.equal(frame.error, undefined, JSON.stringify(frame));
    assert.equal(fs.readFileSync(path.join(run, 'events.jsonl'), 'utf8'), beforeExpanded);
    frame = await f.reply(run, { type: 'WRITE_ENVELOPE', envelopePath: expandedEnvelopePath });
    assert.equal(frame.error, undefined, JSON.stringify(frame));
    assert.notEqual(frame.data['kind'], 'scope-deviation');
  } finally { f.cleanup(); }
});

test('level-journal: scope-draining preview enforces the original writer envelope', async () => {
  const f = fixture();
  try {
    const session = await f.initialize();
    fs.writeFileSync(path.join(f.skill, 'config.local.jsonc'), JSON.stringify({
      ...f.config, 'write-concurrency': 2,
      'write-subagents': { codex: { low: { model: ['native-stub-a', 'native-stub-b'], effort: 'low' } } },
    }));
    const source = `# Deliver two independent values

> **TL;DR:** Preserve both value contracts.
> **Parent:** user request
> **Decide:** none
> **Risk:** low — two isolated files
> **Scope:** src/a.ts, src/b.ts

## Key Decisions & Context
- Keep each value stable.

## Success Criteria
- [SC1] Value A is preserved
  - Changes: src/a.ts
  - Verify: \`node -e "process.exit(0)"\`
  - Evidence: verify
  - Test rationale: This small retained assertion checks that the established value contract still holds.
- [SC2] Value B is preserved
  - Changes: src/b.ts
  - Verify: \`node -e "process.exit(0)"\`
  - Evidence: verify
  - Test rationale: This small retained assertion checks that the independent value contract still holds.

## Proposed Changes
### T1 — Preserve value A
Keep the first value stable.
- Prerequisites: none
- Criteria: SC1

#### [MODIFY] src/a.ts
- Preserve value A.

### T2 — Preserve value B
Keep the second value stable.
- Prerequisites: none
- Criteria: SC2

#### [MODIFY] src/b.ts
- Preserve value B.

## Verification Plan
### Automated Tests
- None: Criterion commands cover both changes.
### Manual Verification
- Confirm each value remains stable.

## Review Findings & Resolutions
*No reviews conducted yet.*
`;
    const plan = path.join(f.repo, 'scope-drain.plan.md');
    fs.writeFileSync(plan, source);
    fs.writeFileSync(path.join(f.repo, 'src/b.ts'), 'export const other = 1;\n');
    f.git('add', 'src', 'scope-drain.plan.md'); f.git('commit', '-qm', 'scope drain plan');
    let frame = await f.begin('implement', session, plan);
    const run = f.absoluteRun(frame.run);
    frame = await f.reply(run, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed with both values.' } });
    frame = await f.reply(run, { type: 'DECISION', kind: 'level-classification', answer: { evaluatedLevel: 'low', rationale: 'Two isolated, reversible value changes.', gateScope: frame.data['gateScope'] } });
    assert.equal(frame.await, 'write', JSON.stringify(frame));
    assert.ok(Array.isArray(frame.data['tasks']), JSON.stringify(frame));
    const initial = frame.data['tasks'] as { task: string; action: string; attempt: number; signature: string; handle: string | null; envelopePath: string; worktree: string }[];
    assert.deepEqual(initial.map(({ task, action }) => [task, action]), [['T1', 'launch'], ['T2', 'launch']]);
    frame = await f.reply(run, { type: 'WRITE_LAUNCHED', tasks: initial.map((slot) => ({ task: slot.task, attempt: slot.attempt, signature: slot.signature, handle: `writer-${slot.task}`, model: (slot as unknown as { model: string }).model, ...(typeof frame.data['effort'] === 'string' ? { effort: frame.data['effort'] as string } : {}) })) });
    const t1 = initial.find((slot) => slot.task === 'T1')!;
    const t2 = initial.find((slot) => slot.task === 'T2')!;
    const baseArtifactHash = `sha256:${crypto.createHash('sha256').update(governedPlanText(source)).digest('hex')}`;
    fs.writeFileSync(t1.envelopePath, JSON.stringify({
      schemaVersion: 1, status: 'SCOPE_REQUEST', stage: 'COMPLETE', summary: 'Request a companion path before editing it.', evidence: [],
      scopeRequest: { requestId: 't1-extra-path', source: 'task', task: 'T1', baseArtifactHash, writerRationale: 'The accepted behavior requires one companion file.', delta: { paths: ['src/extra.ts'], criteria: [], obligations: [], commands: [], phaseDuties: [], increments: [] } },
    }));
    frame = await f.reply(run, { type: 'WRITE_ENVELOPE', task: t1.task, attempt: t1.attempt, signature: t1.signature, handle: 'writer-T1', envelopePath: t1.envelopePath });
    assert.equal(frame.data['kind'], 'scope-deviation', JSON.stringify(frame));
    const request = frame.data['pendingProposal'];
    frame = await f.reply(run, { type: 'DECISION', kind: 'scope-deviation', answer: { by: 'orchestrator', request, ruling: 'approve', rationale: 'The requested path is required by T1.' } });
    assert.equal(frame.await, 'write', JSON.stringify(frame));

    fs.writeFileSync(path.join(t2.worktree, 'src/extra.ts'), 'export const unauthorized = true;\n');
    fs.writeFileSync(t2.envelopePath, JSON.stringify({
      schemaVersion: 1, status: 'DONE', stage: 'COMPLETE', summary: 'Delivered value B.',
      evidence: ['CRITERION SC2 | src/b.ts | Preserved value B.'], files: [{ path: 'src/extra.ts', note: 'Added an unapproved file for T2.' }],
    }));
    const receipt = { type: 'WRITE_ENVELOPE', task: 'T2', attempt: t2.attempt, signature: t2.signature, handle: 'writer-T2', envelopePath: t2.envelopePath };
    const beforePreview = fs.readFileSync(path.join(run, 'events.jsonl'), 'utf8');
    const preview = await f.reply(run, receipt, true);
    assert.ok(preview.events?.some((event) => event.type === 'WRITE_FAILED'), JSON.stringify(preview));
    assert.deepEqual(((preview.data['tasks'] as { task: string; paths: string[] }[]).find((slot) => slot.task === 'T2'))?.paths, ['src/b.ts']);
    assert.equal(fs.readFileSync(path.join(run, 'events.jsonl'), 'utf8'), beforePreview);
    frame = await f.reply(run, receipt);
    assert.equal(frame.await, 'write', JSON.stringify(frame));
    assert.deepEqual(((frame.data['tasks'] as { task: string; attempt: number; paths: string[] }[]).find((slot) => slot.task === 'T2'))?.paths, ['src/b.ts']);
    assert.equal(((frame.data['tasks'] as { task: string; attempt: number }[]).find((slot) => slot.task === 'T2'))?.attempt, t2.attempt + 1);
    assert.equal(fs.existsSync(path.join(f.repo, 'src/extra.ts')), false);
  } finally { f.cleanup(); }
});

test('reuses settled plan from session journal and rejects stale or failed candidates', async () => {
  const f = fixture();
  try {
    let session = await f.initialize();
    const plan = path.join(f.repo, 'reuse.plan.md');
    fs.writeFileSync(plan, `# Normalize values

> **TL;DR:** Normalize values before use.
> **Parent:** user request
> **Decide:** none
> **Risk:** low — isolated helper
> **Scope:** src/a.ts

## Key Decisions & Context
- Preserve case.

## Technical-Design Traceability
- Approved revision: none

## Success Criteria
- [SC1] Values are normalized
  - Changes: src/a.ts
  - Verify: \`node -e "process.exit(0)"\`
  - Evidence: verify
  - Test rationale: Run the isolated verification command.

## Proposed Changes
### T1 — Normalize values
Values are normalized before use so downstream comparisons agree.
- Prerequisites: none
- Criteria: SC1

#### [MODIFY] src/a.ts
- Normalize the value.

## Verification Plan
### Automated Tests
- \`node -e "console.log('final gate')"\`
### Manual Verification
- Observe normalized output.

## Review Findings & Resolutions
*No reviews conducted yet.*
`);
    f.git('add', 'reuse.plan.md'); f.git('commit', '-qm', 'plan');

    // 1. Unsettled plan in implement runs plan review
    const unreviewedFrame = await f.begin('implement', session, plan);
    const unreviewedJournal = fs.readFileSync(path.join(f.absoluteRun(unreviewedFrame.run), 'events.jsonl'), 'utf8');
    assert.match(unreviewedJournal, /"effectId":"implement\.plan-review/);

    // 2. Run plan to settlement
    let planFrame = await f.begin('plan', session, plan);
    const planRun = f.absoluteRun(planFrame.run);
    assert.equal(planFrame.await, 'author');
    planFrame = await f.reply(planRun, { type: 'AUTHORED', path: plan });
    assert.equal(planFrame.await, 'done');
    assert.equal(planFrame.data['outcome'], 'complete');
    if (typeof planFrame.data['handoff'] === 'string') session = planFrame.data['handoff'];

    // 3. Reusing settled plan in implement skips review directly to approval decision
    const reuseFrame = await f.begin('implement', session, plan);
    const reuseJournal = fs.readFileSync(path.join(f.absoluteRun(reuseFrame.run), 'events.jsonl'), 'utf8');
    assert.equal(reuseFrame.await, 'decide');
    assert.equal(reuseFrame.data['kind'], 'approval');
    assert.doesNotMatch(reuseJournal, /"effectId":"implement\.plan-review/);
    session = path.resolve(f.absoluteRun(reuseFrame.run), '../../..');

    // 3b. Reusing settled plan with differing drive/path case matches via designPathIdentity
    const casedPlan = process.platform === 'win32'
      ? (/^[a-z]:/i.test(plan) ? (plan[0] === plan[0]?.toLowerCase() ? plan[0]!.toUpperCase() : plan[0]!.toLowerCase()) + plan.slice(1) : plan)
      : plan;
    const casedReuseFrame = await f.begin('implement', session, casedPlan);
    const casedReuseJournal = fs.readFileSync(path.join(f.absoluteRun(casedReuseFrame.run), 'events.jsonl'), 'utf8');
    assert.equal(casedReuseFrame.await, 'decide');
    assert.equal(casedReuseFrame.data['kind'], 'approval');
    assert.doesNotMatch(casedReuseJournal, /"effectId":"implement\.plan-review/);

    // 4. Stale hash: modify plan on disk so hash differs from settled run
    fs.writeFileSync(plan, fs.readFileSync(plan, 'utf8').replace('- Preserve case.', '- Preserve case and format.'));
    const staleFrame = await f.begin('implement', session, plan);
    const staleJournal = fs.readFileSync(path.join(f.absoluteRun(staleFrame.run), 'events.jsonl'), 'utf8');
    assert.match(staleJournal, /"effectId":"implement\.plan-review/);

    // 5. Unfinished plan run in a fresh session is rejected
    const session2 = await f.initialize();
    await f.begin('plan', session2, plan);
    const rejectUnfinished = await f.begin('implement', session2, plan);
    const rejectJournal = fs.readFileSync(path.join(f.absoluteRun(rejectUnfinished.run), 'events.jsonl'), 'utf8');
    assert.match(rejectJournal, /"effectId":"implement\.plan-review/);

    // 6. Failed plan run in a fresh session is rejected
    const session3 = await f.initialize();
    const failedPlanFrame = await f.begin('plan', session3, plan);
    const replyFrame = await f.reply(f.absoluteRun(failedPlanFrame.run), { type: 'AUTHORED', path: path.join(f.repo, 'does-not-exist.plan.md') });
    const session3Active = typeof replyFrame.data?.['handoff'] === 'string' ? replyFrame.data['handoff'] : session3;
    const rejectFailed = await f.begin('implement', session3Active, plan);
    const rejectFailedJournal = fs.readFileSync(path.join(f.absoluteRun(rejectFailed.run), 'events.jsonl'), 'utf8');
    assert.match(rejectFailedJournal, /"effectId":"implement\.plan-review/);
  } finally {
    f.cleanup();
  }
});


// SECTION: Private checkout ops

async function checkoutRepo() {

  const { nodePorts } = await import('../../skills/dispatch/scripts/core/ports.ts');
  const { createCheckout } = await import('../../skills/dispatch/scripts/effects/checkout.ts');
  const repo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dispatch-checkout-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'core.autocrlf', 'false');
  const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), text); };
  write('.gitignore', '.scratch/\nnode_modules/\n.env\n'); write('src/a.ts', 'a1\n'); write('src/b.ts', 'b1\n'); write('src/gone.ts', 'gone\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const runDir = path.join(repo, '.scratch/run'); fs.mkdirSync(runDir, { recursive: true });
  const ports = nodePorts();
  const handler = createCheckout({ cwd: repo, links: { create: (target, link) => fs.symlinkSync(target, link, 'junction'), remove: (link) => fs.unlinkSync(link) } });
  let id = 0;
  const invoke = async (name: string, input: Record<string, unknown> = {}) => {
    const [event] = await handler({ kind: 'checkout', id: `c.${++id}`, op: name as never, input }, ports, { runDir, attempt: 1 });
    assert.ok(event, 'checkout handler returned an event');
    return event;
  };
  const op = async (name: string, input: Record<string, unknown> = {}) => {
    const event = await invoke(name, input);
    assert.ok(event.type === 'CHECKOUT_DONE', JSON.stringify(event));
    return event.result as Record<string, unknown>;
  };
  return { repo, git, write, runDir, ports, invoke, op, read: (root: string, file: string) => fs.readFileSync(path.join(root, file), 'utf8') };
}

test('checkout: baseline reproduces caller dirt and links ignored dependencies without deleting them on cleanup', async () => {
  const c = await checkoutRepo();
  c.write('src/a.ts', 'a-dirty\n'); c.write('src/new.ts', 'new\n'); fs.rmSync(path.join(c.repo, 'src/gone.ts')); c.write('node_modules/dep/index.js', 'dep'); c.write('.env', 'X=1');
  const baseline = await c.op('init'), root = String(baseline['path']);
  assert.equal(c.read(root, 'src/a.ts'), 'a-dirty\n'); assert.equal(c.read(root, 'src/new.ts'), 'new\n'); assert.equal(fs.existsSync(path.join(root, 'src/gone.ts')), false);
  assert.equal(c.read(root, 'node_modules/dep/index.js'), 'dep'); assert.equal(c.read(root, '.env'), 'X=1');
  assert.deepEqual((await c.op('init'))['base'], baseline['base']);
  const task = String((await c.op('task', { name: 't1', revision: baseline['base'], links: ['node_modules'], ignored: ['.env'] }))['path']);
  assert.equal(c.read(task, '.env'), 'X=1'); assert.equal(c.read(task, 'node_modules/dep/index.js'), 'dep');
  assert.deepEqual((await c.op('cleanup', { names: ['integration', 't1'], links: ['node_modules'] }))['removed'], ['integration', 't1']);
  assert.equal(c.read(c.repo, 'node_modules/dep/index.js'), 'dep'); assert.equal(c.read(c.repo, 'src/a.ts'), 'a-dirty\n');
});

test('checkout: task worktrees are isolated and integration is idempotent and resets on conflict', async () => {
  const c = await checkoutRepo();
  const base = String((await c.op('init'))['base']);
  const t1 = String((await c.op('task', { name: 't1', revision: base }))['path']), t2 = String((await c.op('task', { name: 't2', revision: base }))['path']);
  fs.writeFileSync(path.join(t1, 'src/a.ts'), 't1\n'); fs.writeFileSync(path.join(t2, 'src/a.ts'), 't2\n');
  assert.equal(c.read(t2, 'src/a.ts'), 't2\n'); assert.equal(c.read(c.repo, 'src/a.ts'), 'a1\n');
  const one = await c.op('commit', { name: 't1', base }), two = await c.op('commit', { name: 't2', base });
  assert.deepEqual(one['paths'], ['src/a.ts']); assert.equal((await c.op('commit', { name: 't1', base }))['revision'], one['revision']);
  const merged = await c.op('integrate', { task: 'T1', candidate: one['revision'], expected: base });
  assert.equal(merged['conflict'], false);
  assert.deepEqual(await c.op('integrate', { task: 'T1', candidate: one['revision'], expected: base }), { revision: merged['revision'], conflict: false, reused: true });
  const conflict = await c.op('integrate', { task: 'T2', candidate: two['revision'], expected: merged['revision'] });
  assert.equal(conflict['conflict'], true); assert.deepEqual(conflict['paths'], ['src/a.ts']); assert.equal(conflict['revision'], merged['revision']);
  assert.equal(c.read(path.join(c.runDir, 'wt/integration'), 'src/a.ts'), 't1\n');
});

test('checkout: RED replay applies approved checkpoint files at the input revision and rejects others', async () => {
  const c = await checkoutRepo();
  const base = String((await c.op('init'))['base']), out = path.join(c.runDir, 'red.json');
  const t1 = String((await c.op('task', { name: 't1', revision: base }))['path']);
  fs.mkdirSync(path.join(t1, 'tests')); fs.writeFileSync(path.join(t1, 'tests/a.test.ts'), 'red'); fs.rmSync(path.join(t1, 'src/b.ts'));
  const candidate = (await c.op('commit', { name: 't1', base }))['revision'];
  fs.writeFileSync(out, JSON.stringify({ schemaVersion: 1, files: { 'tests/a.test.ts': Buffer.from('red').toString('base64'), 'src/b.ts': null } }));
  const rejected = await c.op('red', { name: 't1-red', base, candidate, checkpointPath: out, permitted: ['tests/a.test.ts'] });
  assert.match(String(rejected['defects']), /not an approved task test path: src\/b\.ts/);
  const replay = await c.op('red', { name: 't1-red', base, candidate, checkpointPath: out, permitted: ['tests/a.test.ts', 'src/b.ts'] });
  assert.deepEqual(replay['defects'], []); assert.equal(c.read(String(replay['path']), 'tests/a.test.ts'), 'red'); assert.equal(fs.existsSync(path.join(String(replay['path']), 'src/b.ts')), false);
});

test('checkout: delivery transfers integrated changes and refuses caller drift without writing', async () => {
  const c = await checkoutRepo();
  const base = String((await c.op('init'))['base']);
  const t1 = String((await c.op('task', { name: 't1', revision: base }))['path']);
  fs.writeFileSync(path.join(t1, 'src/a.ts'), 'a2\n'); fs.rmSync(path.join(t1, 'src/gone.ts'));
  const candidate = await c.op('commit', { name: 't1', base });
  const revision = (await c.op('integrate', { task: 'T1', candidate: candidate['revision'], expected: base }))['revision'];
  c.write('src/a.ts', 'caller drift\n');
  assert.deepEqual(await c.op('deliver', { base, revision }), { conflicts: ['src/a.ts'], transferred: [], already: [] });
  assert.equal(c.read(c.repo, 'src/a.ts'), 'caller drift\n'); assert.equal(fs.existsSync(path.join(c.repo, 'src/gone.ts')), true);
  c.write('src/a.ts', 'a1\n');
  assert.deepEqual(await c.op('deliver', { base, revision }), { conflicts: [], transferred: ['src/a.ts', 'src/gone.ts'], already: [] });
  assert.equal(c.read(c.repo, 'src/a.ts'), 'a2\n');
  assert.deepEqual(await c.op('deliver', { base, revision }), { conflicts: [], transferred: [], already: ['src/a.ts', 'src/gone.ts'] });
});

test('checkout: RED replay rejects a submitted test that differs from its checkpoint', async () => {
  const c = await checkoutRepo();
  const base = String((await c.op('init'))['base']), out = path.join(c.runDir, 'red.json');
  const t1 = String((await c.op('task', { name: 't1', revision: base }))['path']);
  fs.mkdirSync(path.join(t1, 'tests')); fs.writeFileSync(path.join(t1, 'tests/a.test.ts'), 'passing stub');
  const candidate = (await c.op('commit', { name: 't1', base }))['revision'];
  fs.writeFileSync(out, JSON.stringify({ schemaVersion: 1, files: { 'tests/a.test.ts': Buffer.from('failing assertion').toString('base64') } }));
  const replay = await c.op('red', { name: 't1-red', base, candidate, checkpointPath: out, permitted: ['tests/a.test.ts'] });
  assert.match(String(replay['defects']), /Submitted test differs from its RED checkpoint: tests\/a\.test\.ts/);
});

test('checkout: integration discards an interrupted uncommitted cherry-pick before replaying the candidate', async () => {
  const c = await checkoutRepo();
  const base = String((await c.op('init'))['base']);
  const t1 = String((await c.op('task', { name: 't1', revision: base }))['path']);
  fs.writeFileSync(path.join(t1, 'src/a.ts'), 't1\n');
  const candidate = String((await c.op('commit', { name: 't1', base }))['revision']);
  const integration = path.join(c.runDir, 'wt/integration');
  execFileSync('git', ['cherry-pick', '--no-commit', candidate], { cwd: integration, windowsHide: true });
  const merged = await c.op('integrate', { task: 'T1', candidate, expected: base });
  assert.equal(merged['conflict'], false); assert.equal(c.read(integration, 'src/a.ts'), 't1\n');
});

test('checkout: delivery refuses a caller ancestor directory replaced by an external link', async () => {
  const c = await checkoutRepo();
  const base = String((await c.op('init'))['base']);
  const t1 = String((await c.op('task', { name: 't1', revision: base }))['path']);
  fs.writeFileSync(path.join(t1, 'src/a.ts'), 'a2\n');
  const candidate = await c.op('commit', { name: 't1', base });
  const revision = (await c.op('integrate', { task: 'T1', candidate: candidate['revision'], expected: base }))['revision'];
  const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dispatch-outside-'));
  fs.cpSync(path.join(c.repo, 'src'), outside, { recursive: true }); fs.rmSync(path.join(c.repo, 'src'), { recursive: true }); fs.symlinkSync(outside, path.join(c.repo, 'src'), 'junction');
  assert.deepEqual((await c.op('deliver', { base, revision }))['conflicts'], ['src/a.ts']);
  assert.equal(fs.readFileSync(path.join(outside, 'a.ts'), 'utf8'), 'a1\n');
});

test('checkout: baseline and delivery preserve executable modes', { skip: process.platform === 'win32' && 'POSIX file modes' }, async () => {
  const c = await checkoutRepo();
  c.write('bin/run.sh', 'echo\n'); fs.chmodSync(path.join(c.repo, 'bin/run.sh'), 0o755);
  const base = String((await c.op('init'))['base']);
  assert.equal(fs.statSync(path.join(c.runDir, 'wt/integration/bin/run.sh')).mode & 0o111, 0o111);
  const t1 = String((await c.op('task', { name: 't1', revision: base }))['path']);
  fs.chmodSync(path.join(t1, 'src/a.ts'), 0o755);
  const candidate = await c.op('commit', { name: 't1', base });
  const revision = (await c.op('integrate', { task: 'T1', candidate: candidate['revision'], expected: base }))['revision'];
  assert.deepEqual((await c.op('deliver', { base, revision }))['transferred'], ['src/a.ts']);
  assert.equal(fs.statSync(path.join(c.repo, 'src/a.ts')).mode & 0o111, 0o111);
});

test('prewrite-level: accepted deviation reapplies parked in-scope draft to changed prerequisite base', async () => {
  const c = await checkoutRepo();
    c.write('.env', 'local=1\n');
    c.write('node_modules/dep/index.js', 'dependency');
    const base = String((await c.op('init'))['base']);
    const original = String((await c.op('task', { name: 'task-t1', revision: base, links: ['node_modules'], ignored: ['.env'] }))['path']);
    fs.writeFileSync(path.join(original, 'src/a.ts'), 'writer draft\n');
    fs.writeFileSync(path.join(original, 'src/new.ts'), 'untracked writer draft\n');

    const prerequisite = String((await c.op('task', { name: 'task-t2', revision: base }))['path']);
    fs.writeFileSync(path.join(prerequisite, 'src/b.ts'), 'accepted prerequisite\n');
    const prerequisiteCandidate = await c.op('commit', { name: 'task-t2', base });
    const integration = await c.op('integrate', { task: 'T2', candidate: prerequisiteCandidate['revision'], expected: base });
    const revision = String(integration['revision']);
    const name = 'task-t1-scope-2';
    const target = path.join(c.runDir, 'wt', name);
    const input = {
      name, originalName: 'task-t1', revision, permitted: ['src/a.ts', 'src/new.ts'],
      transferKey: 'scope-rebase:T1:accepted-prerequisite:signature', links: ['node_modules'], ignored: ['.env'],
    };
    const writeAtomic = c.ports.fs.writeBase64Atomic;
    let interrupted = false;
    c.ports.fs.writeBase64Atomic = (file, contents) => {
      if (!interrupted && path.resolve(file) === path.resolve(target, 'src/new.ts')) {
        interrupted = true;
        throw new Error('simulated process interruption during untracked draft transfer');
      }
      writeAtomic(file, contents);
    };
    const first = await c.invoke('scope-rebase', input);
    assert.equal(first.type, 'EFFECT_FAILED', JSON.stringify(first));
    assert.equal(c.read(target, 'src/a.ts'), 'writer draft\n');
    assert.equal(fs.existsSync(path.join(target, 'src/new.ts')), false);

    c.ports.fs.writeBase64Atomic = writeAtomic;
    const replay = await c.invoke('scope-rebase', input);
    assert.equal(replay.type, 'CHECKOUT_DONE', JSON.stringify(replay));
    if (replay.type !== 'CHECKOUT_DONE') return;
    assert.equal(replay.result['conflict'], false);
    assert.deepEqual(replay.result['transferred'], ['src/a.ts', 'src/new.ts']);
    assert.equal(c.read(original, 'src/a.ts'), 'writer draft\n');
    assert.equal(c.read(original, 'src/b.ts'), 'b1\n');
    assert.equal(c.read(target, 'src/a.ts'), 'writer draft\n');
    assert.equal(c.read(target, 'src/b.ts'), 'accepted prerequisite\n');
    assert.equal(c.read(target, 'src/new.ts'), 'untracked writer draft\n');
    assert.equal(c.read(target, '.env'), 'local=1\n');
    assert.equal(c.read(target, 'node_modules/dep/index.js'), 'dependency');

    const admitted = await c.op('commit', { name, base: revision, message: 'scope replacement' });
    assert.deepEqual(admitted['paths'], ['src/a.ts', 'src/new.ts']);
});

// SECTION: Task graph through the public CLI

type TaskSlot = { task: string; action: string; attempt: number; signature: string; handle: string | null; worktree: string; envelopePath: string; checkpointPath: string };
type CliFrame = Awaited<ReturnType<ReturnType<typeof fixture>['cli']>>;
const taskSlots = (frame: CliFrame) => (frame.data['tasks'] ?? []) as TaskSlot[];

async function taskGraph(cap: number, independent = false) {
  const f = fixture();
  try {
    // NOTE: an empty NODE_TEST_CONTEXT still suppresses nested node:test; clear it before Node starts.
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    fs.writeFileSync(path.join(f.dir, 'bin', process.platform === 'win32' ? 'node.cmd' : 'node'),
      process.platform === 'win32'
        ? `@echo off\r\nset NODE_TEST_CONTEXT=\r\n"${process.execPath}" %*\r\n`
        : `#!/bin/sh\nunset NODE_TEST_CONTEXT\nexec ${quote(process.execPath)} "$@"\n`,
      { mode: 0o700 });
    f.git('config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(f.skill, 'config.local.jsonc'), JSON.stringify({
      ...f.config, 'write-concurrency': cap,
      phases: { 'plan-review': { rounds: { low: 0 }, targets: { low: 0 } }, 'code-review': { rounds: { low: 1 }, targets: { low: 1 } } },
    }));
    fs.writeFileSync(path.join(f.repo, 'src/b.ts'), 'export const value = 1;\n');
    fs.writeFileSync(path.join(f.repo, 'src/c.ts'), 'export const value = 1;\n');
    f.git('add', 'src'); f.git('commit', '-qm', 'consumer inputs');
    const names = ['normalizes shared value', 'consumer b observes contract', 'consumer c observes contract'];
    const files = ['a', 'b', 'c'];
    const nodeTest = 'node --test --test-reporter=tap';
    const criteria = files.map((file, index) => `- [SC${index + 1}] ${names[index]}
  - Changes: src/${file}.ts, tests/${file}.test.js
  - Verify: \`${nodeTest} tests/${file}.test.js\`
  - Evidence: ${index === 0 ? 'red' : 'verify'}
  - Pre-existing: no
  - Test rationale: Assert the exported value and prerequisite interface with executable Node tests.`).join('\n');
    const tasks = files.map((file, index) => `### T${index + 1} — ${names[index]}
Deliver the ${file} interface and check its result${index && !(independent && index === 1) ? '; the shared contract must be accepted first' : ''}.
- Prerequisites: ${index && !(independent && index === 1) ? 'T1' : 'none'}
- Criteria: SC${index + 1}
#### [MODIFY] src/${file}.ts
- Export value two.
#### [NEW] tests/${file}.test.js
- Check the exported value${index && !(independent && index === 1) ? ' and the shared contract' : ''}.`).join('\n');
    const plan = path.join(f.repo, 'graph.plan.md');
    fs.writeFileSync(plan, `# Deliver task graph

> **TL;DR:** Deliver a checked contract and independent consumers.
> **Parent:** user request
> **Decide:** none
> **Risk:** low — isolated fixture interfaces
> **Scope:** src and tests
## Key Decisions & Context
- Consumers use the accepted contract; each task owns separate source and test files.
## Success Criteria
${criteria}
- [SC4] Accumulated interfaces agree
  - Changes: src/a.ts, src/b.ts, src/c.ts
  - Verify: \`${nodeTest} tests/*.test.js\` [FINAL]
  - Evidence: verify
  - Integration: The final command checks every accumulated interface.
  - Test rationale: Executable assertions establish behavior in the delivered tree.
## Proposed Changes
${tasks}
## Verification Plan
### Automated Tests
- None: Criterion commands cover the executable fixture interfaces.
### Manual Verification
- Observe isolated task frames and final evidence.
## Review Findings & Resolutions
No reviews conducted yet.
`);
    f.git('add', 'graph.plan.md'); f.git('commit', '-qm', 'governed graph');
    // Caller inputs include staged, unstaged, untracked, and ignored contents.
    fs.writeFileSync(path.join(f.repo, 'src/a.ts'), 'export const value = 1; // caller input\n');
    fs.writeFileSync(path.join(f.repo, 'notes.txt'), 'staged caller note\n'); f.git('add', 'notes.txt');
    fs.writeFileSync(path.join(f.repo, 'local.txt'), 'untracked caller input\n');
    fs.writeFileSync(path.join(f.repo, '.gitignore'), '.scratch/\nlocal.config\n');
    fs.writeFileSync(path.join(f.repo, 'local.config'), 'local setting\n');
    const session = await f.initialize();
    let frame = await f.begin('implement', session, plan), run = f.absoluteRun(frame.run);
    if (frame.await === 'decide' && frame.data['kind'] === 'baseline') {
      const ids = [...new Set((frame.data['items'] as { failureId: string }[]).map((row) => row.failureId))];
      frame = await f.reply(run, { type: 'DECISION', kind: 'baseline', answer: { action: 'accept-known-red', ids } });
    }
    assert.equal(frame.data['kind'], 'approval', JSON.stringify(frame));
    frame = await f.reply(run, { type: 'DECISION', kind: 'approval', answer: { by: 'user', quote: 'Proceed with fixture graph' } });
    assert.equal(frame.data['kind'], 'level-classification', JSON.stringify(frame));
    frame = await f.reply(run, { type: 'DECISION', kind: 'level-classification', answer: { evaluatedLevel: 'low', rationale: 'The fixture tasks are bounded and recoverable.', gateScope: frame.data['gateScope'] } });
    assert.equal(frame.await, 'write', JSON.stringify(frame));
    return { f, session, run, frame, independent };
  } catch (error) { f.cleanup(); throw error; }
}

type TaskGraph = Awaited<ReturnType<typeof taskGraph>>;
async function launchTasks(g: TaskGraph, frame: CliFrame) {
  return g.f.reply(g.run, { type: 'WRITE_LAUNCHED', tasks: taskSlots(frame).filter((slot) => slot.action === 'launch').map((slot) => ({ task: slot.task, attempt: slot.attempt, signature: slot.signature, handle: `writer-${slot.task}`, model: (slot as unknown as { model: string }).model, ...(typeof frame.data['effort'] === 'string' ? { effort: frame.data['effort'] as string } : {}) })) });
}
async function finishTask(g: TaskGraph, frame: CliFrame, id: string, red: 'valid' | 'missing' | 'setup' = 'valid') {
  const slot = taskSlots(frame).find((item) => item.task === id)!;
  assert.ok(slot, JSON.stringify(frame));
  const file = { T1: 'a', T2: 'b', T3: 'c' }[id]!;
  const name = { T1: 'normalizes shared value', T2: 'consumer b observes contract', T3: 'consumer c observes contract' }[id]!;
  const dependent = id !== 'T1' && !(g.independent && id === 'T2');
  fs.mkdirSync(path.join(slot.worktree, 'tests'), { recursive: true });
  const testSource = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { value } from '../src/${file}.ts';
${dependent ? "import { value as shared } from '../src/a.ts';" : ''}
test('${name}', () => { assert.equal(value, 2);${dependent ? ' assert.equal(shared, 2);' : ''} });
`;
  fs.writeFileSync(path.join(slot.worktree, `tests/${file}.test.js`), red === 'setup' && id === 'T1' ? `import '../missing.ts';\n${testSource}` : testSource);
  if (id === 'T1' && red !== 'missing') await g.f.cli(['checkpoint', '--root', slot.worktree, '--out', slot.checkpointPath, '--', 'tests/a.test.js']);
  fs.writeFileSync(path.join(slot.worktree, `src/${file}.ts`), 'export const value = 2;\n');
  fs.writeFileSync(slot.envelopePath, JSON.stringify({
    schemaVersion: 1, stage: 'COMPLETE', status: 'DONE', summary: `Delivered ${id}`,
    evidence: [`CRITERION SC${file.charCodeAt(0) - 96} | src/${file}.ts | exports the checked value`,
      ...(id === 'T1' ? [`RED-MATRIX SC1 | tests/a.test.js:${name} | exit 1 test:${name}`] : [])],
    files: [{ path: `src/${file}.ts`, note: 'Exports value two.' }, { path: `tests/${file}.test.js`, note: 'Checks the interface.' }],
  }));
  return g.f.reply(g.run, { type: 'WRITE_ENVELOPE', task: id, attempt: slot.attempt, signature: slot.signature, handle: slot.handle!, envelopePath: slot.envelopePath });
}

test('prewrite-level: live CLI taskGraph resolves classification before writer launch', async () => {
  const g = await taskGraph(2), f = g.f;
  try {
    assert.deepEqual(taskSlots(g.frame).map((slot) => slot.task), ['T1']);
    const first = taskSlots(g.frame)[0]!;
    assert.match(fs.readFileSync(path.join(first.worktree, 'src/a.ts'), 'utf8'), /caller input/);
    assert.equal(fs.readFileSync(path.join(first.worktree, 'local.config'), 'utf8'), 'local setting\n');
    let frame = await finishTask(g, await launchTasks(g, g.frame), 'T1');
    assert.deepEqual(taskSlots(frame).map((slot) => slot.task), ['T2', 'T3'], JSON.stringify(frame));
    for (const slot of taskSlots(frame)) assert.equal(fs.readFileSync(path.join(slot.worktree, 'src/a.ts'), 'utf8'), 'export const value = 2;\n');
    assert.notEqual(taskSlots(frame)[0]!.worktree, taskSlots(frame)[1]!.worktree);
    assert.match(fs.readFileSync(path.join(f.repo, 'src/a.ts'), 'utf8'), /caller input/);
    frame = await launchTasks(g, frame);
    const journal = path.join(g.run, 'events.jsonl'), before = fs.readFileSync(journal, 'utf8');
    await f.cli(['status', '--run', g.run]);
    const dry = await f.cli(['send', '--run', g.run, '--dry-run']);
    assert.deepEqual(taskSlots(dry).map((slot) => slot.handle), ['writer-T2', 'writer-T3']);
    assert.equal(fs.readFileSync(journal, 'utf8'), before);
    frame = await f.cli(['send', '--run', g.run]);
    assert.deepEqual(taskSlots(frame).map((slot) => [slot.task, slot.action, slot.handle]), [['T2', 'running', 'writer-T2'], ['T3', 'running', 'writer-T3']]);
    frame = await finishTask(g, frame, 'T3');
    assert.deepEqual(taskSlots(frame).map((slot) => slot.task), ['T2']);
    frame = await finishTask(g, frame, 'T2');
    assert.equal(frame.await, 'evidence', JSON.stringify(frame));
    assert.equal(f.git('diff', '--cached', '--name-only').trim(), 'notes.txt');
    for (const file of ['a', 'b', 'c']) assert.equal(fs.readFileSync(path.join(f.repo, `src/${file}.ts`), 'utf8'), 'export const value = 2;\n');
    assert.equal(fs.readFileSync(path.join(f.repo, 'local.txt'), 'utf8'), 'untracked caller input\n');
    assert.equal(fs.readFileSync(path.join(f.repo, 'local.config'), 'utf8'), 'local setting\n');
    const events = fs.readFileSync(journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { type: string; data: { op?: string; result?: { revision?: string } } });
    const integrated = events.filter((event) => event.type === 'CHECKOUT_DONE' && event.data.op === 'integrate');
    assert.equal(integrated.length, 3); assert.equal(new Set(integrated.map((event) => event.data.result?.revision)).size, 3);
    frame = await f.reply(g.run, { type: 'EVIDENCE', criteria: Object.fromEntries(['SC1', 'SC2', 'SC3', 'SC4'].map((id) => [id, { outcome: 'pass', evidence: 'Executable interface assertions passed after final delivery.' }])) });
    assert.equal(frame.data['outcome'], 'complete');
    assert.ok(f.launches().length > 0, 'final code review used the provider shim');
  } finally { f.cleanup(); }
});

test('task graph: cap one uses isolated acceptance for every task', async () => {
  const g = await taskGraph(1);
  try {
    let frame = g.frame;
    for (const id of ['T1', 'T2', 'T3']) {
      assert.deepEqual(taskSlots(frame).map((slot) => slot.task), [id], JSON.stringify(frame));
      assert.notEqual(taskSlots(frame)[0]!.worktree, g.f.repo);
      frame = await finishTask(g, await launchTasks(g, frame), id);
    }
    assert.equal(frame.await, 'evidence', JSON.stringify(frame));
  } finally { g.f.cleanup(); }
});

test('task graph: failed branch leaves an independent writer running and blocks descendants', async () => {
  const g = await taskGraph(2, true);
  try {
    assert.deepEqual(taskSlots(g.frame).map((slot) => slot.task), ['T1', 'T2']);
    let frame = await launchTasks(g, g.frame);
    const failedSlot = taskSlots(frame).find((slot) => slot.task === 'T1')!;
    frame = await g.f.reply(g.run, { type: 'WRITE_FAILED', task: 'T1', attempt: failedSlot.attempt, signature: failedSlot.signature, handle: failedSlot.handle!, model: 'native-stub', kind: 'integrity', reason: 'fixture scope violation' });
    assert.deepEqual(taskSlots(frame).map((slot) => [slot.task, slot.handle]), [['T2', 'writer-T2']]);
    frame = await finishTask(g, frame, 'T2');
    assert.equal(frame.await, 'decide'); assert.equal(frame.data['kind'], 'failure');
    const tasks = (frame.data['items'] as { tasks: { task: string; status: string }[] }[])[0]!.tasks;
    assert.deepEqual(tasks.map((row) => [row.task, row.status]), [['T1', 'failed'], ['T3', 'blocked']]);
    assert.equal(fs.readFileSync(path.join(g.f.repo, 'src/b.ts'), 'utf8'), 'export const value = 1;\n');
  } finally { g.f.cleanup(); }
});

for (const red of ['missing', 'setup'] as const) {
  test(`task graph: ${red === 'missing' ? 'missing RED checkpoint' : 'setup-only RED'} prevents acceptance`, async () => {
    const g = await taskGraph(2);
    try {
      const frame = await finishTask(g, await launchTasks(g, g.frame), 'T1', red);
      assert.equal(frame.await, 'decide'); assert.equal(frame.data['kind'], 'failure', JSON.stringify(frame));
      assert.match(JSON.stringify(frame.data), red === 'missing' ? /checkpoint|ENOENT/i : /RED replay rejected|load\/setup error/i);
      assert.equal(fs.readFileSync(path.join(g.f.repo, 'src/b.ts'), 'utf8'), 'export const value = 1;\n');
      assert.ok(fs.existsSync(taskSlots(g.frame)[0]!.worktree), 'failed artifact remains available');
    } finally { g.f.cleanup(); }
  });
}

test('checkout: older independent baseline integrates only the task delta', async () => {
  const c = await checkoutRepo(), base = String((await c.op('init'))['base']);
  const a = String((await c.op('task', { name: 'a', revision: base }))['path']);
  const b = String((await c.op('task', { name: 'b', revision: base }))['path']);
  fs.writeFileSync(path.join(a, 'src/a.ts'), 'a2\n'); fs.writeFileSync(path.join(b, 'src/b.ts'), 'b2\n');
  const one = await c.op('commit', { name: 'a', base }), two = await c.op('commit', { name: 'b', base });
  const accepted = (await c.op('integrate', { task: 'T1', candidate: one['revision'], expected: base }))['revision'];
  const merged = await c.op('integrate', { task: 'T2', candidate: two['revision'], expected: accepted });
  assert.equal(merged['conflict'], false);
  const integration = path.join(c.runDir, 'wt/integration');
  assert.equal(c.read(integration, 'src/a.ts'), 'a2\n'); assert.equal(c.read(integration, 'src/b.ts'), 'b2\n');
  assert.equal(c.read(b, 'src/a.ts'), 'a1\n');
});

test('checkout: partial delivery replay preserves caller dirt and transfers remaining paths', async () => {
  const c = await checkoutRepo();
  c.write('src/b.ts', 'caller dirt\n');
  const base = String((await c.op('init'))['base']), t1 = String((await c.op('task', { name: 't1', revision: base }))['path']);
  fs.writeFileSync(path.join(t1, 'src/a.ts'), 'a2\n'); fs.rmSync(path.join(t1, 'src/gone.ts'));
  const candidate = (await c.op('commit', { name: 't1', base }))['revision'];
  const revision = (await c.op('integrate', { task: 'T1', candidate, expected: base }))['revision'];
  c.write('src/a.ts', 'a2\n');
  assert.deepEqual(await c.op('deliver', { base, revision }), { conflicts: [], transferred: ['src/gone.ts'], already: ['src/a.ts'] });
  assert.equal(c.read(c.repo, 'src/b.ts'), 'caller dirt\n'); assert.equal(fs.existsSync(path.join(c.repo, 'src/gone.ts')), false);
  assert.deepEqual(await c.op('deliver', { base, revision }), { conflicts: [], transferred: [], already: ['src/a.ts', 'src/gone.ts'] });
});
