import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mock } from 'node:test';
import { memoryNodeFs } from '../../../helpers/memory-node-fs.ts';
import path from 'node:path';
import type { CliDeps } from '../../../../skills/dispatch/scripts/toolkit/cli.ts';
import type { ToolResult } from '../../../../skills/dispatch/scripts/toolkit/output.ts';
import type {
  DelegateRequest,
  ModeId,
  ProviderId,
  RunOutcome,
} from '../../../../skills/dispatch/scripts/providers/types.ts';
import { canonicalRepositoryRoot } from '../../../../skills/dispatch/scripts/lib/session.ts';
import { nodeLinkFs } from '../../../../skills/dispatch/scripts/lib/node-fs-ext.ts';
import { isRecord } from '../../../../skills/dispatch/scripts/lib/config.ts';

export function useMemoryAtomicWrite(): () => void {
  // Route artifact updates through the active in-memory filesystem.
  const write = mock.method(nodeLinkFs, 'writeAtomic', (file: string, text: string) => fs.writeFileSync(file, text));
  return () => write.mock.restore();
}

export function sessionFixture(options: { memory?: boolean } = {}) {
  const root = options.memory
    ? path.join(os.tmpdir(), 'toolkit-' + randomUUID())
    : fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-'));
  const restore = options.memory ? memoryNodeFs(root) : null;
  const session = path.join(root, '.scratch', 'dispatch-skills', '20261023T0000Z-test');
  fs.mkdirSync(session, { recursive: true });
  fs.writeFileSync(
    path.join(session, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      folderName: path.basename(session),
      sessionId: 'test',
      safeSessionId: 'test',
      repositoryRoot: canonicalRepositoryRoot(root),
    }),
  );
  const lines: Array<string> = [];
  const sleeps: Array<number> = [];
  const replies = new Map<string, RunOutcome>();
  const launches: Array<{ provider: ProviderId; request: DelegateRequest; mode: ModeId }> = [];
  const deps: CliDeps = {
    run: async () => {
      throw new Error('Unit tests must not spawn processes');
    },
    delegate: async (provider, request, mode) => {
      launches.push({ provider, request, mode });
      const outcome = replies.get(provider + ':' + request.model);
      if (!outcome) {
        throw new Error('Unscripted delegate ' + provider + ':' + request.model);
      }
      return { outcome, invocations: [] };
    },
    modes: () => ['cli'],
    orchestrator: null,
    liveness: { claude: true, agy: true, codex: true, copilot: true, opencode: true },
    stdout: (line) => lines.push(line),
    env: {},
    clock: () => 0,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    pid: 42,
    host: 'test-host',
    isAlive: () => false,
    skillRoot: path.resolve('skills/dispatch'),
  };
  const artifact = (name: string, source: string) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, source);
    return file;
  };
  const script = (provider: string, model: string, text: string | RunOutcome) =>
    replies.set(
      provider + ':' + model,
      typeof text === 'string' ? { status: 'ok', text, resume: null, sessionId: null } : text,
    );
  return {
    root,
    session,
    lines,
    sleeps,
    deps,
    artifact,
    script,
    launches,
    output: (): Omit<ToolResult, 'exit'> => {
      const [line] = lines;
      if (lines.length !== 1 || line === undefined) {
        throw new Error('Expected one output line');
      }
      const output: unknown = JSON.parse(line);
      if (!isRecord(output)) {
        throw new Error('Expected a toolkit response');
      }
      const { ok, summary, path, reason, hint } = output;
      if (
        typeof ok !== 'boolean' ||
        typeof summary !== 'string' ||
        (path !== null && typeof path !== 'string') ||
        (reason !== undefined && typeof reason !== 'string') ||
        (hint !== undefined && typeof hint !== 'string')
      ) {
        throw new Error('Invalid toolkit response');
      }
      return {
        ...output,
        ok,
        summary,
        path,
        ...(reason !== undefined && { reason }),
        ...(hint !== undefined && { hint }),
      };
    },
    cleanup: () => {
      if (restore) {
        restore();
      } else {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  };
}
