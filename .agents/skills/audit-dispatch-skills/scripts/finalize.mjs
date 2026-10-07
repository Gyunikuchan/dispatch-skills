#!/usr/bin/env node

/**
 * @file finalize.mjs
 * @description Closes an audit run: requires every scope and probe to have stopped, checks the repo
 * against the baseline status and content snapshots, relocates the work dir to OS temp, and appends
 * the relocation path and integrity result to the report, leaving `.scratch/audits/<run>-audit.md`
 * as the run's only file in the repo.
 *
 * Relocates rather than deletes (the repo's scratch convention), so findings and probe captures
 * stay inspectable after the run. Relocation stages a copy, verifies it, records publication and the
 * integrity result in the manifest, appends the report footer once, and only then removes the source;
 * a failed or interrupted relocation keeps the source authoritative and preserves the uncertain copy,
 * so a retry is safe and completes the footer exactly once.
 *
 * Usage: node <skill>/scripts/finalize.mjs --run <yyyy-mm-dd-hhmm>
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { pathToFileURL } from 'node:url';
const isMainModule = (url) => !!process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === url;
import { auditGitStatus, contentSnapshot, diffContent, diffStatus, resolveRepoRoot, resolveRunDirs, toPosix } from './shared.mjs';
import { readRun, resolveAuthority, updateRun } from './run-state.ts';

const MANIFEST = 'manifest.json';
const defaultCopyDir = (from, to) => fs.cpSync(from, to, { recursive: true });

// ============================================================================
// SECTION: Main
// ============================================================================

export function main(options = {}) {
  const root = options.root ?? resolveRepoRoot();
  const { runId, reportPath, workDir, rel } = resolveRunDirs(root, options.argv ?? process.argv);
  if (!fs.existsSync(reportPath)) {
    throw new Error(`${rel(reportPath)} not found; write the report before finalizing.`);
  }

  const manifest = fs.existsSync(path.join(workDir, MANIFEST)) ? readRun(workDir) : null;
  if (manifest) assertStopped(manifest, workDir);

  const ports = { copyDir: options.copyDir ?? defaultCopyDir, removeDir: options.removeDir ?? removeTree, appendReport: options.appendReport ?? fs.appendFileSync };
  const authority = resolveAuthority(workDir, manifest?.relocation ?? null);
  if (authority.authoritative !== workDir) {
    // A prior attempt published; the integrity recorded at publication completes the footer without re-copying.
    const integrity = manifest.relocation.integrity ?? 'unknown (not recorded before publication)';
    completeReport(reportPath, authority.authoritative, integrity, ports);
    if (authority.removeSource) ports.removeDir(workDir);
    process.stdout.write(`Run artifacts already relocated to ${toPosix(authority.authoritative)}\n`);
    return;
  }
  if (!fs.existsSync(workDir) && hasFooter(reportPath)) {
    // The footer lands before source removal, so a missing source with a footer means a finished run.
    process.stdout.write(`Report already finalized: ${rel(reportPath)}\n`);
    return;
  }

  const integrity = formatIntegrity(compare(root, workDir, reportPath, rel));
  let destination = null;
  try {
    destination = relocateWorkDir(workDir, runId, manifest !== null, integrity, ports.copyDir);
  } catch (err) {
    const footer = [
      '',
      '---',
      '',
      `Audit relocation failed (${err.message}); evidence remains at \`${toPosix(workDir)}\`${err.destination ? `; uncertain copy preserved at \`${toPosix(err.destination)}\`` : ''}. Re-run finalize to retry.`,
      '',
      `Repo integrity: ${integrity}`,
      '',
    ].join('\n');
    ports.appendReport(reportPath, footer, 'utf8');
    throw new Error(`relocation failed: ${err.message}`);
  }

  const footer = completeReport(reportPath, destination, integrity, ports);
  // Source removal is last: until then the source manifest records the published destination and integrity.
  if (destination) ports.removeDir(workDir);
  process.stdout.write(`Report: ${rel(reportPath)}\n${footer.trim()}\n`);
}

const ARTIFACTS_LINE = 'Run artifacts (baseline, findings, probe captures): ';
const removeTree = (dir) => fs.rmSync(dir, { recursive: true, force: true });
const hasFooter = (reportPath, destination) => fs.readFileSync(reportPath, 'utf8').includes(destination === undefined ? ARTIFACTS_LINE : `${ARTIFACTS_LINE}\`${toPosix(destination)}\``);

/** Appends the authoritative-path and integrity footer once per destination, so retries never duplicate it. */
function completeReport(reportPath, destination, integrity, ports) {
  const footer = ['', '---', '', `${ARTIFACTS_LINE}${destination ? `\`${toPosix(destination)}\`` : 'none'}`, '', `Repo integrity: ${integrity}`, ''].join('\n');
  if (!(destination ? hasFooter(reportPath, destination) : hasFooter(reportPath))) ports.appendReport(reportPath, footer, 'utf8');
  return footer;
}

/**
 * Finalizing while a scope or probe still runs would relocate evidence it is still writing; a terminal
 * probe whose child exit is unconfirmed may still hold its capture and fixture, so it blocks too.
 */
function assertStopped(manifest, workDir) {
  const running = [
    ...Object.entries(manifest.scopes).filter(([, s]) => s.lifecycle === 'running' || s.lifecycle === 'pending').map(([id]) => `scope ${id}`),
    ...Object.entries(manifest.probes).filter(([, p]) => p.lifecycle === 'running' || p.lifecycle === 'pending').map(([id]) => `probe ${id}`),
  ];
  if (running.length) throw new Error(`Cannot finalize: still running: ${running.join(', ')}. Stop or record a terminal state first.`);
  const unconfirmed = Object.entries(manifest.probes)
    .filter(([, p]) => p.exitConfirmed === false || p.liveness === 'unknown' || p.liveness === 'alive')
    .map(([id, p]) => `probe ${id} (${p.lifecycle}, liveness ${p.liveness}, handle ${p.handle ?? 'none'}${p.fixturePath ? `, fixture ${p.fixturePath}` : ''})`);
  if (unconfirmed.length) {
    throw new Error(`Cannot finalize: no confirmed exit for ${unconfirmed.join(', ')}. Evidence is left at ${toPosix(workDir)}; confirm each child has exited, record exitConfirmed and liveness "exited", then re-run finalize.`);
  }
}

// ============================================================================
// SECTION: Integrity
// ============================================================================

/** @returns {{changes: string[], gaps: string[]}|null} */
function compare(root, workDir, reportPath, rel) {
  const statusPath = path.join(workDir, 'git-status.txt');
  const snapshotPath = path.join(workDir, 'content-snapshot.json');
  if (!fs.existsSync(statusPath)) return null;
  const changes = diffStatus(fs.readFileSync(statusPath, 'utf8'), auditGitStatus(root) ?? '');
  const gaps = [];
  if (fs.existsSync(snapshotPath)) {
    const before = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    const after = contentSnapshot(root, { exclude: [rel(workDir), rel(reportPath)] });
    changes.push(...diffContent(before, after));
    gaps.push(...before.gaps, ...after.gaps);
  } else {
    gaps.push('no content snapshot; edits to already-dirty files are undetected');
  }
  return { changes, gaps };
}

/** @param {{changes: string[], gaps: string[]}|null} result @returns {string} */
function formatIntegrity(result) {
  if (result === null) return 'unknown (no baseline snapshot)';
  const gaps = result.gaps.length ? `\n\nGaps: ${result.gaps.join('; ')}` : '';
  if (result.changes.length === 0) return `unchanged${gaps}`;
  return `CHANGED during the audit:\n\n\`\`\`\n${result.changes.join('\n')}\n\`\`\`${gaps}`;
}

// ============================================================================
// SECTION: Artifact Relocation
// ============================================================================

/**
 * Stage → verify → publish; the caller removes the source after the report footer lands. Phase changes
 * persist in the source manifest, with the integrity result at publication, so a retry knows which copy
 * is authoritative and can complete the footer.
 * @returns {string|null}
 */
function relocateWorkDir(workDir, runId, tracked, integrity, copyDir) {
  if (!fs.existsSync(workDir)) return null;

  const destination = fs.mkdtempSync(path.join(os.tmpdir(), `audit-dispatch-skills-${runId}-`));
  const setPhase = (phase) => { if (tracked) updateRun(workDir, (m) => { m.relocation = phase === 'published' ? { phase, destination, integrity } : { phase, destination }; }); };
  try {
    setPhase('staging');
    copyDir(workDir, destination);
    const missing = treeMismatch(workDir, destination);
    if (missing.length) throw new Error(`copy verification failed for ${missing.join(', ')}`);
    setPhase('published');
    // The published manifest is copied last, so the destination carries the authoritative phase.
    if (tracked) fs.copyFileSync(path.join(workDir, MANIFEST), path.join(destination, MANIFEST));
  } catch (err) {
    try { setPhase('failed'); } catch {}
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { destination });
  }
  return destination;
}

/** Paths whose content differs between the source and the copy; the manifest changes during staging. */
function treeMismatch(source, copy) {
  const a = hashTree(source), b = hashTree(copy);
  return [...new Set([...a.keys(), ...b.keys()])].filter((p) => p !== MANIFEST && a.get(p) !== b.get(p)).sort();
}

function hashTree(dir, prefix = '', out = new Map()) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) hashTree(full, rel, out);
    else out.set(rel, createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
  }
  return out;
}

/** @param {string} from @param {string} to */
export function moveEntry(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    // NOTE: rename fails across volumes (EXDEV) and on Windows when a handle lingers (EPERM).
    if (!['EXDEV', 'EPERM', 'EBUSY'].includes(err.code)) throw err;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

// ============================================================================
// SECTION: CLI Entry
// ============================================================================

// Guarded so helpers can be imported without finalizing a run.
if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[finalize] ${err.message}\n`);
    process.exit(1);
  }
}
