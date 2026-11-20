import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { measureRuns, parsePairs, runMeasureRuns, type Comparison, type SideResult } from '../../scripts/measure-runs.ts';

const CREATED = '2020-01-01T00:00:00.000Z';
const E0 = Date.parse(CREATED);
const REVIEW = 'plan-fixture';
const SESSION = '20200101T0000Z-plan-fixture';
const PRICING = { asOf: '2026-11-19', source: ['https://example.test/pricing'], models: { m: { rates: { input: 2, output: 10 } } } };

type Fixture = { root: string; claudeConfig: string; env: NodeJS.ProcessEnv; cleanup: () => void };
type SideSpec = { session: string; host: string; nativeId?: string };
type MeasureOptions = { baseDir?: string; pricing?: string };

function fixture(): Fixture {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'measure-runs-')));
  const claudeConfig = path.join(root, 'claude-config');
  return { root, claudeConfig, env: { CLAUDE_CONFIG_DIR: claudeConfig }, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function writeText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const writeJson = (file: string, value: unknown) => writeText(file, `${JSON.stringify(value)}\n`);
const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
const reviewKey = (session: string) => `review-${digest(path.join(session, '.state', 'reviews', REVIEW))}`;
const subjectFor = (base: string, round: number) => digest(path.join(base, '.state', 'reviews', REVIEW, `round-${round}`, 'gen-1'));

function makeSession(fx: Fixture, options: { name?: string; sessionId?: string } = {}): string {
  const name = options.name ?? SESSION;
  const sessionId = options.sessionId ?? 'host-1';
  const session = path.join(fx.root, '.scratch', 'dispatch-skills', name);
  writeJson(path.join(session, 'manifest.json'), {
    schemaVersion: 1, folderName: name, sessionId, safeSessionId: sessionId, repositoryRoot: fx.root,
    sessionTitle: 'fixture', createdAt: CREATED, lastUsedAt: CREATED, location: 'workspace',
  });
  return session;
}

function writeRound(session: string, round: number, completed: boolean): void {
  const roundDir = path.join(session, '.state', 'reviews', REVIEW, `round-${round}`);
  writeJson(path.join(roundDir, 'round.json'), { round, generation: 1, cap: 4, roster: [] });
  fs.mkdirSync(path.join(roundDir, 'gen-1'), { recursive: true });
  if (completed) writeJson(path.join(roundDir, 'findings.json'), { review: REVIEW, round, cap: 4, findings: [] });
}

function writeCapture(session: string, name: string, capture: { start: number; end?: number }, phase: string | undefined, invocations: unknown[] = []): void {
  writeJson(path.join(session, '.state', 'diagnostics', `${name}.json`), {
    capture: { state: capture.end === undefined ? 'opened' : 'completed', ...capture },
    phases: phase ? [{ key: phase, name: 'plan review' }] : [], invocations, reviews: [],
  });
}

// NOTE: a reviewer run without usage is an unpriced unit, so the fixture records usage to keep cost complete.
const REVIEWER_USAGE = { input: 10, output: 5 };
// Standard fixture cost: two host rows (999/1 and 100/50) plus three reviewer runs, priced at PRICING rates.
const FIXTURE_COST = (999 * 2 + 1 * 10 + 100 * 2 + 50 * 10 + 3 * (REVIEWER_USAGE.input * 2 + REVIEWER_USAGE.output * 10)) / 1_000_000;
const reviewRun = (subject: string) => ({
  phase: 'review-run-plan', subject, attempt: 1, provider: 'claude', model: 'm', surface: 'cli', launched: true, outcome: 'ok', slot: 'claude[0]',
  usage: REVIEWER_USAGE,
});

// Two completed plan rounds and one unfinished round; `base` is the path string the recorded subjects hash.
function writeRoundFixture(session: string, base: string = session): void {
  for (const round of [1, 2, 3]) writeRound(session, round, round !== 3);
  writeCapture(session, 'review-1', { start: E0 + 1000, end: E0 + 4000 }, 'review-run-plan', [reviewRun(subjectFor(base, 1))]);
  writeCapture(session, 'ledger', { start: E0 + 2000, end: E0 + 2100 }, 'ledger-append');
  writeCapture(session, 'review-2', { start: E0 + 10000, end: E0 + 12000 }, 'review-run-plan', [reviewRun(subjectFor(base, 2))]);
  writeCapture(session, 'review-3', { start: E0 + 20000, end: E0 + 21000 }, 'review-run-plan', [reviewRun(subjectFor(base, 3))]);
}

const usageLine = (id: string, at: number, input: number, output: number) => JSON.stringify({
  type: 'assistant', timestamp: new Date(at).toISOString(), message: { id, model: 'm', usage: { input_tokens: input, output_tokens: output } },
});
const denialLine = (at: number, source: string) => JSON.stringify({
  type: 'user', timestamp: new Date(at).toISOString(), toolDenialKind: 'tool', permissionDecision: { decision: 'reject', source },
});

function writeClaudeTranscript(fx: Fixture, hostId: string, lines: string[], subagentLines: string[] = []): void {
  const projectDir = path.join(fx.claudeConfig, 'projects', 'project-a');
  writeText(path.join(projectDir, `${hostId}.jsonl`), `${lines.join('\n')}\n`);
  if (subagentLines.length) writeText(path.join(projectDir, hostId, 'subagents', 'agent-1.jsonl'), `${subagentLines.join('\n')}\n`);
}

function optionsFor(fx: Fixture, options: MeasureOptions) {
  return { baseDir: options.baseDir ?? fx.root, home: fx.root, env: fx.env, pricing: { path: 'pricing.json', text: options.pricing ?? JSON.stringify(PRICING) } };
}

function measureSides(fx: Fixture, sides: SideSpec[], options: MeasureOptions = {}): Comparison {
  const pairs = parsePairs({ pairs: [{ name: 'plan', sides: sides.map((side, index) => ({ label: `side-${index}`, ...side })) }] });
  return measureRuns(pairs, optionsFor(fx, options));
}

function measureOne(fx: Fixture, side: SideSpec, options: MeasureOptions = {}): SideResult {
  return measureSides(fx, [side], options).pairs[0]!.sides[0]!;
}

function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[path.relative(dir, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return files;
}

// Another path string for the same folder: a lowercase drive letter on Windows, otherwise a directory symlink.
function aliasOf(fx: Fixture, session: string): string | null {
  if (process.platform === 'win32') {
    const alias = session.replace(/^([A-Z]):/, (_match, drive: string) => `${drive.toLowerCase()}:`);
    return alias === session ? null : alias;
  }
  const link = path.join(fx.root, 'alias', path.basename(session));
  fs.mkdirSync(path.dirname(link), { recursive: true });
  try {
    fs.symlinkSync(session, link, 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  }
  return link;
}

function io(fx: Fixture, stdout: string[], stderr: string[]) {
  return { cwd: fx.root, home: fx.root, env: fx.env, stdout: (text: string) => stdout.push(text), stderr: (text: string) => stderr.push(text) };
}

test('measures rounds and per-round calls and host tokens for completed rounds only', () => {
  const fx = fixture();
  try {
    const session = makeSession(fx);
    writeRoundFixture(session);
    writeClaudeTranscript(fx, 'host-1', [usageLine('pre', E0 + 500, 999, 1), usageLine('a', E0 + 1500, 100, 50)]);
    const side = measureOne(fx, { session, host: 'claude' });
    const key = reviewKey(session);
    assert.equal(side.session, session);
    assert.equal(side.nativeId, 'host-1');
    assert.deepEqual(side.window, { startMs: E0, endMs: E0 + 21000, pathForm: 'canonical' });
    assert.deepEqual(side.rounds, { total: 2, byReview: { [key]: 2 } });
    assert.deepEqual(side.perRound, [
      { review: key, round: 1, calls: 2, hostTokens: 150 },
      { review: key, round: 2, calls: 1, hostTokens: 0 },
    ]);
    assert.equal(side.hostTokens, 1150);
    // Round 3 is unfinished: it stays out of the totals and is named as excluded.
    assert.deepEqual(side.unavailable, [`rounds: ${key} 3 excluded: no readable round result`]);
  } finally {
    fx.cleanup();
  }
});

test('measuring leaves session folders and host transcripts unchanged', () => {
  const fx = fixture();
  try {
    const session = makeSession(fx);
    writeRoundFixture(session);
    writeClaudeTranscript(fx, 'host-1', [usageLine('a', E0 + 1500, 100, 50)]);
    const before = snapshot(fx.root);
    measureOne(fx, { session, host: 'claude' });
    assert.deepEqual(snapshot(fx.root), before);
  } finally {
    fx.cleanup();
  }
});

test('a pre-session denial counts only in the headline and free text never counts; config and hook count separately', () => {
  const fx = fixture();
  try {
    const session = makeSession(fx);
    writeRoundFixture(session);
    writeClaudeTranscript(fx, 'host-1', [
      denialLine(E0 - 60000, 'config'),
      denialLine(E0 + 5000, 'config'),
      denialLine(E0 + 6000, 'hook'),
      denialLine(E0 + 7000, 'mystery'),
      'the call was denied, toolDenialKind noted in free text',
      JSON.stringify({ type: 'user', text: 'permission denied' }),
    ], [denialLine(E0 + 7500, 'config')]);
    const side = measureOne(fx, { session, host: 'claude' });
    assert.deepEqual(side.denials, { config: 3, hook: 1, other: 1, inWindow: { config: 2, hook: 1, other: 1 } });
  } finally {
    fx.cleanup();
  }
});

test('resolves a relative session against the pairs.json folder and attributes its rounds', () => {
  const fx = fixture();
  try {
    const session = makeSession(fx);
    writeRoundFixture(session);
    const pairsDir = path.join(fx.root, 'pairs');
    fs.mkdirSync(pairsDir);
    const side = measureOne(fx, { session: path.relative(pairsDir, session), host: 'claude' }, { baseDir: pairsDir });
    assert.equal(side.session, session);
    assert.equal(side.perRound[0]?.calls, 2);
  } finally {
    fx.cleanup();
  }
});

test('fails the run naming the side when the session folder is missing or the manifest is invalid', () => {
  const fx = fixture();
  try {
    const missing = path.join(fx.root, 'missing-session');
    assert.throws(() => measureSides(fx, [{ session: missing, host: 'claude' }]), /pair "plan" side "side-0": session folder missing/);
    const session = makeSession(fx);
    writeJson(path.join(session, 'manifest.json'), { schemaVersion: 1, folderName: 'other-name', sessionId: 'host-1', safeSessionId: 'host-1', repositoryRoot: fx.root });
    assert.throws(() => measureSides(fx, [{ session, host: 'claude' }]), /pair "plan" side "side-0": Session manifest/);
  } finally {
    fx.cleanup();
  }
});

test('measures a session given through an alias of its canonical folder', (t) => {
  const fx = fixture();
  try {
    const session = makeSession(fx);
    const alias = aliasOf(fx, session);
    if (!alias) {
      t.skip('no alias path can be created on this host');
      return;
    }
    writeRoundFixture(session);
    const side = measureOne(fx, { session: alias, host: 'claude' });
    assert.equal(side.session, session);
    assert.equal(side.window.pathForm, 'canonical');
    assert.equal(side.perRound[0]?.calls, 2);
  } finally {
    fx.cleanup();
  }
});

test('retries with the path as given when the captures recorded that path form', (t) => {
  const fx = fixture();
  try {
    const session = makeSession(fx);
    const alias = aliasOf(fx, session);
    if (!alias) {
      t.skip('no alias path can be created on this host');
      return;
    }
    writeRoundFixture(session, alias);
    const side = measureOne(fx, { session: alias, host: 'claude' });
    assert.equal(side.window.pathForm, 'as-given');
    assert.equal(side.perRound[0]?.calls, 2);
    assert.equal(side.perRound[0]?.review, reviewKey(alias));
  } finally {
    fx.cleanup();
  }
});

test('a moved session keeps its rounds but drops per-round calls with a no round starts reason', () => {
  const fx = fixture();
  try {
    const session = makeSession(fx);
    writeRoundFixture(session, path.join(fx.root, 'old-folder'));
    writeClaudeTranscript(fx, 'host-1', [usageLine('a', E0 + 1500, 100, 50)]);
    const side = measureOne(fx, { session, host: 'claude' });
    const key = reviewKey(session);
    assert.equal(side.rounds.total, 2);
    assert.deepEqual(side.perRound, [{ review: key, round: 1 }, { review: key, round: 2 }]);
    assert.deepEqual(side.unavailable, [
      `rounds: ${key} 3 excluded: no readable round result`,
      `perRound: ${key} 1 calls: no round starts`, `perRound: ${key} 1 hostTokens: no round starts`,
      `perRound: ${key} 2 calls: no round starts`, `perRound: ${key} 2 hostTokens: no round starts`,
    ]);
  } finally {
    fx.cleanup();
  }
});

test('a Claude side without a host transcript reports the missing transcript and partial cost', () => {
  const fx = fixture();
  try {
    const session = makeSession(fx);
    writeRoundFixture(session);
    const side = measureOne(fx, { session, host: 'claude' });
    assert.deepEqual(side.denials, { unavailable: 'host transcript missing' });
    assert.equal(side.hostTokens, undefined);
    assert.equal(side.cost.partial, true);
    assert.ok(side.unavailable.includes('denials: host transcript missing'));
    assert.ok(side.unavailable.includes('hostTokens: host id file missing'));
  } finally {
    fx.cleanup();
  }
});

test('an agy side reports no denial marker and no host tokens', () => {
  const fx = fixture();
  try {
    const session = makeSession(fx);
    writeRoundFixture(session);
    const side = measureOne(fx, { session, host: 'agy', nativeId: 'conv-1' });
    assert.deepEqual(side.denials, { unavailable: 'no denial marker' });
    assert.equal(side.hostTokens, undefined);
    assert.equal(side.cost.partial, true);
    assert.ok(side.unavailable.includes('denials: no denial marker'));
  } finally {
    fx.cleanup();
  }
});

test('nativeId selects the host transcript instead of the manifest session id', () => {
  const fx = fixture();
  try {
    const session = makeSession(fx, { sessionId: 'manifest-id' });
    writeRoundFixture(session);
    writeClaudeTranscript(fx, 'native-1', [usageLine('a', E0 + 1500, 100, 50)]);
    const side = measureOne(fx, { session, host: 'claude', nativeId: 'native-1' });
    assert.equal(side.nativeId, 'native-1');
    assert.equal(side.hostTokens, 150);
  } finally {
    fx.cleanup();
  }
});

test('prices every host and reviewer unit from the given pricing table and ignores a config pricing override', () => {
  const fx = fixture();
  try {
    const session = makeSession(fx);
    writeRoundFixture(session);
    writeClaudeTranscript(fx, 'host-1', [usageLine('pre', E0 + 500, 999, 1), usageLine('a', E0 + 1500, 100, 50)]);
    writeJson(path.join(fx.root, 'skills', 'dispatch', 'config.local.jsonc'), { pricing: { m: { rates: { input: 1000, output: 1000 } } } });
    const side = measureOne(fx, { session, host: 'claude' });
    assert.equal(side.cost.priced, true);
    assert.equal(side.cost.partial, false);
    assert.ok(Math.abs(side.cost.low - FIXTURE_COST) < 1e-12, `${side.cost.low} vs ${FIXTURE_COST}`);
    assert.equal(side.cost.high, side.cost.low);
  } finally {
    fx.cleanup();
  }
});

test('an unpriced host unit with usage available marks cost partial', () => {
  const fx = fixture();
  try {
    const session = makeSession(fx);
    writeRoundFixture(session);
    writeClaudeTranscript(fx, 'host-1', [usageLine('a', E0 + 1500, 100, 50)]);
    const otherOnly = JSON.stringify({ ...PRICING, models: { other: { rates: { input: 1, output: 1 } } } });
    const side = measureOne(fx, { session, host: 'claude' }, { pricing: otherOnly });
    assert.equal(side.cost.priced, false);
    assert.equal(side.cost.partial, true);
    assert.ok(side.cost.reasons.includes('unpriced model'));
  } finally {
    fx.cleanup();
  }
});

test('a priced delegate unit with transcript-unavailable coverage marks cost partial with its reason', () => {
  const fx = fixture();
  try {
    const session = makeSession(fx);
    writeRoundFixture(session);
    writeClaudeTranscript(fx, 'host-1', [usageLine('a', E0 + 1500, 100, 50)]);
    writeCapture(session, 'delegate', { start: E0 + 3000, end: E0 + 3500 }, undefined, [{
      phase: 'delegate-run', attempt: 1, provider: 'claude', model: 'm', mode: 'cli', surface: 'cli', launched: true,
      outcome: 'ok', slot: 'claude[1]', usage: { input: 100, output: 50 }, coverage: ['transcript unavailable'],
    }]);
    const side = measureOne(fx, { session, host: 'claude' });
    assert.equal(side.cost.priced, true);
    assert.equal(side.cost.partial, true);
    assert.ok(side.cost.reasons.includes('delegate coverage: transcript unavailable'));
  } finally {
    fx.cleanup();
  }
});

test('a missing pricing file fails the run naming the file', () => {
  const fx = fixture();
  try {
    const session = makeSession(fx);
    writeRoundFixture(session);
    writeJson(path.join(fx.root, 'pairs.json'), { pricing: 'missing/pricing.json', pairs: [{ name: 'plan', sides: [{ label: 'historical', session, host: 'claude' }] }] });
    const stdout: string[] = [], stderr: string[] = [];
    assert.equal(runMeasureRuns([path.join(fx.root, 'pairs.json'), '--out', path.join(fx.root, 'out')], io(fx, stdout, stderr)), 1);
    assert.match(stderr.join(''), /missing[\\/]pricing\.json/);
    assert.equal(fs.existsSync(path.join(fx.root, 'out', 'comparison.json')), false);
  } finally {
    fx.cleanup();
  }
});

// Runs the CLI for one side; pricing.json and pairs.json sit in the fixture root, which is the working directory.
function runSingleSide(fx: Fixture, session: string, out: string): { code: number; stderr: string } {
  writeJson(path.join(fx.root, 'pricing.json'), PRICING);
  writeJson(path.join(fx.root, 'pairs.json'), { pricing: 'pricing.json', pairs: [{ name: 'plan', sides: [{ label: 'historical', session, host: 'claude' }] }] });
  const stdout: string[] = [], stderr: string[] = [];
  const code = runMeasureRuns([path.join(fx.root, 'pairs.json'), '--out', out], io(fx, stdout, stderr));
  return { code, stderr: stderr.join('') };
}

test('refuses an --out folder inside a measured session folder before writing', () => {
  const fx = fixture();
  try {
    const session = makeSession(fx);
    writeRoundFixture(session);
    writeClaudeTranscript(fx, 'host-1', [usageLine('a', E0 + 1500, 100, 50)]);
    const out = path.join(session, 'comparison');
    const result = runSingleSide(fx, session, out);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /--out must not be inside or equal a measured session folder/);
    assert.equal(fs.existsSync(out), false);
  } finally {
    fx.cleanup();
  }
});

test('refuses an --out folder inside or equal to a host store before writing', () => {
  const fx = fixture();
  try {
    const session = makeSession(fx);
    writeRoundFixture(session);
    writeClaudeTranscript(fx, 'host-1', [usageLine('a', E0 + 1500, 100, 50)]);
    for (const out of [path.join(fx.claudeConfig, 'comparison'), fx.claudeConfig]) {
      const result = runSingleSide(fx, session, out);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /--out must not be inside or equal a host store/);
    }
    assert.equal(fs.existsSync(path.join(fx.claudeConfig, 'comparison')), false);
  } finally {
    fx.cleanup();
  }
});

test('a corrupt capture marks cost partial and calls and host tokens partial in the entries and comparison.md', () => {
  const fx = fixture();
  try {
    const session = makeSession(fx);
    writeRoundFixture(session);
    writeClaudeTranscript(fx, 'host-1', [usageLine('a', E0 + 1500, 100, 50)]);
    writeJson(path.join(session, '.state', 'diagnostics', 'broken.json'), { unexpected: true });
    const side = measureOne(fx, { session, host: 'claude' });
    assert.equal(side.cost.priced, true);
    assert.equal(side.cost.partial, true);
    assert.deepEqual(side.cost.reasons, ['captures partial']);
    assert.ok(side.unavailable.includes('perRound calls partial: captures partial (1)'));
    assert.ok(side.unavailable.includes('hostTokens partial: captures partial (1)'));
    const out = path.join(fx.root, 'out');
    assert.equal(runSingleSide(fx, session, out).code, 0);
    const md = fs.readFileSync(path.join(out, 'comparison.md'), 'utf8');
    assert.match(md, /^\| Calls in rounds \| 3 \(partial\) \|$/m);
    assert.match(md, /^\| Host tokens in rounds \| 150 \(partial\) \|$/m);
  } finally {
    fx.cleanup();
  }
});

test('an unparsed host transcript line marks host tokens partial in the entry and comparison.md', () => {
  const fx = fixture();
  try {
    const session = makeSession(fx);
    writeRoundFixture(session);
    writeClaudeTranscript(fx, 'host-1', [usageLine('a', E0 + 1500, 100, 50), 'not json']);
    const side = measureOne(fx, { session, host: 'claude' });
    assert.ok(side.unavailable.includes('hostTokens partial: unparsed lines'));
    const out = path.join(fx.root, 'out');
    assert.equal(runSingleSide(fx, session, out).code, 0);
    assert.match(fs.readFileSync(path.join(out, 'comparison.md'), 'utf8'), /^\| Host tokens in rounds \| 150 \(partial\) \|$/m);
  } finally {
    fx.cleanup();
  }
});

test('a round with an unreadable round.json or findings.json is excluded and named once', () => {
  for (const file of ['round.json', 'findings.json']) {
    const fx = fixture();
    try {
      const session = makeSession(fx);
      writeRoundFixture(session);
      writeText(path.join(session, '.state', 'reviews', REVIEW, 'round-2', file), '{not json');
      writeClaudeTranscript(fx, 'host-1', [usageLine('a', E0 + 1500, 100, 50)]);
      const side = measureOne(fx, { session, host: 'claude' });
      const key = reviewKey(session);
      assert.deepEqual(side.rounds, { total: 1, byReview: { [key]: 1 } }, file);
      assert.deepEqual(side.perRound.map((row) => row.round), [1], file);
      const namedCount = (round: number) => side.unavailable.filter((entry) => entry === `rounds: ${key} ${round} excluded: no readable round result`).length;
      assert.equal(namedCount(2), 1, file);
      assert.equal(namedCount(3), 1, file);
    } finally {
      fx.cleanup();
    }
  }
});

// Symlink creation can be refused on Windows hosts without developer mode; the test is then skipped, as the alias test is.
function linkOrSkip(t: { skip(message?: string): void }, target: string, link: string): boolean {
  try {
    fs.symlinkSync(target, link, 'file');
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('no symlink permission on this host');
      return false;
    }
    throw error;
  }
}

for (const name of ['comparison.json', 'comparison.md']) {
  test(`refuses an --out whose ${name} is a symbolic link and writes nothing`, (t) => {
    const fx = fixture();
    try {
      const session = makeSession(fx);
      writeRoundFixture(session);
      writeClaudeTranscript(fx, 'host-1', [usageLine('a', E0 + 1500, 100, 50)]);
      const target = path.join(fx.root, 'elsewhere.txt');
      writeText(target, 'original');
      const out = path.join(fx.root, 'out');
      fs.mkdirSync(out);
      if (!linkOrSkip(t, target, path.join(out, name))) return;
      const result = runSingleSide(fx, session, out);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /symbolic link/);
      assert.equal(fs.readFileSync(target, 'utf8'), 'original');
      const other = name === 'comparison.json' ? 'comparison.md' : 'comparison.json';
      assert.equal(fs.existsSync(path.join(out, other)), false);
    } finally {
      fx.cleanup();
    }
  });
}

test('a subagent-only note leaves host tokens unflagged while cost stays partial', () => {
  const fx = fixture();
  try {
    const session = makeSession(fx);
    writeRoundFixture(session);
    writeClaudeTranscript(fx, 'host-1', [usageLine('a', E0 + 1500, 100, 50)], ['not json']);
    const side = measureOne(fx, { session, host: 'claude' });
    assert.equal(side.cost.partial, true);
    assert.ok(side.cost.reasons.includes('unparsed lines'));
    assert.equal(side.unavailable.some((entry) => entry.startsWith('hostTokens partial:')), false);
    const out = path.join(fx.root, 'out');
    assert.equal(runSingleSide(fx, session, out).code, 0);
    assert.match(fs.readFileSync(path.join(out, 'comparison.md'), 'utf8'), /^\| Host tokens in rounds \| 150 \|$/m);
  } finally {
    fx.cleanup();
  }
});

test('writes comparison.json and comparison.md with pair tables, per-round rows and confounds', () => {
  const fx = fixture();
  try {
    const plan = makeSession(fx);
    writeRoundFixture(plan);
    writeClaudeTranscript(fx, 'host-1', [usageLine('a', E0 + 1500, 100, 50)]);
    const replay = makeSession(fx, { name: '20200101T0001Z-plan-replay', sessionId: 'host-2' });
    writeRoundFixture(replay);
    writeClaudeTranscript(fx, 'host-2', [usageLine('b', E0 + 1500, 40, 10)]);
    writeJson(path.join(fx.root, 'pricing.json'), PRICING);
    writeJson(path.join(fx.root, 'pairs.json'), {
      pricing: 'pricing.json',
      pairs: [{ name: 'plan', sides: [{ label: 'historical', session: plan, host: 'claude' }, { label: 'p3-desktop', session: replay, host: 'claude' }] }],
      confounds: ['one run per side'],
    });
    const stdout: string[] = [], stderr: string[] = [];
    const out = path.join(fx.root, 'out');
    assert.equal(runMeasureRuns([path.join(fx.root, 'pairs.json'), '--out', out], io(fx, stdout, stderr)), 0, stderr.join(''));
    const comparison = JSON.parse(fs.readFileSync(path.join(out, 'comparison.json'), 'utf8')) as Comparison;
    assert.deepEqual(comparison.pricing, { path: 'pricing.json', asOf: PRICING.asOf });
    assert.deepEqual(comparison.confounds, ['one run per side']);
    assert.deepEqual(comparison.pairs.map((pair) => pair.sides.map((side) => side.label)), [['historical', 'p3-desktop']]);
    const md = fs.readFileSync(path.join(out, 'comparison.md'), 'utf8');
    assert.match(md, /^## plan$/m);
    assert.match(md, /^\| Metric \| historical \| p3-desktop \|$/m);
    assert.match(md, /^\| Rounds \| 2 \| 2 \|$/m);
    assert.match(md, /^### Per-round$/m);
    assert.match(md, /^## Confounds$/m);
    assert.match(md, /^- one run per side$/m);
    assert.match(md, /Pricing: `pricing\.json` as of 2026-11-19/);
  } finally {
    fx.cleanup();
  }
});
