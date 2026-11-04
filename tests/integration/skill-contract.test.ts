import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {TOOL_ACTIONS} from '../../skills/dispatch/scripts/toolkit/cli.ts';
import {KINDS} from '../../skills/dispatch/scripts/toolkit/records.ts';
import {OVERLAY_ROOT} from './scan.ts';
const root = 'skills/dispatch/';
const read = (file: string) => fs.readFileSync(path.join(OVERLAY_ROOT, file), 'utf8');
const refs = ['toolkit', 'spec-stage', 'review-rules', 'decision-frame', 'providers', 'worktree-cleanup', 'diagnostics', 'glossary', 'self-build', ...['ask', 'design', 'plan', 'implement', 'review'].map(v => 'verbs/' + v)];
const scanned = ['SKILL.md', ...refs.map(v => 'references/' + v + '.md')];
const links = (text: string) => [...text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map(m => m[1]!);
const markdown = (dir: string): string[] => fs.readdirSync(path.join(OVERLAY_ROOT, dir), {withFileTypes: true}).flatMap(e => e.isDirectory() ? markdown(dir + '/' + e.name) : e.name.endsWith('.md') ? [dir + '/' + e.name] : []);
const section = (text: string, heading: string) => text.split('### ' + heading + '\n')[1]?.split(/\n#{1,3} /)[0] ?? '';

test('skill contract keeps router entries and resolving reference links', () => {
  const skill = read(root + 'SKILL.md');
  assert.match(skill, /Recommend `plan` or `design` after intent refinement under \[spec stage\]\(references\/spec-stage\.md\)\./);
  assert.match(skill, /Keep `ask`, `review` and `implement` on their requested verb/);
  assert.ok(skill.indexOf('Read the selected phase') < skill.indexOf('## Tool loop'));
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
    escalation: ['id', 'state', 'summary'], ruling: ['subject', 'ruling', 'rationale'], note: ['text'],
    edit: ['artifact', 'before', 'after', 'class', 'affects', 'rationale', 'diffRef'],
    evidence: ['criterion', 'commandDigest', 'tree', 'clean', 'before', 'after', 'exit', 'path'],
    writer: ['phase', 'task', 'launched', 'path', 'base', 'commit', 'taskSection', 'seq', 'finished', 'launch', 'candidate', 'abandoned', 'reason'],
    integrate: ['phase', 'opened', 'path', 'branch', 'base', 'dest', 'started', 'task', 'candidate', 'conflict', 'paths', 'done', 'commit', 'abandoned', 'reason', 'fix', 'deliver-started', 'mode', 'from', 'source', 'delivered', 'closed'],
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

test('spec stage critiques the request premise before confirmation', () => {
  const stage = read(root + 'references/spec-stage.md');
  const groundStep = stage.indexOf('1. **Ground.**');
  const refineStep = stage.indexOf('2. **Critique and refine.**');
  const authorStep = stage.indexOf('3. **Author.**');
  const confirmStep = stage.indexOf('4. **Confirm.**');
  const refine = stage.split('2. **Critique and refine.**')[1]?.split('\n3. **Author.**')[0] ?? '';
  const author = stage.split('3. **Author.**')[1]?.split('\n4. **Confirm.**')[0] ?? '';
  const confirm = stage.split('4. **Confirm.**')[1]?.split('\n\n## ')[0] ?? '';

  assert.ok(groundStep >= 0 && refineStep > groundStep && authorStep > refineStep && confirmStep > authorStep, 'ground, critique, author and confirm in order');
  assert.match(refine, /materially better/i);
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
});

test('aliases preserve entry mappings', () => {
  const mapping = {'dispatch-plan': 'plan', 'dispatch-implement': 'implement', 'dispatch-code-review': 'review --kind code'};
  for (const [name, verb] of Object.entries(mapping)) {
    const text = read('skills/' + name + '/SKILL.md');
    assert.ok(text.includes('`' + verb + '`'), name);
    assert.ok(text.includes('Missing dependency: dispatch is required by ' + name));
  }
  const review = read('skills/dispatch-code-review/SKILL.md');
  assert.ok(review.includes('--spec'));
  for (const file of [root + 'SKILL.md', ...markdown(root + 'references')]) assert.doesNotMatch(read(file), /\b(?:dispatch-plan|dispatch-implement|dispatch-code-review)\b/, file);
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
  assert.ok(read(root + 'references/verbs/plan.md').includes('../grounding.md#scope-round'));
  assert.ok(read(root + 'references/verbs/design.md').includes('../grounding.md#scope-round'));
  assert.ok(explorer.includes('<slug>.spec.context.md'));
  assert.ok(explorer.includes('<slug>.plan.context.md'));
  for (const [name, text] of [['grounding.md', grounding], ['explorer-brief.md', explorer]] as const) {
    assert.ok(!text.includes('<slug>.context.md'), name + ' uses an unphased map path');
  }

  assert.ok(explorer.includes('## Host rules and tools'));
  assert.ok(explorer.includes('quality-bar.md#shared'));
  assert.ok(explorer.includes('../providers.md#native-slots'));
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
    ['Test cleanup', 'Utility subagent'], ['retro', 'Utility subagent'], ['mechanical fixes', 'Utility subagent'],
    ['Plan tasks', 'Writer at run level'], ['Differentiated review or ask voices', 'Delegate or native slot'],
    ['Decisions, rulings, ledger, user gates', 'Orchestrator'], ['submitted-change inspection', 'Orchestrator'],
  ] as const) assert.equal(route(work), target, work);
  assert.equal(rows.length, 5, 'five routes');
  assert.ok(links(routing).includes('references/toolkit.md#doctor-run'));
  for (const phrase of ['the `explore-subagents` entry, else the lowest `write-subagents` entry', 'Do explorer and utility work inline only when none resolves', 'A configured launch failure is a blocker, not a fallback trigger', 'edits only assigned paths and runs no Git write commands and no toolkit', 'Reviewers read directly and launch no explorers']) assert.ok(routing.includes(phrase), phrase);
  const guard = block('Context guard');
  for (const phrase of ['every verb', 'files, logs, web, command output, result files, diffs', 'a launch has a cost', 'known file, cited range, index query or small read', 'about 5 files or 500 lines', 'one explorer per independent topic in parallel', 'distilled, cited reply', 'verify load-bearing claims at source', 'Orchestrator-row work stays with the orchestrator at any size', 'including `ask`', 'Run `ask` only on user request']) assert.ok(guard.includes(phrase), phrase);
  const launch = block('Launch and continue');
  for (const phrase of ['Request fresh context without parent history', 'report that once in the final handoff', 'objective, decisions, constraints, current state, next action and required evidence', 'grant no write authority', 'Retain handles until the run ends or the host drops them', 'it keeps its model, write boundary and reply rules', 'A follow-up answer returns inline and writes no file', 'never rewrites `replyPath`, `reportPath` or an existing map', 'Launch fresh for an unrelated topic or when the host cannot continue', 'Never replace or duplicate work only for fresh context', 'creates no finding and no rejection confirmation', 'Reviewers are not continued across rounds', 'answers read-only', 'Two writers never share a worktree']) assert.ok(launch.includes(phrase), phrase);
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
  const step6 = ref('verbs/implement').split('\n6. ')[1]?.split('\n7. ')[0] ?? '';
  assert.doesNotMatch(step6, /--level low/);
  assert.match(step6, /utility subagent \(\[routing\]\(\.\.\/\.\.\/SKILL\.md#routing\)\) on doctor's `utility` host entry/);
  assert.match(step6, /runs only its edited test files/);
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
  for (const [file, anchor] of [['spec-stage.md','spec'], ['verbs/plan.md','plan'], ['verbs/design.md','design'], ['verbs/implement.md','code'], ['verbs/review.md','code']]) {
    const text = read(root + 'references/' + file);
    assert.ok(links(text).some(link => link.endsWith('quality-bar.md#' + anchor)), file);
    assert.ok(links(text).some(link => link.endsWith('quality-bar.md#shared')), file);
  }
});
