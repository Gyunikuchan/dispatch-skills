import assert from 'node:assert/strict';
import { test } from 'node:test';

import { diversitySort, nativeFirstRoute, parsePins, resolveLevel, resolveRoster, type ReadDelegate, type RosterInput } from '../../../skills/dispatch/scripts/policy/roster.ts';

const base: RosterInput = {
  level: 'high',
  readDelegates: {
    claude: { targets: [{ low: { model: 'claude-opus' } }, { low: { model: 'claude-sonnet' } }] },
    codex: { targets: [{ low: { model: 'gpt-5' } }, { low: { model: 'gpt-5-mini' } }] },
    agy: { targets: [{ low: { model: 'gemini-pro' } }] },
  },
  policy: { rounds: { low: 2 }, targets: { low: 3 } },
  orchestrator: { platform: 'claude' },
};
const slots = (roster: ReturnType<typeof resolveRoster>) => roster.targets.map((slot) => `${slot.slot}:${String(slot.model)}`);

// SECTION: Grammar and level resolution

test('grammar-sparse-level-maps: nearest lower level, else the lowest higher one', () => {
  assert.equal(resolveLevel({ low: 1, xhigh: 4 }, 'high'), 1);
  assert.equal(resolveLevel({ medium: 2, max: 5 }, 'low'), 2);
  assert.equal(resolveLevel({ high: 3 }, 'high'), 3);
  assert.equal(resolveLevel(undefined, 'high'), undefined);
});

test('grammar-pins: (a,b), (3), and (all) parse; count and all stand alone', () => {
  assert.deepEqual(parsePins('(Antigravity, codex)'), { kind: 'providers', keys: ['agy', 'codex'] });
  assert.deepEqual(parsePins('(3)'), { kind: 'count', count: 3 });
  assert.deepEqual(parsePins('(all)'), { kind: 'all' });
  assert.throws(() => parsePins('(2, codex)'), /stand alone/);
  assert.throws(() => parsePins('(0)'), /positive/);
  const pinned = resolveRoster({ ...base, pins: parsePins('(codex)') });
  assert.deepEqual(slots(pinned), ['codex[0]:gpt-5', 'codex[1]:gpt-5-mini']);
  assert.equal(resolveRoster({ ...base, pins: { kind: 'all' } }).targets.length, 5);
  assert.throws(() => resolveRoster({ ...base, pins: { kind: 'providers', keys: ['codex', 'typo'] } }), /typo/);
});

// SECTION: Diversity and identity

test('grammar-diversity-sort: every platform first once, orchestrator platform last in config order', () => {
  assert.deepEqual(diversitySort(['a1', 'a2', 'b1', 'c1', 'b2'], (item) => item[0]), ['a1', 'b1', 'c1', 'a2', 'b2']);
  // Wider host object, as the toolkit passes at runtime: the model must not affect ordering.
  const host = { platform: 'claude', model: 'claude-opus-20260101' };
  const roster = resolveRoster({ ...base, orchestrator: host, policy: { rounds: { low: 1 }, targets: { low: 'all' } } });
  assert.deepEqual(slots(roster), ['codex[0]:gpt-5', 'agy[0]:gemini-pro', 'codex[1]:gpt-5-mini', 'claude[0]:claude-opus', 'claude[1]:claude-sonnet']);
});

test('grammar-target-identity: positional provider[index] slots; reserves follow targets', () => {
  const roster = resolveRoster(base);
  assert.equal(roster.rounds, 2);
  assert.deepEqual(roster.targets.map((slot) => slot.slot), ['codex[0]', 'agy[0]', 'codex[1]']);
  assert.deepEqual(roster.reserves.map((slot) => [slot.slot, slot.reserve]), [['claude[0]', true], ['claude[1]', true]]);
  const { policy: _policy, ...standalone } = base;
  const single = resolveRoster(standalone);
  assert.deepEqual([single.rounds, single.targets.length], [1, 1]);
});

// SECTION: Filters and overrides

test('grammar-only-filter: phase only keeps listed platforms', () => {
  const roster = resolveRoster({ ...base, policy: { rounds: { low: 1 }, targets: { low: 'all' }, only: ['Claude-Code'] } });
  assert.deepEqual(roster.targets.map((slot) => slot.provider), ['claude', 'claude']);
});

test('grammar-override-collapse: -m/-e collapse each platform to one target carrying the override', () => {
  const roster = resolveRoster({ ...base, policy: { rounds: { low: 1 }, targets: { low: 'all' } }, overrides: { effort: 'high' } });
  assert.deepEqual(roster.targets.map((slot) => [slot.slot, slot.effort]), [['codex[0]', 'high'], ['agy[0]', 'high'], ['claude[0]', 'high']]);
});

test('grammar-native-subagents-only: such platforms serve only as the orchestrator native subagents', () => {
  const readDelegates = { ...base.readDelegates, copilot: { targets: [{ low: { model: 'gpt-4.1' } }], nativeSubagentsOnly: true } };
  const policy = { rounds: { low: 1 }, targets: { low: 'all' as const } };
  const elsewhere = resolveRoster({ ...base, readDelegates, policy });
  assert.ok(!elsewhere.targets.some((slot) => slot.provider === 'copilot'));
  const native = resolveRoster({ ...base, readDelegates, policy, orchestrator: { platform: 'copilot' } });
  assert.deepEqual(native.targets.filter((slot) => slot.provider === 'copilot').map((slot) => [slot.slot, slot.native]), [['copilot[0]', true]]);
});

// SECTION: Native-first route

test('native-first route runs a host delegate unless it opts out or stays native-only', () => {
  const targets = [{ low: { model: 'm' } }];
  const cases: Array<[string, string, Record<string, ReadDelegate>, { platform: string } | null, boolean]> = [
    ['host default', 'claude', { claude: { targets } }, { platform: 'claude' }, true],
    ['normalized key', 'claude', { 'Claude-Code': { targets } }, { platform: 'Claude-Code' }, true],
    ['normalized host', 'Claude-Code', { 'Claude-Code': { targets } }, { platform: 'claude' }, true],
    ['another provider', 'codex', { claude: { targets }, codex: { targets } }, { platform: 'claude' }, false],
    ['no host', 'claude', { claude: { targets } }, null, false],
    ['opt-out', 'claude', { claude: { nativeSubagents: false, targets } }, { platform: 'claude' }, false],
    ['native-only', 'claude', { claude: { nativeSubagentsOnly: true, targets } }, { platform: 'claude' }, false],
  ];
  for (const [name, provider, readDelegates, orchestrator, expected] of cases) {
    assert.equal(nativeFirstRoute(provider, readDelegates, orchestrator), expected, name);
  }
});

// SECTION: Underfill

test('underfill-native-exclusion: native-only providers of another host are listed once each in config order', () => {
  const readDelegates = { ...base.readDelegates, copilot: { targets: [{ low: { model: 'gpt-4.1' } }, { low: { model: 'gpt-4.1-mini' } }], nativeSubagentsOnly: true } };
  const policy = { rounds: { low: 1 }, targets: { low: 'all' as const } };
  assert.deepEqual(resolveRoster({ ...base, readDelegates, policy }).underfill, { host: 'claude', configured: 'all', resolved: 5, excluded: ['copilot'] });
  assert.deepEqual(resolveRoster({ ...base, readDelegates, policy, orchestrator: null }).underfill, { host: null, configured: 'all', resolved: 5, excluded: ['copilot'] });
  assert.deepEqual(resolveRoster({ ...base, policy: { rounds: { low: 1 }, targets: { low: 9 } } }).underfill, { host: 'claude', configured: 9, resolved: 5, excluded: [] });
  assert.equal(resolveRoster(base).underfill, undefined);
  assert.equal(resolveRoster({ ...base, readDelegates, orchestrator: { platform: 'copilot' } }).underfill, undefined);
});

// SECTION: Sandbox support

test('sandbox-unsupported provider leaves targets and reserves unless opted out or pinned', () => {
  const policy = { rounds: { low: 1 }, targets: { low: 2 } };
  const ids = (roster: ReturnType<typeof resolveRoster>) => [roster.targets.map((slot) => slot.slot), roster.reserves.map((slot) => slot.slot)];
  assert.deepEqual(ids(resolveRoster({ ...base, policy })), [['codex[0]', 'agy[0]'], ['codex[1]', 'claude[0]', 'claude[1]']]);
  // The next candidate takes the slot, and an absent entry means supported.
  assert.deepEqual(ids(resolveRoster({ ...base, policy, sandboxSupported: { codex: false } })), [['agy[0]', 'claude[0]'], ['claude[1]']]);
  // The orchestrator's own platform has no exemption.
  assert.deepEqual(ids(resolveRoster({ ...base, policy, sandboxSupported: { claude: false } })), [['codex[0]', 'agy[0]'], ['codex[1]']]);

  const optedOut = { ...base.readDelegates, codex: { sandbox: false, targets: [{ low: { model: 'gpt-5' } }] } };
  assert.deepEqual(ids(resolveRoster({ ...base, policy, readDelegates: optedOut, sandboxSupported: { codex: false } })), [['codex[0]', 'agy[0]'], ['claude[0]', 'claude[1]']]);

  const unsupported = { codex: false };
  assert.deepEqual(ids(resolveRoster({ ...base, policy, sandboxSupported: unsupported, pins: { kind: 'providers', keys: ['codex'] } })), [['codex[0]', 'codex[1]'], []]);
  assert.equal(resolveRoster({ ...base, policy, sandboxSupported: unsupported, pins: { kind: 'all' } }).targets.filter((slot) => slot.provider === 'codex').length, 2);
  assert.equal(resolveRoster({ ...base, policy, sandboxSupported: unsupported, pins: { kind: 'count', count: 5 } }).targets.filter((slot) => slot.provider === 'codex').length, 2);

  // A native slot runs as the host's own subagent, so no provider sandbox applies.
  const native = { copilot: { nativeSubagentsOnly: true, targets: [{ low: { model: 'gpt-4.1' } }] } };
  assert.deepEqual(ids(resolveRoster({ ...base, policy, readDelegates: native, orchestrator: { platform: 'copilot' }, sandboxSupported: { copilot: false } })), [['copilot[0]'], []]);
});

test('underfill names the sandbox gap once per provider and only when a provider left', () => {
  const dropped = resolveRoster({ ...base, sandboxSupported: { codex: false } });
  assert.deepEqual(dropped.underfill, { host: 'claude', configured: 3, resolved: 3, excluded: [], sandboxUnsupported: ['codex'] });
  assert.deepEqual(resolveRoster({ ...base, sandboxSupported: { codex: false, claude: false } }).underfill, { host: 'claude', configured: 3, resolved: 1, excluded: [], sandboxUnsupported: ['claude', 'codex'] });
  assert.equal(resolveRoster({ ...base, sandboxSupported: { codex: true } }).underfill, undefined);
  assert.deepEqual(resolveRoster({ ...base, policy: { rounds: { low: 1 }, targets: { low: 9 } }, sandboxSupported: {} }).underfill, { host: 'claude', configured: 9, resolved: 5, excluded: [] });
});
