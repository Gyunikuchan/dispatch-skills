#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

export const RUN_MARKER = '.dispatch-run.json';
export const SLOT_SCHEMA_VERSION = 1;
export const MAX_SLOT_BYTES = 256 * 1024;

const RESULTS = new Set(['ok', 'failed', 'partial', 'error']);
const TRUNCATION = new Set(['timeout', 'buffer']);

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertNullableString(value, label, maxLength = 256) {
  if (
    value !== null &&
    (typeof value !== 'string' || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value))
  ) {
    throw new Error(`${label} must be a bounded string or null.`);
  }
}

function assertCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
}

function assertNullableCount(value, label) {
  if (value !== null) assertCount(value, label);
}

function inspectExistingComponents(target) {
  const parsed = path.parse(target);
  const relative = path.relative(parsed.root, target);
  let current = parsed.root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) break;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Metrics path contains a symbolic link: ${current}`);
  }
}

function readMarker(runDir) {
  const markerPath = path.join(runDir, RUN_MARKER);
  let stat;
  try {
    stat = fs.lstatSync(markerPath);
  } catch (err) {
    throw new Error(`Initialized run marker is missing: ${markerPath}`, { cause: err });
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Run marker must be a regular file.');
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  assertPlainObject(marker, 'Run marker');
  if (marker.schemaVersion !== 1 || typeof marker.runId !== 'string') {
    throw new Error('Run marker has an unsupported schema.');
  }
  if (fs.realpathSync(runDir) !== path.resolve(marker.runDir)) {
    throw new Error('Run marker does not identify its containing directory.');
  }
  return marker;
}

function directoryIdentity(runDir) {
  const stat = fs.lstatSync(runDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Metrics run directory must be a regular directory.');
  }
  return { dev: stat.dev, ino: stat.ino };
}

function assertDirectoryIdentity(destination) {
  const current = directoryIdentity(destination.runDir);
  if (current.dev !== destination.directoryIdentity.dev ||
      current.ino !== destination.directoryIdentity.ino) {
    throw new Error('Metrics run directory changed after validation.');
  }
}

export function validateSlotRecord(record) {
  assertPlainObject(record, 'Slot record');
  const allowed = new Set(['schemaVersion', 'runId', 'slotId', 'recordedAt', 'attempts', 'effectiveAttempt']);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`Slot record contains unsupported field "${key}".`);
  }
  if (record.schemaVersion !== SLOT_SCHEMA_VERSION) throw new Error('Unsupported slot schemaVersion.');
  if (typeof record.runId !== 'string' || !/^[A-Za-z0-9._-]{1,96}$/.test(record.runId)) {
    throw new Error('Slot record runId is invalid.');
  }
  if (typeof record.slotId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(record.slotId)) {
    throw new Error('Slot record slotId is invalid.');
  }
  if (typeof record.recordedAt !== 'string' ||
      record.recordedAt.length > 32 ||
      !Number.isFinite(Date.parse(record.recordedAt))) {
    throw new Error('Slot record recordedAt is invalid.');
  }
  if (!Array.isArray(record.attempts) || record.attempts.length > 64) {
    throw new Error('Slot record attempts must be an array with at most 64 entries.');
  }
  for (const [index, attempt] of record.attempts.entries()) {
    assertPlainObject(attempt, `attempts[${index}]`);
    const attemptAllowed = new Set([
      'provider', 'model', 'effort', 'mode', 'inputChars', 'inputEstimate', 'outputChars',
      'outputEstimate', 'toolTurns', 'providerUsage', 'result', 'failureKind', 'truncated',
    ]);
    for (const key of Object.keys(attempt)) {
      if (!attemptAllowed.has(key)) throw new Error(`attempts[${index}] contains unsupported field "${key}".`);
    }
    if (typeof attempt.provider !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(attempt.provider)) {
      throw new Error(`attempts[${index}].provider is invalid.`);
    }
    for (const key of ['model', 'effort', 'mode', 'failureKind']) {
      assertNullableString(attempt[key], `attempts[${index}].${key}`);
    }
    for (const key of ['inputChars', 'inputEstimate']) {
      assertNullableCount(attempt[key], `attempts[${index}].${key}`);
    }
    for (const key of ['outputChars', 'outputEstimate']) {
      assertCount(attempt[key], `attempts[${index}].${key}`);
    }
    if ((attempt.inputChars === null) !== (attempt.inputEstimate === null) ||
        attempt.inputChars !== null && attempt.inputEstimate !== Math.ceil(attempt.inputChars / 4) ||
        attempt.outputEstimate !== Math.ceil(attempt.outputChars / 4)) {
      throw new Error(`attempts[${index}] character estimates are inconsistent.`);
    }
    if (attempt.toolTurns !== null) assertCount(attempt.toolTurns, `attempts[${index}].toolTurns`);
    if (!RESULTS.has(attempt.result)) throw new Error(`attempts[${index}].result is invalid.`);
    if (attempt.truncated !== null && !TRUNCATION.has(attempt.truncated)) {
      throw new Error(`attempts[${index}].truncated is invalid.`);
    }
    if (attempt.providerUsage !== null) {
      assertPlainObject(attempt.providerUsage, `attempts[${index}].providerUsage`);
      const usageAllowed = new Set(['inputTokens', 'outputTokens']);
      for (const key of Object.keys(attempt.providerUsage)) {
        if (!usageAllowed.has(key)) {
          throw new Error(`attempts[${index}].providerUsage contains unsupported field "${key}".`);
        }
      }
      for (const key of ['inputTokens', 'outputTokens']) {
        const value = attempt.providerUsage[key];
        if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
          throw new Error(`attempts[${index}].providerUsage.${key} is invalid.`);
        }
      }
    }
  }
  if (
    record.effectiveAttempt !== null &&
    (!Number.isSafeInteger(record.effectiveAttempt) ||
      record.effectiveAttempt < 0 ||
      record.effectiveAttempt >= record.attempts.length)
  ) {
    throw new Error('Slot record effectiveAttempt is outside attempts.');
  }
  return record;
}

export function prepareMetricsDestination(metricsFile) {
  if (!path.isAbsolute(metricsFile)) throw new Error('--metrics-file must be an absolute path.');
  const requested = path.resolve(metricsFile);
  const requestedParent = path.dirname(requested);
  inspectExistingComponents(requestedParent);
  if (fs.lstatSync(requestedParent).isSymbolicLink()) {
    throw new Error(`Metrics destination directory is a symbolic link: ${requestedParent}`);
  }
  const runDir = fs.realpathSync(requestedParent);
  const target = path.join(runDir, path.basename(requested));
  if (path.extname(target) !== '.json' || path.basename(target) === RUN_MARKER || path.basename(target) === 'run.json') {
    throw new Error('--metrics-file must name a new .json slot file.');
  }
  const marker = readMarker(runDir);
  if (fs.existsSync(target)) throw new Error(`Metrics destination already exists: ${target}`);
  return {
    target,
    runDir,
    marker,
    slotId: path.basename(target, '.json'),
    directoryIdentity: directoryIdentity(runDir),
  };
}

export function publishSlotRecord(destination, record) {
  assertDirectoryIdentity(destination);
  validateSlotRecord(record);
  if (record.runId !== destination.marker.runId) {
    throw new Error('Slot record runId does not match the initialized run.');
  }
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_SLOT_BYTES) throw new Error('Slot record exceeds 256 KiB.');
  const temp = path.join(
    destination.runDir,
    `.${destination.slotId}.${process.pid}.${Date.now()}.tmp`,
  );
  const handle = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(handle, serialized, 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  try {
    assertDirectoryIdentity(destination);
    fs.linkSync(temp, destination.target);
  } catch (err) {
    throw new Error(`Could not publish metrics atomically: ${err.message}`, { cause: err });
  } finally {
    fs.rmSync(temp, { force: true });
  }
  if (process.platform !== 'win32') fs.chmodSync(destination.target, 0o600);
  return destination.target;
}

export function recordDispatchMetrics(metricsFile, result = null, error = null) {
  const destination = prepareMetricsDestination(metricsFile);
  const attempts =
    Array.isArray(result?.metricsAttempts) ? result.metricsAttempts :
      Array.isArray(error?.metricsAttempts) ? error.metricsAttempts : [];
  const effectiveAttempt =
    Number.isSafeInteger(result?.effectiveAttempt) ? result.effectiveAttempt :
      attempts.length > 0 && result ? attempts.length - 1 : null;
  return publishSlotRecord(destination, {
    schemaVersion: SLOT_SCHEMA_VERSION,
    runId: destination.marker.runId,
    slotId: destination.slotId,
    recordedAt: new Date().toISOString(),
    attempts,
    effectiveAttempt,
  });
}
