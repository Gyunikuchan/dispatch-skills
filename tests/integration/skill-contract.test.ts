import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ALIASES } from '../../skills/dispatch/scripts/lib/cli.ts';
import { AWAIT_ACCEPTS } from '../../skills/dispatch/scripts/core/validate.ts';
import { OVERLAY_ROOT, scanOverlay } from './scan.ts';
const read = (file: string) => fs.readFileSync(path.join(OVERLAY_ROOT, file), 'utf8');
const contractName = fs.existsSync(path.join(OVERLAY_ROOT, 'skills/dispatch/SKILL.next.md')) ? 'SKILL.next.md' : 'SKILL.md';
const LEGACY_WORD_BUDGET = 657;
test('five contracts carry exact alias mappings and named dependency guards', () => {
  const contract = read(`skills/dispatch/${contractName}`);
  for (const awaitKind of ['author', 'native', 'rule', 'fix', 'write', 'evidence', 'decide', 'done']) assert.equal(contract.match(new RegExp(`^## Await ${awaitKind}$`, 'gm'))?.length, 1);
  assert.ok(contract.trim().split(/\s+/).length < LEGACY_WORD_BUDGET);
  for (const [awaitKind, accepts] of Object.entries(AWAIT_ACCEPTS)) {
    const section = contract.split(`## Await ${awaitKind}\n`)[1]?.split('\n## ')[0] ?? '';
    for (const event of accepts.filter((event) => event !== 'REVISE')) assert.ok(section.includes(`\`${event}\``), `${awaitKind} must document ${event}`);
    for (const event of section.matchAll(/`([A-Z_]+)`/g)) assert.ok(accepts.includes(event[1] as typeof accepts[number]), `${awaitKind} documents unaccepted ${event[1]}`);
  }
  assert.match(contract, /journal is authoritative/i); assert.match(contract, /level-source explicit\|classified/); assert.match(contract, /Preserve unrelated dirty and ignored files/);
  for (const [name, mapping] of Object.entries(ALIASES)) {
    const text = read(`skills/${name}/${contractName}`); assert.match(text, /disable-model-invocation: true/); assert.ok(text.includes(mapping)); assert.ok(text.includes(`Missing dependency: dispatch is required by ${name}`));
    assert.ok(fs.existsSync(path.join(OVERLAY_ROOT, `skills/${name}/README.md`)));
  }
  assert.ok(!Object.keys(ALIASES).some((name) => contract.includes(name)));
});
test('branch references and manuals resolve every local link and use portable relative paths', () => {
  const files = scanOverlay().filter((file) => file.path.startsWith('skills/') && file.path.endsWith('.md'));
  const errors: string[] = [];
  for (const file of files) {
    assert.ok(!/file:\/\/|[A-Z]:\\Users\\/.test(file.text), file.path);
    for (const match of file.text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1]!.split('#')[0]!;
      if (!target || /^(?:https?:|mailto:|<)/.test(target)) continue;
      const absolute = path.resolve(OVERLAY_ROOT, path.dirname(file.path), target);
      if (!fs.existsSync(absolute)) errors.push(`${file.path}: ${target}`);
    }
  }
  assert.deepEqual(errors, []);
  // Contract rename is a tracked move: links must resolve unchanged in the final tree too.
  const finalPaths = new Set(files.map((file) => file.path.replace(/\/SKILL\.next\.md$/, '/SKILL.md')));
  for (const file of files) for (const match of file.text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1]!.split('#')[0]!; if (!target || /^(?:https?:|mailto:|<)/.test(target)) continue;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), target));
    assert.ok(finalPaths.has(resolved) || [...finalPaths].some((entry) => entry.startsWith(`${resolved}/`)) || fs.existsSync(path.join(OVERLAY_ROOT, resolved)), `${file.path}: cutover breaks ${target}`);
    assert.ok(!target.endsWith('SKILL.next.md'), `${file.path}: cutover must preserve contract links`);
  }
  assert.match(read('skills/dispatch/README.md'), /\^22\.18 \|\| >=23\.6/);
});


test('rewrite SC5 aliases forward explicit fix intent and host contract uses emitted envelopes', () => {
  for (const name of ['dispatch-code-review', 'dispatch-plan-review', 'dispatch-design-review']) assert.match(read(`skills/${name}/SKILL.md`), /--fix/);
  assert.match(read('skills/dispatch/SKILL.md'), /`events`/); assert.match(read('skills/dispatch/SKILL.md'), /outcome:"pass"/);
});


test('rewrite SC6 guidance uses delivered APIs and describes migration boundaries', () => {
  const root = read('README.md'); assert.doesNotMatch(root, /--phases|clean tree falls back/i); assert.match(root, /Ambient credential/); assert.match(root, /invoke `implement:`/);
  const config = read('skills/dispatch/references/readme/configuration.md'); for (const term of ['nativeSubagentsOnly', 'write-subagents', 'unsupported-journal-protocol', 'OPENCODE_CONFIG_DIR', 'sandbox:false']) assert.ok(config.includes(term), term);
  assert.doesNotMatch(read('skills/dispatch/references/templates/plan.md'), /Resolution log/);
});
