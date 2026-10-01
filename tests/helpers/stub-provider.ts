// Scenario-owned stub reached only through fixture provider PATH shims.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
export type Scenario = { delayMs?: number; responses: unknown[] };
export type StubLaunch = { index: number; pid: number; prompt: string };
export function recordedLaunches(file: string): StubLaunch[] {
  const dir = `${file}.launches`;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => /^\d+$/.test(name)).sort((a, b) => Number(a) - Number(b)).flatMap((name) => {
    try { return [JSON.parse(fs.readFileSync(path.join(dir, name, 'launch.json'), 'utf8')) as StubLaunch]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  });
}
export async function stub(file: string, args: readonly string[]): Promise<void> {
  if (args[0] === 'debug') {
    process.stdout.write(JSON.stringify(args[1] === 'config' ? [] : [{ id: 'explore', permissions: [{ action: '*', resource: '*', effect: 'deny' }, { action: 'read', resource: '*', effect: 'allow' }] }]) + '\n'); return;
  }
  const scenario = JSON.parse(fs.readFileSync(file, 'utf8')) as Scenario;
  const dir = `${file}.launches`;
  fs.mkdirSync(dir, { recursive: true });
  let index = 0, recordDir: string;
  // Exclusive reservations give concurrent processes unique response indexes without rewriting the scenario.
  for (;;) {
    recordDir = path.join(dir, String(index));
    try { fs.mkdirSync(recordDir); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; index++; }
  }
  const raw = args.join(' '), brief = /Brief file:\s*(.+)$/.exec(raw)?.[1]?.trim();
  const prompt = brief && fs.existsSync(brief) ? fs.readFileSync(brief, 'utf8') : raw;
  fs.writeFileSync(path.join(recordDir, 'launch.tmp'), JSON.stringify({ index, pid: process.pid, prompt }));
  fs.renameSync(path.join(recordDir, 'launch.tmp'), path.join(recordDir, 'launch.json'));
  if (scenario.delayMs) await new Promise<void>((resolve) => setTimeout(resolve, scenario.delayMs));
  const output = scenario.responses[Math.min(index, scenario.responses.length - 1)];
  process.stdout.write(`${typeof output === 'string' ? output : JSON.stringify(output)}\n`);
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await stub(process.argv[2]!, process.argv.slice(3));
