import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCommand } from '../../../skills/dispatch/scripts/lib/cli.ts';

test('quota reprobe validates its exact session action', () => {
  const args = ['session', 'quota-reprobe', '--session-dir', 'chat', '--provider', 'codex', '--mode', 'cli'];
  const command = parseCommand(args);
  assert.equal(command.action, 'quota-reprobe');
  assert.equal(command.flags['model'] ?? null, null);
  assert.equal(parseCommand([...args, '--model', '../literal alias']).flags['model'], '../literal alias');
  for (const name of ['session-dir', 'provider', 'mode']) {
    const index = args.indexOf('--' + name);
    assert.throws(() => parseCommand(args.filter((_, i) => i !== index && i !== index + 1)));
  }
  for (const extra of [['--objective', 'x'], ['--session-id', 'x'], ['--model', ' '], ['--provider', 'codex'], ['--', 'x'], ['--']]) assert.throws(() => parseCommand([...args, ...extra]));
  for (const action of ['init', 'reactivate']) for (const name of ['provider', 'model', 'mode']) {
    assert.throws(() => parseCommand(['session', action, ...(action === 'init' ? ['--objective', 'x'] : ['--session-dir', 'chat']), '--' + name, 'x']));
  }
});
