// Leaf command grammar; callers inject policy validation.
export type Verb = 'ask' | 'design' | 'plan' | 'review' | 'implement';
export type CliPolicy = { levels: readonly string[]; pins(text: string): unknown; provider(text: string): string | null };
export type Command = { command: 'start' | 'send' | 'status' | 'doctor' | 'session' | 'wave-worker' | 'checkpoint'; verb?: Verb; action?: string; argument: string; paths?: string[]; flags: Record<string, string | boolean> };
export class UsageError extends Error {}
export const ALIASES: Readonly<Record<string, string>> = {
  'dispatch-code-review': 'start review --kind code', 'dispatch-plan': 'start plan', 'dispatch-implement': 'start implement',
};
const VERBS: readonly Verb[] = ['ask', 'design', 'plan', 'review', 'implement'];
const FLAGS: Readonly<Record<string, readonly string[]>> = {
  start: ['session-dir', 'orchestrator', 'level', 'level-source', 'pins', 'fix', 'kind', 'provider', 'model', 'effort', 'timeout', 'orchestrator-model', 'verbose', 'context'],
  send: ['run', 'event', 'dry-run', 'refresh-config'], status: ['run'], doctor: ['level', 'json'],
  session: ['objective', 'session-dir', 'session-id'], 'wave-worker': ['run', 'effect', 'attempt'],
  checkpoint: ['root', 'out'],
};
const BOOLEANS = new Set(['fix', 'verbose', 'dry-run', 'json', 'refresh-config']);

export function parseCommand(argv: readonly string[], policy: CliPolicy): Command {
  const args = [...argv], command = args.shift();
  if (!command || !Object.hasOwn(FLAGS, command)) throw new UsageError('Expected start, send, status, doctor, session, checkpoint, or internal wave-worker');
  const out: Command = { command: command as Command['command'], argument: '', flags: {} };
  if (command === 'start') {
    const verb = args.shift();
    if (!VERBS.includes(verb as Verb)) throw new UsageError('start requires ask, design, plan, review, or implement');
    out.verb = verb as Verb;
  }
  if (command === 'session') {
    out.action = args.shift() ?? '';
    if (!['init', 'reactivate', 'handoff'].includes(out.action)) throw new UsageError('session requires init, reactivate, or handoff');
  }
  while (args.length) {
    const token = args.shift()!;
    if (token === '--') { out.argument = args.join(' ').trim(); out.paths = [...args]; break; }
    if (!token.startsWith('--')) throw new UsageError(`Unexpected argument ${token}; use -- before the objective`);
    const name = token.slice(2);
    if (!FLAGS[command]?.includes(name) || Object.hasOwn(out.flags, name)) throw new UsageError(`Invalid or repeated flag ${token} for ${command}`);
    if (BOOLEANS.has(name)) out.flags[name] = true;
    else {
      const value = args.shift();
      if (!value || value.startsWith('--')) throw new UsageError(`${token} requires a value`);
      out.flags[name] = value;
    }
  }
  const need = (name: string) => { if (typeof out.flags[name] !== 'string') throw new UsageError(`--${name} is required`); };
  if (out.flags['refresh-config'] && out.flags['event'] !== undefined) throw new UsageError('--refresh-config cannot be combined with --event');
  if (command === 'start') {
    need('session-dir'); need('orchestrator');
    if (!out.argument && out.verb !== 'review') throw new UsageError(`${out.verb} requires an argument`);
    const level = out.flags['level'];
    if (level !== undefined && !policy.levels.includes(String(level))) throw new UsageError('Invalid level');
    const source = out.flags['level-source'] ?? (level === undefined ? 'classified' : 'explicit');
    if (!['explicit', 'classified'].includes(String(source))) throw new UsageError('Invalid --level-source');
    if (source === 'classified' && (level === 'xhigh' || level === 'max')) throw new UsageError('Classified levels are low, medium, or high');
    out.flags['level-source'] = source;
    if (out.flags['pins']) policy.pins(String(out.flags['pins']));
    for (const key of ['provider', 'orchestrator']) if (out.flags[key] && !policy.provider(String(out.flags[key]))) throw new UsageError(`Unknown --${key}`);
    if (out.flags['provider'] && out.verb !== 'ask') throw new UsageError('--provider is for ask');
    if (out.flags['kind'] && !['code', 'design', 'plan'].includes(String(out.flags['kind']))) throw new UsageError('Invalid --kind');
    if (out.flags['kind'] && out.verb !== 'review') throw new UsageError('--kind is for review');
    if (out.flags['context'] && out.verb !== 'review') throw new UsageError('--context is for review');
    if (out.flags['timeout'] && (!Number.isFinite(Number(out.flags['timeout'])) || Number(out.flags['timeout']) <= 0)) throw new UsageError('--timeout must be positive seconds');
  }
  if (command === 'doctor' && out.flags['level'] && !policy.levels.includes(String(out.flags['level']))) throw new UsageError('Invalid level');
  if (command === 'send' || command === 'status' || command === 'wave-worker') need('run');
  if (command === 'wave-worker') { need('effect'); need('attempt'); if (!Number.isSafeInteger(Number(out.flags['attempt'])) || Number(out.flags['attempt']) < 1) throw new UsageError('Invalid worker attempt'); }
  if (command === 'checkpoint') { need('root'); need('out'); if (!out.paths?.length) throw new UsageError('checkpoint requires repository paths after --'); }
  if (command === 'session') { if (out.action === 'init') need('objective'); else need('session-dir'); }
  return out;
}

/** Host invocation grammar: optional level and pins, then verb prefix or default ask. */
export function parseInvocation(text: string, policy: CliPolicy): { verb: Verb; argument: string; level: string | null; pins: string | null } {
  let remaining = text.trim(), level: string | null = null, pins: string | null = null;
  const word = /^(\S+)\s*/.exec(remaining)?.[1];
  if (word && policy.levels.includes(word)) { level = word; remaining = remaining.slice(word.length).trim(); }
  const pin = /^\([^)]*\)/.exec(remaining)?.[0];
  if (pin) { policy.pins(pin); pins = pin; remaining = remaining.slice(pin.length).trim(); }
  const match = /^(ask|design|plan|review|implement)(?::|\s|$)\s*/.exec(remaining);
  const verb = match ? match[1] as Verb : 'ask';
  const argument = match ? remaining.slice(match[0].length).trim() : remaining;
  if (!argument && verb !== 'review') throw new UsageError(`${verb} requires an argument`);
  return { verb, argument, level, pins };
}
