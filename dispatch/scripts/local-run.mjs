#!/usr/bin/env node

/**
 * @file local-run.mjs
 * @description Local OpenCode + LM Studio runner with proxy trapping and sandboxing.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyFailure,
  createSessionLogger,
  DEFAULT_TIMEOUT_SECONDS,
  emitCompletionBanner,
  emitInitBanner,
  parseCommonArgs,
  readStdin,
  spawnLogTerminal,
} from './common.mjs';
import {
  preflightLMStudioCheck,
  runLocalAgent,
} from './local-llm-run.mjs';

const currentFilePath = fileURLToPath(import.meta.url);

/**
 * Checks if local LM Studio / OpenCode service is available.
 */
export async function isLocalAvailable() {
  try {
    return await preflightLMStudioCheck(1500);
  } catch {
    return false;
  }
}

/**
 * Executes a task using the local OpenCode runner.
 */
export async function runLocal(options = {}) {
  const {
    prompt,
    files = [],
    model = null,
    agent = null,
    timeout = DEFAULT_TIMEOUT_SECONDS,
    maxBufferMb = 10,
    allowWrite = false,
    json = false,
    verbose = false,
    watchTerminal = false,
  } = options;

  const sessionLogger = createSessionLogger('local');

  if (watchTerminal) {
    spawnLogTerminal(sessionLogger.logFile, { title: 'Local OpenCode Live Trace' });
  }

  emitInitBanner({
    provider: 'Local OpenCode (LM Studio)',
    sessionLink: 'http://127.0.0.1:1234',
    logFile: sessionLogger.logFile,
    mode: allowWrite ? 'READ-WRITE' : 'READ-ONLY',
  });

  try {
    const result = await runLocalAgent({
      prompt,
      files,
      model,
      agent,
      timeout,
      maxBufferMb,
      allowWrite,
      json,
      verbose,
      // Stream to the log as the run proceeds; writing only at exit left nothing to tail.
      onChunk: (chunk) => sessionLogger.write(chunk),
    });

    sessionLogger.close();

    emitCompletionBanner({
      provider: 'Local OpenCode (LM Studio)',
      exitCode: result.exitCode,
      truncated: result.truncated,
    });

    return {
      provider: 'local',
      stdout: result.stdout,
      rawStdout: result.rawStdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      logFile: sessionLogger.logFile,
      truncated: result.truncated,
      failureKind:
        classifyFailure(`${result.stderr || ''}\n${result.stdout || ''}`) || result.truncated,
      gitIntegrityViolation: result.gitIntegrityViolation,
    };
  } catch (err) {
    sessionLogger.write(`\nError: ${err.message}\n${err.stderr || ''}`);
    sessionLogger.close();
    err.failureKind = classifyFailure(`${err.message}\n${err.stderr || ''}`);
    throw err;
  }
}

export async function main() {
  const options = parseCommonArgs(process.argv);

  if (options.help) {
    console.log(`
Local OpenCode Runner (Sandboxed + WAN proxy-trapped)

Usage:
  node scripts/local-run.mjs [options] [prompt]

Options:
  -p, --prompt <string>       The prompt message to send
  -f, --file, --artifact      Attach context file (repeatable)
  -m, --model <name>          Override model identifier
  -a, --agent <name>          Override agent (default: delegate)
  -t, --timeout <seconds>     Override timeout in seconds (default: ${DEFAULT_TIMEOUT_SECONDS})
  --allow-write, --write      Grant write access (default: read-only)
  --read-only                 Enforce read-only analysis
  -w, --watch-terminal        Watch live log trace in external GUI terminal (default: disabled)
  --headless, --no-watch      Run headless without opening an external terminal window
  -v, --verbose               Stream live trace to stderr (terminal only; ignored when piped)
  -h, --help                  Show this help
`);
    process.exit(0);
  }

  const pipedStdin = await readStdin();
  let finalPrompt = options.prompt.trim();
  if (pipedStdin) {
    finalPrompt = finalPrompt
      ? `${finalPrompt}\n\n[Piped Input]:\n${pipedStdin}`
      : pipedStdin;
  }

  if (!finalPrompt) {
    console.error('Error: No prompt provided.');
    process.exit(1);
  }

  try {
    const res = await runLocal({ ...options, prompt: finalPrompt });
    if (res.stdout) {
      process.stdout.write(res.stdout.endsWith('\n') ? res.stdout : `${res.stdout}\n`);
    }
    if (res.gitIntegrityViolation) {
      console.warn(`\n[dispatch] WARNING: Workspace was modified during READ-ONLY execution!\n`);
    }
    process.exit(res.exitCode);
  } catch (err) {
    console.error(`\n[dispatch] ERROR: ${err.message}`);
    process.exit(typeof err.code === 'number' ? err.code : 1);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(currentFilePath)
) {
  main().catch((err) => {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
  });
}
