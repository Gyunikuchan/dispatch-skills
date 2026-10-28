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
  assert.match(skill, /For `plan`.*multiple ordered increments.*recommend `design`/);
  assert.match(skill, /For `design`.*one coherent unit.*recommend `plan`/);
  assert.match(skill, /wait for the user's choice/);
  assert.match(skill, /Keep `ask`, `review` and `implement` on their requested verb/);
  assert.ok(skill.indexOf('Read the selected phase') < skill.indexOf('## Tool loop'));
  for (const branch of ['`ask`: follow', '`review`: resolve', '`design` or `plan`: resolve', '`implement`: resolve']) assert.ok(skill.includes(branch), branch);
  assert.match(skill, /Ask needs no spec, plan or approval/);
  assert.match(skill, /Standalone review adds no approval gate/);
  for (const file of refs.filter(v => v !== 'glossary' && v !== 'diagnostics')) assert.ok(links(skill).includes('references/' + file + '.md'), file);
  for (const file of [root + 'SKILL.md', ...markdown(root + 'references')]) for (const target of links(read(file))) {
    const local = target.split('#')[0]!;
    if (!local || /^(https?:|mailto:|<)/.test(local)) continue;
    assert.ok(fs.existsSync(path.resolve(OVERLAY_ROOT, path.dirname(file), local)), file + ' -> ' + target);
  }
});

test('plan guidance documents test retention and verification fields', () => {
  const plan = read(root + 'references/templates/plan.md').replace(/\r\n/g, '\n');
  const notes = plan.split('## Field notes\n')[1]!;
  for (const field of ['Tests', 'RED', 'Retain', 'Automated Tests', '`[GENERATED]`']) assert.ok(notes.includes('- ' + field + ':'), field);
});

test('audit catalog points to existing toolkit and reference entry points', () => {
  const catalog = JSON.parse(read('.agents/skills/audit-dispatch-skills/references/scenarios.json'));
  for (const scenario of catalog.scenarios) for (const entry of scenario.entries) {
    assert.ok(fs.existsSync(path.join(OVERLAY_ROOT, entry)), scenario.id + ' -> ' + entry);
  }
});

test('skill contract owns action syntax', () => {
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
});

test('skill contract documents ledger data and native reply and session contracts', () => {
  const toolkit = read(root + 'references/toolkit.md');
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

test('phase prose places each workflow rule in its canonical home', () => {
  const ref = (name: string) => read(root + 'references/' + name + '.md');
  for (const term of ['ask run', 'replyPath', 'rerun']) assert.ok(ref('verbs/ask').includes(term), term);
  for (const verb of ['design', 'plan']) for (const term of ['edit', 'before', 'after', 'class', 'diffRef', 'rationale', 'intent', 'dependency', 'discard', 'walkthrough']) assert.ok(ref('verbs/' + verb).includes(term), verb + ' ' + term);
  for (const term of ['only writers whose paths or criteria change', 'scope overrun', 'concerns', 'conflicts', 'red baselines', 'information with options']) assert.ok(ref('verbs/implement').includes(term), term);
  for (const term of ['review run', 'plan', 'design', 'code', 'integration', 'task ID', 'worktree', '<a>..<b>', '<rev>']) assert.ok(ref('verbs/review').includes(term), term);
  assert.match(ref('spec-stage'), /intent.*user quote/i);
  assert.match(ref('spec-stage'), /continue.*unaffected writers/i);
  assert.ok(ref('review-rules').includes('review:<review>:<finding>'));
  assert.match(ref('review-rules'), /ruling/);
  const decision = ref('decision-frame');
  for (const term of ['Conflict or blocker', 'Verified facts', 'Recommendation', 'Consequences', 'User Gate Boundaries', 'approval tuple']) assert.ok(decision.includes(term), term);
  for (const trigger of ['Spec approval', 'Plan or design approval', 'Intent finding', 'Writer scope request', 'Red baseline', 'Failed task', 'Optional findings', 'Concerns', 'Review escalation']) assert.ok(decision.includes('### ' + trigger), trigger);
  for (const term of ['doctor run', 'native-pending']) assert.ok(ref('providers').includes(term), term);
  for (const term of ['ledger', 'result file', 'tool']) assert.ok(ref('glossary').includes('**' + term + '**'), term);
});

test('aliases preserve entry mappings', () => {
  const mapping = {'dispatch-plan': 'plan', 'dispatch-implement': 'implement', 'dispatch-code-review': 'review --kind code'};
  for (const [name, verb] of Object.entries(mapping)) {
    const text = read('skills/' + name + '/SKILL.md');
    assert.ok(text.includes('`' + verb + '`'), name);
    assert.ok(text.includes('Missing dependency: dispatch is required by ' + name));
  }
  const review = read('skills/dispatch-code-review/SKILL.md');
  for (const term of ['target', 'argument', '--spec', 'bound spec']) assert.ok(review.includes(term), term);
  for (const file of [root + 'SKILL.md', ...markdown(root + 'references')]) assert.doesNotMatch(read(file), /\b(?:dispatch-plan|dispatch-implement|dispatch-code-review)\b/, file);
});

test('human configuration keeps level and concurrency guidance', () => {
  const config = read(root + 'references/readme/configuration.md');
  for (const term of ['An explicit level stays in force', '`xhigh` and `max` remain user-selected', '`medium` is the normal level', '`high` requires a credible consequential risk', 'write-concurrency']) assert.ok(config.includes(term), term);
  assert.match(read(root + 'README.md'), /\^22\.18 \|\| >=23\.6/);
  assert.ok(links(read(root + 'references/templates/walkthrough.md')).includes('../review-rules.md'));
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
    'after its plan and baseline are concrete, immediately before the first production write',
    'failures remain observable and recoverable', 'financial or data-integrity errors',
    'a small rate-precision change can',
    'A large diff, changed external contract, finance repository, or state-machine file alone does not require high',
    'Plan-only, ask, review-only, and design-authoring runs receive only the invocation assessment',
    'Retries, later phases, accepted scope changes, and later design increments keep the settled level',
    'nativeSubagentsOnly', 'write-subagents', 'OPENCODE_CONFIG_DIR', 'sandbox:false',
    'positive safe integer', 'omission defaults to one',
  ]) assert.ok(config.includes(term), term);
  assert.doesNotMatch(config, /OS temp|asks whether to adopt or retain/i);
  const humanRoot = read('README.md');
  assert.doesNotMatch(humanRoot, /--phases|clean tree falls back/i);
  for (const term of ['Ambient credential', 'invoke `implement:`']) assert.ok(humanRoot.includes(term), term);
  assert.match(read(root + 'references/templates/plan.md'), /retaining the session in the workspace/);
  for (const name of ['plan', 'walkthrough']) assert.doesNotMatch(read(root + 'references/templates/' + name + '.md'), /Resolution log/);
  const concepts = read(root + 'references/readme/concepts.md');
  for (const term of ['accepted prerequisites', 'Generated outputs', 'older baseline', 'setup-only', 'handles', 'already-delivered']) assert.ok(concepts.includes(term), term);
  assert.match(read(root + 'README.md'), /task summaries/);
  assert.match(read(root + 'references/readme/design.md'), /increments in order/);
});

test('uncommitted delivery contract', () => {
  const toolkit=section(read(root+'references/toolkit.md'),'worktree deliver');
  for(const term of ['uncommitted','unstaged','delivered-source','caller-dirty','recovery-blocked','unsupported-sparse','unsupported-entry','git restore --source','??','race limit','new run']) assert.ok(toolkit.includes(term),term);
  const names=['references/toolkit.md','references/verbs/implement.md','references/worktree-cleanup.md','references/readme/concepts.md','references/readme/implement.md'];
  for(const name of ['verbs/implement','worktree-cleanup','readme/implement']) assert.ok(links(read(root+'references/'+name+'.md')).some(link=>link.endsWith('toolkit.md#worktree-deliver')),name);
  for(const name of names){
    const text=read(root+name);
    for(const term of ['squash commit','fast-forward','Dispatch-Source:','delivery-prepared','sole parent','to=from']) assert.ok(!text.includes(term),name+': '+term);
  }
  const concepts=read(root+'references/readme/concepts.md');
  assert.match(concepts,/delivered-source/);assert.match(concepts,/git restore --source/);
});
