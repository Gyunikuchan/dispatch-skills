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

test('walkthrough-reference: template links to findings rules without a removed anchor', () => {
  const file = 'skills/dispatch/references/templates/walkthrough.md';
  const reference = /\[[^\]]+\]\(([^)]+)\)/.exec(read(file));
  assert.equal(reference?.[1], '../review-rules.md');
  const target = path.resolve(OVERLAY_ROOT, path.dirname(file), reference![1]!);
  assert.ok(fs.existsSync(target));
});
test('four contracts carry exact alias mappings and named dependency guards', () => {
  const contract = read(`skills/dispatch/${contractName}`);
  for (const awaitKind of ['author', 'native', 'rule', 'fix', 'write', 'evidence', 'decide', 'retro', 'done']) assert.equal(contract.match(new RegExp(`^## Await ${awaitKind}$`, 'gm'))?.length, 1);
  assert.match(contract, /journal is authoritative/i); assert.match(contract, /level-source explicit\|classified/); assert.match(contract, /unrelated dirty or ignored files stay intact/i);
  for (const [name, mapping] of Object.entries(ALIASES)) {
    const text = read(`skills/${name}/${contractName}`); assert.doesNotMatch(text, /disable-model-invocation/); assert.ok(text.includes(mapping)); assert.ok(text.includes(`Missing dependency: dispatch is required by ${name}`));
    assert.ok(fs.existsSync(path.join(OVERLAY_ROOT, `skills/${name}/README.md`)));
  }
  assert.doesNotMatch(contract, /disable-model-invocation/);
  assert.ok(!Object.keys(ALIASES).some((name) => contract.includes(name)));
});

test('level-rubric: SKILL.md remains below its unchanged 657-word budget', () => {
  const contract = read(`skills/dispatch/${contractName}`);
  assert.equal(WORD_BUDGET, 657);
  assert.ok(contract.trim().split(/\s+/).length < WORD_BUDGET);
});

test('level-rubric: documents invocation and pre-write assessment timing', () => {
  const contract = read(`skills/dispatch/${contractName}`);
  const config = read('skills/dispatch/references/readme/configuration.md');
  const implement = read('skills/dispatch/references/verbs/implement.md');
  assert.match(contract, /Classify omitted levels at invocation; implementation receives one more assessment before its first write/);
  assert.match(config, /after its plan, baseline, and applicable write authorization are concrete, immediately before the first production write/);
  assert.match(implement, /ordinary tasks, inline baseline hotfixes, and the first child of a design/);
});

test('level-rubric: preserves explicit levels and asks before adopting a higher assessment', () => {
  const config = read('skills/dispatch/references/readme/configuration.md');
  assert.match(config, /An explicit level stays in force unless the assessment recommends a higher level; Dispatch then asks whether to adopt or retain it/);
  assert.match(config, /`xhigh` and `max` remain user-selected/);
});

test('level-rubric: medium remains the default for bounded recoverable work', () => {
  const config = read('skills/dispatch/references/readme/configuration.md');
  assert.match(config, /`medium` is the normal level for bounded behavior/);
  assert.match(config, /failures remain observable and recoverable/);
});

test('level-rubric: high requires concrete consequential risk', () => {
  const config = read('skills/dispatch/references/readme/configuration.md');
  assert.match(config, /`high` requires a credible consequential risk/);
  assert.match(config, /financial or data-integrity errors/);
  assert.match(config, /a small rate-precision change can/);
});

test('level-rubric: file count and finance-domain labels alone do not force high', () => {
  const config = read('skills/dispatch/references/readme/configuration.md');
  assert.match(config, /A large diff, changed external contract, finance repository, or state-machine file alone does not require high/);
  assert.match(config, /a broad reversible accessibility change may not/);
});

test('level-rubric: carries phase skips and post-gate scope decisions forward', () => {
  const config = read('skills/dispatch/references/readme/configuration.md');
  assert.match(config, /Plan-only, ask, review-only, and design-authoring runs receive only the invocation assessment/);
  assert.match(config, /Retries, later phases, accepted scope changes, and later design increments keep the settled level/);
});

test('level-rubric: tells writers to request orchestrator adjudication before deviating', () => {
  const implement = read('skills/dispatch/references/verbs/implement.md');
  assert.match(implement, /pauses before editing outside it and submits the typed `SCOPE_REQUEST`/);
  assert.match(implement, /If it agrees, Dispatch records the approved delta, informs the user before writer resumption/);
  assert.match(implement, /only a disagreement requires user adjudication/);
});

test('level-rubric: documents scope requests outside Await write and task receipt identity', () => {
  const contract = read(`skills/dispatch/${contractName}`);
  const awaitWrite = contract.split('## Await write\n')[1]?.split('\n## ')[0] ?? '';
  assert.match(contract, /Before out-of-brief edits, writers request orchestrator adjudication/);
  assert.doesNotMatch(awaitWrite, /SCOPE_REQUEST/);
  assert.match(contract, /task-scoped slots.*task-scoped terminal receipts echo all three/);
  assert.match(contract, /Taskless hotfix receipts omit these identity fields/);
});
test('level-rubric: implement guide documents decision payloads, scope receipt placement, and writer draining', () => {
  const guide = read('skills/dispatch/references/verbs/implement.md');
  for (const kind of ['run-stop', 'level-classification', 'level-recommendation', 'scope-deviation', 'scope-deviation-user']) {
    assert.ok(guide.includes('DECISION kind=' + kind));
  }
  assert.match(guide, /submits `SCOPE_REQUEST` as the `status` in its `WRITE_ENVELOPE`/);
  assert.match(guide, /Taskless hotfix `WRITE_ENVELOPE` and `WRITE_FAILED` receipts omit those four fields/);
  assert.match(guide, /sibling `SCOPE_REQUEST` during this drain is nonterminal: keep that attempt active/);
  assert.match(guide, /Do not charge its retry budget or launch replacements while any live sibling remains/);
  assert.match(guide, /Show the writer's rationale and the orchestrator's rationale to the user only when they disagree/);
});
test('level-rubric: Await sections contain only their configured accepted events', () => {
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
  for (const name of ['dispatch-code-review']) assert.match(read(`skills/${name}/SKILL.md`), /--fix/);
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
  assert.match(implement, /one continuous writer invocation/); assert.match(implement, /\[task brief\]\(\.\.\/templates\/write-brief-task\.md\) owns the development sequence/);
  assert.match(read('skills/dispatch/references/templates/write-brief-task.md'), /record RED, implement to verified GREEN, inspect for refactoring/);
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


test('amendment: writers propose plan changes on BLOCKED and the orchestrator adjudicates them', () => {
  const brief = read('skills/dispatch/references/templates/write-brief-task.md');
  assert.match(brief, /is wrong or infeasible, stop and return `BLOCKED` with an `amendment`/);
  assert.doesNotMatch(read('skills/dispatch/references/templates/write-brief.md') + read('skills/dispatch/references/templates/write-brief-hotfix.md'), /amendment/);
  assert.match(brief, /Never edit the plan or work around it/);
  const implement = read('skills/dispatch/references/verbs/implement.md');
  assert.match(implement, /verify each failed task's `amendment` against plan intent, invariants, and code/);
});

test('run-loop: long-running work runs as background tasks', () => {
  assert.match(read(`skills/dispatch/${contractName}`), /`start`, subagents, and long checks as separate background tasks; act on completion notices/);
});
