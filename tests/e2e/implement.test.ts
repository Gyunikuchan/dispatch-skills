import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from '../helpers/e2e.ts';
test('implementation happy path runs real CLI approval, writer receipt, verification, review and terminal handoff', async () => {
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
### Value helper
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
    assert.equal(frame.await, 'write', JSON.stringify(frame));
    const brief = fs.readFileSync(String(frame.data['briefPath'])); assert.equal(`sha256:${crypto.createHash('sha256').update(brief).digest('hex')}`, frame.data['briefSha256']);
    fs.writeFileSync(path.join(f.repo, 'src/a.ts'), 'export const value = 2;\n');
    const envelopePath = String(frame.data['envelopePath']);
    const previewEvent = fs.readdirSync(run).find((file) => file.endsWith('.self-check.event.json'))!;
    assert.match(brief.toString('utf8'), /send --run .*--event .*self-check.event.json.*--dry-run/);
    const beforePreview = fs.readFileSync(path.join(run, 'events.jsonl'), 'utf8');
    fs.writeFileSync(envelopePath, '{"schemaVersion":1,"status":"DONE","stage":"COMPLETE","summary":""}');
    const invalidReceipt = await f.cli(['send', '--run', run, '--event', `@${path.join(run, previewEvent)}`, '--dry-run']);
    assert.match(invalidReceipt.error ?? '', /summary|evidence/i); assert.equal(fs.readFileSync(path.join(run, 'events.jsonl'), 'utf8'), beforePreview);
    fs.writeFileSync(envelopePath, JSON.stringify({ schemaVersion: 1, status: 'DONE', stage: 'COMPLETE', summary: 'Values normalized', evidence: ['CRITERION SC1 | src/a.ts | normalizes value before use'], files: [{ path: 'src/a.ts', note: 'Normalizes values.' }] }));
    const validReceipt = await f.cli(['send', '--run', run, '--event', `@${path.join(run, previewEvent)}`, '--dry-run']); assert.equal(validReceipt.error, undefined);
    frame = await f.reply(run, { type: 'WRITE_ENVELOPE', envelopePath }); assert.equal(frame.await, 'evidence', JSON.stringify(frame));
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
### Value helper
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

