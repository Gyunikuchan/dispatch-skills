export class UsageError extends Error {}
export const SESSION_ACTIONS = ['init', 'reactivate', 'quota-reprobe'] as const;
const FLAGS = ['objective', 'session-dir', 'session-id', 'provider', 'model', 'mode', 'host'];

export function parseCommand(argv: readonly string[]): { action: string; flags: Record<string, string> } {
  const args = [...argv],
    command = args.shift();
  if (command !== 'session') throw new UsageError('Expected session');
  const out = { action: args.shift() ?? '', flags: {} as Record<string, string> };
  if (!(SESSION_ACTIONS as readonly string[]).includes(out.action))
    throw new UsageError(
      'session requires ' + SESSION_ACTIONS.slice(0, -1).join(', ') + ', or ' + SESSION_ACTIONS.at(-1),
    );
  let positional = false;
  while (args.length) {
    const token = args.shift()!;
    if (token === '--') {
      positional = true;
      break;
    }
    if (!token.startsWith('--')) throw new UsageError(`Unexpected argument ${token}; use -- before the objective`);
    const name = token.slice(2);
    if (!FLAGS.includes(name) || Object.hasOwn(out.flags, name))
      throw new UsageError(`Invalid or repeated flag ${token} for ${command}`);
    const value = args.shift();
    if (!value || value.startsWith('--')) throw new UsageError(`${token} requires a value`);
    out.flags[name] = value;
  }
  const need = (name: string) => {
    if (typeof out.flags[name] !== 'string') throw new UsageError(`--${name} is required`);
  };
  if (command === 'session') {
    if (out.action === 'init') need('objective');
    else need('session-dir');
    if (out.action !== 'quota-reprobe') need('host');
    const quotaFlags = ['provider', 'model', 'mode'];
    if (out.action === 'quota-reprobe') {
      need('provider');
      need('mode');
      if (positional || ['objective', 'session-id', 'host'].some((name) => out.flags[name] !== undefined))
        throw new UsageError('quota-reprobe accepts only session-dir, provider, model, and mode');
      for (const name of quotaFlags)
        if (out.flags[name] !== undefined && !String(out.flags[name]).trim())
          throw new UsageError(`--${name} requires a nonempty value`);
    } else if (quotaFlags.some((name) => out.flags[name] !== undefined))
      throw new UsageError('provider, model, and mode are for quota-reprobe');
  }
  return out;
}
