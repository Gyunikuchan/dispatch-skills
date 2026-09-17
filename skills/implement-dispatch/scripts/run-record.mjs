#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  isMainModule,
  verifySkillIntegrity,
} from '../../dispatch/scripts/common.mjs';
import {
  RUN_MARKER,
  validateSlotRecord,
} from '../../dispatch/scripts/slot-metrics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEEP_FINALIZED = 100;
const INCOMPLETE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const LABEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,47}:[a-z0-9][a-z0-9._-]{0,47}$/;
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}$/i;
const SLOT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const CANDIDATE_ID_PATTERN = /^(plan-review|code-review):[a-z][a-z0-9-]*:[0-9]+$/;
const SOURCE_KEY_PATTERN = /^(plan-review|code-review):R[1-9]\d*:[a-z][a-z0-9-]*:[0-9]+$/;
const MAX_WAVES = 64;
const MAX_SUBSTITUTIONS = 64;
const TOTAL_KEYS = new Set([
  'accepted', 'rejected', 'downgraded', 'disputed', 'rebutted',
  'liveFindings', 'settledFindings', 'substitutions',
]);

function gitCommonDir(cwd) {
  const absolute = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd,
    encoding: 'utf8',
  });
  if (absolute.status === 0 && absolute.stdout.trim()) return path.resolve(absolute.stdout.trim());

  const legacy = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8' });
  if (legacy.status !== 0 || !legacy.stdout.trim()) {
    throw new Error((legacy.stderr || absolute.stderr || 'Unable to resolve Git common directory.').trim());
  }
  return path.resolve(cwd, legacy.stdout.trim());
}

function statePaths(repoRoot = process.cwd()) {
  const root = path.join(gitCommonDir(repoRoot), 'dispatch-skills');
  return {
    root,
    runsDir: path.join(root, 'runs'),
    baselinesPath: path.join(root, 'baselines.json'),
    lockPath: path.join(root, '.baselines.lock'),
  };
}

function assertSafePathComponents(target, label) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const part of path.relative(parsed.root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) break;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`${label} contains a symbolic link: ${current}`);
  }
}

function safeRunId(now = new Date()) {
  const timestamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${timestamp}-${crypto.randomBytes(3).toString('hex')}`;
}

function writeExclusiveJson(file, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temp, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    fs.linkSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function writeReplaceJson(file, value) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  fs.renameSync(temp, file);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== null) return fallback;
    throw new Error(`Cannot read ${file}: ${err.message}`, { cause: err });
  }
}

function validateRunDir(runDir) {
  const resolved = fs.realpathSync(runDir);
  const markerPath = path.join(resolved, RUN_MARKER);
  const stat = fs.lstatSync(markerPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Run marker must be a regular file.');
  const marker = readJson(markerPath);
  if (
    marker?.schemaVersion !== 1 ||
    typeof marker.runId !== 'string' ||
    path.resolve(marker.runDir) !== resolved
  ) {
    throw new Error('Run marker is invalid.');
  }
  return { resolved, marker };
}

function withBaselineLock(paths, fn) {
  fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = fs.openSync(paths.lockPath, 'wx', 0o600);
  } catch (err) {
    throw new Error(
      `Baseline index is locked at ${paths.lockPath}: ${err.message}. ` +
      'After confirming no pin-baseline or finalize process is active, remove that lock file and retry.',
      { cause: err },
    );
  }
  try {
    return fn();
  } finally {
    fs.closeSync(handle);
    fs.rmSync(paths.lockPath, { force: true });
  }
}

function validateSummary(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    throw new Error('Summary must be a JSON object.');
  }
  const allowed = new Set([
    'requestedLevel', 'initialLevel', 'finalLevel', 'waves', 'totals', 'benchmark',
  ]);
  for (const key of Object.keys(summary)) {
    if (!allowed.has(key)) throw new Error(`Summary contains unsupported field "${key}".`);
  }
  for (const key of ['requestedLevel', 'initialLevel', 'finalLevel']) {
    if (
      summary[key] !== undefined &&
      summary[key] !== null &&
      (typeof summary[key] !== 'string' || !IDENTIFIER_PATTERN.test(summary[key]))
    ) {
      throw new Error(`${key} must be a bounded identifier or null.`);
    }
  }
  if (summary.waves !== undefined) {
    if (!Array.isArray(summary.waves) || summary.waves.length > MAX_WAVES) {
      throw new Error(`waves must be an array with at most ${MAX_WAVES} entries.`);
    }
    for (const [index, wave] of summary.waves.entries()) {
      if (!wave || typeof wave !== 'object' || Array.isArray(wave)) {
        throw new Error(`waves[${index}] must be an object.`);
      }
      const allowedWave = new Set([
        'phase', 'round', 'effectiveLevel', 'slotIds', 'sourceKeys', 'substitutions',
      ]);
      for (const key of Object.keys(wave)) {
        if (!allowedWave.has(key)) throw new Error(`waves[${index}] contains unsupported field "${key}".`);
      }
      if (typeof wave.phase !== 'string' || !IDENTIFIER_PATTERN.test(wave.phase)) {
        throw new Error(`waves[${index}].phase is invalid.`);
      }
      if (!Number.isSafeInteger(wave.round) || wave.round < 1) {
        throw new Error(`waves[${index}].round must be a positive safe integer.`);
      }
      if (wave.effectiveLevel !== null &&
          (typeof wave.effectiveLevel !== 'string' || !IDENTIFIER_PATTERN.test(wave.effectiveLevel))) {
        throw new Error(`waves[${index}].effectiveLevel is invalid.`);
      }
      if (!Array.isArray(wave.slotIds) || wave.slotIds.length > 128 ||
          wave.slotIds.some((slotId) => typeof slotId !== 'string' || !SLOT_ID_PATTERN.test(slotId))) {
        throw new Error(`waves[${index}].slotIds is invalid.`);
      }
      if (wave.sourceKeys !== undefined &&
          (!Array.isArray(wave.sourceKeys) ||
            wave.sourceKeys.length > 128 ||
            wave.sourceKeys.some((sourceKey) =>
              typeof sourceKey !== 'string' || !SOURCE_KEY_PATTERN.test(sourceKey)))) {
        throw new Error(`waves[${index}].sourceKeys is invalid.`);
      }
      if (wave.substitutions !== undefined) {
        if (!Array.isArray(wave.substitutions) || wave.substitutions.length > MAX_SUBSTITUTIONS) {
          throw new Error(`waves[${index}].substitutions is invalid.`);
        }
        for (const [subIndex, substitution] of wave.substitutions.entries()) {
          if (!substitution || typeof substitution !== 'object' || Array.isArray(substitution)) {
            throw new Error(`waves[${index}].substitutions[${subIndex}] must be an object.`);
          }
          const allowedSubstitution = new Set([
            'kind', 'failedSlot', 'replacementSlot', 'attemptedCandidateId',
            'effectiveSourceKey', 'substitutesFor', 'reason',
          ]);
          for (const key of Object.keys(substitution)) {
            if (!allowedSubstitution.has(key)) {
              throw new Error(`waves[${index}].substitutions[${subIndex}] contains unsupported field "${key}".`);
            }
          }
          if (!['reserve', 'native-fallback', 'dropped'].includes(substitution.kind) ||
              typeof substitution.failedSlot !== 'string' ||
              !SLOT_ID_PATTERN.test(substitution.failedSlot) ||
              substitution.replacementSlot !== null &&
                (typeof substitution.replacementSlot !== 'string' ||
                  !SLOT_ID_PATTERN.test(substitution.replacementSlot)) ||
              typeof substitution.reason !== 'string' ||
              !IDENTIFIER_PATTERN.test(substitution.reason) ||
              substitution.attemptedCandidateId !== undefined &&
                (typeof substitution.attemptedCandidateId !== 'string' ||
                  !CANDIDATE_ID_PATTERN.test(substitution.attemptedCandidateId)) ||
              substitution.effectiveSourceKey !== undefined &&
                substitution.effectiveSourceKey !== null &&
                (typeof substitution.effectiveSourceKey !== 'string' ||
                  !SOURCE_KEY_PATTERN.test(substitution.effectiveSourceKey)) ||
              substitution.substitutesFor !== undefined &&
                substitution.substitutesFor !== null &&
                (typeof substitution.substitutesFor !== 'string' ||
                  !SOURCE_KEY_PATTERN.test(substitution.substitutesFor))) {
            throw new Error(`waves[${index}].substitutions[${subIndex}] is invalid.`);
          }
        }
      }
    }
  }
  if (summary.totals !== undefined) {
    if (!summary.totals || typeof summary.totals !== 'object' || Array.isArray(summary.totals)) {
      throw new Error('totals must be an object.');
    }
    for (const [key, value] of Object.entries(summary.totals)) {
      if (!TOTAL_KEYS.has(key)) throw new Error(`totals contains unsupported field "${key}".`);
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`totals.${key} must be a non-negative safe integer.`);
    }
  }
  if (summary.benchmark !== undefined && summary.benchmark !== null) {
    if (!summary.benchmark || typeof summary.benchmark !== 'object' || Array.isArray(summary.benchmark)) {
      throw new Error('benchmark must be an object or null.');
    }
    const allowedBenchmark = new Set(['corpusVersion', 'matrixVersion', 'grammar', 'status']);
    for (const [key, value] of Object.entries(summary.benchmark)) {
      if (!allowedBenchmark.has(key)) throw new Error(`benchmark contains unsupported field "${key}".`);
      if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
        throw new Error(`benchmark.${key} must be a bounded identifier.`);
      }
    }
  }
  return summary;
}

function readBaselines(paths) {
  const value = readJson(paths.baselinesPath, { schemaVersion: 1, labels: {} });
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !['schemaVersion', 'labels'].includes(key)) ||
    value.schemaVersion !== 1 ||
    !value.labels ||
    typeof value.labels !== 'object' ||
    Array.isArray(value.labels)
  ) {
    throw new Error('Baseline index is invalid.');
  }
  for (const [label, entry] of Object.entries(value.labels)) {
    if (!LABEL_PATTERN.test(label) ||
        !entry ||
        typeof entry !== 'object' ||
        Array.isArray(entry) ||
        Object.keys(entry).some((key) => !['runId', 'runDir', 'pinnedAt'].includes(key)) ||
        typeof entry.runId !== 'string' ||
        !IDENTIFIER_PATTERN.test(entry.runId) ||
        typeof entry.runDir !== 'string' ||
        !path.isAbsolute(entry.runDir) ||
        typeof entry.pinnedAt !== 'string' ||
        !Number.isFinite(Date.parse(entry.pinnedAt))) {
      throw new Error(`Baseline index entry "${label}" is invalid.`);
    }
  }
  return value;
}

function pruneRunPaths(paths, now, { pruneFinalized = true } = {}) {
  if (!fs.existsSync(paths.runsDir)) return { incompleteRemoved: 0, finalizedRemoved: 0 };
  const pinned = pruneFinalized
    ? new Set(Object.values(readBaselines(paths).labels).map((entry) => entry.runId))
    : new Set();
  let incompleteRemoved = 0;
  const finalized = [];
  for (const entry of fs.readdirSync(paths.runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const runDir = path.join(paths.runsDir, entry.name);
    const manifestPath = path.join(runDir, 'run.json');
    if (fs.existsSync(manifestPath)) {
      if (pruneFinalized) {
        try {
          const manifest = readJson(manifestPath);
          finalized.push({ runDir, runId: manifest.runId, finalizedAt: Date.parse(manifest.finalizedAt) || 0 });
        } catch (err) {
          if (err?.cause instanceof SyntaxError || err instanceof SyntaxError) {
            finalized.push({ runDir, runId: null, finalizedAt: 0 });
          } else {
            throw err;
          }
        }
      }
      continue;
    }
    const markerPath = path.join(runDir, RUN_MARKER);
    const ageBase = fs.existsSync(markerPath) ? fs.statSync(markerPath).mtimeMs : fs.statSync(runDir).mtimeMs;
    if (now - ageBase > INCOMPLETE_MAX_AGE_MS) {
      fs.rmSync(runDir, { recursive: true, force: true });
      incompleteRemoved++;
    }
  }
  const removable = pruneFinalized
    ? finalized
        .filter((entry) => !pinned.has(entry.runId))
        .sort((a, b) => b.finalizedAt - a.finalizedAt)
        .slice(KEEP_FINALIZED)
    : [];
  for (const entry of removable) fs.rmSync(entry.runDir, { recursive: true, force: true });
  return { incompleteRemoved, finalizedRemoved: removable.length };
}

export function pruneRuns(repoRoot = process.cwd(), now = Date.now()) {
  const paths = statePaths(repoRoot);
  return withBaselineLock(paths, () => pruneRunPaths(paths, now));
}

export function initRun({ repoRoot = process.cwd(), now = new Date() } = {}) {
  const paths = statePaths(repoRoot);
  assertSafePathComponents(paths.root, 'Run-record path');
  fs.mkdirSync(paths.runsDir, { recursive: true, mode: 0o700 });
  for (const directory of [paths.root, paths.runsDir]) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Run-record path must be a regular directory: ${directory}`);
    }
  }
  pruneRunPaths(paths, now.getTime(), { pruneFinalized: false });
  let runId;
  let runDir;
  for (let i = 0; i < 10; i++) {
    runId = safeRunId(now);
    runDir = path.join(paths.runsDir, runId);
    try {
      fs.mkdirSync(runDir, { mode: 0o700 });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST' || i === 9) throw err;
    }
  }
  if (process.platform !== 'win32') fs.chmodSync(runDir, 0o700);
  const markerPath = path.join(runDir, RUN_MARKER);
  writeExclusiveJson(markerPath, {
    schemaVersion: 1,
    runId,
    runDir: fs.realpathSync(runDir),
    startedAt: now.toISOString(),
  });
  return { runId, runDir: fs.realpathSync(runDir), markerPath };
}

export function finalizeRun({ runDir, expectedSlots, summary = {} }) {
  if (!Number.isSafeInteger(expectedSlots) || expectedSlots < 0) {
    throw new Error('expectedSlots must be a non-negative safe integer.');
  }
  const { resolved, marker } = validateRunDir(runDir);
  const records = [];
  const seen = new Set();
  for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || [RUN_MARKER, 'run.json'].includes(entry.name)) continue;
    const file = path.join(resolved, entry.name);
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`Slot file is a symbolic link: ${entry.name}`);
    const record = validateSlotRecord(readJson(file));
    if (record.runId !== marker.runId) throw new Error(`Slot ${record.slotId} belongs to another run.`);
    if (seen.has(record.slotId)) throw new Error(`Duplicate embedded slotId: ${record.slotId}`);
    seen.add(record.slotId);
    records.push(record);
  }
  if (records.length !== expectedSlots) {
    throw new Error(`Expected ${expectedSlots} slot record(s), found ${records.length}.`);
  }
  const safeSummary = validateSummary(summary);
  const attempts = records.flatMap((record) => record.attempts);
  const aggregate = {
    inputChars: attempts.reduce((sum, attempt) => sum + (attempt.inputChars ?? 0), 0),
    outputChars: attempts.reduce((sum, attempt) => sum + attempt.outputChars, 0),
    attempts: attempts.length,
    successfulSlots: records.filter((record) => record.effectiveAttempt !== null &&
      record.attempts[record.effectiveAttempt]?.result === 'ok').length,
  };
  const manifest = {
    schemaVersion: 1,
    runId: marker.runId,
    startedAt: marker.startedAt,
    finalizedAt: new Date().toISOString(),
    expectedSlots,
    slots: records.sort((a, b) => a.slotId.localeCompare(b.slotId)),
    aggregate,
    ...safeSummary,
  };
  writeExclusiveJson(path.join(resolved, 'run.json'), manifest);
  const paths = {
    root: path.dirname(path.dirname(resolved)),
    runsDir: path.dirname(resolved),
    baselinesPath: path.join(path.dirname(path.dirname(resolved)), 'baselines.json'),
    lockPath: path.join(path.dirname(path.dirname(resolved)), '.baselines.lock'),
  };
  withBaselineLock(paths, () => pruneRunPaths(paths, Date.now()));
  return manifest;
}

export function pinBaseline({ repoRoot = process.cwd(), runDir = null, label, clear = false }) {
  if (!LABEL_PATTERN.test(label || '')) throw new Error('Baseline label must match <phase>:<corpus>.');
  const paths = statePaths(repoRoot);
  return withBaselineLock(paths, () => {
    const index = readBaselines(paths);
    if (clear) {
      delete index.labels[label];
    } else {
      const { resolved, marker } = validateRunDir(runDir);
      const expectedRunsDir = fs.existsSync(paths.runsDir)
        ? fs.realpathSync(paths.runsDir)
        : path.resolve(paths.runsDir);
      if (path.dirname(resolved) !== expectedRunsDir) {
        throw new Error('Pinned run must belong to this repository run directory.');
      }
      if (!fs.existsSync(path.join(resolved, 'run.json'))) throw new Error('Only a finalized run can be pinned.');
      index.labels[label] = { runId: marker.runId, runDir: resolved, pinnedAt: new Date().toISOString() };
    }
    writeReplaceJson(paths.baselinesPath, index);
    return index;
  });
}

function parseArgs(argv) {
  const out = { command: argv[0], repoRoot: process.cwd(), runDir: null, expectedSlots: null, summary: null, label: null, clear: false, help: false };
  if (argv.includes('-h') || argv.includes('--help')) return { ...out, help: true };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next) throw new Error(`${arg} requires a value.`);
      return next;
    };
    if (arg === '--repo-root') out.repoRoot = path.resolve(value());
    else if (arg === '--run-dir') out.runDir = path.resolve(value());
    else if (arg === '--expected-slots') out.expectedSlots = Number(value());
    else if (arg === '--summary') out.summary = value();
    else if (arg === '--label') out.label = value();
    else if (arg === '--clear') { out.clear = true; out.label = value(); }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

const USAGE = `Usage:
  node run-record.mjs init [--repo-root <path>]
  node run-record.mjs finalize --run-dir <path> --expected-slots <n> [--summary <json-file|->]
  node run-record.mjs pin-baseline --run-dir <path> --label <phase:corpus>
  node run-record.mjs pin-baseline [--repo-root <path>] --clear <phase:corpus>
`;

async function main() {
  const integrity = verifySkillIntegrity(path.resolve(__dirname, '..'));
  if (!integrity.valid && !integrity.missing) throw new Error(`Skill integrity failure: ${integrity.violations.join(', ')}`);
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return process.stdout.write(USAGE);
  if (args.command === 'init') {
    return process.stdout.write(`${JSON.stringify(initRun({ repoRoot: args.repoRoot }), null, 2)}\n`);
  }
  if (args.command === 'finalize') {
    if (!args.runDir || args.expectedSlots === null) throw new Error('finalize requires --run-dir and --expected-slots.');
    const summary = args.summary
      ? JSON.parse(args.summary === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(args.summary, 'utf8'))
      : {};
    return process.stdout.write(`${JSON.stringify(finalizeRun({ runDir: args.runDir, expectedSlots: args.expectedSlots, summary }), null, 2)}\n`);
  }
  if (args.command === 'pin-baseline') {
    if (!args.label || (!args.clear && !args.runDir)) throw new Error('pin-baseline requires --label/--clear and a finalized --run-dir when pinning.');
    return process.stdout.write(`${JSON.stringify(pinBaseline({
      repoRoot: args.repoRoot,
      runDir: args.runDir,
      label: args.label,
      clear: args.clear,
    }), null, 2)}\n`);
  }
  throw new Error(`Unknown command "${args.command || ''}".\n${USAGE}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`[run-record] ${err.message}\n`);
    process.exit(1);
  });
}
