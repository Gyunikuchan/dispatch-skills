import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { sessionFixture } from './helpers/session.ts';
import { listOf, numeric, optional, readJson, shape, text } from './helpers/json.ts';

const scoped = sessionFixture({ memory: true });
after(() => scoped.cleanup());

const CONTEXT_MAP = [
  '# Context map: file',
  '',
  '> **Commit:** abcdef0',
  '>',
  '> **Tool:** text',
  '',
  '## Map',
  '- File — `src/file.ts:1`',
  '',
  '## Flows',
  '- file: `src/file.ts:1`',
  '',
  '## Invariants',
  '- File exists — `src/file.ts:1` — "File"',
  '',
  '## Coverage',
  '- entry-points: `src/file.ts:1`',
  '',
  '## Precedent',
  '- File: `src/file.ts`',
  '',
  '## Surprises',
  '- none — `src/file.ts:1`',
  '',
  '## Not covered',
  '- Dynamic dispatch',
  '',
].join('\n');
async function lint(name: string, source: string) {
  const f = { ...scoped, cleanup: () => {} };
  f.lines.length = 0;
  try {
    const exit = await main(['lint', 'run', f.artifact(name, source), '--session', f.session], f.deps);
    const output = f.output();
    const result = readJson(
      output.path!,
      shape({ errors: listOf(shape({ code: text, message: text, line: optional(numeric) })) }),
    );
    return { exit, output, result };
  } finally {
    f.cleanup();
  }
}
describe('lint severity', () => {
  test('lint run rejects malformed Commit metadata and accepts valid or missing metadata', async () => {
    fs.mkdirSync(path.join(scoped.root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(scoped.root, 'src', 'file.ts'), 'File\n');
    const validSources = [
      CONTEXT_MAP.replace('> **Commit:** abcdef0', `> **Commit:** ${'a'.repeat(40)}`),
      CONTEXT_MAP.replace('> **Commit:** abcdef0\n', ''),
    ];
    for (const [index, source] of validSources.entries()) {
      const result = await lint(`valid-${index}.context.md`, source);
      assert.equal(result.exit, 0, result.output.summary);
      assert.deepEqual(result.result.errors, []);
    }

    const result = await lint(
      'invalid-commit.context.md',
      CONTEXT_MAP.replace('> **Commit:** abcdef0', '> **Commit:** abcdef'),
    );
    assert.equal(result.exit, 4, result.output.summary);
    assert.equal(result.output.reason, 'lint-errors');
    const issue = result.result.errors.find((issue) => issue.code === 'context-commit');
    assert.ok(issue, JSON.stringify(result.result.errors));
    assert.equal(issue.line, 3);
    assert.match(issue.message, /7 to 64/);
  });

  test('lint run rejects context references through links outside the repository root', async () => {
    const f = sessionFixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'context-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'secret.ts'), 'export const secret = true;\n');
      fs.symlinkSync(outside, path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
      const map = [
        '# Context map: linked path',
        '',
        '> **Commit:** abcdef0',
        '>',
        '> **Tool:** text',
        '',
        '## Map',
        '- Secret — `linked/secret.ts:1`',
        '',
        '## Flows',
        '- secret: `linked/secret.ts:1`',
        '',
        '## Invariants',
        '- Secret exists — `linked/secret.ts:1` — "export const secret = true;"',
        '',
        '## Coverage',
        '- entry-points: `linked/secret.ts:1`',
        '',
        '## Precedent',
        '- Secret: `linked/secret.ts`',
        '',
        '## Surprises',
        '- none — `linked/secret.ts:1`',
        '',
        '## Not covered',
        '- Dynamic dispatch',
        '',
      ].join('\n');
      const file = f.artifact('linked.context.md', map);
      const exit = await main(['lint', 'run', file, '--session', f.session], f.deps);
      const output = f.output();
      const result = readJson(
        output.path!,
        shape({ errors: listOf(shape({ code: text, message: text, line: optional(numeric) })) }),
      );
      assert.equal(exit, 4);
      assert.ok(result.errors.some((issue: { code: string }) => issue.code === 'context-ref-missing'));
    } finally {
      f.cleanup();
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
  test('invalid artifact fields persist actionable input failures', async () => {
    const f = { ...scoped, cleanup: () => {} };
    try {
      for (const artifact of [f.root + '/missing.plan.md', f.root, f.artifact('unknown.txt', 'text')]) {
        f.lines.length = 0;
        assert.equal(await main(['lint', 'run', artifact, '--session', f.session], f.deps), 1);
        assert.match(fs.readFileSync(f.output().path!, 'utf8'), /artifact/);
        assert.equal(f.output().reason, 'invalid-input');
      }
    } finally {
      f.cleanup();
    }
  });
});
