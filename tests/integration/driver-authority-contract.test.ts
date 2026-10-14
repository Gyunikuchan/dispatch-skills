import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateHostEvent } from '../../skills/dispatch/scripts/core/validate.ts';
import { parseCommand } from '../../skills/dispatch/scripts/lib/cli.ts';
import { OVERLAY_ROOT } from './scan.ts';
const read = (file: string) => fs.readFileSync(path.join(OVERLAY_ROOT, file), 'utf8');
const jsonExamples = (file: string) => [...read(file).matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]!) as { type: string });

test('authority-contract: replacement and rebind examples validate and obsolete drift gates are absent', () => {
  const files = ['skills/dispatch/references/change-handling.md', 'skills/dispatch/references/verbs/implement.md', 'skills/dispatch/references/review-rules.md'];
  const awaits = { EVIDENCE: 'evidence', REPLACE_PLAN: 'write', REVIEW_USE: 'rule' } as const;
  const examples = files.flatMap(jsonExamples);
  assert.deepEqual(examples.map((row) => row.type).sort(), Object.keys(awaits).sort());
  for (const event of examples) {
    const kind = awaits[event.type as keyof typeof awaits];
    const result = validateHostEvent(kind, event);
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  const policy = { levels: ['low'], pins: () => null, provider: () => null };
  const guide = read('skills/dispatch/references/readme/troubleshooting.md');
  const command = /node scripts\/dispatch\.ts (rebind --run <dir> --reason "([^"]+)")/.exec(guide);
  assert.ok(command);
  assert.equal(parseCommand(['rebind', '--run', 'run', '--reason', command[2]!], policy).command, 'rebind');
  assert.equal(parseCommand(['rebind', '--run', 'run', '--reason', command[2]!, '--event', '@reply.json'], policy).flags['event'], '@reply.json');
  assert.equal(parseCommand(['send', '--run', 'run'], policy).command, 'send');
  assert.equal(parseCommand(['checkpoint', '--root', 'repo', '--out', 'red.json', '--', 'tests/value.test.ts'], policy).command, 'checkpoint', 'RED checkpoint remains distinct');
  const operational = files.map(read).join('\n');
  for (const obsolete of [/Irrelevant requires complete dependency/, /identity changes invalidate all/, /accepted task cannot gain an unaccepted/, /removed accepted task rewinds/, /preserve.*only for established irrelevant/, /original receipt is parked and resumes after resolution/]) assert.doesNotMatch(operational, obsolete);
  assert.match(read(files[0]!), /An observation adds no await/);
  assert.match(read(files[0]!), /Failed required checks remain unresolved/);
  assert.match(read(files[1]!), /Retirement archives work references and retains integrated bytes/);
  assert.match(read(files[2]!), /Only launched review waves consume rounds/);
});

test('authority-contract: recovery pointers preserve old runs and state exact proof limits', () => {
  const canonical = read('skills/dispatch/references/change-handling.md');
  assert.match(canonical, /full private machine state/); assert.match(canonical, /exact FIFO effect descriptors/);
  assert.match(canonical, /orphan checkpoint is ignored/); assert.match(canonical, /data\.recoveryReply/);
  assert.match(canonical, /validates input only; send that event afterward/);
  assert.match(canonical, /before sealing and no handler proof exists/);
  const guide = read('skills/dispatch/references/readme/troubleshooting.md');
  assert.match(guide, /finish and deliver live old-protocol runs/);
  assert.match(guide, /preserve their whole folders/); assert.match(guide, /no automatic migration/);
  for (const file of ['docs/decisions/0003-chat-session-artifact-lifecycle.md', 'docs/decisions/0004-fast-forward-recovery.md']) assert.match(read(file), /superseded by the \[current checkpoint\/continuation contract\]/);
  for (const alias of ['dispatch-plan', 'dispatch-implement', 'dispatch-code-review']) {
    const contract = read(`skills/${alias}/SKILL.md`);
    assert.match(contract, /\[dispatch\]\(\.\.\/dispatch\)/);
    assert.doesNotMatch(contract, /changeDispositions|EFFECT_RECOVERY|RUNTIME_REBOUND/, 'aliases route to the canonical contract');
  }
});
