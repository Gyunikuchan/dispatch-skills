// Scenario-owned stub reached only through fixture provider PATH shims.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { errorCode } from './guards.ts';
export type Scenario = { delayMs?: number; responses: Array<unknown> };
export type StubLaunch = { index: number; pid: number; prompt: string };
type EventPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  text?: string;
  reason?: string;
  cost?: number;
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
};
function isStubLaunch(value: unknown): value is StubLaunch {
  return (
    typeof value === 'object' &&
    value !== null &&
    'index' in value &&
    typeof value.index === 'number' &&
    'pid' in value &&
    typeof value.pid === 'number' &&
    'prompt' in value &&
    typeof value.prompt === 'string'
  );
}
function isScenario(value: unknown): value is Scenario {
  return (
    typeof value === 'object' &&
    value !== null &&
    'responses' in value &&
    Array.isArray(value.responses) &&
    (!('delayMs' in value) || typeof value.delayMs === 'number')
  );
}
export function recordedLaunches(file: string): Array<StubLaunch> {
  const dir = `${file}.launches`;
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => /^\d+$/.test(name))
    .sort((a, b) => Number(a) - Number(b))
    .flatMap((name) => {
      try {
        const launch: unknown = JSON.parse(fs.readFileSync(path.join(dir, name, 'launch.json'), 'utf8'));
        assert.ok(isStubLaunch(launch), `invalid launch record ${name}`);
        return [launch];
      } catch (error) {
        if (errorCode(error) === 'ENOENT') {
          return [];
        }
        throw error;
      }
    });
}
export function completedLaunch(file: string, launch: StubLaunch): boolean {
  try {
    const receipt: unknown = JSON.parse(
      fs.readFileSync(path.join(`${file}.launches`, String(launch.index), 'done.json'), 'utf8'),
    );
    return (
      typeof receipt === 'object' &&
      receipt !== null &&
      'index' in receipt &&
      'pid' in receipt &&
      receipt.index === launch.index &&
      receipt.pid === launch.pid
    );
  } catch {
    return false;
  }
}
const event = (type: string, part: EventPart) =>
  JSON.stringify({ type, timestamp: 0, sessionID: 'stub-session', part });

export async function stub(file: string, args: ReadonlyArray<string>): Promise<void> {
  const inspectionArgs = args[0] === '--standalone' && args[1] === 'debug' ? args.slice(1) : args;
  if (inspectionArgs[0] === 'debug') {
    process.stdout.write(
      JSON.stringify(
        inspectionArgs[1] === 'config'
          ? []
          : [
              {
                id: 'explore',
                permissions: [
                  { action: '*', resource: '*', effect: 'deny' },
                  { action: 'read', resource: '*', effect: 'allow' },
                ],
              },
            ],
      ) + '\n',
    );
    return;
  }
  const scenario: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(isScenario(scenario), `invalid scenario ${file}`);
  const dir = `${file}.launches`;
  fs.mkdirSync(dir, { recursive: true });
  let index = 0,
    recordDir: string;
  // Exclusive reservations give concurrent processes unique response indexes without rewriting the scenario.
  for (;;) {
    recordDir = path.join(dir, String(index));
    try {
      fs.mkdirSync(recordDir);
      break;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw error;
      }
      index++;
    }
  }
  const raw = args.join(' '),
    brief = /Brief file:\s*(.+)$/.exec(raw)?.[1]?.trim();
  const prompt = brief && fs.existsSync(brief) ? fs.readFileSync(brief, 'utf8') : raw;
  fs.writeFileSync(path.join(recordDir, 'launch.tmp'), JSON.stringify({ index, pid: process.pid, prompt }));
  fs.renameSync(path.join(recordDir, 'launch.tmp'), path.join(recordDir, 'launch.json'));
  if (scenario.delayMs) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, scenario.delayMs);
    });
  }
  const output = scenario.responses[Math.min(index, scenario.responses.length - 1)];
  if (args.includes('--format') && args[args.indexOf('--format') + 1] === 'json') {
    // OpenCode JSON mode: one text event carries the scenario reply; tool output stays on the event stream.
    const text = typeof output === 'string' ? output : JSON.stringify(output);
    const stream = [
      event('text', { id: 'stub-text', sessionID: 'stub-session', messageID: 'stub-message', type: 'text', text }),
      event('step_finish', {
        id: 'stub-step',
        sessionID: 'stub-session',
        messageID: 'stub-message',
        type: 'step-finish',
        reason: 'stop',
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    ].join('\n');
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(`${stream}\n`, (error) => (error ? reject(error) : resolve()));
    });
  } else {
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(`${typeof output === 'string' ? output : JSON.stringify(output)}\n`, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }
  fs.writeFileSync(path.join(recordDir, 'done.tmp'), JSON.stringify({ index, pid: process.pid }));
  fs.renameSync(path.join(recordDir, 'done.tmp'), path.join(recordDir, 'done.json'));
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await stub(process.argv[2] ?? '', process.argv.slice(3));
}
