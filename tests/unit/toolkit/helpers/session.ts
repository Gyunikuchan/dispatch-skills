import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CliDeps } from '../../../../skills/dispatch/scripts/toolkit/cli.ts';

export function sessionFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-'));
  const session = path.join(root, '20261023T0000Z-test');
  fs.mkdirSync(session);
  fs.writeFileSync(path.join(session, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, folderName: path.basename(session), sessionId: 'test', safeSessionId: 'test', repositoryRoot: root,
  }));
  const lines: string[] = [];
  const sleeps: number[] = [];
  const deps: CliDeps = {
    stdout: (line) => lines.push(line), env: {}, clock: () => 0,
    sleep: async (ms) => { sleeps.push(ms); }, pid: 42, host: 'test-host', isAlive: () => false,
    skillRoot: path.resolve('skills/dispatch'),
  };
  const artifact = (name: string, source: string) => { const file = path.join(root, name); fs.writeFileSync(file, source); return file; };
  return { root, session, lines, sleeps, deps, artifact,
    output: () => { if (lines.length !== 1) throw new Error('Expected one output line'); return JSON.parse(lines[0]!) as { ok: boolean; summary: string; path: string | null; reason?: string }; },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
