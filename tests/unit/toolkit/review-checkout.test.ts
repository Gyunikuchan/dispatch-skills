import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkoutReportsFor } from '../../../skills/dispatch/scripts/toolkit/findings.ts';

test('checkout report reads treat a missing generation as closed but surface other read faults', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-reports-')); try {
    assert.deepEqual(checkoutReportsFor(path.join(root, 'round-1'), 'gen-1'), []);
    fs.writeFileSync(path.join(root, 'blocker'), 'not a directory');
    assert.throws(() => checkoutReportsFor(root, 'blocker'), /ENOTDIR/);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
