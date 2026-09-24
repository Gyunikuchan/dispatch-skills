// @ts-check
/**
 * Per-session OS-temp root. Every run-scoped temp artifact (driver state, prompts, packets, slot
 * reports, runner logs, verification logs) lives under one directory:
 * `<os.tmpdir()>/dispatch-skills-<user>/sessions/<session-id>/`. Durable cross-session stores
 * (ledgers, relocated artifacts, telemetry, locks) stay beside it under the same user root.
 *
 * A driver run owns one session (its run ID); child processes inherit it through
 * `DISPATCH_SESSION_DIR`, and host-run argv carries it with `--session-dir`. A standalone process
 * without either creates its own session on first use.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { userSlug } from './telemetry.mjs';

export const SESSION_ENV = 'DISPATCH_SESSION_DIR';
export const SESSION_FLAG = '--session-dir';

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const SESSIONS_DIRECTORY = 'sessions';

// SECTION: Roots and validation

/**
 * `<realpath(os.tmpdir())>/dispatch-skills-<user>`: the single dispatch temp root.
 *
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 */
export function dispatchTempRoot({ env = process.env } = {}) {
  return path.join(fs.realpathSync(os.tmpdir()), `dispatch-skills-${userSlug({ env })}`);
}

export function sessionsRoot(options) {
  return path.join(dispatchTempRoot(options), SESSIONS_DIRECTORY);
}

/** True when `dir` resolves to a direct child of the sessions root. */
export function isSessionDir(dir) {
  if (typeof dir !== 'string' || !dir) return false;
  let real;
  try { real = fs.realpathSync(dir); } catch { real = path.resolve(dir); }
  return path.dirname(real) === sessionsRoot() && SESSION_ID_PATTERN.test(path.basename(real));
}

function makeDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* NOTE: win32 ignores POSIX modes. */ }
  return fs.realpathSync(dir);
}

// SECTION: Session lifecycle

/** Creates (or reuses) the session named `id` and binds it to this process and its children. */
export function openSession(id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`) {
  if (!SESSION_ID_PATTERN.test(id)) throw new Error(`Invalid session id "${id}".`);
  const dir = makeDir(path.join(sessionsRoot(), id));
  process.env[SESSION_ENV] = dir;
  pruneSessions();
  return dir;
}

/** Binds an existing session directory (from `--session-dir` or a state file's parent). */
export function bindSession(dir) {
  if (!isSessionDir(dir)) throw new Error(`Session directory must be a child of ${sessionsRoot()}: ${dir}`);
  const real = makeDir(dir);
  process.env[SESSION_ENV] = real;
  return real;
}

/** The bound session directory, opening a fresh one when none is bound. */
export function sessionDir() {
  const bound = process.env[SESSION_ENV];
  if (bound && isSessionDir(bound)) return makeDir(bound);
  return openSession();
}

/** A unique private directory inside the session (the session-scoped `mkdtemp`). */
export function sessionTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(sessionDir(), prefix));
  try { fs.chmodSync(dir, 0o700); } catch { /* NOTE: win32 ignores POSIX modes. */ }
  return dir;
}

// SECTION: Argument propagation

/** Removes `--session-dir <dir>` from argv, binding it; returns the remaining argv. */
export function consumeSessionFlag(args) {
  const out = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') { out.push(...args.slice(index)); break; }
    if (arg === SESSION_FLAG) { bindSession(args[++index]); continue; }
    if (arg.startsWith(`${SESSION_FLAG}=`)) { bindSession(arg.slice(SESSION_FLAG.length + 1)); continue; }
    out.push(arg);
  }
  return out;
}

/** `[SESSION_FLAG, dir]` for argv the host runs in a fresh shell. */
export function sessionArgs() {
  return [SESSION_FLAG, sessionDir()];
}

// SECTION: Retention

/**
 * Best-effort removal of unbound sessions untouched for `maxAgeMs`.
 *
 * @param {{ maxAgeMs?: number, now?: number }} [options]
 */
export function pruneSessions({ maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now() } = {}) {
  let root;
  try { root = sessionsRoot(); } catch { return; }
  let names;
  try { names = fs.readdirSync(root); } catch { return; }
  const bound = process.env[SESSION_ENV] ? path.resolve(process.env[SESSION_ENV]) : null;
  for (const name of names) {
    const dir = path.join(root, name);
    if (bound && path.resolve(dir) === bound) continue;
    try {
      let newest = fs.statSync(dir).mtimeMs;
      for (const entry of fs.readdirSync(dir)) newest = Math.max(newest, fs.statSync(path.join(dir, entry)).mtimeMs);
      if (now - newest < maxAgeMs) continue;
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // NOTE: pruning never blocks a run.
    }
  }
}
