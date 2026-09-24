// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureLedgerNamespace } from '../ledger/ledger.mjs';
import { extractGeneratedPaths } from '../plan/structure.mjs';
import { repositoryRootHash } from '../artifacts/resolve-paths.mjs';
import { captureRepositoryState, compareFailureIdentity, criterionMappings, diffRepositoryState, extractApprovedPathSet, failureIdentity, mapVerificationCommandsToPaths, outcomeFirstPacket } from '../verification/evidence.mjs';
import { baselineFingerprint, materializedFingerprint } from '../lib/git-state.mjs';
import {
  parseIdentifiers,
  stripIdentifierSpans,
  checkRedQuality,
} from '../verification/red-quality.mjs';
import { emitAction } from './actions.mjs';
import { source } from './implement-state.mjs';

export function verificationPlan(state) {
  const text = source(state);
  const approvedPaths = extractApprovedPathSet(text);
  const criteria = criterionMappings(text);
  const commands = [...new Set(criteria.flatMap(item => item.commands))];
  if (!approvedPaths.length || !commands.length || criteria.some(item => !item.paths.length || !item.commands.length || !['red', 'verify', 'review'].includes(item.evidence))) throw new Error('Baseline requires approved paths, commands, and explicit evidence classes for every criterion.');
  const scopes = mapVerificationCommandsToPaths(text, commands, approvedPaths);
  const coverage = suiteCoverage(state.repoRoot, commands);
  // A covering suite's freshness must span the paths of every command it replaces.
  for (const [covered, suite] of Object.entries(coverage)) scopes[suite] = [...new Set([...scopes[suite], ...scopes[covered]])].sort();
  return {
    approvedPaths, commands, scopes, coverage, criteria,
    generators: extractGeneratedPaths(text).filter(item => item.path && item.command).map(({ path: file, command }) => ({ path: file, command })),
    packet: outcomeFirstPacket(text, criteria),
    redCriteria: criteria.filter(item => item.evidence === 'red'),
    verifyCriteria: criteria.filter(item => item.evidence === 'verify'),
    reviewCriteria: criteria.filter(item => item.evidence === 'review'),
  };
}
// SECTION: aggregate suite coverage
// `npm test` (or `npm run test`) covers a `node --test <files>` command when every file matches a
// glob in package.json's `test` script; completion then runs the suite once instead of both.
const SUITE_COMMAND = /^npm\s+(?:run\s+)?test$|^npm\s+t$/;
const slashPath = file => file.replace(/\\/g, '/').replace(/^\.\//, '');
function globRegExp(glob) {
  let source = '', braces = 0;
  const text = slashPath(glob);
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (text.startsWith('**/', index)) { source += '(?:.*/)?'; index += 2; }
    else if (text.startsWith('**', index)) { source += '.*'; index++; }
    else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else if (char === '{') { source += '(?:'; braces++; }
    else if (char === '}' && braces) { source += ')'; braces--; }
    else if (char === ',' && braces) source += '|';
    else source += char.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}
function commandArgs(text) {
  return (text.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map(arg => arg.replace(/"([^"]*)"|'([^']*)'/g, '$1$2'));
}
function suiteArgs(repoRoot) {
  let script;
  try { script = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts?.test; } catch { return null; }
  const run = typeof script === 'string' ? /\bnode\s+--test\b([^&|;]*)/.exec(script) : null;
  const args = run ? commandArgs(run[1]) : [];
  // A filtered or sharded suite may skip the tests a narrower command runs.
  if (!run || args.some(arg => /^--test-(?:name-pattern|skip-pattern|only|shard)\b/.test(arg))) return null;
  return args;
}
function suiteGlobs(repoRoot) {
  return (suiteArgs(repoRoot) ?? []).filter(arg => !arg.startsWith('-')).map(globRegExp);
}
/** Maps each `node --test` command whose files all fall under the plan's aggregate suite to that suite command. */
export function suiteCoverage(repoRoot, commands) {
  const suite = commands.find(command => SUITE_COMMAND.test(command.trim()));
  const globs = suite ? suiteGlobs(repoRoot) : [];
  if (!globs.length) return {};
  const covered = commands.filter(command => {
    const match = /^node\s+--test\s+(.+)$/.exec(command.trim());
    if (!match) return false;
    // Only `--flag=value` options are unambiguous; a bare option could consume the next argument.
    const args = commandArgs(match[1]);
    const files = args.filter(arg => !arg.startsWith('--'));
    return files.length > 0 && args.every(arg => !arg.startsWith('-') || /^--[\w-]+=/.test(arg))
      && files.every(file => globs.some(glob => glob.test(slashPath(file))));
  });
  return Object.fromEntries(covered.map(command => [command, suite]));
}
// SECTION: RED narrowing
// The RED gate needs only the new tests: an aggregate suite command narrows to `node --test` over
// the red criteria's approved test files, keeping the suite's `--flag=value` options. A suite with
// any bare option stays whole: it could consume the next argument, so files and values are ambiguous.
export function redSubstitutions(state) {
  const data = state.ordinary, args = suiteArgs(state.repoRoot), out = {};
  if (!args) return out;
  const flags = args.filter(arg => arg.startsWith('-'));
  const globs = args.filter(arg => !arg.startsWith('-')).map(globRegExp);
  if (!globs.length || flags.some(arg => !/^--[\w-]+=\S+$/.test(arg))) return out;
  const quote = value => (/[\s"'&|;<>^%]/.test(value) ? `"${value}"` : value);
  for (const command of purposeCommands(data, 'red')) {
    if (!SUITE_COMMAND.test(command.trim())) continue;
    const files = [...new Set(data.redCriteria.filter(item => item.commands.includes(command)).flatMap(item => item.paths))]
      .filter(file => data.testsOnlyPaths.includes(file) && globs.some(glob => glob.test(slashPath(file)))).sort();
    if (files.length) out[command] = ['node', '--test', ...flags, ...files].map(quote).join(' ');
  }
  return out;
}
/** Commands each gate runs: RED runs only red-mapped commands; completion drops suite-covered commands; baseline records both. */
export function purposeCommands(data, purpose) {
  const red = new Set((data.redCriteria ?? []).flatMap(item => item.commands));
  const uncovered = data.commands.filter(command => !data.coverage?.[command]);
  if (purpose === 'red') return data.commands.filter(command => red.has(command));
  if (purpose === 'baseline') return data.commands.filter(command => red.has(command) || uncovered.includes(command));
  return uncovered;
}
/** Criteria whose evidence a command carries, including those of commands its suite replaces. */
function commandCriteria(data, command) {
  return data.criteria.filter(item => item.commands.some(mapped => mapped === command || data.coverage?.[mapped] === command));
}
export function snapshot(state) {
  const capture = captureRepositoryState(state.repoRoot);
  if (!capture.available) throw new Error(capture.reason);
  capture.entries = Object.fromEntries(Object.entries(capture.entries).filter(([file]) => !file.startsWith('.scratch/')));
  return capture;
}
export function fingerprint(state, paths = state.ordinary.approvedPaths) {
  return materializedFingerprint(state.repoRoot, paths).digest;
}
export function repositoryBaseline(state) {
  const { commit, repositoryState, dirtyPaths } = baselineFingerprint(state.repoRoot);
  return { commit, repositoryState, dirtyPaths };
}
// SECTION: driver-run verification
// The driver executes plan-approved commands itself (`dispatch.mjs --verify`), capturing Git
// state around each one and extracting failure identities from its log; the host only runs that
// argv and, at completion, supplies judgment evidence for verify/review criteria.
export function beginVerification(state, purpose) {
  const data = state.ordinary, token = crypto.randomUUID();
  data.verification = {
    purpose, token, commands: purposeCommands(data, purpose),
    substitutions: purpose === 'red' ? redSubstitutions(state) : {},
    generators: purpose === 'completion' ? data.generators ?? [] : [],
    resultsPath: path.join(path.dirname(state.stateFile), `${state.runId}-verify-${purpose}-${token.slice(0, 8)}.json`),
  };
  return verificationAction(state);
}
/** Non-red criteria whose evidence these commands carry. */
function judgedCriteria(data, commands) {
  return data.criteria.filter(item => item.evidence !== 'red' && commands.some(command => commandCriteria(data, command).includes(item)));
}
export function verificationAction(state) {
  const data = state.ordinary, pending = data.verification;
  // NOTE: a host-run verification pending from before driver-run gates restarts on this gate's commands.
  if (!pending.token) return beginVerification(state, pending.purpose);
  pending.before = snapshot(state);
  pending.epoch = data.mutationEpoch ?? 0;
  const judged = pending.purpose === 'completion' ? judgedCriteria(data, pending.commands) : [];
  const substitutions = Object.keys(pending.substitutions ?? {}).length ? { substitutions: pending.substitutions } : {};
  const generators = pending.generators.length ? { generators: [...new Set(pending.generators.map(item => item.command))] } : {};
  const criteria = pending.commands.flatMap(command => commandCriteria(data, command)).filter((item, index, all) => all.indexOf(item) === index);
  return emitAction(state, 'verify', {
    purpose: pending.purpose, commands: pending.commands.map(command => pending.substitutions?.[command] ?? command), ...substitutions, ...generators,
    argv: [process.execPath, state.dispatchScript, '--verify', '--state', state.stateFile], resultsPath: pending.resultsPath,
    scopes: Object.fromEntries(pending.commands.map(command => [command, data.scopes[command]])), mutationEpoch: pending.epoch,
    criteria: criteria.map(item => ({ id: item.id, evidenceClass: item.evidence, review: item.review ?? null, commands: pending.commands.filter(command => commandCriteria(data, command).includes(item)) })),
  }, [
    'Run argv once as one background command and wait for it to exit: it runs every listed command on the host, logs each to the session directory, and extracts failure identities. Do not run the commands yourself.',
    judged.length
      ? `Then read its summary (and logs as needed) and call --next with --input {"criterionEvidence":[...]} holding one entry for each of ${judged.map(item => item.id).join(', ')}: {criterionId, evidenceClass, reviewer, scenario, inspectedRevision (the summary scopeHash of the criterion's command), observableResult, limitations, mutationEpoch (that command's summary mutationEpoch)}.`
      : 'Then call --next with no --input.',
  ]);
}
export function acceptVerification(state, reply) {
  const data = state.ordinary, pending = data.verification;
  if (reply?.results) throw new Error('This gate runs on the driver: run the verify argv, then call --next without results.');
  let file;
  try { file = JSON.parse(fs.readFileSync(pending.resultsPath, 'utf8')); } catch { throw new Error('Verification results are missing: run the verify argv, wait for it to exit, then call --next.'); }
  if (file.token !== pending.token || file.purpose !== pending.purpose) throw new Error('Verification results belong to another gate; rerun the verify argv.');
  // Edits after the runner finished postdate every result, so they mark the last one changed.
  const drift = diffRepositoryState(file.final, snapshot(state)).changed;
  const criterionEvidence = reply?.criterionEvidence ?? [];
  const records = pending.commands.map((command) => {
    const result = file.results.find(item => item.command === command);
    if (!result) throw new Error(`Verification results lack ${command}; rerun the verify argv.`);
    const mapped = commandCriteria(data, command).map(item => item.id);
    return {
      command, ...(result.ran !== command ? { ran: result.ran } : {}), exitStatus: result.exit, ...(result.counts ?? {}),
      identifiers: result.identifiers, diagnostic: result.diagnostic, logPath: result.logPath,
      identity: failureIdentity({ exitStatus: result.exit, identifiers: result.identifiers, diagnostic: result.diagnostic }),
      criterionEvidence: criterionEvidence.filter(item => mapped.includes(item.criterionId)),
      scopeHash: result.scopeHash, mutationEpoch: result.mutationEpoch, changed: result.changed,
    };
  });
  if (drift.length && records.length) records.at(-1).changed = [...new Set([...records.at(-1).changed, ...drift])];
  if (pending.purpose === 'completion') {
    for (const criterion of judgedCriteria(data, pending.commands)) {
      const evidence = criterionEvidence.find(item => item.criterionId === criterion.id);
      const carriers = records.filter(record => commandCriteria(data, record.command).includes(criterion));
      if (!evidence || evidence.evidenceClass !== criterion.evidence || !evidence.reviewer?.trim() || !evidence.scenario?.trim() || !evidence.observableResult?.trim() || !evidence.limitations?.trim()
        || !carriers.some(record => evidence.inspectedRevision === record.scopeHash && evidence.mutationEpoch === record.mutationEpoch)) {
        throw new Error(`Completion requires fresh structured ${criterion.evidence} evidence for ${criterion.id}.`);
      }
    }
  }
  data.generatorDefects = (file.generated ?? []).flatMap(item => (item.exit !== 0 ? [`Generator \`${item.command}\` exited ${item.exit}; log: ${item.logPath}`]
    : item.outside.length ? [`Generator \`${item.command}\` changed undeclared paths: ${item.outside.join(', ')}`] : []));
  data.mutationEpoch = file.mutationEpoch + (drift.length ? 1 : 0);
  data[`${pending.purpose}Results`] = records;
  delete data.verification;
  if (pending.purpose === 'baseline') storeBaseline(state, records);
  return null;
}
// SECTION: baseline reuse
// A baseline is a function of the tree, commands, and runtime: an identical repository state
// (HEAD, index, dirty-path contents) within a day reuses it instead of rerunning the suite.
const BASELINE_TTL_MS = 24 * 60 * 60 * 1000;
function baselineCachePath(state) {
  return state.ledgerPath.replace(/-ledger\.md$/, '-baseline.json');
}
function baselineKey(state) {
  const data = state.ordinary, commands = purposeCommands(data, 'baseline');
  const key = { repository: repositoryBaseline(state), commands, scopes: commands.map(command => data.scopes[command]), node: process.version, platform: process.platform };
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(key)).digest('hex')}`;
}
/**
 * Cached baseline results for the current tree, or null.
 *
 * @param {any} state
 * @param {{ now?: any }} [options]
 */
export function cachedBaseline(state, { now = Date.now() } = {}) {
  try {
    const cache = JSON.parse(fs.readFileSync(baselineCachePath(state), 'utf8'));
    if (cache.v !== 1 || cache.key !== baselineKey(state) || !(now - Date.parse(cache.capturedAt) <= BASELINE_TTL_MS)) return null;
    return cache;
  } catch { return null; }
}
export function storeBaseline(state, results) {
  try {
    ensureLedgerNamespace({ repoHash: repositoryRootHash(state.repoRoot) });
    const file = baselineCachePath(state), temp = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify({ v: 1, key: baselineKey(state), capturedAt: new Date().toISOString(), results })}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch {
    // NOTE: the cache only saves time; a failed write reruns the baseline next segment.
  }
}
export function freshResults(state, purpose) {
  const data = state.ordinary, results = data[`${purpose}Results`], commands = purposeCommands(data, purpose);
  return results?.length === commands.length && commands.every(command => {
    const result = results.find(item => item.command === command);
    return result && result.changed.length === 0 && result.mutationEpoch === (data.mutationEpoch ?? 0) &&
      result.scopeHash === fingerprint(state, data.scopes[command]);
  });
}
export function completionResult(state) {
  if (!freshResults(state, 'completion')) return 'regression';
  const data = state.ordinary;
  if (data.generatorDefects?.length) return 'regression';
  for (const criterion of data.criteria.filter(item => item.evidence !== 'red')) {
    const evidence = data.completionResults.flatMap(item => item.criterionEvidence ?? []).find(item => item.criterionId === criterion.id);
    if (!evidence || evidence.evidenceClass !== criterion.evidence || evidence.mutationEpoch !== (data.mutationEpoch ?? 0)) return 'regression';
  }
  let knownRed = false;
  for (const result of state.ordinary.completionResults) {
    if (result.exitStatus === 0) continue;
    const baseline = state.ordinary.baselineResults.find(item => item.command === result.command);
    if (!baseline || !state.ordinary.baselineAccepted || !compareFailureIdentity(baseline.identity, result.identity)) return 'regression';
    knownRed = true;
  }
  return knownRed ? 'accepted-baseline-equivalent' : 'pass';
}
// Module-resolution and parse errors abort a test file before any leaf test runs.
const LOAD_FAILURE = /ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)|does not provide an export named|SyntaxError|ERR_REQUIRE_ESM|\bfailed to load\b/i;
/** Host RED results where a test file failed to load: a load crash, not behavioral RED. */
export function redLoadFailures(state) {
  const data = state.ordinary, redCommands = new Set(data.redCriteria.flatMap(item => item.commands));
  return data.redResults.filter(red => red.exitStatus !== 0 && redCommands.has(red.command) && (
    red.identifiers.some(id => /^error:\s*load\b/i.test(id)) ||
    (LOAD_FAILURE.test(String(red.diagnostic ?? '')) && red.identifiers.every(id => !id.startsWith('test:') || data.testsOnlyPaths.some(file => id.slice(5).trim().startsWith(file))))));
}
export function loadFailureDefect(reds) {
  return `RED test file failed to load under ${reds.map(red => red.command).join(', ')}; a load crash is not behavioral RED. Make each test file load (import the missing production symbol dynamically inside each test, or guard it) so every leaf test runs and fails on its own assertion.`;
}
export function validateRedAdmission(state, envelope) {
  const data = state.ordinary, defects = [];
  if (!envelope || !['DONE', 'DONE_WITH_CONCERNS'].includes(envelope.status) || envelope.stage !== 'RED_READY' || !Array.isArray(envelope.evidence)) return ['Valid tests-only RED_READY envelope required.'];
  const rows = envelope.evidence.filter(item => typeof item === 'string' && item.startsWith('RED-MATRIX '));
  const expected = new Set(data.redCriteria.map(item => item.id)), parsedRows = [];
  for (const row of rows) {
    const match = /^RED-MATRIX\s+(SC\d+)\s*\|\s*([^|]+?)\s*\|\s*(.+)$/.exec(row);
    if (!match) { defects.push(`Malformed RED-MATRIX row: ${row}`); continue; }
    const [, id, test, failure] = match;
    parsedRows.push({ id, test: test.trim(), failure });
    if (!expected.has(id)) defects.push(`Unexpected RED-MATRIX criterion ${id}.`);
    if (test.trim() === 'N/A') {
      if (!failure.trim()) defects.push(`${id} N/A requires a non-empty class reason.`);
    } else {
      if (!data.testsOnlyPaths.some(file => test.trim() === file || test.trim().startsWith(`${file}:`) || test.trim().startsWith(`${file} `))) defects.push(`${id} matrix test is outside classified test paths.`);
      if (!/\bexit\s+[1-9]\d*\b/i.test(failure) || parseIdentifiers(failure).length === 0) defects.push(`${id} expected failure lacks stable exit and identifier shape.`);
      // ";" separates identifiers, so a segment without a prefix is a test name that contained one.
      if (failure.split(';').slice(1).some(part => part.trim() && parseIdentifiers(part).length === 0)) defects.push(`${id} test name contains ";"; rename the test so each identifier is test:<full name> without semicolons.`);
    }
  }
  for (const criterion of data.redCriteria) if (parsedRows.filter(row => row.id === criterion.id).length !== 1) defects.push(`Exactly one primary RED-MATRIX row required for ${criterion.id}.`);
  return [...new Set(defects)];
}
export function validateRed(state, envelope) {
  const data = state.ordinary, defects = [...validateRedAdmission(state, envelope)];
  if (!freshResults(state, 'red')) defects.push('RED host evidence is stale or changed the repository.');
  const changed = diffRepositoryState(data.taskStart, snapshot(state)).changed;
  // A declared pre-existing RED (plan "Pre-existing: yes") may already be in place; no test change is required.
  const allPreExisting = data.redCriteria.length > 0 && data.redCriteria.every(item => item.preExisting);
  if ((!changed.length && !allPreExisting) || changed.some(file => !data.testsOnlyPaths.includes(file))) defects.push('Tests-only mutation must change only classified approved test paths.');
  const rows = envelope.evidence.filter(item => item.startsWith('RED-MATRIX '));
  const parsedRows = rows.map(row => /^RED-MATRIX\s+(SC\d+)\s*\|\s*([^|]+?)\s*\|\s*(.+)$/.exec(row)).filter(Boolean).map(([, id, test, failure]) => ({ id, test: test.trim(), failure }));
  for (const criterion of data.redCriteria) {
    if (parsedRows.some(row => row.id === criterion.id && row.test === 'N/A')) defects.push(`${criterion.id} exception requires an explicit evidence-backed ruling.`);
  }
  const redCommands = new Set(data.redCriteria.flatMap(item => item.commands));
  const reds = data.redResults.filter(item => item.exitStatus !== 0 && redCommands.has(item.command));
  if (!reds.length) defects.push('No host-observed RED.');
  for (const red of reds) {
    const baseline = data.baselineResults.find(item => item.command === red.command);
    if (!baseline) defects.push(`RED command has no baseline result: ${red.command}`);
    // A narrowed RED run sees a subset of the suite's failures, so it collides when the baseline already fails every one of them.
    else if (baseline.exitStatus !== 0 && (red.ran ? red.identity.identifiers.length > 0 && red.identity.identifiers.every(id => baseline.identity.identifiers.includes(id)) : compareFailureIdentity(baseline.identity, red.identity)) &&!data.redCriteria.filter(item => item.commands.includes(red.command)).every(item => item.preExisting)) defects.push('Known-red baseline collision is not attributable RED; declare "Pre-existing: yes" on the criterion to adopt it.');
    defects.push(...checkRedQuality(source(state), envelope, red));
  }
  for (const criterion of data.redCriteria) {
    const row = parsedRows.find(item => item.id === criterion.id);
    if (!row || row.test === 'N/A') continue;
    const test = row.test, expected = row.failure;
    if (!data.testsOnlyPaths.some(file => test === file || test.startsWith(`${file}:`) || test.startsWith(`${file} `))) defects.push(`${criterion.id} matrix test is outside classified test paths.`);
    // A command shared by several red criteria is matched against the union of their rows' identifiers.
    const peers = data.redCriteria.filter(other => other.commands.some(command => criterion.commands.includes(command)));
    const peerRows = parsedRows.filter(item => peers.some(peer => peer.id === item.id) && item.test !== 'N/A' && /\bexit\s+\d+\b/i.test(item.failure));
    const identifiers = [...new Set(peerRows.flatMap(item => parseIdentifiers(item.failure)))];
    const exit = /\bexit\s+(\d+)\b/i.exec(expected);
    const expectedIdentity = failureIdentity({ exitStatus: exit ? Number(exit[1]) : 1, identifiers,
      diagnostic: stripIdentifierSpans(expected.replace(/\bexit\s*\d+\b/i, '')).trim() });
    if (!reds.some(red => criterion.commands.includes(red.command) && compareFailureIdentity(red.identity, expectedIdentity))) defects.push(`${criterion.id} has no matching stable failure in its mapped host command.`);
  }
  return [...new Set(defects)];
}
