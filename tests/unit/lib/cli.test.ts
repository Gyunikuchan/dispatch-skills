import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALIASES, parseCommand, parseInvocation } from '../../../skills/dispatch/scripts/lib/cli.ts';
import { LEVELS, normalizeProvider, parsePins } from '../../../skills/dispatch/scripts/policy/roster.ts';
const policy = { levels: LEVELS, pins: parsePins, provider: (text: string) => ['codex', 'claude', 'agy', 'opencode', 'copilot'].includes(normalizeProvider(text)) ? normalizeProvider(text) : null };
const start = ['start', 'ask', '--session-dir', 'chat', '--orchestrator', 'codex'];
test('grammar-default-ask: default routes question; level and pins precede explicit verbs', () => {
  assert.deepEqual(parseInvocation('Why is this slow?', policy), { verb: 'ask', argument: 'Why is this slow?', level: null, pins: null });
  assert.deepEqual(parseInvocation('max (3) review: src/a.ts', policy), { verb: 'review', argument: 'src/a.ts', level: 'max', pins: '(3)' });
});
test('grammar-argument-required: prefix-only write verbs reject empty argument', () => {
  for (const verb of ['design', 'plan', 'implement', 'ask']) { assert.throws(() => parseInvocation(`${verb}:`, policy), /requires an argument/); assert.throws(() => parseCommand(['start', verb, '--session-dir', 'chat', '--orchestrator', 'codex'], policy), /requires an argument/); }
  assert.equal(parseInvocation('review:', policy).argument, '');
});
test('grammar-level-classification: classified effort excludes xhigh/max; explicit levels survive', () => {
  assert.equal(parseCommand([...start, '--', 'question'], policy).flags['level-source'], 'classified');
  assert.equal(parseCommand([...start, '--level', 'max', '--', 'question'], policy).flags['level-source'], 'explicit');
  for (const level of ['max', 'xhigh']) assert.throws(() => parseCommand([...start, '--level', level, '--level-source', 'classified', '--', 'question'], policy), /Classified/);
  assert.throws(() => parseCommand([...start, '--level', 'bogus', '--', 'q'], policy), /Invalid level/);
});
test('leaf CLI enforces flags, duplicate/value guards, providers, pins and command-local options', () => {
  for (const flag of ['--next', '--drive', '--state', '--check-envelope', '--no-config', '--json']) assert.throws(() => parseCommand([...start, flag, '--', 'q'], policy), /Invalid/);
  assert.throws(() => parseCommand([...start, '--level', '--', 'q'], policy), /requires a value/);
  assert.throws(() => parseCommand([...start, '--pins', '(all,3)', '--', 'q'], policy), /stand alone/);
  assert.throws(() => parseCommand(['status', '--run', 'r', '--event', '{}'], policy), /Invalid/);
  assert.equal(parseCommand(['send', '--run', 'r', '--dry-run', '--event', '{}'], policy).flags['dry-run'], true);
  assert.throws(() => parseCommand([...start, '--orchestrator', 'claude', '--', 'q'], policy), /repeated/);
  assert.throws(() => parseCommand([...start, '--timeout', 'NaN', '--', 'q'], policy), /positive/);
  for (const verb of ['ask', 'design', 'plan', 'implement']) assert.throws(() => parseCommand(['start', verb, '--session-dir', 'chat', '--orchestrator', 'codex', '--kind', 'code', '--', 'target'], policy), /--kind is for review/);
  for (const kind of ['code', 'design', 'plan']) assert.equal(parseCommand(['start', 'review', '--session-dir', 'chat', '--orchestrator', 'codex', '--kind', kind], policy).flags['kind'], kind);
});
test('compatibility alias parity uses public start mappings', () => {
  assert.deepEqual(Object.values(ALIASES), ['start review --kind code', 'start review --kind design', 'start review --kind plan', 'start implement']);
  for (const line of Object.values(ALIASES)) assert.equal(parseCommand([...line.split(' '), '--session-dir', 'chat', '--orchestrator', 'codex', '--', 'target'], policy).command, 'start');
});
