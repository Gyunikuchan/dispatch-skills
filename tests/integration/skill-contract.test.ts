import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ALIASES } from '../../skills/dispatch/scripts/lib/cli.ts';
import { AWAIT_ACCEPTS } from '../../skills/dispatch/scripts/core/validate.ts';
import { OVERLAY_ROOT, scanOverlay } from './scan.ts';
const read = (file: string) => fs.readFileSync(path.join(OVERLAY_ROOT, file), 'utf8');
const contractName = 'SKILL.md';
const WORD_BUDGET = 657;
test('five contracts carry exact alias mappings and named dependency guards', () => {
  const contract = read(`skills/dispatch/${contractName}`);
  for (const awaitKind of ['author', 'native', 'rule', 'fix', 'write', 'evidence', 'decide', 'done']) assert.equal(contract.match(new RegExp(`^## Await ${awaitKind}$`, 'gm'))?.length, 1);
  assert.ok(contract.trim().split(/\s+/).length < WORD_BUDGET);
  assert.match(contract, /journal is authoritative/i); assert.match(contract, /level-source explicit\|classified/); assert.match(contract, /Preserve unrelated dirty and ignored files/);
  for (const [name, mapping] of Object.entries(ALIASES)) {
    const text = read(`skills/${name}/${contractName}`); assert.match(text, /disable-model-invocation: true/); assert.ok(text.includes(mapping)); assert.ok(text.includes(`Missing dependency: dispatch is required by ${name}`));
    assert.ok(fs.existsSync(path.join(OVERLAY_ROOT, `skills/${name}/README.md`)));
  }
  assert.ok(!Object.keys(ALIASES).some((name) => contract.includes(name)));
});
test('await documents exactly its accepted events', () => {
  const contract = read(`skills/dispatch/${contractName}`);
  for (const [awaitKind, accepts] of Object.entries(AWAIT_ACCEPTS)) {
    const section = contract.split(`## Await ${awaitKind}\n`)[1]?.split('\n## ')[0] ?? '';
    for (const event of accepts.filter((event) => event !== 'REVISE')) assert.ok(section.includes(`\`${event}\``), `${awaitKind} must document ${event}`);
    for (const event of section.matchAll(/`([A-Z_]+)`/g)) assert.ok(accepts.includes(event[1] as typeof accepts[number]), `${awaitKind} documents unaccepted ${event[1]}`);
  }
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
  const finalPaths = new Set(files.map((file) => file.path));
  for (const file of files) for (const match of file.text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1]!.split('#')[0]!; if (!target || /^(?:https?:|mailto:|<)/.test(target)) continue;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), target));
    assert.ok(finalPaths.has(resolved) || [...finalPaths].some((entry) => entry.startsWith(`${resolved}/`)) || fs.existsSync(path.join(OVERLAY_ROOT, resolved)), `${file.path}: broken link ${target}`);
  }
  assert.match(read('skills/dispatch/README.md'), /\^22\.18 \|\| >=23\.6/);
});


test('aliases forward explicit fix intent and host contract uses emitted envelopes', () => {
  for (const name of ['dispatch-code-review', 'dispatch-plan-review', 'dispatch-design-review']) assert.match(read(`skills/${name}/SKILL.md`), /--fix/);
  assert.match(read('skills/dispatch/SKILL.md'), /`events`/); assert.match(read('skills/dispatch/SKILL.md'), /outcome:"pass"/);
});


test('guidance uses delivered APIs and describes migration boundaries', () => {
  const root = read('README.md'); assert.doesNotMatch(root, /--phases|clean tree falls back/i); assert.match(root, /Ambient credential/); assert.match(root, /invoke `implement:`/);
  const config = read('skills/dispatch/references/readme/configuration.md'); for (const term of ['nativeSubagentsOnly', 'write-subagents', 'unsupported-journal-protocol', 'OPENCODE_CONFIG_DIR', 'sandbox:false']) assert.ok(config.includes(term), term);
  assert.doesNotMatch(read('skills/dispatch/references/templates/plan.md'), /Resolution log|entry format/);
  assert.doesNotMatch(read('skills/dispatch/references/templates/walkthrough.md'), /Resolution log/);
  assert.doesNotMatch(read('skills/dispatch/scripts/machines/plan.ts'), /is not available in plan/);
});

test('operational contracts reflect workspace session retention and contain no temp migration instructions', () => {
  const contract = read(`skills/dispatch/${contractName}`);
  assert.doesNotMatch(contract, /published folder|temp folder/i);
  assert.match(contract, /session reactivate/i);

  const config = read('skills/dispatch/references/readme/configuration.md');
  assert.match(config, /\.scratch\/dispatch-skills/);
  assert.doesNotMatch(config, /OS temp/i);

  const planTemplate = read('skills/dispatch/references/templates/plan.md');
  assert.match(planTemplate, /retaining the session in the workspace/);
  assert.doesNotMatch(planTemplate, /OS temp/i);
});

test('review-context-contract: documents --context and alias forwarder parity', () => {
  const verbRef = read('skills/dispatch/references/verbs/review.md');
  assert.match(verbRef, /\[--context <text>\]/);
  assert.match(verbRef, /Pass `--context` to supply semantic intent/);

  const reviewRef = read('skills/dispatch/references/review-rules.md');
  assert.match(reviewRef, /Review prompt context composes two channels/);
  assert.match(reviewRef, /git log --format="%s%n%b" <range>/);
  assert.match(reviewRef, /sessionDir/);

  const codeReviewSkill = read('skills/dispatch-code-review/SKILL.md');
  assert.match(codeReviewSkill, /distill active chat intent and intentional deviations into `--context "<intent>"`/);

  const agentCodeReviewSkill = read('.agents/skills/dispatch-code-review/SKILL.md');
  assert.equal(codeReviewSkill, agentCodeReviewSkill);
});

test('task execution guidance describes graph ownership, continuous writers and recovery boundaries', () => {
  const plan = read('skills/dispatch/references/verbs/plan.md');
  assert.match(plan, /task outcomes/); assert.match(plan, /prerequisite graph/); assert.match(plan, /producer\/consumer interfaces/);
  const implement = read('skills/dispatch/references/verbs/implement.md');
  assert.match(implement, /one continuous writer invocation/); assert.match(implement, /RED checkpoint before production/);
  assert.match(implement, /submission alone does not/); assert.match(implement, /Keep running handles and completed receipts/);
  assert.match(implement, /final code review\/fixes.*caller checkout/s);
  assert.doesNotMatch(implement, /Tests-only RED evidence precedes production/);
  const config = read('skills/dispatch/references/readme/configuration.md');
  assert.match(config, /write-concurrency/); assert.match(config, /positive safe integer/); assert.match(config, /omission defaults to one/);
  assert.match(config, /explicit reauthor\/restart/);
  const concepts = read('skills/dispatch/references/readme/concepts.md');
  for (const term of ['accepted prerequisites', 'Generated outputs', 'older baseline', 'setup-only', 'retained handles', 'already-delivered']) assert.ok(concepts.includes(term), term);
  assert.match(read('skills/dispatch/README.md'), /task summaries/);
  assert.match(read('skills/dispatch/references/readme/design.md'), /increments in order/);
});

