import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {TOOL_ACTIONS} from '../../skills/dispatch/scripts/toolkit/cli.ts';
import {KINDS} from '../../skills/dispatch/scripts/toolkit/records.ts';
import {OVERLAY_ROOT} from './scan.ts';
const root = 'skills/dispatch/';
const read = (file: string) => fs.readFileSync(path.join(OVERLAY_ROOT, file), 'utf8');
const refs = ['toolkit', 'spec-stage', 'review-rules', 'decision-frame', 'providers', 'worktree-cleanup', 'diagnostics', 'glossary', 'self-build', ...['ask', 'design', 'plan', 'implement', 'review', 'verify'].map(v => 'verbs/' + v)];
const scanned = ['SKILL.md', ...refs.map(v => 'references/' + v + '.md')];
const links = (text: string) => [...text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map(m => m[1]!);
const markdown = (dir: string): string[] => fs.readdirSync(path.join(OVERLAY_ROOT, dir), {withFileTypes: true}).flatMap(e => e.isDirectory() ? markdown(dir + '/' + e.name) : e.name.endsWith('.md') ? [dir + '/' + e.name] : []);
const section = (text: string, heading: string) => text.split('### ' + heading + '\n')[1]?.split(/\n#{1,3} /)[0] ?? '';

test('decision records resolve local links and headings', () => {
  for (const file of markdown('docs/decisions')) for (const target of links(read(file))) {
    if (/^(?:[a-z][a-z0-9+.-]*:|<)/i.test(target)) continue;
    const [local, fragment] = target.split('#');
    const resolved = path.resolve(OVERLAY_ROOT, path.dirname(file), local || path.basename(file));
    const label = file + ' -> ' + target;
    assert.ok(fs.existsSync(resolved), label);
    if (fragment && resolved.endsWith('.md')) {
      const headings = fs.readFileSync(resolved, 'utf8').match(/^#{1,6}\s+.+$/gm) ?? [];
      const slugs = headings.map(heading => heading.replace(/^#{1,6}\s+/, '').toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-'));
      assert.ok(slugs.includes(decodeURIComponent(fragment)), label);
    }
  }
});

test('skill contract keeps router entries and resolving reference links', () => {
  const skill = read(root + 'SKILL.md');
  assert.match(skill, /Recommend `plan` or `design` after intent refinement under \[spec stage\]\(references\/spec-stage\.md\)\./);
  assert.match(skill, /Keep `ask`, `review`, `verify` and `implement` on their requested verb/);
  const readPhase = skill.indexOf('Read the phase first');
  assert.ok(readPhase >= 0 && readPhase < skill.indexOf('## Tool loop'));
  assert.match(skill, /Ask needs no spec, plan or approval/);
  assert.match(skill, /Standalone review adds no approval gate/);
  for (const file of refs.filter(v => v !== 'glossary' && v !== 'diagnostics')) assert.ok(links(skill).includes('references/' + file + '.md'), file);
  for (const file of [root + 'SKILL.md', ...markdown(root + 'references')]) for (const target of links(read(file))) {
    const local = target.split('#')[0]!;
    if (!local || /^(https?:|mailto:|<)/.test(local)) continue;
    assert.ok(fs.existsSync(path.resolve(OVERLAY_ROOT, path.dirname(file), local)), file + ' -> ' + target);
  }

  // Tool actions syntax documentation
  const toolkit = read(root + 'references/toolkit.md');
  const actions = toolkit.split('## Tool actions\n')[1]?.split('\n## ')[0] ?? '';
  assert.deepEqual([...actions.matchAll(/^### (.+)$/gm)].map(m => m[1]).sort(), [...TOOL_ACTIONS].sort());
  for (const action of TOOL_ACTIONS) for (const label of ['Arguments:', 'Result path:', 'Refusals:']) assert.ok(section(actions, action).includes(label), action + ' ' + label);
  assert.ok(toolkit.indexOf('## Session commands') > toolkit.indexOf('## Tool actions'));
  for (const file of scanned) {
    const text = read(root + file);
    const matches = TOOL_ACTIONS.filter(action => text.split(/\r?\n/).some(line => new RegExp('\\b' + action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(line) && /--session\b/.test(line)));
    if (file !== 'references/toolkit.md') assert.ok(matches.length <= 1, file + ' ' + matches);
    if (file === 'SKILL.md') { assert.deepEqual(matches, []); assert.ok(text.includes('<tool> <action>')); }
  }

  // Ledger records schema documentation
  const ledger = toolkit.split('## Ledger records\n')[1]?.split('\n## ')[0] ?? '';
  for (const kind of KINDS) { const body = section(ledger, kind); assert.match(body, /data/); assert.match(body, /by/); }
  for (const field of ['spec', 'plan', 'design', 'criterion', 'reason', 'evidence', 'subject', 'ruling', 'rationale', 'before', 'after', 'class', 'diffRef', 'affects', 'commandDigest', 'tree', 'clean', 'exit', 'phase', 'task', 'launch', 'candidate', 'dest']) assert.ok(ledger.includes('`' + field + '`'), field);
  for (const term of ['native-pending', 'promptPath', 'replyPath', 'rerun']) assert.ok(toolkit.includes(term), term);
  const sessions = toolkit.split('## Session commands\n')[1] ?? '';
  for (const term of ['session init', 'session reactivate', 'session quota-reprobe', 'ok', 'summary', 'path', 'appliesTo', "action:'quota-reprobe'", "v:1"]) assert.ok(sessions.includes(term), term);
  const fields: Record<string, string[]> = {
    bind: ['spec', 'plan', 'design'], approval: ['spec', 'plan', 'design'],
    level: ['level'], waiver: ['criterion', 'reason'], 'manual-complete': ['criterion', 'evidence'],
    escalation: ['id', 'state', 'summary'], ruling: ['subject', 'ruling', 'rationale', 'verification:<cycle>:V<n>'], note: ['text'],
    edit: ['artifact', 'before', 'after', 'class', 'affects', 'rationale', 'diffRef'],
    evidence: ['criterion', 'commandDigest', 'tree', 'clean', 'before', 'after', 'exit', 'path'],
    writer: ['phase', 'task', 'launched', 'path', 'base', 'commit', 'taskSection', 'seq', 'finished', 'launch', 'candidate', 'abandoned', 'reason'],
    integrate: ['verification', 'cycle', 'outcome', 'head', 'open', 'report', 'artifacts', 'dirty', 'phase', 'opened', 'path', 'branch', 'base', 'dest', 'started', 'task', 'candidate', 'conflict', 'paths', 'done', 'commit', 'abandoned', 'reason', 'fix', 'deliver-started', 'mode', 'from', 'source', 'delivered', 'committed', 'differing', 'closed'],
  };
  for (const [kind, names] of Object.entries(fields)) {
    const body = section(ledger, kind);
    for (const name of names) assert.ok(body.includes(name), kind + ' ' + name);
    assert.ok(body.includes('Allowed by: user'), kind);
    if (['approval', 'waiver', 'manual-complete'].includes(kind)) assert.ok(body.includes('user only with a nonblank quote'), kind);
    else for (const author of ['orchestrator', 'tool']) assert.ok(body.includes(author), kind + ' ' + author);
  }
});

test('audit catalog points to existing toolkit and reference entry points', () => {
  const catalog = JSON.parse(read('.agents/skills/audit-dispatch-skills/references/scenarios.json'));
  for (const scenario of catalog.scenarios) for (const entry of scenario.entries) {
    assert.ok(fs.existsSync(path.join(OVERLAY_ROOT, entry)), scenario.id + ' -> ' + entry);
  }
});

test('phase prose places each workflow rule in its canonical home', () => {
  const ref = (name: string) => read(root + 'references/' + name + '.md');
  assert.ok(links(ref('verbs/ask')).includes('../toolkit.md#ask-run'));
  assert.match(ref('spec-stage'), /intent.*user quote/i);
  assert.match(ref('spec-stage'), /continue.*unaffected writers/i);
  assert.ok(ref('review-rules').includes('review:<review>:<finding>'));
  assert.match(ref('review-rules'), /ruling/);
  for (const term of ['doctor run', 'native-pending']) assert.ok(ref('providers').includes(term), term);

  // Authoring carry-over and review round roster rules
  const plan = ref('verbs/plan');
  const design = ref('verbs/design');
  const rules = ref('review-rules');
  assert.match(plan, /existing test seams and helpers[^.]*`Seams:`/);
  assert.match(plan, /unchanged consumers and callers[^.]*`Rollback & Blast Radius`/);
  assert.match(plan, /parallel implementations[^.]*`Invariants:`/);
  assert.match(design, /unchanged consumers and parallel implementations[^.]*`Architecture & Boundaries`[^.]*`Affected contracts`/);
  assert.match(rules, /launches the full configured roster when the previous completed round has an accepted MUST/);
  assert.match(rules, /or an accepted SHOULD from a round below the cap/);
  assert.match(rules, /launches one target: the first non-reserve slot of the previous round's saved roster/);
  assert.match(rules, /pending MUST rejection requests stay assigned/);
  assert.match(rules, /Plan and design review prompts also name the session context map as a pre-change index when it exists/);
  assert.match(rules, /code review prompts never receive it/);

  // Review continuation and ceiling rules: one canonical home
  for (const name of ['decision-frame', 'toolkit']) {
    assert.doesNotMatch(ref(name), /round-1 cap plus 2|each grant 2 rounds/, name);
    assert.ok(links(ref(name)).includes('review-rules.md#review-provenance-and-applicability'), name);
  }
  assert.ok(rules.includes('the round-1 cap + 2 + 2 per user-resolved grant'));

  // Implement post-cleanup verification and review timing
  const implementText = ref('verbs/implement');
  assert.match(implementText, /start[^.]*verification[^.]*code review[^.]*same[^.]*HEAD[^.]*together/i);
  assert.match(implementText, /verification fails[^.]*repair[^.]*review/i);

  // Scope round single canonical home
  const canonical = ref('grounding');
  assert.match(canonical, /## Scope round\s+After `confirm` and before authoring a standalone plan or any design/i);
  for (const [file, link] of [['spec-stage.md','grounding.md#scope-round'], ['verbs/plan.md','../grounding.md#scope-round'], ['verbs/design.md','../grounding.md#scope-round'], ['verbs/implement.md','../grounding.md#scope-round']] as const) {
    const text = read(root + 'references/' + file);
    assert.ok(links(text).includes(link), file);
    assert.doesNotMatch(text, /(?:After `confirm`|after confirming the spec)[^\n]*scope round|scope round[^\n]*after `confirm`/i, file);
  }
  assert.match(implementText, /brief names the governing spec path for a whole read/i);

  // Severity rubric reference and no table restatement
  assert.ok(links(rules).includes('templates/review-severity.md'));
  assert.doesNotMatch(rules, /^\s*\|.*\b(critical|blocks|degrades|minor)\b.*\b(MUST|SHOULD|CONSIDER)\b/im);
});

const stageParts = () => {
  const stage = read(root + 'references/spec-authoring.md');
  return {
    refine: stage.split('2. **Critique and refine.**')[1]?.split('\n3. **Author.**')[0] ?? '',
    author: stage.split('3. **Author.**')[1]?.split('\n4. **Confirm.**')[0] ?? '',
    confirm: stage.split('4. **Confirm.**')[1]?.split('\n\n## ')[0] ?? '',
  };
};

test('spec stage critiques the request premise before confirmation', () => {
  const stage = read(root + 'references/spec-authoring.md');
  const groundStep = stage.indexOf('1. **Ground.**');
  const refineStep = stage.indexOf('2. **Critique and refine.**');
  const authorStep = stage.indexOf('3. **Author.**');
  const confirmStep = stage.indexOf('4. **Confirm.**');
  const {refine, author, confirm} = stageParts();

  assert.ok(groundStep >= 0 && refineStep > groundStep && authorStep > refineStep && confirmStep > authorStep, 'ground, critique, author and confirm in order');
  assert.match(refine, /problem, scope and cost-and-risk[^.]*materially better/i);
  assert.match(refine, /not worse on intent/i);
  assert.match(refine, /in one line that the premise holds, with the reason/i);
  assert.match(refine, /after grounding[\s\S]*first-round/i);
  assert.match(refine, /each with a recommended answer/i);
  assert.match(refine, /For `plan`, `design`, or an `implement` that authors its plan or design/i);
  assert.match(refine, /skip[^.]*`review` without a spec/i);
  assert.match(refine, /add no other clarification round/i);

  assert.match(author, /DEC[\s\S]*Options[\s\S]*Rejected[\s\S]*user's actual quote/i);
  assert.match(author, /user's choice governs/i);
  assert.match(author, /critique alone never blocks progress/i);

  assert.match(confirm, /when `grilling` was unavailable[\s\S]*Confirm exchange/i);
  assert.match(confirm, /If the reply settles a presented alternative in this fallback/i);
  const update = confirm.indexOf('first update the canonical spec and its DEC');
  const lint = confirm.indexOf('lint the updated spec', update);
  const recordText = "Record the user's reply as a `confirm` ledger record with the spec hash";
  const record = confirm.indexOf(recordText, lint);
  assert.ok(update >= 0 && lint > update && record > lint, 'update and lint the fallback spec before recording confirm');
  assert.equal((confirm.match(/Record the user's reply as a `confirm` ledger record with the spec hash/g) ?? []).length, 1);
  assert.match(confirm, /once, using the resulting hash if this fallback update ran, or the current spec hash otherwise/i);
  assert.match(confirm, /reply is both the decision and confirmation/i);
  assert.match(confirm, /no extra exchange/i);
  assert.match(confirm, /revision protocol/i);
  assert.match(refine, /replaces grilling's closing shared-understanding confirmation, so ask no separate one/);
  assert.match(confirm, /record no `edit` or `confirm` until the user accepts the repeated exchange/);
});

test('spec stage lays out grounded approaches', () => {
  const {refine, author} = stageParts();
  assert.match(refine, /two or three grounded approaches with trade-offs and one recommendation/i);
  assert.match(refine, /drop approaches that work against the user's why or that existing work rules out/i);
  assert.match(refine, /when one approach remains, say so and state why the others do not fit/i);
  assert.match(refine, /differ in what the user sees[^.]*text sketch/i);
  assert.match(refine, /raises the approach or asks about trade-offs[^.]*grilling question/i);
  assert.match(refine, /only outcomes[^.]*stated default[^.]*override[^.]*Confirm/i);
  assert.match(author, /approach set[\s\S]*DEC[\s\S]*Options[\s\S]*Rejected/i);
  assert.match(author, /delegated default[^.]*`\(assumption\)`[^.]*no user quote/i);
  assert.match(author, /override[^.]*updates that DEC with the user's actual quote/i);
  const template = read(root + 'references/templates/spec.md');
  assert.match(template, /verbatim user quote[^.\n]*`\(user\)`/i);
});

test('spec stage offers the simplest worthwhile approach', () => {
  const {refine} = stageParts();
  assert.match(refine, /simplest approach with a reasonable trade-off worth considering/i);
  assert.match(refine, /\[simplicity order\]\(templates\/quality-bar\.md#shared\)/);
  assert.match(refine, /never a strawman/i);
  assert.match(refine, /already that option[^.]*say so/i);
  assert.match(refine, /trade-off, limitation and risk/i);
  assert.match(refine, /recommend the simplest presented approach that meets intent and the simplicity floor[^.]*heavier[^.]*reason/i);
  const template = read(root + 'references/templates/spec.md');
  assert.match(template, /<option: trade-off, limitation, risk>/);
  assert.doesNotMatch(template, /<option and trade-off>/);
});

test('spec stage asks only build-changing questions', () => {
  const {refine} = stageParts();
  assert.match(refine, /only decisions that change scope, behavior or risk and that grounding cannot answer/i);
  assert.match(refine, /other calls[^.]*`\(assumption\)`/i);
  assert.match(refine, /never questions, and never ask process steps/i);
  assert.match(refine, /A material unanswered question still blocks approval/);
  assert.match(refine, /states no why and grounding cannot infer it/i);
  assert.match(refine, /why[^.]*alone[^.]*first grilling round[^.]*no recommended answer/i);
  assert.match(refine, /override[^.]*per-question recommendation[^.]*that one question/i);
  assert.match(refine, /rest of the frontier, including approach options, follows in the next round/i);
  assert.match(refine, /inferred why[^.]*`\(assumption\)`/i);
});

test('spec stage short path and self-check', () => {
  const {refine, author, confirm} = stageParts();
  assert.match(refine, /open the first user exchange[^.]*with a short restatement of the request[\s\S]*current behavior[\s\S]*what the change touches[\s\S]*verified Surprises/i);
  assert.match(refine, /leaves no user decision open[^.]*no grilling round/i);
  assert.match(refine, /at every level, except when the critique leaves no user decision open/i);
  assert.match(refine, /Confirm carries the critique result, any approach default, stated and assumed intent and the verb recommendation/i);
  assert.match(confirm, /when `grilling` was unavailable or asked no round/i);
  assert.match(confirm, /approach default, a self-check answer or a corrected assumption/i);
  assert.match(confirm, /opens a new decision in this fallback, follow the \[revision protocol\]\(spec-stage\.md#revision-protocol\) \(for a new decision, resume `grilling` for its branch first when the host provides it\), which records the new confirmation; otherwise:/i);
  const lint = author.indexOf('Lint');
  const check = author.search(/self-check/i);
  const relint = author.search(/lint (?:again|passes again)/i);
  assert.ok(lint >= 0 && check > lint && relint > check, 'self-check after lint, re-lint after it');
  assert.match(author, /plan author/i);
  assert.match(author, /answered by chat or grounding \(fill in\)[\s\S]*minor[^.]*`\(assumption\)`[\s\S]*ask[^.]*in Confirm, most important first/i);
  assert.match(author, /before Confirm/i);
});

test('spec stage docs describe approach options', () => {
  const stage = read(root + 'references/spec-authoring.md');
  const docs = {
    readme: read(root + 'README.md'),
    concepts: read(root + 'references/readme/concepts.md'),
    adr: read('docs/decisions/0014-ground-first-intent-and-evidence-based-level.md'),
  };
  for (const [name, text] of Object.entries({...docs, stage})) {
    if (name !== 'stage') assert.match(text, /approach options?[^.]*recommend|recommend[^.]*approach options?/i, name);
    for (const sentence of text.split(/\.\s/).filter((s) => /alternative only when[^.]*materially better/i.test(s))) {
      assert.match(sentence, /problem, scope and cost|other lenses/i, name + ': materially-better filter names its lenses');
    }
  }
  for (const [name, text] of Object.entries(docs)) {
    assert.match(text, /simplest[^.]*worth considering/i, name + ': simplest worthwhile option');
    assert.match(text, /trade-off, limitation and risk/i, name + ': per-option cost');
  }
  assert.match(docs.adr, /brainstorming[^.]*rejected as a whole[\s\S]*adopts[^.]*approach options[^.]*question admission[^.]*short path[^.]*self-check/i);
});

test('aliases preserve entry mappings', () => {
  const mapping = {'dispatch-plan': 'plan', 'dispatch-implement': 'implement', 'dispatch-code-review': 'review --kind code', 'dispatch-verify': 'verify'};
  for (const [name, verb] of Object.entries(mapping)) {
    const text = read('skills/' + name + '/SKILL.md');
    assert.ok(text.includes('`' + verb + '`'), name);
    assert.ok(text.includes('Missing dependency: dispatch is required by ' + name));
    assert.match(text, new RegExp('name: ' + name));
    assert.ok(fs.existsSync(path.join(OVERLAY_ROOT, '.agents/skills', name, 'SKILL.md')), name + ': host link');
  }
  const review = read('skills/dispatch-code-review/SKILL.md');
  assert.ok(review.includes('--spec'));
  for (const file of [root + 'SKILL.md', ...markdown(root + 'references')]) assert.doesNotMatch(read(file), /\b(?:dispatch-plan|dispatch-implement|dispatch-code-review|dispatch-verify)\b/, file);
});

test('human manuals retain portable links and current operational guidance', () => {
  for (const file of markdown('skills')) {
    const text = read(file);
    assert.doesNotMatch(text, /file:\/\/|[A-Z]:\\Users\\/, file);
    for (const target of links(text)) {
      const local = target.split('#')[0]!;
      if (!local || /^(https?:|mailto:|<)/.test(local)) continue;
      assert.ok(fs.existsSync(path.resolve(OVERLAY_ROOT, path.dirname(file), local)), file + ' -> ' + target);
    }
  }
  const config = read(root + 'references/readme/configuration.md');
  for (const term of [
    'after it authors and lints a plan or design',
    'records it before the first review',
    'confirm the proposal with artifact approval after review',
    'failures remain observable and recoverable', 'financial or data-integrity errors',
    'a small rate-precision change can',
    'A large diff, changed external contract, finance repository, or state-machine file alone does not require high',
    '`ask` and standalone `review` resolve the level from the invocation, then the session ledger, then `medium`',
    'the level never decreases mid-run',
    'nativeSubagentsOnly', 'write-subagents', 'OPENCODE_CONFIG_DIR', 'sandbox:false',
    'positive safe integer', 'omission defaults to one',
  ]) assert.ok(config.includes(term), term);
  const humanRoot = read('README.md');
  assert.match(read(root + 'references/templates/plan.md'), /retaining the session in the workspace/);
  const concepts = read(root + 'references/readme/concepts.md');
  assert.match(read(root + 'README.md'), /task summaries/);
  assert.match(read(root + 'references/readme/design.md'), /increments in order/);
});

test('commit phase and all-increments opt-in contracts', () => {
  const toolkit = read(root + 'references/toolkit.md');
  const deliver = section(toolkit, 'worktree deliver');
  assert.ok(toolkit.includes('`worktree deliver --session <session> [--commit <message-file>]`'), 'call table');
  for (const term of ['--commit', 'recordOnly', 'committed', 'differing', 'warning', 'not-delivered', 'staged-changes', 'delivered-content-changed', 'commit-failed', 'head-not-descendant', 'delivered-uncommitted', 'caller-moved'])
    assert.ok(deliver.includes(term), term);
  assert.ok(section(toolkit, 'lint run').includes('outside-increment'), 'lint run warning');
  const approval = read(root + 'references/spec-stage.md').split('## Approval\n')[1]?.split(/\n## /)[0] ?? '';
  assert.match(approval, /approve all increments/);
  assert.match(approval, /user-quoted `note`/);
  assert.match(approval, /tuple with that quote/);
  const frame = section(read(root + 'references/decision-frame.md'), 'Plan or design approval');
  assert.match(frame, /all increments/);
  assert.ok(links(frame).some(link => link.includes('spec-stage.md#approval')), 'opt-in link');
});

test('uncommitted delivery contract', () => {
  const toolkit=section(read(root+'references/toolkit.md'),'worktree deliver');
  for (const term of ['delivered-source', 'caller-dirty', 'recovery-blocked', 'unsupported-sparse', 'unsupported-entry', 'git restore --source', '??']) assert.ok(toolkit.includes(term), term);
  for(const name of ['verbs/implement','worktree-cleanup','readme/implement']) assert.ok(links(read(root+'references/'+name+'.md')).some(link=>link.endsWith('toolkit.md#worktree-deliver')),name);
  const concepts=read(root+'references/readme/concepts.md');
  assert.match(concepts,/delivered-source/);assert.match(concepts,/git restore --source/);
});

test('grounding contracts carry conventions host tools and follow-up guidance', () => {
  const grounding = read(root + 'references/grounding.md');
  const explorer = read(root + 'references/templates/explorer-brief.md');
  const contextMap = read(root + 'references/templates/context-map.md');
  const providers = read(root + 'references/providers.md');
  const reviewPrompt = read(root + 'references/templates/review-prompt.md');
  const writerBrief = read(root + 'references/templates/writer-brief.md');

  assert.match(grounding, /landscape/i);
  assert.match(grounding, /load-bearing/i);
  assert.match(grounding, /live explorer/i);
  assert.match(grounding, /each design increment plan/i);
  assert.match(grounding, /cited range/i);
  assert.ok(grounding.includes('providers.md#native-slots'));
  assert.ok(grounding.includes('## Scope round'));
  assert.ok(grounding.includes('Launch one map explorer per grounding phase'));
  assert.ok(grounding.includes('launch research explorers in parallel, one per independent topic'));
  assert.ok(grounding.includes('writes no map'));
  assert.ok(grounding.includes('../SKILL.md#context-guard'));
  assert.ok(read(root + 'references/verbs/plan.md').includes('../grounding.md#scope-round'));
  assert.ok(read(root + 'references/verbs/design.md').includes('../grounding.md#scope-round'));
  assert.ok(explorer.includes('<slug>.spec.context.md'));
  assert.ok(explorer.includes('<slug>.plan.context.md'));
  for (const [name, text] of [['grounding.md', grounding], ['explorer-brief.md', explorer]] as const) {
    assert.ok(!text.includes('<slug>.context.md'), name + ' uses an unphased map path');
  }

  assert.ok(explorer.includes('## Host rules and tools'));
  assert.ok(explorer.includes('{{quality}}'));
  assert.match(explorer, /native slots/);
  assert.doesNotMatch(explorer, /\]\(/);
  assert.match(explorer, /Conventions/);
  assert.match(explorer, /parallel:/);
  assert.match(explorer, /Surprises/);
  assert.ok(contextMap.includes('## Conventions'));
  assert.ok(contextMap.includes('parallel:'));

  assert.match(providers, /own cache or index/i);
  assert.match(providers, /create or update only/i);
  assert.match(reviewPrompt, /own cache or index/i);
  assert.match(reviewPrompt, /A reviewer may run a host read tool that creates or updates only its own cache or index/);
  assert.doesNotMatch(reviewPrompt, /A native reviewer/);
  assert.match(writerBrief, /own cache or index/i);
  const skill = read(root + 'SKILL.md');
  assert.ok(skill.includes('references/providers.md#native-slots'));
  assert.doesNotMatch(skill, /write its output to .replyPath/);
});

test('root skill routes work and guards orchestrator context', () => {
  const skill = read(root + 'SKILL.md');
  const definition = skill.indexOf("You are the orchestrator: the user's deputy, who middle-manages dispatched agents, whether native subagents or provider delegates");
  assert.ok(definition >= 0 && definition < skill.indexOf('## Tool loop'), 'orchestrator definition precedes the tool loop');
  const block = (heading: string) => skill.split('## ' + heading + '\n')[1]?.split('\n## ')[0] ?? '';
  const routing = block('Routing');
  const rows = routing.split('\n').filter(line => line.startsWith('| ') && !line.startsWith('| Work')).map(line => line.split('|').map(cell => cell.trim()).filter(Boolean));
  const route = (work: string) => rows.find(([cell]) => cell!.includes(work))?.[1];
  for (const [work, target] of [
    ['log and verify triage', 'Explorer subagent (read-only)'], ['grounding maps', 'Explorer subagent (read-only)'],
    ['Test cleanup', 'Utility subagent'], ['mechanical fixes', 'Utility subagent'],
    ['Plan tasks', 'Writer at run level'], ['Differentiated review or ask voices', 'Delegate or native slot'],
    ['Decisions, rulings, ledger, user gates', 'Orchestrator'], ['submitted-change inspection', 'Orchestrator'],
  ] as const) assert.equal(route(work), target, work);
  assert.equal(route('retro'), undefined);
  assert.equal(rows.length, 5, 'five routes');
  assert.ok(links(routing).includes('references/toolkit.md#doctor-run'));
  for (const phrase of ['the `explore-subagents` entry, else the lowest `write-subagents` entry', 'Do explorer and utility work inline only when none resolves', 'edits only assigned paths and runs no Git write commands and no toolkit', 'Reviewers read directly and launch no explorers']) assert.ok(routing.includes(phrase), phrase);
  const guard = block('Context guard');
  for (const phrase of ['every verb', 'files, logs, web, command output, result files, diffs', 'a launch has a cost', 'known file, cited range, index query or small read', 'about 5 files or 20 KB (~5k tokens)', 'an estimate, not a measured check', 'one explorer per independent topic in parallel', 'distilled, cited reply', 'verify load-bearing claims at source', 'Orchestrator-row work stays with the orchestrator at any size', 'including `ask`', 'Run `ask` only on user request']) assert.ok(guard.includes(phrase), phrase);
  assert.ok(!guard.includes('500 lines'));
  const launch = block('Launch and continue');
  for (const phrase of ['Request fresh context without parent history', 'report that once in the final handoff', 'objective, decisions, constraints, current state, next action and required evidence', 'grant no write authority', 'Retain handles until the run ends or the host drops them', 'it keeps its model, write boundary and reply rules', 'A follow-up answer returns inline and writes no file', 'never rewrites `replyPath`, `reportPath` or an existing map', 'Launch fresh for an unrelated topic or when the host cannot continue', 'Never replace or duplicate work only for fresh context', 'creates no finding and no rejection confirmation', 'Reviewers are not continued across rounds', 'answers read-only', 'Two writers never share a worktree', 'with exactly the launch result', 'report a blocker with retained evidence instead of launching without them']) assert.ok(launch.includes(phrase), phrase);
  assert.ok(skill.indexOf('## Launch and continue') < skill.indexOf('## Invariants and recovery'));
  assert.doesNotMatch(skill, /`(?:Task|Agent|spawn_agent|runSubagent)`/, 'no host-specific subagent tool');
  const glossary = read(root + 'references/glossary.md');
  assert.match(glossary, /^\| utility subagent \|[^\n]*\| lowest subagent \|$/m);
});

test('references keep branch detail and use the utility entry', () => {
  const ref = (name: string) => read(root + 'references/' + name + '.md');
  const skill = read(root + 'SKILL.md');
  for (const heading of ['## Routing', '## Launch and continue']) assert.match(skill, new RegExp('^' + heading + '$', 'm'), heading);
  const grounding = ref('grounding');
  assert.doesNotMatch(grounding, /^## Follow-up explorers$/m);
  assert.ok(links(grounding).includes('../SKILL.md#routing'));
  assert.match(grounding, /`utility`/);
  for (const file of ['grounding', 'spec-stage']) assert.doesNotMatch(ref(file), /follow-up explorers/i, file);
  const providers = ref('providers');
  assert.doesNotMatch(providers, /^## Subagent context$/m);
  assert.ok(links(providers).includes('../SKILL.md#launch-and-continue'));
  assert.ok(links(ref('verbs/ask')).includes('../../SKILL.md#routing'));
  const step6 = ref('verbs/implement').split('\n').find(line => line.includes('Apply [shared]')) ?? '';
  assert.doesNotMatch(step6, /--level low/);
  assert.match(step6, /utility subagent \(\[routing\]\(\.\.\/\.\.\/SKILL\.md#routing\)\) on the `brief test-cleanup` result/);
  assert.match(step6, /runs only its edited test files/);
});

test('native voice launch order failure reports and change rules are documented', () => {
  const providers = read(root + 'references/providers.md');
  for (const term of [
    '`cliWave: "pending"`', 'no retained handle', 'every retained handle finished or was reported',
    'Stop a timed-out handle', '30-minute', '--native-failed', 'takes its reserve or saves `failed`', 'work in `cwd`',
  ]) assert.ok(providers.includes(term), term);
  const coverage = read(root + 'references/review-coverage.md');
  for (const term of [
    'repositoryChanges', 'unproven', 'repository-changes:', 'repository-rerun:', 'Decision Frame',
  ]) assert.ok(coverage.includes(term), term);
  const rules = read(root + 'references/review-rules.md');
  assert.ok(links(rules).includes('review-coverage.md#repository-changes-from-native-voices'));
  assert.doesNotMatch(rules, /repository-changes:|repository-rerun:|keeps the legacy round-level meaning/);
  const toolkit = read(root + 'references/toolkit.md');
  for (const term of [
    '--native-failed', 'cliWave', 'repositoryChanges', 'openRepositoryChanges', 'checkout-report.json',
  ]) assert.ok(toolkit.includes(term), term);
  const ask = read(root + 'references/verbs/ask.md');
  for (const term of ['`cliWave: "pending"`', '--native-failed']) assert.ok(ask.includes(term), term);
});
test('native slots launch by prompt path', t => {
  const providers = read(root + 'references/providers.md');
  const openCode = providers.indexOf('## OpenCode private launches');
  for (const heading of ['Native slots', 'Shared provider controls', 'Quota']) {
    const position = providers.indexOf('## ' + heading);
    assert.ok(position >= 0 && openCode >= 0 && position < openCode, heading);
  }
  const toolkit = read(root + 'references/toolkit.md');
  assert.doesNotMatch(toolkit, /#### (?:Test cleanup|Cap-ending SHOULD corrections)|\]\(#test-cleanup\)/);
  for (const term of ['test-cleanup-evidence-required', 'test-cleanup-paths-unchanged', 'test-cleanup-recorded', 'test-cleanup-empty', 'test-cleanup-removed', '--review-fix', 'reviewFix', 'bind the revised spec, then append its `edit` record']) assert.ok(toolkit.includes(term), term);
  t.diagnostic('toolkit.md: ' + Buffer.byteLength(toolkit) + ' UTF-8 bytes; baseline 27475');
  const grounding = read(root + 'references/grounding.md');
  assert.match(grounding, /only when the explorer did not report a passing `lint run`[^.]*inline[^.]*or after the orchestrator edits the map/);
  for (const phrase of ['Relaunch a failed, timed-out or lint-failing explorer once', 'For a size error, ask it to compress wording while retaining every entry', 'self-ground']) assert.ok(grounding.includes(phrase), phrase);
  assert.match(providers, /read and execute[^.]*`promptPath`/i);
  assert.match(providers, /cannot read files[^.]*inline/i);
  assert.match(read(root + 'references/verbs/ask.md'), /answering a native voice yourself, read its prompt/i);
  for (const file of ['SKILL.md', 'references/toolkit.md', 'references/verbs/ask.md']) assert.doesNotMatch(read(root + file), /read (?:each|the result's native slots and each) `?promptPath/i);
});
test('orchestrator reads quality bar sections by stage', () => {
  const skill = read(root + 'SKILL.md');
  assert.ok(!links(skill).some(link => link.endsWith('quality-bar.md')), 'SKILL.md does not link to the whole quality bar');
  const plan = read(root + 'references/verbs/plan.md');
  assert.ok(links(plan).includes('../grounding.md#design-increments'));
  assert.doesNotMatch(plan, /quality-bar\.md#code/);
  const review = read(root + 'references/verbs/review.md');
  for (const anchor of ['spec', 'plan', 'design']) assert.ok(links(review).includes('../templates/quality-bar.md#' + anchor));
  for (const phrase of ['Standalone review needs no bound plan', 'Code targets are `integration`, a bound-plan task ID, `worktree`, `<a>..<b>` or `<rev>`', 'Session state is excluded']) assert.ok(review.includes(phrase), phrase);
  assert.doesNotMatch(review.split('for plan,')[1]?.split(';')[0] ?? '', /quality-bar\.md#code/);
  const implementLinks = links(read(root + 'references/verbs/implement.md'));
  for (const anchor of ['rulings-and-fix-scope', 'review-provenance-and-applicability']) assert.ok(implementLinks.includes('../review-rules.md#' + anchor));
  for (const guide of ['../spec-stage.md', 'plan.md', 'design.md']) assert.ok(implementLinks.includes(guide), guide);
  for (const [file, anchor] of [['spec-authoring.md','spec'], ['verbs/plan.md','plan'], ['verbs/design.md','design'], ['verbs/implement.md','code'], ['verbs/review.md','code'], ['verbs/plan.md','testing'], ['verbs/implement.md','testing'], ['verbs/review.md','testing']]) {
    const text = read(root + 'references/' + file);
    assert.ok(links(text).some(link => link.endsWith('quality-bar.md#' + anchor)), file);
    assert.ok(links(text).some(link => link.endsWith('quality-bar.md#shared')), file);
  }
});
test('failed plan slot rule has one home', () => {
  const coverage = read(root + 'references/review-coverage.md');
  assert.match(section(coverage, 'Failed-slot coverage'), /failed plan or design slot at the cap gets no extra round[^.]*\[Decision Frame\]\(decision-frame\.md\)[^.]*user decides/);
  const rules = read(root + 'references/review-rules.md');
  assert.ok(links(rules).includes('review-coverage.md#failed-slot-coverage'));
  assert.doesNotMatch(rules, /failed plan or design slot at the cap gets no extra round/);
  const implement = read(root + 'references/verbs/implement.md');
  const step = (n: number) => implement.split('\n').find(line => line.startsWith(n + '. ')) ?? '';
  assert.ok(links(step(1)).includes('../review-coverage.md#failed-slot-coverage'));
  assert.doesNotMatch(implement, /extra round|reduced coverage goes/);
  assert.match(step(3), /`worktree create` refuses a task until its prerequisites have integrated; verify an integrated prerequisite before creating its dependents/);
  const toolkit = read(root + 'references/toolkit.md');
  assert.ok(section(toolkit, 'worktree create').includes('prerequisite-pending'));
  const removal = /drops only a non-host provider whose sandbox cannot run/;
  assert.match(read(root + 'references/readme/configuration.md'), removal);
  assert.match(read(root + 'references/readme/troubleshooting.md'), removal);
});

test('reference duplicates keep one home and link to it', () => {
  const ref = (name: string) => read(root + 'references/' + name + '.md');
  // Spec authoring sequence lives in spec-authoring.md; spec-stage.md keeps its anchor and links.
  const stage = ref('spec-stage');
  assert.ok(links(stage).some((link) => link === 'spec-authoring.md' || link.startsWith('spec-authoring.md#')));
  assert.ok(stage.includes('## Resolve and author'));
  assert.doesNotMatch(stage, /1\. \*\*Ground\.\*\*/);
  const authoring = read(root + 'references/spec-authoring.md');
  assert.match(authoring, /1\. \*\*Ground\.\*\*/);
  assert.match(authoring, /2\. \*\*Critique and refine\.\*\*/);
  assert.match(authoring, /3\. \*\*Author\.\*\*/);
  assert.match(authoring, /4\. \*\*Confirm\.\*\*/);
  assert.ok(links(authoring).includes('spec-stage.md#revision-protocol'));
  // Lint-code field notes live in plan-field-notes.md; plan.md links them.
  const planTemplate = read(root + 'references/templates/plan.md');
  assert.ok(links(planTemplate).includes('plan-field-notes.md'));
  const fieldNotes = read(root + 'references/templates/plan-field-notes.md');
  for (const code of ['glance-restates-task-map', 'section-order', 'task-behaviour', 'plan-id-in-test-name', 'criterion-red-test-path', 'criterion-tests-path', 'undeclared-test-path', 'criterion-red-command', 'red-downgraded', 'overlap', 'duplicate-change-path', 'criterion-task-changes']) assert.ok(fieldNotes.includes(code), code);
  assert.doesNotMatch(planTemplate.split('## Field notes')[1] ?? '', /glance-restates-task-map/);
  // The map budget is rendered from DEFAULT_MAP_BUDGET; no reference hardcodes it.
  assert.doesNotMatch(ref('templates/context-map'), /16,384|32,768/);
  assert.doesNotMatch(ref('grounding'), /16,384/);
  assert.ok(links(ref('grounding')).includes('templates/explorer-brief.md#map-budget-and-output'));
  // The native reply channel is generated; providers.md links it.
  assert.ok(links(ref('providers')).some((link) => link.includes('scripts/toolkit/fanout.ts')));
  // The utility entry resolves through SKILL routing.
  assert.ok(links(ref('grounding')).includes('../SKILL.md#routing'));
  // The repository-change closing rule lives in review-coverage.md; toolkit links it.
  assert.ok(links(ref('toolkit')).includes('review-coverage.md#failed-slot-coverage'));
  assert.ok(links(ref('toolkit')).includes('review-coverage.md#repository-changes-from-native-voices'));
  assert.doesNotMatch(ref('toolkit'), /keeps the legacy round-level meaning/);
  // Implement step 6 launches through the brief test-cleanup action.
  const implement = ref('verbs/implement');
  assert.match(implement, /brief test-cleanup/);
  assert.ok(links(implement).some((link) => link.includes('toolkit.md#brief-test-cleanup')));
  // The SKILL write boundary links the quality bar.
  assert.ok(links(read(root + 'SKILL.md')).includes('references/templates/quality-bar.md#shared'));
});

test('scope-round carry-forward and settled-decision deduplication contracts hold across grounding quality bar and review prompt', () => {
  const grounding = read(root + 'references/grounding.md');
  const explorer = read(root + 'references/templates/explorer-brief.md');
  for (const [name, text] of [['explorer-brief.md', explorer]] as const) {
    assert.ok(text.includes('realpath'), name + ': symlinked path resolution');
    assert.ok(text.includes('(uncommitted)'), name + ': uncommitted marker');
    assert.ok(text.includes('git ls-tree'), name + ': tracked path check');
    assert.ok(text.includes('git diff --name-only'), name + ': unchanged path check');
    assert.match(text, /Commit: <sha>/, name + ': capture commit');
  }

  // The carry-forward conditions live in the explorer brief; grounding links them.
  assert.ok(links(grounding).includes('templates/explorer-brief.md#map-budget-and-output'));
  assert.ok(grounding.includes('carries forward an entry'));
  assert.ok(grounding.includes("explorer brief's scope-round rule"));
  assert.match(grounding, /re-read and re-verify/);
  assert.ok(grounding.includes('refined `REQ`s, `DEC`s, planning-altitude test seams, callers and parallel implementations'));
  assert.equal(grounding.split('git status').length - 1, 1, 'git status appears only as a prohibition');
  assert.ok(grounding.includes('Do not run a `git status` check.'));
  assert.equal(explorer.split('git status').length - 1, 0, 'explorer brief asks for no git status check');

  assert.match(explorer, /recorded `Commit: <sha>` is present/);
  assert.match(explorer, /otherwise it re-reads the file/i);

  // Settled decisions, non-goals and earlier rulings are closed without new unweighed evidence.
  const quality = read(root + 'references/templates/quality-bar.md');
  const prompt = read(root + 'references/templates/review-prompt.md');
  for (const [name, text] of [['quality-bar.md', quality], ['review-prompt.md', prompt]] as const) {
    assert.match(text, /accepted or rejected rulings/i, name + ': settled rulings');
  }
  assert.match(quality, /Treat settled DECs, non-goals, and prior accepted or rejected rulings in `### Settled in earlier rounds` as closed unless new unweighed code or requirement evidence is cited\./);
  const promptFlat = prompt.replace(/\s+/g, ' ');
  assert.match(promptFlat, /earlier accepted or rejected rulings in `### Settled in earlier rounds` as closed unless you cite new code or requirement evidence that the ruling missed/);
  assert.match(promptFlat, /do not re-raise style preferences or checks enforced by configured linters, formatters or type checkers/);

  const append = section(read(root + 'references/toolkit.md'), 'ledger append');
  assert.match(append, /single record object or a non-empty JSON array of record objects/i);
  assert.match(append, /validates each record sequentially|validated sequentially/i);
  assert.match(append, /one `withLedger` lock|single `withLedger` lock/i);
  assert.match(append, /findings refresh/i);
});

test('grounding guidance defines gap explorer triggers limits scout role and remaining gap handling', () => {
  const grounding = read(root + 'references/grounding.md');
  for (const signal of ['Not covered', 'Surprises', '(text-only)', 'unresolved-dispatch', 'map size warning']) {
    assert.ok(grounding.includes(signal), signal);
  }
  assert.match(grounding, /Launch a gap explorer only when the answer could change a REQ, DEC, scope or blast radius and its reading exceeds the \[context guard\]\(\.\.\/SKILL\.md#context-guard\) threshold/);
  assert.match(grounding, /read smaller gaps inline/);
  assert.match(grounding, /touches a shared contract, schema or predicate with consumers in several areas, one slot is a scout/);
  assert.match(grounding, /gets the objective and the paths already covered, not the findings, and reports surfaces absent from them/);
  assert.match(grounding, /A scout is new work, not duplicated work for fresh context/);
  assert.match(grounding, /Launch at most three in one round, one per independent surface, fresh, as research explorers/);
  assert.match(grounding, /Remaining gaps stay in `Not covered` or the spec's Open Questions/);
});

test('implement guide bounds active task writers by doctor run writeConcurrency', () => {
  const implement = read(root + 'references/verbs/implement.md');
  assert.match(implement, /Keep active task writers within `doctor run` `writeConcurrency`\./);
  assert.doesNotMatch(implement, /Honor configured native capacity\./);
});

test('configuration documentation recommends strongest model for orchestrator', () => {
  const config = read(root + 'references/readme/configuration.md');
  assert.match(config, /strongest available model for the orchestrator/i);
  assert.match(config, /cheap explorers and writers depend on a strong lead/i);
});

test('toolkit doctor run documents writeConcurrency in result shape', () => {
  const toolkit = read(root + 'references/toolkit.md');
  assert.match(section(toolkit, 'doctor run'), /writeConcurrency/);
});

test('implement runs verification before test cleanup', () => { const s = read(root + 'references/verbs/implement.md'); assert.ok(s.indexOf('verification step') < s.indexOf('Apply [shared]')); for (const term of ['criterion and contract checks must pass on the new HEAD', 'Any verifier-added test launches cleanup', 'all review rounds settle', 'accepted review fixes changed proved behaviour', 'V0', 'before launching', 'covering those fixes together', 'Never re-check between rounds', 'add tests in a re-check', 'another code review round', 'three fix rounds per issue']) assert.ok(s.includes(term), term); });
test('verify guide states approval and issue loop', () => { const s = read(root + 'references/verbs/verify.md'); for (const term of ['finishes unblocked checks', 'NEEDS_APPROVAL', 'approval quote', 'declined check', 'not proved', 'Read-only calls', 'Persistent or shared state', 'verification:<cycle>:V<n>', 'On resume rule', 're-check only those issues', 'Escalate recurrence', 'three fix rounds per issue', 'report-only', 'dirty: true', 'returns results inline', 'new cycle launches fresh', 'no delivery step', 'test edits permitted', 'no test edits']) assert.ok(s.includes(term), term); });
test('verify manual describes proof and host guidance', () => { const s = read(root + 'references/readme/verify.md'); assert.match(s, /verification\/report.md/); assert.match(s, /Verification/); });

test('call table lists every tool action, record kind and session command with its section argument form', () => {
  const toolkit = read(root + 'references/toolkit.md');
  const lines = section(toolkit, 'call table').split('\n').filter(line => line.startsWith('| ')).slice(2);
  const parsed = lines.map(line => {
    const [type, heading, ...rest] = line.slice(2, -2).split(' | ');
    return {type: type!, heading: heading!, form: rest.join(' | ').split('\\|').join('|')};
  });
  const expected = [
    ...TOOL_ACTIONS.map(h => ['action', h]), ...KINDS.map(h => ['record', h]),
    ...['session init', 'session reactivate', 'session quota-reprobe'].map(h => ['session', h]),
  ];
  assert.deepEqual(parsed.map(r => [r.type, r.heading]).sort(), expected.sort());
  const firstSpan = (text: string) => /`([^`]+)`/.exec(text)?.[1] ?? '-';
  for (const row of parsed) {
    const body = section(toolkit, row.heading);
    const form = row.type === 'action' ? firstSpan(body.split('\n').find(line => line.startsWith('Arguments: ')) ?? '')
      : row.type === 'session' ? firstSpan(body) : '-';
    assert.equal(row.form.replace(/^`|`$/g, ''), form, row.heading);
  }
});

test('SKILL.md read rule loads the call table once and each tool section through help', () => {
  const skill = read(root + 'SKILL.md');
  assert.ok(skill.includes('dispatch.ts help call table` once per run. Run `help <heading>` before the first use in a run of each tool action, ledger record kind and session command except `session init`'));
  assert.ok(skill.includes('after each `ok:false` result that has a `help` field'));
  assert.ok(!skill.includes('For each call read its action section'));
  assert.ok(!skill.includes('for ledger calls also read the matching record-kind section'));
});

test('merged rules keep one home', () => {
  const ref = (file: string) => read(root + 'references/' + file);
  const homes: Array<[string, string, string, string]> = [
    ['review-rules.md', 'plan and design only', 'decision-frame.md', 'Offer this only for plan and design reviews'],
    ['decision-frame.md', 'Obtain a user quote for any actual waiver', 'decision-frame.md', 'Waivers, manual completion and selection of xhigh/max also require verbatim user quotes'],
    ['verbs/implement.md', 'Waivers and manual-completion records must quote', 'decision-frame.md', 'Waivers, manual completion and selection of xhigh/max also require verbatim user quotes'],
    ['verbs/verify.md', 'commit fixes and verifier-added tests', 'verbs/implement.md', 'Commit verifier-added tests and fixes with `worktree commit`'],
    ['verbs/verify.md', 'A post-review re-check adds no tests', 'verbs/implement.md', 'Never re-check between rounds or add tests in a re-check'],
    ['worktree-cleanup.md', 'Report every retained owned path', 'worktree-cleanup.md', 'Resolve owned retained paths before a successful handoff'],
    ['verbs/review.md', 'worktree captures tracked and untracked', 'toolkit.md', 'Worktree captures HEAD plus tracked/untracked changes'],
    ['verbs/review.md', 'Verify claims against intent and current source', 'review-rules.md', 'Verify every claim against current source and governing outcomes'],
    ['verbs/review.md', 'Preserve prior findings, rulings', 'review-rules.md', 'Retain reviewed revision, scope, findings, rulings'],
    ['verbs/plan.md', 'Settle the approval tuple', 'decision-frame.md', 'one approval tuple of spec hash, plan hash and optional design hash'],
    ['grounding.md', 'resolve any symlinked cited path', 'templates/explorer-brief.md', 'resolve any symlinked path with `realpath`'],
  ];
  for (const [oldFile, repeat, homeFile, home] of homes) {
    assert.ok(!ref(oldFile).includes(repeat), `${oldFile} repeats: ${repeat}`);
    assert.ok(ref(homeFile).includes(home), `${homeFile} lacks: ${home}`);
  }
});

test('flow defect repairs state background review start and verifier disposable and refused-write rules', () => {
  const toolkit = read(root + 'references/toolkit.md');
  assert.match(section(toolkit, 'review run'), /Start a long `review run` as a background command and wait for its completion notice/);
  const brief = read(root + 'references/templates/verifier-brief.md');
  assert.match(brief, /disposable repositories you create and remove are excepted/);
  assert.match(brief, /When the host refuses the report write, return the full report text/);
  assert.match(brief, /A refused write needs no user ruling/);
  const verify = read(root + 'references/verbs/verify.md');
  assert.match(verify, /When the host refuses the report write, the verifier returns the full report text and the orchestrator persists it/);
  assert.match(verify, /a refused write needs no user ruling/);
});
