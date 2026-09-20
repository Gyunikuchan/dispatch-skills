import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

describe('v0.4 durable ledger contracts', () => {
  it('routes canonical plan resume through the disclosed ledger contract', () => {
    const skill = read('skills/implement-dispatch/SKILL.md');
    assert.match(skill, /\/implement-dispatch <plan-path>/);
    assert.match(skill, /references\/ledger-contract\.md/);
    assert.match(skill, /explicit slug matching the canonical plan filename/);
  });

  it('defines append, reconciliation, flow confirmation, and handoff behavior', () => {
    const contract = read('skills/implement-dispatch/references/ledger-contract.md');
    for (const phrase of [
      'append `run-start`, then `approval`',
      'Before each task or cluster dispatch append `task-start`',
      'needs-reconciliation',
      'always obtains user confirmation before dispatch',
      'never relocated',
      '`Rulings made`',
      'Review-log rulings are authoritative',
    ]) assert.match(contract, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('keeps the ledger out of scratch relocation', () => {
    const skill = read('skills/implement-dispatch/SKILL.md');
    assert.match(skill, /Never relocate the ledger/);
    assert.match(skill, /canonical\s+resume command/);
    assert.match(skill, /`Rulings made` list/);
  });
});
