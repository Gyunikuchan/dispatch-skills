import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { CATEGORIES, DIAGNOSTIC_LIMITS } from '../../skills/dispatch/scripts/domain/diagnostics.ts';
import { OVERLAY_ROOT, scanOverlay } from './scan.ts';

const read = (file: string) => fs.readFileSync(path.join(OVERLAY_ROOT, file), 'utf8');
const section = (text: string, heading: string) => text.split(`${heading}\n`)[1]?.split('\n## ')[0] ?? '';

test('SC8 retro instruction fits budget', () => {
  const instruction = read('skills/dispatch/references/diagnostics.md');
  // The interpreter drops an oversize instruction, so the budget is a hard limit; CRLF checkouts must fit too.
  assert.ok(Buffer.byteLength(instruction.replace(/\r?\n/g, '\r\n')) <= DIAGNOSTIC_LIMITS.instructionBytes);
  // Budget pressure must not cut the protocol the gate enforces.
  assert.match(instruction, /`RETRO`/);
  assert.ok(instruction.includes('{id,component,category,evidence,impact,proposedFix}'));
  for (const key of Object.keys(CATEGORIES)) assert.ok(instruction.includes(`\`${key}\``), key);
  assert.match(instruction, new RegExp(`at most ${DIAGNOSTIC_LIMITS.fieldBytes} bytes`));
  assert.match(instruction, /Exclude repository, toolchain, and user-work issues/);
  assert.match(instruction, /Fixes must hold on any repository and machine/);
});

test('SC8 skill contract documents retro and done mention', () => {
  const contract = read('skills/dispatch/SKILL.md');
  assert.equal(contract.match(/^## Await retro$/gm)?.length, 1);
  assert.equal(section(contract, '## Await retro').trim(), 'Follow `data.diagnostics.instruction`; reply `RETRO`.');
  assert.match(section(contract, '## Await done'), /If `data\.diagnostics` exists, add one line with its `path` and the report's first top finding\./);
  assert.match(contract, /optional `diagnostics\.md`/);
  // Off means off: diagnostics prose stays in the retro await, the done mention, and the session-root list.
  const mentions = contract.split('\n## ').filter((part) => /diagnostics/.test(part)).map((part) => part.split('\n')[0]);
  assert.deepEqual(mentions, ['Await retro', 'Await done', 'Write boundaries and recovery']);
  assert.ok(contract.trim().split(/\s+/).length < 657);
});

test('SC8 no legacy diagnostics text remains', () => {
  // `pending-` alone also matches review states such as `pending-rejection`, so only numbered slot files count.
  const legacy = [/replyTransport/, /\{\s*v\s*:\s*1\s*,\s*event/, /\{v,event,diagnostics\}/, /capture\.json/, /pending-(?:\d+|N)\.json/, /capture\.lock/, /diagnostics\.render\.lock/];
  const hits = scanOverlay()
    .filter((file) => file.path.startsWith('skills/dispatch/'))
    .flatMap((file) => legacy.filter((pattern) => pattern.test(file.text)).map((pattern) => `${file.path}: ${pattern.source}`));
  assert.deepEqual(hits, []);
});
