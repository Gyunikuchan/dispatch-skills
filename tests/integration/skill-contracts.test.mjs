import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

// Anchors load-bearing phrases in agent contracts so an edit cannot silently drop a gate.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const ALIASES = ['dispatch-plan-review', 'dispatch-code-review', 'dispatch-design-review', 'dispatch-implement'];

describe('dispatch SKILL.md', () => {
  const text = read('skills/dispatch/SKILL.md');

  it('owns the verb grammar and action loop', () => {
    assert.match(text, /ask\|plan\|design\|review\|implement/);
    for (const action of ['ask-user', 'author', 'launch', 'native-fallback', 'adjudicate', 'apply-fixes', 'delegate-write', 'verify', 'done']) {
      assert.match(text, new RegExp(`\\b${action}\\b`));
    }
    assert.match(text, /--help.*authoritative/s);
  });

  it('discloses review, implement, and design references', () => {
    for (const ref of ['references/review.md', 'verbs/implement.md', 'verbs/design.md']) assert.ok(text.includes(ref), ref);
  });

  it('keeps review fixes opt-in', () => {
    assert.match(text, /report-only unless the user explicitly supplied `--fix`/);
  });

  it('clarifies before authoring and writes one artifact', () => {
    assert.match(text, /`implement` without a plan path\), first clarify scope and solution with `brainstorming` if installed, then any user-invoked grilling skill; both stay in chat/);
    assert.match(text, /the driver's canonical artifact is the only plan or design written/);
  });
});

describe('companion aliases', () => {
  for (const name of ALIASES) {
    it(`${name} stays a small mapping-only alias`, () => {
      const text = read(`skills/${name}/SKILL.md`);
      assert.match(text, /^disable-model-invocation: true$/m);
      assert.ok(text.includes(`description: Use only when the user explicitly invokes \`/${name}\`.`));
      assert.match(text, new RegExp(`${name} requires the dispatch skill`));
      assert.ok(text.trim().split(/\s+/).length < 100, `${name} is not a small alias`);
      assert.doesNotMatch(text, /prepare-review\.mjs|parse-report\.mjs|check-consensus\.mjs|resolve-flow\.mjs|ledger-events|task-start|run-complete/);
    });
  }

  it('code-review alias does not inject fixes', () => {
    const text = read('skills/dispatch-code-review/SKILL.md');
    assert.match(text, /only when it appears in the user's invocation/);
    assert.match(text, /otherwise the review is report-only/);
  });
});

describe('shared review reference', () => {
  const text = read('skills/dispatch/references/review.md');

  it('keeps walkthrough sections', () => {
    for (const heading of ['Changes Made', 'Verification & Validation', 'Outcome Traceability', 'Key Deviations', 'Review Findings & Resolutions', 'Follow-ups']) {
      assert.ok(text.includes(heading), heading);
    }
  });

  it('keeps finality and application records', () => {
    for (const anchor of [/consensus: true/, /CONFIRM/, /application:/, /adjacent/]) assert.match(text, anchor);
  });
});

describe('implement reference', () => {
  const text = read('skills/dispatch/references/verbs/implement.md');

  it('owns ledger fold and recovery', () => {
    for (const anchor of [/Resolve and fold the ledger/, /run-start/, /run-complete/, /reconciliation/, /never relocated/]) assert.match(text, anchor);
  });

  it('maps evidence and baseline handling', () => {
    assert.match(text, /Extract approved paths, commands, criterion mappings, and `\[GENERATED\]` paths/);
    assert.match(text, /baseline/);
    assert.match(text, /known red — unchanged/);
  });

  it('keeps RED admission and evidence', () => {
    assert.match(text, /tests-only write subagent/);
    assert.match(text, /matrix row per red criterion/);
    assert.match(text, /driver observes the expected failure/);
    assert.match(text, /No read review gates RED/);
  });

  it('preserves failures and requires explicit rulings', () => {
    assert.match(text, /preserves and fingerprints the tree/);
    assert.match(text, /keep for repair, revert attributable paths, inspect first/);
    assert.match(text, /stable-failure/);
  });
});

describe('design reference', () => {
  const text = read('skills/dispatch/references/verbs/design.md');

  it('keeps approval and durable stop', () => {
    assert.match(text, /design-approved-stop/);
    assert.match(text, /Approval records design revision/);
  });

  it('runs one increment per invocation with amendments and later integration', () => {
    for (const anchor of [/One invocation runs one ledger-selected increment/, /Amendments/, /Final integration/, /later invocation/, /never relocate the ledger/]) {
      assert.match(text, anchor);
    }
  });
});

describe('plan template', () => {
  it('orders success criteria before proposed changes', () => {
    const text = read('skills/dispatch/references/templates/plan.md');
    assert.ok(text.indexOf('## Success Criteria') < text.indexOf('## Proposed Changes'));
    assert.match(text, /Changes:/);
    assert.match(text, /Verify:/);
  });
});
