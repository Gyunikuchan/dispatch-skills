#!/usr/bin/env node

/**
 * @file calibrate.ts
 * @description Static calibration of old and new audit briefs against curated historical defects and intentional
 * controls: prepares answer-free case packets, fixes claims before reveal, and scores lead-adjudicated root-cause matches.
 * It never launches agents or providers.
 *
 * Usage: node <skill>/scripts/calibrate.ts prepare --run <run> --host <host> --model <model> [--effort <effort>]
 *        node <skill>/scripts/calibrate.ts fix --run <run> --arm <old|new>
 *        node <skill>/scripts/calibrate.ts summarize --run <run> --adjudication <file.json> --usage <file.json>
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ============================================================================
// SECTION: Types
// ============================================================================

export type Excerpt = { path: string; commit: string; blob: string; lines: string; sha256: string; text: string };
export type CalibrationCase = {
  id: string; kind: 'defect' | 'control'; category: string; severity?: string; scenario: string;
  source: { commit: string; parent: string | null }; excerpts: Excerpt[]; answer: Record<string, string>;
};
export type BriefRef = { commit: string | null; paths: { path: string; blob: string | null }[] };
export type CalibrationFixture = { version: 1; briefs: Record<Arm, BriefRef>; cases: CalibrationCase[] };
export type Arm = 'old' | 'new';
export type Settings = { host: string; model: string; effort: string };
export type Claim = { id: string; verdict: 'defect' | 'opportunity' | 'none'; claim: string; evidence: string[] };
export type Adjudication = { arms: Record<Arm, Record<string, { match: string | null; rationale: string }>> };
export type Usage = Partial<Record<Arm, Partial<Record<UsageMetric, number | null>>>>;
type UsageMetric = (typeof USAGE_METRICS)[number];
export type ArmResult = {
  recovered: string[]; missed: string[]; highMissed: string[]; controlFalseDefects: { caseId: string; claim: string }[];
  missingCases: string[]; unsupported: string[]; pass: boolean;
};

// ============================================================================
// SECTION: Configuration
// ============================================================================

export const ARMS: readonly Arm[] = ['old', 'new'];
const DEFECT_CATEGORIES = ['ambiguity', 'handoff', 'efficiency', 'recovery'];
const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const HIGH = new Set(['high', 'critical']);
const CONTROLS = 2;
const MIN_RECOVERED = 3;
const USAGE_METRICS = ['inputTokens', 'outputTokens', 'toolCalls', 'wallSeconds'] as const;
const SHA = /^[0-9a-f]{40}$/;
const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(SKILL_DIR, '..', '..', '..');
export const DEFAULT_FIXTURE_PATH = path.join(SKILL_DIR, 'fixtures', 'calibration', 'cases.json');

const sha256 = (text: string) => `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const dirOf = (workDir: string) => path.join(workDir, 'calibration');
const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8')) as T;
const writeJson = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

// ============================================================================
// SECTION: Validation
// ============================================================================

// Only controls carry rationale comments, so their presence would reveal the answer; strip them from every packet alike.
// The packet keeps the source sha256 so provenance stays checkable against the corpus.
const RATIONALE_LINE = /^[ \t]*(?:\/\/|#|\*)\s*(?:NOTE|WHY|RATIONALE)\b.*(?:\r?\n|$)/gim;
export const redactRationale = (text: string): string => text.replace(RATIONALE_LINE, '');

/** Throws with every corpus defect: counts, categories, provenance, excerpt hashes and answer keys. */
export function validateFixture(fixture: CalibrationFixture): void {
  const errors: string[] = [];
  const defects = fixture.cases.filter((c) => c.kind === 'defect');
  const controls = fixture.cases.filter((c) => c.kind === 'control');
  if (defects.length !== DEFECT_CATEGORIES.length || controls.length !== CONTROLS) {
    errors.push(`corpus needs ${DEFECT_CATEGORIES.length} defects and ${CONTROLS} controls, found ${defects.length} and ${controls.length}`);
  }
  const categories = defects.map((c) => c.category).sort();
  if (categories.join() !== [...DEFECT_CATEGORIES].sort().join()) errors.push(`defect categories must be exactly ${DEFECT_CATEGORIES.join(', ')}; found ${categories.join(', ')}`);
  if (new Set(fixture.cases.map((c) => c.id)).size !== fixture.cases.length) errors.push('case ids must be unique');
  for (const c of fixture.cases) {
    if (!nonEmpty(c.id) || !nonEmpty(c.scenario)) errors.push(`${c.id}: needs an id and scenario`);
    if (!SHA.test(c.source?.commit ?? '')) errors.push(`${c.id}: source commit must be a full hash`);
    if (c.kind === 'defect') {
      if (!SHA.test(c.source?.parent ?? '')) errors.push(`${c.id}: defect source parent must be a full hash`);
      if (!SEVERITIES.includes(c.severity ?? '')) errors.push(`${c.id}: severity must be one of ${SEVERITIES.join(', ')}`);
      if (!nonEmpty(c.answer?.['rootCause']) || !nonEmpty(c.answer?.['fixRationale'])) errors.push(`${c.id}: answer needs rootCause and fixRationale`);
    } else if (c.kind === 'control') {
      if (!nonEmpty(c.answer?.['intent'])) errors.push(`${c.id}: control answer needs intent`);
    } else errors.push(`${c.id}: kind must be defect or control`);
    if (!Array.isArray(c.excerpts) || c.excerpts.length === 0) errors.push(`${c.id}: needs at least one excerpt`);
    for (const e of c.excerpts ?? []) {
      if (!nonEmpty(e.path) || !SHA.test(e.commit ?? '') || !SHA.test(e.blob ?? '') || !nonEmpty(e.lines)) errors.push(`${c.id}: excerpt ${e.path} needs path, commit, blob and lines`);
      if (!nonEmpty(e.text) || sha256(e.text) !== e.sha256) errors.push(`${c.id}: excerpt ${e.path}:${e.lines} text does not match its sha256`);
    }
  }
  if (!SHA.test(fixture.briefs?.old?.commit ?? '') || !fixture.briefs.old.paths.every((p) => SHA.test(p.blob ?? ''))) errors.push('old brief needs a baseline commit and blob per path');
  if (!fixture.briefs?.new?.paths?.length) errors.push('new brief needs paths');
  if (errors.length) throw new Error(`invalid calibration corpus:\n- ${errors.join('\n- ')}`);
}

// ============================================================================
// SECTION: Prepare
// ============================================================================

export type PrepareOptions = {
  fixture: CalibrationFixture; workDir: string; settings: Settings;
  now?: () => Date;
  /** Reads a repo-relative path of the current (new) brief. */
  readBrief?: (repoPath: string) => string;
};

/** Writes one answer-free packet per arm and case plus the calibration manifest; returns packet paths. */
export function prepare(options: PrepareOptions): string[] {
  const { fixture, workDir, settings } = options;
  validateFixture(fixture);
  for (const key of ['host', 'model', 'effort'] as const) if (!nonEmpty(settings[key])) throw new Error(`calibration settings need ${key}; both arms run with identical host/model settings`);
  const readBrief = options.readBrief ?? ((p: string) => fs.readFileSync(path.join(REPO_ROOT, ...p.split('/')), 'utf8'));
  const arms: Record<Arm, unknown> = {
    old: fixture.briefs.old,
    new: { commit: null, paths: fixture.briefs.new.paths.map((p) => ({ path: p.path, sha256: sha256(readBrief(p.path)) })) },
  };
  const dir = dirOf(workDir);
  const preparedAt = (options.now ?? (() => new Date()))().toISOString();
  // Case ids name the kind (defect-*/control-*), so auditors see a per-run opaque id; only the manifest maps it back.
  const packetIds = Object.fromEntries(fixture.cases.map((c) => [c.id, `case-${sha256(`${preparedAt}\0${c.id}`).slice(7, 15)}`]));
  if (new Set(Object.values(packetIds)).size !== fixture.cases.length) throw new Error('opaque packet ids collided; prepare again');
  const written: string[] = [];
  for (const arm of ARMS) {
    for (const c of fixture.cases) {
      const file = path.join(dir, 'packets', arm, `${packetIds[c.id]}.json`);
      // NOTE: kind, category, severity, answer and the fix commit are withheld; parent-commit excerpts show pre-fix source.
      writeJson(file, {
        arm, caseId: packetIds[c.id], scenario: c.scenario, brief: arms[arm],
        excerpts: c.excerpts.map(({ path: p, commit, blob, lines, sha256: hash, text }) => ({ path: p, commit, blob, lines, sha256: hash, text: redactRationale(text) })),
        constraints: { scope: 'calibration', probes: false, nestedDispatch: false },
        claimsPath: `calibration/claims/${arm}.json`,
      });
      written.push(file);
    }
  }
  writeJson(path.join(dir, 'manifest.json'), {
    version: 1, preparedAt, settings, arms, packetIds,
    cases: Object.fromEntries(fixture.cases.map((c) => [c.id, c.excerpts.map((e) => e.sha256)])),
    answerKeySha256: sha256(JSON.stringify(fixture.cases.map((c) => [c.id, c.answer]))),
    fixedClaims: {},
  });
  return written;
}

// ============================================================================
// SECTION: Fix claims
// ============================================================================

/** Records the hash of an arm's claims so later edits are detected; call before revealing answer keys. */
export function fixClaims(workDir: string, arm: Arm): string {
  const dir = dirOf(workDir);
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = readJson<{ fixedClaims: Record<string, string> }>(manifestPath);
  if (manifest.fixedClaims[arm]) throw new Error(`${arm} claims are already fixed`);
  const hash = sha256(fs.readFileSync(path.join(dir, 'claims', `${arm}.json`), 'utf8'));
  manifest.fixedClaims[arm] = hash;
  writeJson(manifestPath, manifest);
  return hash;
}

// ============================================================================
// SECTION: Summarize
// ============================================================================

export type SummarizeOptions = { fixture: CalibrationFixture; workDir: string; adjudication: Adjudication; usage: Usage };

export function summarize(options: SummarizeOptions) {
  const { fixture, workDir, adjudication } = options;
  const dir = dirOf(workDir);
  const manifest = readJson<{ fixedClaims: Record<string, string>; settings: Settings }>(path.join(dir, 'manifest.json'));
  const claims = {} as Record<Arm, Record<string, Claim[]>>;
  for (const arm of ARMS) {
    const file = path.join(dir, 'claims', `${arm}.json`);
    const fixed = manifest.fixedClaims[arm];
    if (!fixed) throw new Error(`${arm} claims are not fixed; run fix before revealing answer keys or scoring`);
    if (sha256(fs.readFileSync(file, 'utf8')) !== fixed) throw new Error(`${arm} claims changed after they were fixed`);
    claims[arm] = readJson<{ cases: Record<string, Claim[]> }>(file).cases;
  }
  const arms = Object.fromEntries(ARMS.map((arm) => [arm, scoreArm(fixture, claims[arm], adjudication.arms[arm] ?? {}, arm)])) as Record<Arm, ArmResult>;
  const summary = { settings: manifest.settings, arms, usage: usageReport(options.usage), pass: arms.new.pass };
  writeJson(path.join(dir, 'summary.json'), summary);
  return summary;
}

function scoreArm(fixture: CalibrationFixture, cases: Record<string, Claim[]>, matches: Adjudication['arms'][Arm], arm: Arm): ArmResult {
  const result: ArmResult = { recovered: [], missed: [], highMissed: [], controlFalseDefects: [], missingCases: [], unsupported: [], pass: false };
  for (const c of fixture.cases) {
    const caseClaims = cases[c.id];
    if (!Array.isArray(caseClaims)) {
      result.missingCases.push(c.id);
      if (c.kind === 'defect') result.missed.push(c.id);
      continue;
    }
    for (const claim of caseClaims) if (claim.verdict === 'defect' && !(claim.evidence ?? []).some(nonEmpty)) result.unsupported.push(claim.id);
    if (c.kind === 'control') {
      for (const claim of caseClaims) if (claim.verdict === 'defect') result.controlFalseDefects.push({ caseId: c.id, claim: claim.id });
      continue;
    }
    const ruling = matches[c.id];
    if (ruling?.match) {
      const claim = caseClaims.find((x) => x.id === ruling.match);
      if (!claim || claim.verdict !== 'defect') throw new Error(`${arm}/${c.id}: match ${ruling.match} is not a fixed defect claim of this case`);
      if (!nonEmpty(ruling.rationale)) throw new Error(`${arm}/${c.id}: a root-cause match needs a rationale`);
      result.recovered.push(c.id);
    } else result.missed.push(c.id);
  }
  result.highMissed = result.missed.filter((id) => HIGH.has(fixture.cases.find((c) => c.id === id)?.severity ?? ''));
  result.pass = result.recovered.length >= MIN_RECOVERED && result.highMissed.length === 0 && result.controlFalseDefects.length === 0
    && result.missingCases.length === 0 && result.unsupported.length === 0;
  return result;
}

/** Reports measured usage per arm; a metric missing from either arm is unavailable and yields no comparison. */
function usageReport(usage: Usage) {
  const unavailable: string[] = [];
  const comparison = {} as Record<UsageMetric, number | 'unavailable'>;
  for (const metric of USAGE_METRICS) {
    const values = ARMS.map((arm) => usage[arm]?.[metric]);
    ARMS.forEach((arm, i) => { if (typeof values[i] !== 'number') unavailable.push(`${arm}.${metric}`); });
    const [before, after] = values;
    comparison[metric] = typeof before === 'number' && typeof after === 'number' ? after - before : 'unavailable';
  }
  return { measured: usage, comparison, unavailable, complete: unavailable.length === 0 };
}

// ============================================================================
// SECTION: CLI
// ============================================================================

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv: string[]): void {
  const [command] = argv;
  const runId = flag(argv, '--run');
  if (!runId) throw new Error('--run <yyyy-mm-dd-hhmm> is required');
  const workDir = path.join(REPO_ROOT, '.scratch', 'audits', `${runId}-work`);
  if (!fs.existsSync(path.join(workDir, 'manifest.json'))) throw new Error(`No audit run reserved at ${workDir}; run baseline first.`);
  const fixture = readJson<CalibrationFixture>(DEFAULT_FIXTURE_PATH);
  if (command === 'prepare') {
    const settings = { host: flag(argv, '--host') ?? '', model: flag(argv, '--model') ?? '', effort: flag(argv, '--effort') ?? 'default' };
    for (const file of prepare({ fixture, workDir, settings })) process.stdout.write(`${path.relative(REPO_ROOT, file).split(path.sep).join('/')}\n`);
  } else if (command === 'fix') {
    const arm = flag(argv, '--arm');
    if (arm !== 'old' && arm !== 'new') throw new Error('--arm must be old or new');
    process.stdout.write(`${fixClaims(workDir, arm)}\n`);
  } else if (command === 'summarize') {
    const adjudication = readJson<Adjudication>(flag(argv, '--adjudication') ?? '');
    const usage = readJson<Usage>(flag(argv, '--usage') ?? '');
    process.stdout.write(`${JSON.stringify(summarize({ fixture, workDir, adjudication, usage }), null, 2)}\n`);
  } else throw new Error('command must be prepare, fix or summarize');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
