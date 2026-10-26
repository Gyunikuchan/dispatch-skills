import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
const legacy = [/\bstart (ask|design|plan|implement|review)\b/, /\bsend --run\b/, /\brebind\b/, /^#+ Await\b/m, /\bAWAIT_/, /\bREVIEW_USE\b/, /\bFIXES_APPLIED\b/, /\bRULINGS\b/, /quiescen/, /\bjournal\b/, /\bAMEND\b/, /\bWRITE_RECEIPT\b/, /\bREQUEST\b/, /\bREPLACE_PLAN\b/, /\bbriefHash\b/, /\breceipt\b/, /\bamendment\b/i, /\benvelope\b/i];
function noLegacy(text: string, file: string) {
  for (const re of legacy) assert.doesNotMatch(text, re, file);
  const plain = text.replace(/\[[^\]]+\]\([^)]*\bdecision-frame\.md(?:#[^)]*)?\)/g, '').replace(/Decision Frame Format|Decision Frame/g, '');
  assert.doesNotMatch(plain, /\bframes?\b/i, file);
}
const section = (text: string, heading: string) => text.split('### ' + heading + '\n')[1]?.split(/\n#{1,3} /)[0] ?? '';

test('skill contract keeps router entries and resolving reference links', () => {
  const skill = read(root + 'SKILL.md');
  for (const file of refs.filter(v => v !== 'glossary' && v !== 'diagnostics')) assert.ok(links(skill).includes('references/' + file + '.md'), file);
  for (const file of [root + 'SKILL.md', ...markdown(root + 'references')]) for (const target of links(read(file))) {
    const local = target.split('#')[0]!;
    if (!local || /^(https?:|mailto:|<)/.test(local)) continue;
    assert.ok(fs.existsSync(path.resolve(OVERLAY_ROOT, path.dirname(file), local)), file + ' -> ' + target);
  }
});

test('mechanics-only references and report schemas are absent from the skill and its links', () => {
  const removed = ['references/change-handling.md', ...['write-brief', 'write-brief-task', 'write-brief-hotfix'].map(name => 'references/templates/' + name + '.md'), ...['code', 'plan', 'design'].map(kind => 'references/templates/schemas/report-' + kind + '.json')];
  const removedPaths = new Set(removed.map(file => path.resolve(OVERLAY_ROOT, root, file)));
  for (const file of removed) assert.equal(fs.existsSync(path.join(OVERLAY_ROOT, root, file)), false, file);
  for (const file of [root + 'SKILL.md', ...markdown(root + 'references')]) for (const target of links(read(file))) {
    assert.ok(!removedPaths.has(path.resolve(OVERLAY_ROOT, path.dirname(file), target.split('#')[0]!)), file + ' -> ' + target);
  }
});

test('plan guidance excludes removed mechanics while preserving the authored skeleton', () => {
  const plan = read(root + 'references/templates/plan.md').replace(/\r\n/g, '\n');
  const skeleton = /\x60{4}markdown\n([\s\S]*?)\n\x60{4}/.exec(plan)?.[1];
  assert.ok(skeleton);
  assert.equal(crypto.createHash('sha256').update(skeleton).digest('hex'), '7383e3467a0ecf3558929827fcf542e1132f53d9081318df043282fa53489734');
  const notes = plan.split('## Field notes\n')[1]!;
  for (const term of [/RED_READY/, /RED-MATRIX/, /checkpoint/i, /state\/runs/, /\btrim(?:med|ming|s)?\b/i, /\benvelope\b/i, /\bdriver\b/i, /\breceipts?\b/i, /briefHash/]) assert.doesNotMatch(plan, term);
  assert.doesNotMatch(read(root + 'references/templates/walkthrough.md'), /\bdriver\b/i);
  for (const field of ['Tests', 'RED', 'Retain', 'Automated Tests', '`[GENERATED]`']) assert.ok(notes.includes('- ' + field + ':'), field);
});

test('audit catalog points to surviving toolkit and reference entry points', () => {
  const catalog = JSON.parse(read('.agents/skills/audit-dispatch-skills/references/scenarios.json'));
  for (const scenario of catalog.scenarios) for (const entry of scenario.entries) {
    assert.doesNotMatch(entry, /scripts\/(?:core|domain|effects|machines)\/|scripts\/policy\/drift\.ts|write-brief(?:-task|-hotfix)?\.md/, scenario.id);
    assert.ok(fs.existsSync(path.join(OVERLAY_ROOT, entry)), scenario.id + ' -> ' + entry);
  }
});

test('skill contract owns action syntax and removes obsolete mechanics', () => {
  const toolkit = read(root + 'references/toolkit.md');
  const actions = toolkit.split('## Tool actions\n')[1]?.split('\n## ')[0] ?? '';
  assert.deepEqual([...actions.matchAll(/^### (.+)$/gm)].map(m => m[1]).sort(), [...TOOL_ACTIONS].sort());
  for (const action of TOOL_ACTIONS) for (const label of ['Arguments:', 'Result path:', 'Refusals:']) assert.ok(section(actions, action).includes(label), action + ' ' + label);
  assert.ok(toolkit.indexOf('## Session commands') > toolkit.indexOf('## Tool actions'));
  for (const file of scanned) {
    const text = read(root + file);
    noLegacy(text, file);
    assert.ok(!links(text).some(v => /(?:^|\/)change-handling\.md(?:#|$)/.test(v)), file);
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
    integrate: ['phase', 'opened', 'path', 'branch', 'base', 'dest', 'started', 'task', 'candidate', 'conflict', 'paths', 'done', 'commit', 'abandoned', 'reason', 'fix', 'deliver-started', 'mode', 'squash', 'from', 'source', 'to', 'delivered', 'closed'],
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
  assert.equal(fs.existsSync(path.join(OVERLAY_ROOT, 'tests/integration/driver-authority-contract.test.ts')), false);
});

test('aliases preserve entry mappings', () => {
  const mapping = {'dispatch-plan': 'plan', 'dispatch-implement': 'implement', 'dispatch-code-review': 'review --kind code'};
  for (const [name, verb] of Object.entries(mapping)) {
    const text = read('skills/' + name + '/SKILL.md');
    assert.ok(text.includes('`' + verb + '`'), name);
    assert.ok(text.includes('Missing dependency: dispatch is required by ' + name));
    noLegacy(text, name);
  }
  const review = read('skills/dispatch-code-review/SKILL.md');
  for (const term of ['target', 'argument', '--spec', 'bound spec']) assert.ok(review.includes(term), term);
  for (const file of [root + 'SKILL.md', ...markdown(root + 'references')]) assert.doesNotMatch(read(file), /\b(?:dispatch-plan|dispatch-implement|dispatch-code-review)\b/, file);
});

test('human configuration keeps level and workspace guidance', () => {
  const config = read(root + 'references/readme/configuration.md');
  for (const term of ['An explicit level stays in force', '`xhigh` and `max` remain user-selected', '`medium` is the normal level', '`high` requires a credible consequential risk', 'write-concurrency', '.scratch/dispatch-skills']) assert.ok(config.includes(term), term);
  assert.match(read(root + 'README.md'), /\^22\.18 \|\| >=23\.6/);
  assert.ok(links(read(root + 'references/templates/walkthrough.md')).includes('../review-rules.md'));
});

test('human manuals retain portable links and unchanged operational guidance', () => {
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
    'nativeSubagentsOnly', 'write-subagents', 'v0.7.x journals and frames are incompatible with the toolkit', 'OPENCODE_CONFIG_DIR', 'sandbox:false',
    'positive safe integer', 'omission defaults to one',
  ]) assert.ok(config.includes(term), term);
  assert.doesNotMatch(config, /OS temp|asks whether to adopt or retain/i);
  assert.match(config, /older plans without file ownership.*rewrite the plan and start a new run/);
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
    let text=read(root+name);
    if(name.endsWith('toolkit.md'))text=text.split(/\r?\n/).filter(line=>!/legacy/i.test(line)).join('\n');
    for(const term of ['squash commit','fast-forward','Dispatch-Source:','delivery-prepared','sole parent','to=from']) assert.ok(!text.includes(term),name+': '+term);
  }
  const concepts=read(root+'references/readme/concepts.md');
  assert.match(concepts,/delivered-source/);assert.match(concepts,/git restore --source/);
});
