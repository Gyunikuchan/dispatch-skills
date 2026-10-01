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
    const published = String(frame.data['handoff']); assert.ok(fs.existsSync(published)); assert.ok(!fs.existsSync(session));
    assert.ok(fs.readdirSync(published).some((file) => file.endsWith('.walkthrough.md')));
    const journal = fs.readFileSync(path.join(frame.run, 'events.jsonl'), 'utf8'); const launches = f.launches().length;
    const replay = await f.cli(['send', '--run', frame.run, '--dry-run']); assert.equal(replay.data['outcome'], 'complete');
    assert.equal(fs.readFileSync(path.join(frame.run, 'events.jsonl'), 'utf8'), journal); assert.equal(f.launches().length, launches);
    fs.rmSync(published, { recursive: true, force: true });
  } finally { f.cleanup(); }
});
