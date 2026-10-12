import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
const read = (file: string): string => fs.readFileSync(file, 'utf8');


test('SC10 collector imports no machines', () => {
  const source = read(path.join(import.meta.dirname, '../../skills/dispatch/scripts/core/diagnostics.ts'));
  const imports = [...source.matchAll(/^import [^;]* from '([^']+)';$/gm)].map((match) => match[1] ?? '');
  assert.ok(imports.length > 0);
  assert.deepEqual(imports.filter((specifier) => /machines\/|interpreter/.test(specifier)), []);
});
