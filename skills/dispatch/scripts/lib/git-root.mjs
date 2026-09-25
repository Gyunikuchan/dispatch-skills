// @ts-check
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const GIT_TIMEOUT_MS = 5000;

// NOTE: several driver modules resolve the same root per step; each lookup is a git spawn (~25-65 ms on Windows).
/** @type {Map<string, string>} */
const toplevels = new Map();

/**
 * Trimmed `git rev-parse --show-toplevel` output for `cwd`, or null outside a work tree. Only hits are
 * cached: a work tree's root cannot move within one process, but a directory may become a repository.
 *
 * @param {string} cwd
 * @returns {string | null}
 */
export function showToplevel(cwd) {
  const key = path.resolve(cwd);
  const cached = toplevels.get(key);
  if (cached !== undefined) return cached;
  const res = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: key, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
  const root = res.status === 0 ? (res.stdout ?? '').trim() : '';
  if (!root) return null;
  toplevels.set(key, root);
  return root;
}

/**
 * Like {@link showToplevel} but throws outside a work tree.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function requireToplevel(cwd) {
  const root = showToplevel(cwd);
  if (!root) throw new Error(`Not inside a git work tree: ${cwd}`);
  return root;
}
