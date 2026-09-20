#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_BYTES = 1024 * 1024;
const FILE_NAME = 'telemetry.jsonl';
const ROTATED_NAME = 'telemetry.1.jsonl';

export function userSlug({ env = process.env, userInfo = () => os.userInfo() } = {}) {
  let name = env.USER || env.USERNAME || '';
  if (!name) {
    // NOTE: os.userInfo() throws when the uid has no passwd entry (some containers).
    try { name = userInfo().username || ''; } catch { name = ''; }
  }
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_');
  return safe === '' || safe === '.' || safe === '..' ? 'unknown' : safe;
}

export function telemetryPath({ dir } = {}) {
  const base = dir ?? path.join(os.tmpdir(), `dispatch-telemetry-${userSlug()}`);
  return path.join(base, FILE_NAME);
}

// Shared tmp is attacker-reachable on POSIX; refuse dirs another user could have planted or can write.
// NOTE: win32 %TEMP% is per-user by default, so directory ACLs are not inspected there.
function safeDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return false;
    if ((stat.mode & 0o022) !== 0) return false;
  }
  return true;
}

function buildRecord({ result, error, startedAt }) {
  const attempts =
    Array.isArray(result?.metricsAttempts) ? result.metricsAttempts :
      Array.isArray(error?.metricsAttempts) ? error.metricsAttempts : [];
  const effectiveAttempt =
    Number.isSafeInteger(result?.effectiveAttempt) ? result.effectiveAttempt :
      attempts.length > 0 && result ? attempts.length - 1 : null;
  const now = Date.now();
  return {
    v: 1,
    recordedAt: new Date(now).toISOString(),
    durationMs: Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : null,
    attempts,
    effectiveAttempt,
  };
}

/** Best-effort, content-free, fully silent: never writes stderr or throws. */
export function appendTelemetry({ result = null, error = null, startedAt, dir } = {}) {
  try {
    if (process.env.DISPATCH_TELEMETRY === '0') return;
    const record = buildRecord({ result, error, startedAt });
    // Only provider attempts count; usage/config/integrity errors never reached a provider.
    if (record.attempts.length === 0) return;
    const file = telemetryPath({ dir });
    const base = path.dirname(file);
    if (!safeDirectory(base)) return;
    let existing = null;
    try { existing = fs.lstatSync(file); } catch { existing = null; }
    if (existing && !existing.isFile()) return;
    // NOTE: rotation can drop a concurrent append; acceptable for content-free best-effort data.
    if (existing && existing.size >= MAX_BYTES) fs.renameSync(file, path.join(base, ROTATED_NAME));
    const line = `${JSON.stringify(record)}\n`;
    // O_NOFOLLOW (POSIX) closes the lstat-to-open symlink swap; fstat rejects anything but a regular file.
    const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW = 0 } = fs.constants;
    const fd = fs.openSync(file, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW, 0o600);
    try {
      if (fs.fstatSync(fd).isFile()) fs.writeSync(fd, line);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Telemetry must never affect dispatch.
  }
}
