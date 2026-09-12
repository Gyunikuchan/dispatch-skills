#!/usr/bin/env node

/**
 * @file finalize.mjs
 * @description Closes an audit run: checks the repo against the baseline snapshot, relocates
 * every working file to OS temp, and appends the relocation path and integrity result to the
 * report, leaving `.scratch/audits/<run>-audit.md` as the run's only file in the repo.
 *
 * Relocates rather than deletes (the repo's scratch convention), so findings and probe captures
 * stay inspectable after the run.
 *
 * Usage: node <skill>/scripts/finalize.mjs --run <yyyy-mm-dd-hhmm>
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { auditGitStatus, diffStatus, resolveRepoRoot, resolveRunDirs } from './shared.mjs';

// ============================================================================
// SECTION: Main
// ============================================================================

function main() {
  const root = resolveRepoRoot();
  const { runId, reportPath, workDir, rel } = resolveRunDirs(root, process.argv);
  if (!fs.existsSync(reportPath)) {
    throw new Error(`${rel(reportPath)} not found; write the report before finalizing.`);
  }

  const baselinePath = path.join(workDir, 'git-status.txt');
  const changes = fs.existsSync(baselinePath)
    ? diffStatus(fs.readFileSync(baselinePath, 'utf8'), auditGitStatus(root) ?? '')
    : null;

  let destination = null;
  if (fs.existsSync(workDir)) {
    destination = fs.mkdtempSync(path.join(os.tmpdir(), `audit-dispatch-skills-${runId}-`));
    for (const name of fs.readdirSync(workDir)) moveEntry(path.join(workDir, name), path.join(destination, name));
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  const integrity =
    changes === null
      ? 'unknown (no baseline snapshot)'
      : changes.length === 0
        ? 'unchanged'
        : `CHANGED during the audit:\n\n\`\`\`\n${changes.join('\n')}\n\`\`\``;
  const footer = [
    '',
    '---',
    '',
    `Run artifacts (baseline, findings, probe captures): ${destination ? `\`${destination.split(path.sep).join('/')}\`` : 'none'}`,
    '',
    `Repo integrity: ${integrity}`,
    '',
  ].join('\n');
  fs.appendFileSync(reportPath, footer, 'utf8');

  process.stdout.write(`Report: ${rel(reportPath)}\n${footer.trim()}\n`);
}

// ============================================================================
// SECTION: Utilities
// ============================================================================

function moveEntry(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    // NOTE: rename fails across volumes (EXDEV) and on Windows when a handle lingers (EPERM).
    if (!['EXDEV', 'EPERM', 'EBUSY'].includes(err.code)) throw err;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`[finalize] ${err.message}\n`);
  process.exit(1);
}
