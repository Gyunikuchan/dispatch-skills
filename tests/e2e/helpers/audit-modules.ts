// Test-side contracts of the declaration-less audit scripts: inputs stay `unknown`, results name what tests read.
import assert from 'node:assert/strict';
import type fs from 'node:fs';
import { isRecord } from '../../../skills/dispatch/scripts/lib/config.ts';

type Spawned = { stdout: string; stderr: string; status: number };
type TestRun = { output: string; status: number | null; signal: string | null; error: string | null; totals: string };
type BaselineModule = {
  main(options: unknown): Promise<void>;
  runTests(root: string, spawn: (cmd: string, args: ReadonlyArray<string>) => Spawned): TestRun;
};
type FinalizeModule = { main(options: unknown): void };
type Snapshot = { entries: { [file: string]: string }; gaps: Array<string> };
type SnapshotFs = Pick<typeof fs, 'lstatSync' | 'readlinkSync'> & { readFileSync: (file: string) => Buffer };
type SharedModule = {
  contentSnapshot(root: string, options?: { fs: SnapshotFs }): Snapshot;
  diffContent(before: Snapshot, after: Snapshot): Array<string>;
};

function exportsFunctions<T>(value: unknown, names: ReadonlyArray<keyof T & string>): value is T {
  return isRecord(value) && names.every((name) => typeof value[name] === 'function');
}

async function load<T>(script: string, names: ReadonlyArray<keyof T & string>): Promise<T> {
  const url = new URL('../../../.agents/skills/audit-dispatch-skills/scripts/' + script, import.meta.url);
  const loaded: unknown = await import(url.href);
  assert.ok(exportsFunctions<T>(loaded, names), script + ' no longer exports the tested helpers');
  return loaded;
}

export const baselineModule = () => load<BaselineModule>('baseline.mjs', ['main', 'runTests']);
export const finalizeModule = () => load<FinalizeModule>('finalize.mjs', ['main']);
export const sharedModule = () => load<SharedModule>('shared.mjs', ['contentSnapshot', 'diffContent']);
