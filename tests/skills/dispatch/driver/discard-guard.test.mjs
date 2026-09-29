// Discard guard (SC6): only discard.mjs may discard repository-tree content; every other write site is a
// reviewed cleanup of driver-owned files (locks, temp/state files, governing artifacts).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const DRIVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../skills/dispatch/scripts/driver');
// Reviewed write/remove sites: walkthrough scaffold, artifact restore, temp/state files, lock files, wave pid files.
const ALLOWED = new Set(['baseline-phase.mjs', 'implement-phase.mjs', 'implement-state.mjs', 'index.mjs', 'review-artifact.mjs', 'state.mjs', 'verification.mjs', 'verify-run.mjs', 'wave-process.mjs']);
const WRITE = /\b(?:rmSync|writeFileSync|chmodSync|unlinkSync)\(/;

describe('discard guard', () => {
  const files = fs.readdirSync(DRIVER).filter(name => name.endsWith('.mjs') && name !== 'discard.mjs');
  const lines = files.flatMap(name => fs.readFileSync(path.join(DRIVER, name), 'utf8').split('\n').map((line, index) => ({ at: `${name}:${index + 1}`, name, line })));

  it('discard guard: no driver source outside discard.mjs restores or removes repository paths', () => {
    const offenders = lines.filter(({ line }) => (WRITE.test(line) && /repoRoot/.test(line)) || /['"](?:restore|checkout|clean)['"]/.test(line) || /git (?:restore|checkout|clean)\b/.test(line));
    assert.deepEqual(offenders.map(item => `${item.at}: ${item.line.trim()}`), []);
  });

  it('discard guard: file writes stay in reviewed cleanup sites', () => {
    const unexpected = lines.filter(({ name, line }) => WRITE.test(line) && !ALLOWED.has(name));
    assert.deepEqual(unexpected.map(item => `${item.at}: ${item.line.trim()}`), []);
  });

  it('discard guard: task-phase revert sites route through discard.mjs', () => {
    const source = fs.readFileSync(path.join(DRIVER, 'task-phase.mjs'), 'utf8');
    assert.match(source, /import \{ discardPaths, savePatch \} from '\.\/discard\.mjs';/);
    for (const key of ['write-scope', 'revert-attributable']) assert.match(source, new RegExp(`discardPaths\\(state, [^)]*key: '${key}'`));
  });
});
