// Interpreter `start` for core tests: root runs read the shared on-disk spec, so they begin at the child's first frame.

import { dispatchMachine, start as rawStart } from '../../skills/dispatch/scripts/core/interpreter.ts';
import type { Effect, Handler } from '../../skills/dispatch/scripts/core/types.ts';
import { parseArtifact } from '../../skills/dispatch/scripts/effects/parse-artifact.ts';
import { rootMachine } from '../../skills/dispatch/scripts/machines/root.ts';
import { governed } from './spec-fixture.ts';

type Parse = Extract<Effect, { kind: 'parse-artifact' }>;

export const start: typeof rawStart = (options) => {
  if ((options.machine as unknown) !== rootMachine && (options.machine as unknown) !== dispatchMachine) return rawStart(options);
  // Spec reads use the real parser; a test's own parse handler still answers plan and design reads.
  const own = (options.handlers as Record<string, Handler<Parse> | undefined>)['parse-artifact'];
  const parse: Handler<Parse> = (effect, ports, ctx) => (effect.artifact === 'spec' || !own ? parseArtifact(effect, ports, ctx) : own(effect, ports, ctx));
  return rawStart({ ...options, handlers: { ...options.handlers, 'parse-artifact': parse }, runStarted: governed(options.runStarted) });
};
