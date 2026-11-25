import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { OVERLAY_ROOT } from './scan.ts';

const section = (text: string, heading: string) => text.split(`### ${heading}\n`)[1]?.split(/\n#{1,3} /)[0] ?? '';
const frame = () =>
  section(
    fs.readFileSync(path.join(OVERLAY_ROOT, 'skills/dispatch/references/decision-frame.md'), 'utf8'),
    'Plan or design approval',
  );

test('plan or design approval frame fits one screen with machine fields collapsed', () => {
  const source = frame();
  assert.notEqual(source, '', 'approval frame exists');
  const [instruction, skeleton] = source.split('```markdown\n');
  assert.match(instruction!, /omit offer for plans/i);
  assert.ok(skeleton, 'approval skeleton exists');
  const filled = skeleton
    .split('```')[0]!
    .replace('<path>', '.scratch/dispatch/session-20261117-abc123/.state/artifacts/design.md')
    .replace('<level>', 'medium')
    .replace(
      '<reason>',
      'because the prose edits are bounded\n  and the cross-file links need review\n  without runtime or data changes',
    )
    .replace('<risk and alternatives>', 'medium: the layout changes; defer T2 or split the frame edit')
    .replace('<bounded unit>', 'T2')
    .replace('<why>', 'it covers linked artifacts and approval')
    .replace('<strategy>', 'link governing artifacts and collapse machine detail')
    .replace('<scope>', 'the assigned walkthrough and approval-frame paths')
    .replace('<hash>', `sha256:${'a'.repeat(64)}`)
    .replace('<hash>', `sha256:${'b'.repeat(64)}`)
    .replace('<hash>', `sha256:${'c'.repeat(64)}`)
    .replace('<tasks/increments>', 'I01, I02, I03, I04, I05, I06, I07')
    .replace('<commands>', 'npm test; npm run typecheck')
    .replace('<tuple>', 'spec, plan and design hashes with the user quote');
  assert.doesNotMatch(
    filled.replaceAll(/<\/?(?:details|summary)[^>]*>/g, ''),
    /<[^>]+>/,
    'all placeholders are filled',
  );

  const plan = filled.replace('/design.md', '/plan.md').replace(/^Approve all increments\?\n/m, '');
  assert.ok(plan.slice(0, plan.indexOf('<details>')).split('\n').length <= 30);
  assert.match(plan, /artifacts\/plan\.md/);
  assert.doesNotMatch(plan.slice(0, plan.indexOf('<details>')), /approve all increments/i);
  const detailsAt = filled.indexOf('<details>');
  assert.notEqual(detailsAt, -1, 'machine fields use details');
  const visible = filled.slice(0, detailsAt);
  assert.match(visible, /^Approve all increments\?$/m);
  assert.ok(visible.split('\n').length <= 30, 'visible approval frame fits one screen');
  for (const value of [
    '.scratch/dispatch/session-20261117-abc123/.state/artifacts/design.md',
    'Approve .scratch/dispatch/session-20261117-abc123/.state/artifacts/design.md at medium?',
    'because the prose edits are bounded',
    'cross-file links need review',
    'without runtime or data changes',
    'Risk/options: medium: the layout changes; defer T2 or split the frame edit',
    'Recommend T2 (it covers linked artifacts and approval)',
    'Strategy: link governing artifacts and collapse machine detail',
    'Scope: the assigned walkthrough and approval-frame paths',
    'approve all increments?',
  ]) {
    assert.ok(visible.toLowerCase().includes(value.toLowerCase()), value);
  }
  const machine = filled.slice(detailsAt);
  for (const value of [
    `sha256:${'a'.repeat(64)}`,
    `sha256:${'b'.repeat(64)}`,
    `sha256:${'c'.repeat(64)}`,
    'I01, I02, I03, I04, I05, I06, I07',
    'npm test; npm run typecheck',
    'toolkit.md#approval',
  ]) {
    assert.ok(machine.indexOf(value) !== -1, value);
  }
});

test('plan or design approval section stays below its base bytes', () => {
  const source = frame();
  assert.match(source, /all increments/i);
  assert.match(source, /spec-stage\.md#run-level/);
  assert.match(source, /spec-stage\.md#approval/);
  assert.match(source, /toolkit\.md#approval/);
  // The 25980b03 baseline section is 517 UTF-8 bytes without a trailing newline.
  const sectionText = `### Plan or design approval\n${source}`.replace(/\n+$/, '');
  assert.ok(
    Buffer.byteLength(sectionText, 'utf8') < 517,
    `approval section is ${Buffer.byteLength(sectionText, 'utf8')} bytes; base is 517`,
  );
});
