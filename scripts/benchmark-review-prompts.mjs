#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isMainModule, measureText } from '../skills/dispatch/scripts/common.mjs';
import { extractTemplate, fillTemplate } from '../skills/dispatch/scripts/fill-template.mjs';
import { parseReport as parseCodeReport } from '../skills/dispatch-code-review/scripts/parse-report.mjs';
import { parseReport as parsePlanReport } from '../skills/dispatch-plan-review/scripts/parse-report.mjs';
import { initRun } from '../skills/implement-dispatch/scripts/run-record.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CORPUS = path.resolve(__dirname, '..', 'tests', 'fixtures', 'review-corpus');
const PROMPT_PATHS = {
  plan: path.resolve(__dirname, '..', 'skills', 'dispatch-plan-review', 'references', 'prompt-template.md'),
  code: path.resolve(__dirname, '..', 'skills', 'dispatch-code-review', 'references', 'prompt-template.md'),
};
const SCHEMA_PATHS = {
  plan: path.resolve(__dirname, '..', 'skills', 'dispatch-plan-review', 'references', 'report-schema.json'),
  code: path.resolve(__dirname, '..', 'skills', 'dispatch-code-review', 'references', 'report-schema.json'),
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function findingKey(finding) {
  return `${finding.kind}|${finding.tag}|${finding.locus}`;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function parseMarkdownReport(text) {
  const findings = [];
  let kind = null;
  for (const line of String(text).split(/\r?\n/)) {
    const heading = /^##\s+(MUST-FIX|SHOULD-FIX|CONSIDER)\s*$/.exec(line.trim());
    if (heading) {
      kind = heading[1] === 'MUST-FIX' ? 'MUST' : heading[1] === 'SHOULD-FIX' ? 'SHOULD' : 'CONSIDER';
      continue;
    }
    const normalized = line.trim().replace(/^[-*]\s+/, '');
    const separator = normalized.indexOf(' — ');
    if (!kind || separator < 0) continue;
    const locus = normalized.slice(0, separator).replace(/^`|`$/g, '').trim();
    if (!locus.startsWith('§') && !/^[^:]+:L\d+$/.test(locus)) continue;
    const tagMatch = /^`?([^`:]+)`?\s*:/.exec(normalized.slice(separator + 3));
    if (tagMatch) findings.push({ kind, locus, tag: tagMatch[1].trim() });
  }
  return findings;
}

export function parseStructuredReport(text, kind) {
  if (!['plan', 'code'].includes(kind)) throw new Error(`Unknown review kind: ${kind}`);
  const parsed = kind === 'plan' ? parsePlanReport(text) : parseCodeReport(text);
  return parsed.findings.map(({ severity, tag, locus }) => ({ kind: severity, tag, locus }));
}

export function parseBenchmarkReport(report, kind, grammar, exitCode) {
  if (exitCode !== 0) return { findings: [], parseFailure: false };
  if (!String(report).trim()) return { findings: [], parseFailure: true };
  try {
    return {
      findings: grammar === 'json'
        ? parseStructuredReport(report, kind)
        : parseMarkdownReport(report),
      parseFailure: false,
    };
  } catch {
    return { findings: [], parseFailure: true };
  }
}

export function scoreFindings(oracle, findings) {
  const actual = new Set(findings.map(findingKey));
  const keys = (name) => new Set((oracle[name] ?? []).map(findingKey));
  const must = keys('must');
  const should = keys('should');
  const optional = keys('optional');
  const forbidden = keys('forbidden');
  const countPresent = (set) => [...set].filter((key) => actual.has(key)).length;
  const unexpected = [...actual].filter((key) =>
    !must.has(key) && !should.has(key) && !optional.has(key) && !forbidden.has(key));
  return {
    mustFound: countPresent(must),
    mustTotal: must.size,
    shouldFound: countPresent(should),
    shouldTotal: should.size,
    forbiddenFound: countPresent(forbidden),
    unexpected: unexpected.length,
    cleanFalsePositive: must.size === 0 && should.size === 0 && actual.size > 0,
  };
}

export function validateCorpus(corpusDir = DEFAULT_CORPUS) {
  const manifest = readJson(path.join(corpusDir, 'manifest.json'));
  if (manifest.schemaVersion !== 1 || typeof manifest.corpusVersion !== 'string') {
    throw new Error('Unsupported review corpus manifest.');
  }
  if (!Array.isArray(manifest.fixtures) || manifest.fixtures.length < 8) {
    throw new Error('Review corpus must contain at least eight fixtures.');
  }
  const ids = new Set();
  for (const fixture of manifest.fixtures) {
    if (ids.has(fixture.id)) throw new Error(`Duplicate fixture id: ${fixture.id}`);
    ids.add(fixture.id);
    if (!['plan', 'code'].includes(fixture.kind) || !['full', 're-review'].includes(fixture.mode)) {
      throw new Error(`Fixture ${fixture.id} has invalid kind or mode.`);
    }
    for (const file of fixture.files) {
      const resolved = path.resolve(corpusDir, fixture.id, file);
      if (!resolved.startsWith(`${path.resolve(corpusDir, fixture.id)}${path.sep}`) || !fs.existsSync(resolved)) {
        throw new Error(`Fixture ${fixture.id} is missing ${file}.`);
      }
    }
  }
  return manifest;
}

export function materializeFixture(corpusDir, fixture) {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), `review-corpus-${fixture.id}-`));
  fs.cpSync(path.join(corpusDir, fixture.id), target, { recursive: true });
  const init = spawnSync('git', ['init', '--quiet'], { cwd: target, encoding: 'utf8' });
  if (init.status !== 0) throw new Error(init.stderr);
  return target;
}

export function renderFixturePrompt(fixture) {
  const artifact = fixture.files.find((file) => file.endsWith('.md')) ?? fixture.files[0];
  const templatePath = PROMPT_PATHS[fixture.kind];
  const { variables, template } = extractTemplate(fs.readFileSync(templatePath, 'utf8'));
  const reviewScope = fixture.mode === 'full'
    ? 'Full review'
    : 'Re-review synthetic fixture; verify the logged prior resolution and changed source.';
  const values = fixture.kind === 'plan'
    ? {
        'Plan Path': artifact,
        Requirement: `Review the synthetic ${fixture.id} plan fixture.`,
        'User Focus Areas': 'General review',
        'Review Scope': reviewScope,
        'Tool Turn Budget': '24',
      }
    : {
        'Task Summary': `Review the synthetic ${fixture.id} code fixture.`,
        'Walkthrough Path': artifact,
        'Plan Path': 'None',
        'User Focus Areas': 'General review',
        'Review Scope': reviewScope,
        'Tool Turn Budget': '24',
      };
  return fillTemplate(template, variables, values);
}

function runLive(corpusDir, manifest, matrix, grammar) {
  const dispatch = path.resolve(__dirname, '..', 'skills', 'dispatch', 'scripts', 'dispatch.mjs');
  const runs = [];
  for (const fixture of manifest.fixtures) {
    for (const target of matrix.targets) {
      for (let repeat = 1; repeat <= matrix.repeats; repeat++) {
        const repo = materializeFixture(corpusDir, fixture);
        try {
          const prompt = renderFixturePrompt(fixture);
          const initialized = initRun({ repoRoot: repo });
          const metricsFile = path.join(initialized.runDir, 'benchmark-slot.json');
          const args = [
            dispatch,
            '--provider', target.provider,
            ...(target.model ? ['--model', target.model] : []),
            ...(target.effort ? ['--effort', target.effort] : []),
            ...(grammar === 'json'
              ? ['--response-schema-file', SCHEMA_PATHS[fixture.kind]]
              : []),
            '--metrics-file', metricsFile,
            prompt,
          ];
          const result = spawnSync(process.execPath, args, {
            cwd: repo,
            encoding: 'utf8',
            timeout: 30 * 60 * 1000,
            maxBuffer: 16 * 1024 * 1024,
          });
          const report = result.status === 0 ? result.stdout : '';
          const slot = fs.existsSync(metricsFile) ? readJson(metricsFile) : null;
          const attempt = slot?.attempts?.[slot.effectiveAttempt ?? slot.attempts.length - 1] ?? null;
          const { findings, parseFailure } =
            parseBenchmarkReport(report, fixture.kind, grammar, result.status);
          const status =
            parseFailure ? 'failed' :
              result.status === 0 ? 'ok' :
                slot?.attempts?.length ? 'failed' : 'skipped';
          if (status !== 'ok' && target.required) {
            throw new Error(`${target.provider} is required but failed for ${fixture.id}: ${result.stderr}`);
          }
          runs.push({
            fixtureId: fixture.id,
            provider: target.provider,
            model: target.model ?? null,
            repeat,
            status,
            failureKind: parseFailure ? 'invalid-report' : attempt?.failureKind ?? null,
            score: scoreFindings(fixture.oracle, findings),
            input: attempt
              ? { characters: attempt.inputChars, estimate: attempt.inputEstimate }
              : { characters: 0, estimate: 0 },
            output: attempt
              ? { characters: attempt.outputChars, estimate: attempt.outputEstimate }
              : measureText(report),
          });
        } finally {
          fs.rmSync(repo, { recursive: true, force: true });
        }
      }
    }
  }
  return runs;
}

export function aggregate(runs) {
  return runs.reduce((total, run) => {
    total.runs++;
    total[run.status]++;
    total.invalidReports += Number(run.failureKind === 'invalid-report');
    if (run.status === 'ok') {
      for (const key of ['mustFound', 'mustTotal', 'shouldFound', 'shouldTotal', 'forbiddenFound', 'unexpected']) {
        total[key] += run.score[key];
      }
      total.cleanFalsePositives += Number(run.score.cleanFalsePositive);
    }
    total.inputChars += run.input.characters ?? 0;
    total.outputChars += run.output.characters ?? 0;
    return total;
  }, {
    runs: 0, ok: 0, failed: 0, skipped: 0, mustFound: 0, mustTotal: 0, shouldFound: 0,
    shouldTotal: 0, forbiddenFound: 0, unexpected: 0, cleanFalsePositives: 0, invalidReports: 0,
    inputChars: 0, outputChars: 0,
  });
}

function availabilityOutcomes(runs) {
  const outcomes = {};
  for (const run of runs) {
    const key = `${run.provider}:${run.model ?? 'default'}`;
    const outcome = outcomes[key] ?? { ok: 0, failed: 0, skipped: 0 };
    outcome[run.status]++;
    outcomes[key] = outcome;
  }
  return outcomes;
}

function parseArgs(argv) {
  const out = { corpusDir: DEFAULT_CORPUS, grammar: 'markdown', live: false, validateOnly: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--corpus') out.corpusDir = path.resolve(argv[++i]);
    else if (arg === '--grammar') out.grammar = argv[++i];
    else if (arg === '--out') out.out = path.resolve(argv[++i]);
    else if (arg === '--live') out.live = true;
    else if (arg === '--validate-only') out.validateOnly = true;
    else if (arg === '-h' || arg === '--help') out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!['markdown', 'json'].includes(out.grammar)) throw new Error('--grammar must be markdown or json.');
  return out;
}

const USAGE = `Usage:
  node scripts/benchmark-review-prompts.mjs --validate-only [--corpus <path>]
  node scripts/benchmark-review-prompts.mjs --live --grammar <markdown|json> --out <path>
`;

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return process.stdout.write(USAGE);
  const manifest = validateCorpus(args.corpusDir);
  const matrix = readJson(path.join(args.corpusDir, 'matrix.json'));
  if (matrix.schemaVersion !== 1 || matrix.repeats !== 3 || !Array.isArray(matrix.targets)) {
    throw new Error('Benchmark matrix must be schema v1 with exactly three repeats.');
  }
  if (args.validateOnly) {
    for (const fixture of manifest.fixtures) {
      const repo = materializeFixture(args.corpusDir, fixture);
      fs.rmSync(repo, { recursive: true, force: true });
    }
    return process.stdout.write(`${manifest.corpusVersion}: ${manifest.fixtures.length} fixtures valid\n`);
  }
  if (!args.live || !args.out) throw new Error('Benchmark execution is opt-in and requires --live and --out.');
  const runs = runLive(args.corpusDir, manifest, matrix, args.grammar);
  const output = {
    schemaVersion: 1,
    corpusVersion: manifest.corpusVersion,
    matrixVersion: matrix.matrixVersion,
    grammar: args.grammar,
    generatedAt: new Date().toISOString(),
    command: 'node scripts/benchmark-review-prompts.mjs --live --grammar <markdown|json> --out <path>',
    environment: {
      node: process.version,
      git: spawnSync('git', ['--version'], { encoding: 'utf8' }).stdout.trim(),
    },
    promptHashes: Object.fromEntries(
      Object.entries(PROMPT_PATHS).map(([kind, file]) => [kind, sha256(fs.readFileSync(file, 'utf8'))]),
    ),
    schemaHashes: args.grammar === 'json'
      ? Object.fromEntries(
          Object.entries(SCHEMA_PATHS).map(([kind, file]) => [kind, sha256(fs.readFileSync(file, 'utf8'))]),
        )
      : null,
    availabilityOutcomes: availabilityOutcomes(runs),
    runs,
    aggregate: aggregate(runs),
  };
  fs.writeFileSync(args.out, `${JSON.stringify(output, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(`${args.out}\n`);
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[benchmark-review-prompts] ${err.message}\n`);
    process.exit(1);
  }
}
