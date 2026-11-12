import { measureBrief } from '../../scripts/brief-size.ts';
import { qualityBar, qualityCriteria } from '../../skills/dispatch/scripts/toolkit/domain/prompt.ts';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsePlan, selectTaskBrief } from '../../skills/dispatch/scripts/toolkit/domain/plan.ts';
import { parseDesign } from '../../skills/dispatch/scripts/toolkit/domain/design.ts';
import { parseSpec } from '../../skills/dispatch/scripts/toolkit/domain/spec.ts';
import { reviewPrompt } from '../../skills/dispatch/scripts/toolkit/prompts.ts';
import { renderWalkthrough } from '../../skills/dispatch/scripts/toolkit/walkthrough.ts';

const root = new URL('../../skills/dispatch/references/templates/', import.meta.url);
const KEPT = [
  'review-prompt.md', 'review-prompt-code.md', 'review-prompt-design.md', 'review-prompt-plan.md', 'plan.md', 'design.md', 'walkthrough.md', 'spec.md',
  'writer-brief.md', 'quality-bar.md', 'review-severity.md', 'context-map.md', 'explorer-brief.md', 'increment-orchestrator-brief.md', 'test-cleanup-brief.md', 'verifier-brief.md',
  'plan-field-notes.md',
];

test('code review evidence is actionable with and without a bound plan', () => {
  for (const planPath of [undefined, 'work.plan.md']) {
    const prompt = reviewPrompt('code', {skillRoot: path.resolve('skills/dispatch'), spec: {path: 'mission.spec.md', hash: 'sha256:' + 'a'.repeat(64)}, artifact: 'worktree', scope: 'Full review', turnTarget: 10, round: 1, ...(planPath ? {planPath} : {})});
    assert.ok(prompt.includes(`- Plan: ${planPath ?? 'None'}`));
    assert.doesNotMatch(prompt, /absent or unfilled table|<Walkthrough Path>/);
    assert.ok(prompt.includes('Walkthrough owns delivered behavior'));
    assert.match(prompt, /selected diff and tests/);
    assert.match(prompt, /does not establish that verification commands ran or final gates passed/);
  }
});

test('readable artifact templates: human layout sections, callouts, details and diagrams', async (t) => {
  for (const name of ['spec.md', 'design.md', 'plan.md', 'walkthrough.md']) {
    const template = readFileSync(new URL(name, root), 'utf8');
    const skeleton = template.split('````markdown\n')[1]!.split('````')[0]!;
    assert.equal(skeleton.match(/^## .+$/m)?.[0], '## At a Glance', name);
    if (name !== 'walkthrough.md') for (const type of ['NOTE', 'IMPORTANT']) assert.ok(template.includes(`[!${type}]`), `${name}: ${type}`);
    if (name !== 'spec.md') {
      assert.match(skeleton, /<details>\n/, name);
      assert.match(skeleton, /\n\n<\/details>/, name);
    }
    if (name === 'design.md') {
      assert.doesNotMatch(skeleton, /<summary>[^<]*<\/summary>/, name);
      const increment = skeleton.split('### I01\n')[1]!.split('\n## Final Integration')[0]!;
      assert.match(increment, /- <Observable behaviour this increment implements and how it works\.>\n\n<details>/);
      assert.doesNotMatch(increment, /<summary>/);
    }
    if (name === 'walkthrough.md') assert.match(skeleton, /<summary>Audit records<\/summary>/, name);
    if (name === 'plan.md') {
      const task = skeleton.split('### T<n> — <Task title>')[1]!.split('\n## Success Criteria')[0]!;
      assert.match(task, /- <Observable behaviour this task implements and how it works\.>[\s\S]*?<details>/);
      assert.doesNotMatch(task, /<summary>/);
      const criteria = skeleton.split('## Success Criteria\n')[1]!.split('\n## Verification Plan')[0]!;
      assert.match(criteria, /- \[SC1\] <checkable outcome>\n  <details>\n\n  - Satisfies:/);
      assert.doesNotMatch(criteria, /<summary>/);
    }
    if (name === 'plan.md' || name === 'design.md') {
      assert.match(skeleton, /```mermaid\n/, name);
      assert.match(skeleton, /Text summary: .+/, name);
    }
  }

  await t.test('design template parses under layered lint and preserves executable fields and exclusions', () => {
    const template = readFileSync(new URL('design.md', root), 'utf8').replace(/\r\n/g, '\n');
    assert.equal((template.match(/^> \*\*.*$/gm) ?? []).length, 4);
    assert.equal((template.match(/^>$/gm) ?? []).length, 3);
    const order = ['## At a Glance', '## Execution Status', '## Approach', '## Alternatives & Decisions', '## Risks, Security & Operations', '## Architecture & Boundaries', '## Increment Dependency Graph', '## Increment Details', '## Final Integration', '## Review Findings & Resolutions'];
    for (let i = 1; i < order.length; i++) assert.ok(template.indexOf(order[i]!) > template.indexOf(order[i - 1]!), order[i]);
    let source = template.split('````markdown\n')[1]!.split('````')[0]!;
    source = source.replace('<`<spec path>` · sha256:<hex>>', '`governing.spec.md` · sha256:' + 'a'.repeat(64))
      .replace('<low|med|high>', 'low').replace('<count>', '1')
      .replace(/\| I02 .*\n/, '').replace(/Next Action: .*\n/, 'Next Action: complete\n');
    source = source.replace('REQ-<n>', 'REQ-1').split('\n').map((line) => /^<\/?(?:details|summary)>/.test(line) ? line : line.replace(/<[^>]+>/g, 'Concrete behavior')).join('\n');
    const parsed = parseDesign(source);
    assert.ok(parsed.ok, JSON.stringify(parsed));
    assert.deepEqual(parsed.warnings.filter(({ code }) => ['missing-section', 'section-order', 'long-paragraph'].includes(code)), []);
    assert.equal(parsed.design.increments[0]!.id, 'I01');
    assert.deepEqual(parsed.warnings.filter(({ code }) => code === 'increment-behaviour'), []);
    assert.deepEqual(parsed.design.increments[0]!.behaviour, ['Concrete behavior']);
    assert.equal(parsed.design.details['I01']!['Outcome'], 'Concrete behavior');
    assert.ok(!parsed.design.governedText.includes('## Execution Status'));
    assert.ok(!parsed.design.governedText.includes('## Review Findings & Resolutions'));
  });

  await t.test('walkthrough template uses the reviewer-first layout', () => {
    const template = readFileSync(new URL('walkthrough.md', root), 'utf8').replace(/\r\n/g, '\n');
    assert.equal((template.match(/^> \*\*.*$/gm) ?? []).length, 0);
    assert.equal((template.match(/^>$/gm) ?? []).length, 0);
    assert.match(template, /^- \*\*How it works:\*\*/m);
    assert.match(template, /^- \*\*Counts:\*\*/m);
    const skeleton = template.split('````markdown\n')[1]!.split('````')[0]!;
    assert.match(skeleton, /### T<n> — <task title>\n\n- <observable behavior from this task>\n\n<details>/);
    assert.match(skeleton, /- `<relative-path>` · <created \| modified \| deleted>/);
    assert.doesNotMatch(skeleton, /#### \[|Changes:/);
    assert.match(skeleton, /<summary>Audit records<\/summary>/);
    assert.match(skeleton, /\| SC \| Evidence \|/);
    const labels = [...skeleton.matchAll(/^- \*\*(What|How it works|Counts):\*\*/gm)].map((match) => match[1]);
    assert.deepEqual(labels, ['What', 'How it works', 'Counts']);
    const headings = (text: string) => [...text.matchAll(/^##? .+$/gm)].map((match) => match[0]).filter((heading) => heading.startsWith('## '));
    assert.deepEqual(headings(skeleton), ['## At a Glance', '## Visuals', '## Review Focus', '## Behaviour Changes', '## Verification', '## Runtime Proof', '## Deviations & Follow-ups', '## Review Findings & Resolutions', '## Appendix']);
    const boxLabels = (text: string) => [...text.matchAll(/^> \*\*([^:]+):\*\*/gm)].map((match) => match[1]);
    assert.deepEqual(boxLabels(template), []);
    assert.match(template, /\[review rules\]\(\.\.\/review-rules.md\)/);

    const rendered = renderWalkthrough({
      title: 'Example', specPath: 'example.spec.md', specHash: `sha256:${'a'.repeat(64)}`,
      planPath: 'example.plan.md', planHash: `sha256:${'b'.repeat(64)}`, risk: 'med', delivered: null,
      glance: { what: 'The example shows the result.', how: 'The report reads the bound plan.', visuals: '' },
      focus: { bullets: [] },
      tasks: [{ id: 'T1', title: 'Add a file', outcome: 'The new file supports the feature.', behaviour: ['The report describes the feature.'] }],
      statuses: [{ criterion: 'SC1', state: 'manual', seq: 1, quote: 'approved', evidence: 'manual/proof.md' }],
      changes: [{ action: 'NEW', path: 'src/new.ts', owners: [{ id: 'T1', title: 'Add a file' }] }],
      edits: [], unplannedPaths: [], openEscalations: [], deferredRulings: [], userRecords: [],
      reviewRows: [], reviewRounds: [], reviewFixes: [],
    } as Parameters<typeof renderWalkthrough>[0]);
    assert.deepEqual(headings(skeleton), headings(rendered));
    const summaryLabels = (text: string) => [...text.matchAll(/^- \*\*(What|How it works|Counts):\*\*/gm)].map((match) => match[1]);
    assert.deepEqual(summaryLabels(skeleton), summaryLabels(rendered));
    assert.match(rendered, /### T1 — Add a file\n\n- The report describes the feature\.\n\n<details>\n\n- `src\/new\.ts` · created\n\n<\/details>/);
    assert.match(rendered, /### Manual\n\n- SC1 · User evidence: manual\/proof\.md; quote: approved/);
    assert.doesNotMatch(rendered, /#### \[|Changes:/);
  });

  await t.test('plan template parses under layered lint and preserves executable contracts', () => {
    const template = readFileSync(new URL('plan.md', root), 'utf8');
    const order = ['## At a Glance', '## Background', '## Key Interfaces & Data', '## Key Decisions & Context', '## Constraints', '## Open Questions & Assumptions', '## Out of Scope', '## Task Map', '## Technical-Design Traceability', '## Proposed Changes', '## Success Criteria', '## Verification Plan', '## Rollback & Blast Radius', '## Review Findings & Resolutions'];
    for (let i = 1; i < order.length; i++) assert.ok(template.indexOf(order[i]!) > template.indexOf(order[i - 1]!));
    assert.equal((template.match(/^> \*\*.*$/gm) ?? []).length, 4);
    assert.equal((template.match(/^>$/gm) ?? []).length, 3);
    assert.match(template, /- #### \[MODIFY\].*\n  - Changes:.*\n  - Invariants:/);
    for (const label of ['Omit optional empty prose sections', 'conditional fields', 'Pre-existing:', 'RED exception:', 'Enforcement infeasibility:', 'Integration:', 'Overlap:', 'Seams:']) assert.ok(template.includes(label));
    let source = template.split('````markdown\n')[1]!.split('````')[0]!;
    source = source.replace(/## Success Criteria[\s\S]*?(?=## Verification Plan)/, '## Success Criteria\n- [SC1] Output stays usable\n  - Satisfies: REQ-1\n  - Changes: src/new.ts, src/edit.ts, src/delete.ts, src/generated.ts\n  - Verify: `npm test`\n  - Evidence: verify\n\n');
    source = source.replace(/## Verification Plan[\s\S]*?(?=## Review Findings)/, '## Verification Plan\n### Automated Tests\n- `npm run lint`\n\n');
    const replacements: Record<string, string> = { '<Goal Description>': 'Check output', '<problem and outcome>': 'Keep output usable', '<`<design path>` · I<nn> | `<spec path>` · sha256:<hex>>': '`governing.spec.md` · sha256:' + 'a'.repeat(64), '<reader decision, or none>': 'none', '<low|med|high>': 'low', '<reason>': 'isolated change', '<paths or components>': 'src', 'T<n>': 'T1', '<Task title>': 'Keep output usable', '<Plain-language outcome>': 'Keep output usable.', '<Observable behaviour this task implements and how it works.>': 'Keep output usable.', '<optional task-specific constraints, including why each non-obvious prerequisite is needed>': 'Keep API.', 'SC<n>[, SC<n>...]': 'SC1', '<file-specific exception>': 'keep deprecated flag', '<generator command>': 'npm run generate', '<path> — <why this unordered task also writes the path>': 'src/edit.ts — shares the edit with an unordered task' };
    for (const [key, value] of Object.entries(replacements)) source = source.replaceAll(key, value);
    const paths = ['src/new.ts', 'src/edit.ts', 'src/delete.ts', 'src/generated.ts'];
    for (const file of paths) source = source.replace('<relative-path>', file);
    source = source.replace('<relative-path>[, <relative-path>...]', 'src/edit.ts');
    const result = parsePlan(source); assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(result.warnings.filter(({ code }) => ['missing-section', 'section-order', 'long-paragraph'].includes(code)), []);
    const brief = selectTaskBrief(result.plan, 'T1')!;
    assert.equal(brief.task.summary, 'Keep output usable.');
    assert.deepEqual(result.warnings.filter(({ code }) => code === 'task-behaviour'), []);
    assert.deepEqual(brief.task.behaviour, ['Keep output usable.']);
    assert.deepEqual(brief.task.constraints, ['Keep API.']);
    assert.match(brief.changes[1]!.note, /Invariants:.*exception: keep deprecated flag/);
    assert.deepEqual(brief.task.generated, [{ path: 'src/generated.ts', inputs: ['src/edit.ts'] }]);
  });

  await t.test('templates: spec template skeleton lints cleanly', () => {
    const template = readFileSync(new URL('spec.md', root), 'utf8').replace(/\r\n/g, '\n');
    const source = template.split('````markdown\n')[1]!.split('````')[0]!
      .replace('### REQ-<n> — <title>', '### REQ-1 — Concrete title').replace('### DEC-<n> — <title>', '### DEC-1 — Concrete title');
    const result = parseSpec(source);
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(result.warnings.filter(({ code }) => ['missing-section', 'section-order', 'long-paragraph'].includes(code)), []);
  });

});

test('templates: every kept template exists and none are extra', () => {
  const files = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.relative(fileURLToPath(root), path.join(entry.parentPath, entry.name)).replaceAll(path.sep, '/'));
  assert.deepEqual(files.sort(), [...KEPT].sort());
});

test('templates: no kept template contains <!--, rebuttal, or consensus', () => {
  for (const name of KEPT) {
    let text = readFileSync(new URL(name, root), 'utf8');
    if (name === 'quality-bar.md') {
      const stripped = text.split('\n').filter((line) => !/^\s*<!--\s*for:\s*[^>]+?-->\s*$/.test(line)).join('\n');
      assert.ok(!/<!--/.test(stripped), `${name} contains non-audience <!--`);
      for (const line of text.split('\n').filter((line) => line.includes('<!--'))) {
        assert.match(line, /^\s*<!--\s*for:\s*(code|plan|design|writer|cleanup|explorer|all|author)(,\s*(code|plan|design|writer|cleanup|explorer|all|author))*\s*-->\s*$/, `${name}: invalid audience tag ${line.trim()}`);
      }
      text = stripped;
    }
    if (name === 'explorer-brief.md') {
      const stripped = text.split('\n').filter((line) => !/^\s*<!--\s*\/?kind:\s*(map|research)\s*-->\s*$/.test(line)).join('\n');
      assert.ok(!/<!--/.test(stripped), `${name} contains non-kind <!--`);
      for (const line of text.split('\n').filter((line) => line.includes('<!--'))) {
        assert.match(line, /^\s*<!--\s*\/?kind:\s*(map|research)\s*-->\s*$/, `${name}: invalid kind tag ${line.trim()}`);
      }
      text = stripped;
    }
    for (const token of [/<!--/, /rebuttal/i, /consensus/i]) assert.ok(!token.test(text), `${name} contains ${String(token)}`);
  }
});

test('templates: plan.md owns task metadata in its map and keeps generated inputs under task details', () => {
  const plan = readFileSync(new URL('plan.md', root), 'utf8');
  for (const line of ['| ID | Title | Outcome | Prerequisites | Criteria |', '| T<n> | <Task title> | <Plain-language outcome> | none | SC<n>[, SC<n>...] |', '### T<n> — <Task title>', '- Constraints: <optional task-specific constraints, including why each non-obvious prerequisite is needed>', '- Inputs: <relative-path>[, <relative-path>...]', '  - Integration: <why this criterion spans tasks>']) {
    assert.ok(plan.includes(line), line);
  }
  assert.doesNotMatch(plan, /- Prerequisites:|^- Criteria:/m);
  assert.ok(!plan.includes('<Component Name>'));
});

test('review prompts offer shared family tags each defined by a quality-bar bullet', async (t) => {
  const { REVIEW_TAGS } = await import('../../skills/dispatch/scripts/toolkit/domain/report.ts');
  const families = [
    'intent', 'spec', 'correctness', 'reliability', 'security', 'performance', 'compatibility',
    'maintainability', 'architecture', 'decomposition', 'operability', 'testing', 'usability', 'standards', 'adjacent',
  ] as const;
  const expectedByKind: Record<'code' | 'plan' | 'design', readonly string[]> = {
    code: families.filter((family) => family !== 'architecture' && family !== 'decomposition'),
    plan: families,
    design: families,
  };
  const sorted = (tags: readonly string[]) => [...tags].sort();
  assert.deepEqual(sorted([...REVIEW_TAGS]), sorted(families), 'validator vocabulary');
  const quality = readFileSync(new URL('quality-bar.md', root), 'utf8');
  const specStage = readFileSync(new URL('../spec-stage.md', root), 'utf8');
  const section = (name: string) => quality.split(`## ${name}\n`)[1]!.split(/^## /m)[0]!;
  for (const rule of ['WCAG accessibility', 'POLA', 'Keep the existing format of rendered output unless a recorded user decision changes it.', 'state non-goals', 'State system-wide invariants that hold within and across increments', 'spoofing, tampering, repudiation, information disclosure, denial of service, and elevation of privilege', 'Map trust boundaries and least privilege', 'missing indexes', 'closed handles and resource closure', 'breaking changes', "Hyrum's law", 'semver', 'expand/contract migrations', 'rollback', 'version skew with graceful degradation', 'affected callers', 'persisted schemas and serialized formats', 'portability across OS, shell, path, and encoding', 'deployment and runtime operation', 'observability through logs, metrics, and traces', 'actionable diagnostics', 'configuration, and a kill switch']) assert.ok(section('shared').includes(rule), rule);
  assert.ok(section('code').includes('- **spec**'));
  for (const rule of ['- Artifact layout:', 'At a Glance', 'State each visible fact once; a summary must add a distinct view, not restate a later visible section.', 'A visible summary may restate collapsed `<details>` detail.', 'Keep task and increment behaviour visible before `<details>`', 'Keep machine fields outside callouts, prefer point form, and retain every required field.', '[!NOTE]', '[!IMPORTANT]']) assert.ok(section('spec').includes(rule), rule);
  const explorer = readFileSync(new URL('explorer-brief.md', root), 'utf8');
  for (const rule of ['Surprises', 'Not covered', '## Questions', '## Coverage checklist', '## Map, budget and output']) assert.ok(explorer.includes(rule), rule);
  // Evidence rule: one shared home, reached by every consumer, embedded in each rendered brief.
  const evidenceRule = quality.split('\n').filter((line) => line.startsWith('- Evidence:'));
  assert.equal(evidenceRule.length, 1);
  for (const term of ['sample inspected against the population', 'uncertainty', "search method's exclusions", 'direct evidence the host supports', 'mark it unverified']) assert.ok(evidenceRule[0]!.includes(term), term);
  for (const consumer of ['code', 'plan', 'design', 'writer'] as const) assert.ok(qualityCriteria(quality, consumer, 0, specStage).includes(evidenceRule[0]!), consumer);
  assert.ok(explorer.includes('{{quality}}'));
  assert.doesNotMatch(explorer, /\]\(/);
  const planGuidance = readFileSync(new URL('plan-field-notes.md', root), 'utf8');
  assert.ok(readFileSync(new URL('plan.md', root), 'utf8').includes('plan-field-notes.md'));
  for (const text of [evidenceRule[0]!, section('plan')]) assert.doesNotMatch(text, /\.codegraph|node_modules|\.gitignore|package\.json|\bnpm\b|\bjest\b|\bpytest\b/);
  assert.match(planGuidance, /Ownership names who changes the outcome, not who runs the evidence/);
  assert.match(planGuidance, /review-only criterion still completes by user manual-complete/);
  const frame = readFileSync(new URL('review-prompt.md', root), 'utf8');
  assert.ok(frame.includes('Verification evidence comes from the orchestrator; run no test or build commands.'));
  assert.ok(frame.includes('Inspect required callers, interfaces, host rules and governing material even outside Scope.'));
  assert.ok(frame.includes('Spend no extra turns hunting for adjacent findings.'));
  const revision = readFileSync(new URL('../spec-stage.md', root), 'utf8').split('## Revision protocol')[1]!;
  assert.ok(revision.includes('append an `edit` ledger record for each revision that admits a validated bound edit chain'));
  assert.ok(revision.includes('[toolkit edit contract](toolkit.md#edit)'));
  assert.ok(revision.includes('for a confirmed standalone spec revision that cannot, use the [note fallback](toolkit.md#note), which grants no edit or approval authority'));
  const codePrompt = readFileSync(new URL('review-prompt-code.md', root), 'utf8').replace(/\s+/g, ' ');
  for (const rule of ['With a plan, its `## Key Decisions & Context` entries are settled', 'An attached "Approved technical-design context"', 'Obey an explicit Git range in Scope', 'when the diff changes a shared invariant, contract, or signature']) assert.ok(codePrompt.includes(rule), rule);
  const explorerInputs: Record<string, string> = { objective: 'Map a shared interface change.', questions: '- Which callers and tests cover the interface?', limit: '150,000 tokens', nestedLaunch: 'model `claude-haiku-5-5`, effort `medium`', replyLimit: '8,192', outputPath: '.scratch/session/work.spec.context.md', cliPath: 'skills/dispatch/scripts/toolkit/cli.ts', session: '.scratch/session', mapBudget: '16,384', contextMapTemplate: readFileSync(new URL('context-map.md', root), 'utf8'), quality: qualityCriteria(quality, 'explorer', 0, specStage) };
  const renderedExplorer = explorer.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    assert.ok(Object.hasOwn(explorerInputs, name), name);
    return explorerInputs[name]!;
  });
  assert.ok(renderedExplorer.includes(evidenceRule[0]!));
  assert.ok(renderedExplorer.includes(readFileSync(new URL('context-map.md', root), 'utf8')));
  assert.doesNotMatch(renderedExplorer, /\{\{\w+\}\}/);
  assert.doesNotMatch(renderedExplorer, /\]\(/);
  t.diagnostic(`rendered explorer brief (fixed objective/questions/outputPath/cliPath/session/mapBudget/contextMapTemplate/quality): ${measureBrief(renderedExplorer).totalBytes} UTF-8 bytes; advisory only`);
  for (const name of ['quality-bar.md', 'explorer-brief.md']) t.diagnostic(`${name}: ${Buffer.byteLength(readFileSync(new URL(name, root), 'utf8'), 'utf8')} UTF-8 bytes`);
  t.diagnostic(`writer template + quality: ${Buffer.byteLength(readFileSync(new URL('writer-brief.md', root), 'utf8'), 'utf8') + Buffer.byteLength(qualityCriteria(quality, 'writer', 0, specStage), 'utf8')} UTF-8 bytes; baseline 9097, soft target <9000`);
  for (const [kind, baseline] of [['code', 15627], ['plan', 19533], ['design', 15297]] as const) t.diagnostic(`${kind} golden: ${Buffer.byteLength(readFileSync(new URL(`../fixtures/review-prompt-golden/${kind}.md`, import.meta.url), 'utf8'), 'utf8')} UTF-8 bytes; baseline ${baseline}`);
  for (const kind of ['code', 'plan', 'design'] as const) {
    const block = readFileSync(new URL(`review-prompt-${kind}.md`, root), 'utf8').split(/^## tags$/m)[1]!.split(/^## /m)[0]!;
    const offered = [...block.matchAll(/^- `([^`]+)`$/gm)].map((tag) => tag[1]!);
    assert.deepEqual(sorted(offered), sorted(expectedByKind[kind]), `${kind} prompt families`);
    const selectedQuality = qualityBar(quality, kind, 0, specStage);
    for (const family of offered.filter((tag) => tag !== 'standards' && tag !== 'adjacent')) {
      assert.equal(selectedQuality.split('\n').filter((line) => line.startsWith(`- **${family}** —`)).length, 1, `${kind}: ${family} quality bullet exactly once`);
    }
  }

  // Plan review decomposition checks
  const planPrompt = readFileSync(new URL('review-prompt-plan.md', root), 'utf8');
  assert.match(quality, /^- \*\*decomposition\*\* — .*A task that consumes another's output without a prerequisite is a defect\. Treat contention on a shared write path as a defect only when neither a `Requires` ordering nor a justified `Overlap:` line covers it\. Shared port, cache, or output contention needs a prerequisite\./m);
  assert.match(planPrompt, /The plan summary, success criteria and task graph/);

  // Searched equivalents and reuse checks
  const planTemplate = readFileSync(new URL('plan.md', root), 'utf8').replace(/\r\n/g, '\n');
  assert.match(planTemplate, /- #### \[NEW\] .*\n  - Purpose: .*\n  - Reuse: <existing equivalents searched and why not reused, or none found>\n/);
  const reuseRule = planTemplate.match(/^- Reuse:.*$/m)?.[0];
  assert.ok(reuseRule);
  assert.match(reuseRule, /\bnone found\b/);
  assert.match(reuseRule, /\[quality bar's shared reuse criterion\]\(quality-bar\.md#shared\)/);
  const maintainability = section('shared').split('\n').find((line) => line.startsWith('- **maintainability** —'));
  assert.ok(maintainability);
  assert.ok(maintainability.includes('search the repository by name and behaviour for an existing equivalent'));

  // Structural coupling/cohesion replaces textbook smells
  const codeMaintainability = qualityBar(quality, 'code', 0, specStage).split('\n').find((line) => line.startsWith('- **maintainability** —'));
  assert.ok(codeMaintainability);
  for (const term of ['shotgun surgery', 'divergent change', 'leaky abstractions', 'CQS', 'removes concrete concepts, files, or code paths', 'never `blocks` or `critical` alone']) assert.ok(codeMaintainability.includes(term), `missing ${term}`);
  for (const smell of ['Duplicated Code', 'Feature Envy', 'Data Clumps', 'Primitive Obsession', 'Repeated Switches', 'Message Chains', 'Middle Man', 'Speculative Generality', 'Refused Bequest', 'Mysterious Name']) assert.ok(!codeMaintainability.includes(smell), `stale ${smell}`);
  assert.ok(!codeMaintainability.includes('Smells (judgement calls'));

  // Unrequested consumer-boundary behaviour as intent
  const against = readFileSync(new URL('review-prompt-code.md', root), 'utf8').split(/^## against$/m)[1]?.split(/^## /m)[0]?.replace(/\s+/g, ' ');
  assert.ok(against);
  assert.ok(against.includes('Behaviour the diff adds that no REQ asks for at a consumer boundary (public API or CLI surface, outputs, persisted data, side effects, dependencies) is an `intent` finding; internal helpers and refactors are not.'));
  const rules = readFileSync(new URL('../review-rules.md', root), 'utf8');
  assert.ok(rules.includes('For an accepted unrequested-behaviour `intent` finding, the orchestrator removes the behaviour; keeping it changes intent and requires a recorded user quote through the [user gate](decision-frame.md#user-gate-boundaries).'));

  // Single-sourced judging rules
  assert.deepEqual([...quality.matchAll(/^## (.+)$/gm)].map((match) => match[1]), ['shared', 'spec', 'code', 'testing', 'plan', 'design']);
  const adjacentRule = 'Report concrete existing-code defects encountered in the selected target or during that required inspection';
  assert.equal(frame.split(adjacentRule).length - 1, 1);
  assert.doesNotMatch(quality, /Adjacent findings|nearest plan|nearest design/);
  assert.match(codePrompt, /cite code at its real `path:L<line>` locus/);
  for (const consumer of ['plan', 'design'] as const) {
    const kindPrompt = readFileSync(new URL(`review-prompt-${consumer}.md`, root), 'utf8');
    assert.match(kindPrompt, /Cite existing code as `path\/to\/file:L<line>` inside `defect`/);
  }
  assert.doesNotMatch(quality, /^- Standards:/m);
  for (const kind of ['plan', 'design']) {
    const prompt = readFileSync(new URL(`review-prompt-${kind}.md`, root), 'utf8');
    assert.doesNotMatch(prompt, /^## quality$/m);
    const tags = prompt.split('## tags')[1]!.split('## severity')[0]!;
    assert.ok(tags.includes('- `decomposition`'));
    assert.doesNotMatch(tags, /\u2014|findings/);
    for (const line of tags.split('\n').filter((line) => line.startsWith('- '))) assert.match(line.trimEnd(), /^- `[^`]+`$/);
  }
  for (const rule of ['Trace the ask to applicable REQs and DECs', 'search the repository by name and behaviour for an existing equivalent', "A task that consumes another's output without a prerequisite", 'Weigh alternatives and trade-offs']) assert.equal(quality.split(rule).length, 2, rule);
});

test('templates: test cleanup brief keeps the placeholders the orchestrator fills and the report block', () => {
  const brief = readFileSync(new URL('test-cleanup-brief.md', root), 'utf8');
  assert.deepEqual([...new Set(brief.match(/\{\{\w+\}\}/g))].sort(), ['{{base}}', '{{integrationPath}}', '{{planPath}}', '{{quality}}']);
  assert.ok(brief.includes('git diff <base>..HEAD'));
  assert.ok(brief.includes('{"removed": ["SC1"], "deleted": 0, "merged": 0}'));
  assert.ok(brief.includes('{{quality}}'));
  assert.doesNotMatch(brief, /\]\(/);
  const rendered = brief.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const slots: Record<string, string> = {base: 'abc1234', integrationPath: '.scratch/worktrees/integration', planPath: 'work.plan.md', quality: qualityCriteria(readFileSync(new URL('quality-bar.md', root), 'utf8'), 'cleanup', 0, readFileSync(new URL('../spec-stage.md', root), 'utf8'))};
    assert.ok(Object.hasOwn(slots, name), name);
    return slots[name]!;
  });
  assert.ok(rendered.includes('Run no Git write commands'));
  assert.doesNotMatch(rendered, /\{\{\w+\}\}/);
  assert.doesNotMatch(rendered, /\]\(/);
});

const LEAN_ANCHORS = [
  'Delete › reuse › stdlib or platform › installed dependency › new',
  'never add a dependency for a few lines',
  'Split by responsibility, never by length',
  'A fix or remedy is the smallest change that removes the defect',
  'prefer deletion; add no layer, config or dependency the defect does not need',
  'Simplicity floor: simplification never removes',
  'trust-boundary validation',
  'data-loss guards',
  'security or accessibility controls',
  'requested behaviour',
  'moved or merged code keeps its error handling and validation',
  'Judge scale against the expected load',
  'name the assumed load',
];

test('lean simplicity rules have one shared home reached by every quality consumer', () => {
  const quality = readFileSync(new URL('quality-bar.md', root), 'utf8');
  const leanStage = readFileSync(new URL('../spec-stage.md', root), 'utf8');
  const count = (text: string, needle: string) => text.split(needle).length - 1;
  for (const anchor of LEAN_ANCHORS) {
    assert.equal(count(quality, anchor), 1, `quality-bar: ${anchor}`);
    for (const consumer of ['code', 'plan', 'design', 'writer'] as const) assert.equal(count(qualityCriteria(quality, consumer, 0, leanStage), anchor), 1, `${consumer}: ${anchor}`);
  }
});

test('review prompt scope strings calibrate CLEAN, replace textbook smells, and reduce golden bytes', () => {
  const quality = readFileSync(new URL('quality-bar.md', root), 'utf8');
  const stage = readFileSync(new URL('../spec-stage.md', root), 'utf8');
  const baselines = { code: 15627, plan: 19533, design: 15297 } as const;
  const bytesByKind = {} as Record<'code' | 'plan' | 'design', number>;
  for (const kind of ['code', 'plan', 'design'] as const) {
    const golden = readFileSync(new URL(`../fixtures/review-prompt-golden/${kind}.md`, import.meta.url), 'utf8');
    const bytes = Buffer.byteLength(golden, 'utf8');
    bytesByKind[kind] = bytes;
    assert.ok(bytes < baselines[kind], `${kind} golden ${bytes} B not below pre-change baseline ${baselines[kind]} B`);
  }
  assert.ok(bytesByKind.plan <= baselines.plan - 2500, `plan golden ${bytesByKind.plan} B not reduced by 2500 B from ${baselines.plan} B`);
  assert.ok(bytesByKind.design <= baselines.design - 2500, `design golden ${bytesByKind.design} B not reduced by 2500 B from ${baselines.design} B`);
  const compiled = (['code', 'plan', 'design'] as const).map((kind) => qualityBar(quality, kind, 0, stage)).join('\n');
  const goldens = (['code', 'plan', 'design'] as const).map((kind) => readFileSync(new URL(`../fixtures/review-prompt-golden/${kind}.md`, import.meta.url), 'utf8')).join('\n');
  const hay = `${compiled}\n${goldens}`;
  for (const term of ['shotgun surgery', 'divergent change', 'leaky abstractions', 'CQS', 'removes concrete concepts, files, or code paths', 'never `blocks` or `critical` alone']) assert.ok(hay.includes(term), `missing coupling rule: ${term}`);
  for (const smell of ['Duplicated Code', 'Feature Envy', 'Data Clumps', 'Primitive Obsession', 'Repeated Switches', 'Message Chains', 'Middle Man', 'Speculative Generality', 'Refused Bequest', 'Mysterious Name']) assert.ok(!hay.includes(smell), `stale textbook smell: ${smell}`);
  assert.ok(!hay.includes('Smells (judgement calls'), 'stale smell prefix');
  for (const term of ['IEEE 29148', 'DRY', 'YAGNI', 'KISS', 'Rule of three', "Chesterton's fence", 'CQS', 'STRIDE', 'OWASP/CWE', 'TOCTOU', 'idempotency', 'fail-closed', 'Big-O', 'N+1', 'backpressure', "Hyrum's law", 'semver', 'expand/contract', 'WCAG', 'POLA', 'FIRST', 'INVEST']) assert.ok(hay.includes(term), `missing dense term: ${term}`);
  const codeDoc = readFileSync(new URL('review-prompt-code.md', root), 'utf8');
  assert.ok(codeDoc.includes('Full review — changed paths: <changed paths>; comparison: <base>..<head>'), 'code Round 1 scope');
  assert.ok(codeDoc.includes('Re-review round <n> (full|narrowed) — changed paths: <changed paths>; comparison: <prev>..<curr>'), 'code narrowed scope');
  assert.ok(codeDoc.includes('Re-review round <n> (coverage) — changed paths: <changed paths>; comparison: <base>..<head>'), 'code coverage scope');
  for (const name of ['review-prompt-plan.md', 'review-prompt-design.md'] as const) {
    const doc = readFileSync(new URL(name, root), 'utf8');
    assert.ok(doc.includes('Full review'), `${name} Round 1 scope`);
    assert.ok(doc.includes('Full review — changed: <changed sections>; comparison: <sha256>'), `${name} rerun scope with changed sections`);
    assert.ok(doc.includes('Full review — comparison: <sha256>'), `${name} rerun scope without changed sections`);
    assert.ok(doc.includes('Re-review round <n> (full|narrowed) — changed: <changed sections>; comparison: <prev>..<curr>'), `${name} narrowed scope`);
    assert.ok(!doc.includes('(coverage)'), `${name} omits coverage`);
    assert.ok(!doc.includes('(delta)'), `${name} omits delta`);
    assert.ok(!doc.includes('(full artifact)'), `${name} omits full artifact`);
  }
  const frame = readFileSync(new URL('review-prompt.md', root), 'utf8');
  assert.ok(frame.includes('expected high-signal'), 'frame CLEAN calibration');
  for (const kind of ['code', 'plan', 'design'] as const) {
    const doc = readFileSync(new URL(`review-prompt-${kind}.md`, root), 'utf8');
    assert.ok(doc.includes('expected high-signal'), `${kind} CLEAN calibration`);
    const opener = doc.split(/^## opener$/m)[1]?.split(/^## /m)[0] ?? '';
    assert.ok(opener.includes('expected high-signal'), `${kind} opener CLEAN`);
  }
});

test('deliberate shortcuts flow from writer report to walkthrough focus and review rulings', () => {
  const refs = new URL('../../skills/dispatch/references/', import.meta.url);
  const read = (name: string) => readFileSync(new URL(name, refs), 'utf8');
  const writer = read('templates/writer-brief.md');
  for (const anchor of ['List each deliberate shortcut under concerns as `Shortcut: <what>; limit: <limit>; upgrade when: <trigger>`.', 'A shortcut never crosses the simplicity floor.', 'Add a code comment for a limit only when']) assert.ok(writer.includes(anchor), anchor);
  const implement = read('verbs/implement.md');
  for (const anchor of ['Shortcut-only concerns need recording, not repair or escalation.', 'record them as focus bullets at any Risk', 'group shortcuts in one bullet that keeps each limit and trigger']) assert.ok(implement.includes(anchor), anchor);
  const rules = read('review-rules.md');
  for (const anchor of ['Reject a maintainability or performance finding against a writer-reported shortcut', 'unless the expected load crosses that limit', 'A shortcut that removes a simplicity-floor protection is a defect, not a shortcut.']) assert.ok(rules.includes(anchor), anchor);
  const walk = (dir: URL): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(new URL(`${e.name}/`, dir)) : e.name.endsWith('.md') ? [readFileSync(new URL(e.name, dir), 'utf8')] : []);
  const comment = 'Add a code comment for a limit only when';
  assert.equal(walk(refs).reduce((n, text) => n + text.split(comment).length - 1, 0), 1);
});
