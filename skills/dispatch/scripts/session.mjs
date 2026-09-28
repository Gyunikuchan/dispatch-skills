// @ts-check
/** Command-line boundary for chat session initialization, lookup, reactivation, and handoff. */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainModule } from './lib/platform.mjs';
import { findSession, handoffSession, initializeSession, reactivateSession } from './lib/session-lifecycle.mjs';

const SCRIPT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'dispatch.mjs');

/** @param {string[]} args */
function parseArgs(args) {
  const [command, ...rest] = args;
  if (!['init', 'lookup', 'reactivate', 'handoff'].includes(command ?? '')) {
    throw new Error(`Usage: node session.mjs <init|lookup|reactivate|handoff> [--session-id ID] [--session-dir PATH] [--session-title TITLE] [--objective TEXT] [--repository-root PATH] [--temp-root PATH]`);
  }
  /** @type {Record<string, string>} */
  const values = {};
  for (let index = 0; index < rest.length; index++) {
    const key = rest[index];
    if (!['--session-id', '--session-dir', '--session-title', '--objective', '--repository-root', '--temp-root'].includes(key)) throw new Error(`Unknown option: ${key}`);
    const value = rest[++index];
    if (!value || value.startsWith('--') || values[key]) throw new Error(`${key} requires one value.`);
    values[key] = value;
  }
  return { command, values };
}

/** @param {string[]} [argv] */
export function runSessionCommand(argv = process.argv.slice(2)) {
  const { command, values } = parseArgs(argv);
  const repositoryRoot = path.resolve(values['--repository-root'] ?? process.cwd());
  const common = {
    repositoryRoot,
    ...(values['--session-id'] ? { sessionId: values['--session-id'] } : {}),
    ...(values['--session-title'] ? { sessionTitle: values['--session-title'] } : {}),
    ...(values['--objective'] ? { objective: values['--objective'] } : {}),
    ...(values['--temp-root'] ? { tempRoot: path.resolve(values['--temp-root']) } : {}),
  };
  if (command === 'init') {
    const sessionDir = values['--session-dir']
      ? reactivateSession({ sessionDir: path.resolve(values['--session-dir']), repositoryRoot, ...(common.tempRoot ? { tempRoot: common.tempRoot } : {}) }).currentRoot
      : initializeSession(common);
    return { schemaVersion: 1, command, sessionDir, dispatchScript: SCRIPT_PATH };
  }
  if (command === 'lookup') {
    const sessionDir = values['--session-dir']
      ? path.resolve(values['--session-dir'])
      : findSession(common);
    return { schemaVersion: 1, command, found: Boolean(sessionDir), sessionDir, dispatchScript: SCRIPT_PATH };
  }
  if (!values['--session-dir']) throw new Error(`${command} requires --session-dir <path>.`);
  const result = command === 'reactivate'
    ? reactivateSession({ sessionDir: path.resolve(values['--session-dir']), repositoryRoot, ...(common.tempRoot ? { tempRoot: common.tempRoot } : {}) })
    : handoffSession({ sessionDir: path.resolve(values['--session-dir']), repositoryRoot, ...(common.tempRoot ? { tempRoot: common.tempRoot } : {}) });
  return { schemaVersion: 1, command, ...result, dispatchScript: SCRIPT_PATH };
}

// NOTE: isMainModule compares real paths so symlinked skill installs still run.
if (isMainModule(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(runSessionCommand())}\n`); }
  catch (error) {
    process.stderr.write(`[dispatch session] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
