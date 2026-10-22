import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ALIASES, parseCommand } from '../../skills/dispatch/scripts/lib/cli.ts';
import { AWAIT_ACCEPTS } from '../../skills/dispatch/scripts/core/validate.ts';
import { OVERLAY_ROOT } from './scan.ts';
const documents = new Map<string, string>();
const read = (file: string): string => {
  let text = documents.get(file);
  if (text === undefined) {
    text = fs.readFileSync(path.join(OVERLAY_ROOT, file), 'utf8');
    documents.set(file, text);
  }
  return text;
};
const contractName = 'SKILL.md';

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

test('level-rubric: documents invocation and pre-write assessment timing', () => {
  const contract = read(`skills/dispatch/${contractName}`);
  const config = read('skills/dispatch/references/readme/configuration.md');
  const implement = read('skills/dispatch/references/verbs/implement.md');
  assert.match(contract, /Classify omitted levels at invocation; implementation receives one more assessment before its first write/);
  assert.match(config, /after its plan and baseline are concrete, immediately before the first production write/);
  assert.match(implement, /ordinary tasks, inline baseline hotfixes, and the first child of a design/);
});

test('level-rubric: preserves explicit levels and reports a higher assessment', () => {
  const config = read('skills/dispatch/references/readme/configuration.md');
  assert.match(config, /An explicit level stays in force; Dispatch reports a higher assessment/);
  assert.match(config, /`xhigh` and `max` remain user-selected/);
  const gates = read('skills/dispatch/references/decision-frame.md');
  assert.match(gates, /`spec-approval`, design `approval`, and manual completion/);
  assert.match(gates, /Changed intent/);
  assert.match(gates, /External dependencies/);
  assert.match(gates, /Discarded work/);
  assert.match(gates, /### Design Approval \(`approval`\)/);
  assert.doesNotMatch(gates, /Design and Plan Approval|### Plan Approval|Approve writer launch/);
  assert.doesNotMatch(config, /asks whether to adopt or retain/);
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

test('contract documents receipt request amend events', () => {
  const contract = read(`skills/dispatch/${contractName}`);
  const awaitWrite = contract.split('## Await write\n')[1]?.split('\n## ')[0] ?? '';
  for (const name of ['WRITE_RECEIPT', 'REQUEST', 'AMEND', 'briefHash']) assert.ok(awaitWrite.includes(name), name);
  assert.match(awaitWrite, /Taskless hotfix receipts omit identity fields/);
  const guide = read('skills/dispatch/references/verbs/implement.md');
  for (const kind of ['run-stop', 'level-classification', 'integration-conflict', 'request', 'request-user']) {
    assert.ok(guide.includes('DECISION kind=' + kind + '`'), kind);
  }
  for (const status of ['launched', 'submitted', 'failed', 'cancelled']) assert.ok(guide.includes('`' + status + '`'), status);
  assert.match(guide, /reply `REQUEST` with `\{ task, attempt, need, paths, rationale \}`; the writer keeps running/);
  assert.match(guide, /`AMEND` `\{ delta, notify, rationale, by\? \}` changes the plan live/);
  assert.match(guide, /first send a user-gated `AMEND` that records the discarded work, then reply `discard`/);
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
  const markdownFiles = (dir: string): string[] => fs.readdirSync(path.join(OVERLAY_ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return ['node_modules', '.git', '.scratch', '.codegraph', '.agents', '.claude', '.codex', '.opencode'].includes(entry.name) ? [] : markdownFiles(file);
    return entry.name.endsWith('.md') ? [file] : [];
  });
  const files = markdownFiles('skills').sort().map((file) => ({ path: file, text: read(file) }));
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
  assert.match(read('skills/dispatch/README.md'), /\^22\.18 \|\| >=23\.6/);
});


test('review alias maps to code review and host contract uses emitted envelopes', () => {
  assert.match(read('skills/dispatch-code-review/SKILL.md'), /start review --kind code/);
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

test('governing spec identity is the documented review and alias intent channel', () => {
  const verbRef = read('skills/dispatch/references/verbs/review.md');
  assert.match(verbRef, /\[--spec <path>\]/);
  assert.doesNotMatch(verbRef, /--context/);

  const reviewRef = read('skills/dispatch/references/review-rules.md');
  assert.match(reviewRef, /settled governing spec path and hash/);
  assert.match(reviewRef, /sessionDir/);

  const codeReviewSkill = read('skills/dispatch-code-review/SKILL.md');
  assert.match(codeReviewSkill, /reuse the governing spec with `--spec "<path>"` or author it under dispatch/);
  const command = /map this invocation to `([^`]+)`/.exec(codeReviewSkill)![1]!;
  const parsed = parseCommand([...command.split(' '), '--session-dir', 'session', '--orchestrator', 'codex', '--spec', 'intent.spec.md', '--', 'HEAD'], { levels: ['low'], pins: () => null, provider: (value) => value });
  assert.equal(parsed.verb, 'review'); assert.equal(parsed.flags['spec'], 'intent.spec.md');

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
  assert.match(config, /older plans without file ownership.*rewrite the plan and start a new run/);
  const concepts = read('skills/dispatch/references/readme/concepts.md');
  for (const term of ['accepted prerequisites', 'Generated outputs', 'older baseline', 'setup-only', 'handles', 'already-delivered']) assert.ok(concepts.includes(term), term);
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
  assert.match(read(`skills/dispatch/${contractName}`), /`start`, subagents, and long checks as background tasks; act on completion notices/);
});

test('Await decide retains the decision fabrication guard', () => {
  const contract = fs.readFileSync(path.join(OVERLAY_ROOT, 'skills/dispatch/SKILL.md'), 'utf8');
  assert.match(contract.split('## Await decide')[1]!.split('## Await retro')[0]!, /Never invent decisions\./);
});
