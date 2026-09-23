import { captureRepositoryState, compareFailureIdentity, criterionMappings, diffRepositoryState, extractApprovedPathSet, failureIdentity, mapVerificationCommandsToPaths, outcomeFirstPacket } from '../verification-evidence.mjs';
import { baselineFingerprint, materializedFingerprint } from '../git-state.mjs';
import { checkRedQuality, parseIdentifiers, stripIdentifierSpans } from '../red-quality.mjs';
import { emitAction } from './actions.mjs';
import { source } from './ordinary-state.mjs';

export function verificationPlan(state) {
  const text = source(state);
  const approvedPaths = extractApprovedPathSet(text);
  const criteria = criterionMappings(text);
  const commands = [...new Set(criteria.flatMap(item => item.commands))];
  if (!approvedPaths.length || !commands.length || criteria.some(item => !item.paths.length || !item.commands.length || !['red', 'verify', 'review'].includes(item.evidence))) throw new Error('Baseline requires approved paths, commands, and explicit evidence classes for every criterion.');
  return {
    approvedPaths, commands, scopes: mapVerificationCommandsToPaths(text, commands, approvedPaths), criteria,
    packet: outcomeFirstPacket(text, criteria),
    redCriteria: criteria.filter(item => item.evidence === 'red'),
    verifyCriteria: criteria.filter(item => item.evidence === 'verify'),
    reviewCriteria: criteria.filter(item => item.evidence === 'review'),
  };
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
export function beginVerification(state, purpose) {
  state.ordinary.verification = { purpose, index: 0, results: [] };
  return verificationAction(state);
}
export function verificationAction(state) {
  const data = state.ordinary, pending = data.verification;
  const command = data.commands[pending.index];
  pending.before = snapshot(state);
  pending.scopeHash = fingerprint(state, data.scopes[command]);
  pending.epoch = data.mutationEpoch ?? 0;
  return emitAction(state, 'verify', {
    purpose: pending.purpose, commands: [command], scopes: { [command]: data.scopes[command] },
    mutationEpoch: pending.epoch, scopeHash: pending.scopeHash, criteria: data.criteria.filter(item => item.commands.includes(command)).map(item => ({ id: item.id, evidenceClass: item.evidence, review: item.review ?? null })),
  }, ['Run this exact command on the host now. Return its exit status, stable failure identifiers, diagnostic, and the emitted scopeHash/mutationEpoch. The driver captures Git state before and after each command; do not reuse delegate results.',
    ...(pending.purpose === 'red' ? ['Report one identifier per failing leaf test using the convention `test:<full failing test name>`; when a test file fails to load, report `error:load <test file>` instead.'] : [])]);
}
export function acceptVerification(state, reply) {
  const data = state.ordinary, pending = data.verification;
  const command = data.commands[pending.index];
  if (reply.results.length !== 1 || reply.results[0].command !== command) throw new Error('Verification reply must contain exactly the pending mapped command.');
  const result = reply.results[0];
  if (result.scopeHash !== pending.scopeHash || result.mutationEpoch !== pending.epoch) throw new Error('Verification reply has stale or missing scope/mutation identity.');
  const after = snapshot(state);
  const changed = diffRepositoryState(pending.before, after).changed;
  const mapped = data.criteria.filter(item => item.commands.includes(command));
  const criterionEvidence = result.criterionEvidence ?? [];
  if (pending.purpose === 'completion') {
    for (const criterion of mapped.filter(item => item.evidence !== 'red')) {
      const evidence = criterionEvidence.find(item => item.criterionId === criterion.id);
      if (!evidence || evidence.evidenceClass !== criterion.evidence || !evidence.reviewer?.trim() || !evidence.scenario?.trim() || !evidence.observableResult?.trim() || !evidence.limitations?.trim() || evidence.inspectedRevision !== pending.scopeHash || evidence.mutationEpoch !== pending.epoch) {
        throw new Error(`Completion requires fresh structured ${criterion.evidence} evidence for ${criterion.id}.`);
      }
    }
  }
  // Counts only, for the review-view table; the raw test output is not persisted.
  const counts = /\bpass\s+(\d+)[\s\S]*?\bfail\s+(\d+)/i.exec(`${result.evidence ?? ''}\n${result.diagnostic ?? ''}`);
  const record = { command, exitStatus: result.exit, ...(counts ? { pass: Number(counts[1]), fail: Number(counts[2]) } : {}), identifiers: result.identifiers ?? [], diagnostic: result.diagnostic ?? result.evidence,
    identity: failureIdentity({ exitStatus: result.exit, identifiers: result.identifiers, diagnostic: result.diagnostic ?? result.evidence }), criterionEvidence,
    scopeHash: pending.scopeHash, mutationEpoch: pending.epoch, before: pending.before, after, changed };
  pending.results.push(record);
  pending.index++;
  if (changed.length) data.mutationEpoch = (data.mutationEpoch ?? 0) + 1;
  if (pending.index < data.commands.length) return verificationAction(state);
  data[`${pending.purpose}Results`] = pending.results;
  delete data.verification;
  return null;
}
export function freshResults(state, purpose) {
  const data = state.ordinary, results = data[`${purpose}Results`];
  return results?.length === data.commands.length && data.commands.every(command => {
    const result = results.find(item => item.command === command);
    return result && result.changed.length === 0 && result.mutationEpoch === (data.mutationEpoch ?? 0) &&
      result.scopeHash === fingerprint(state, data.scopes[command]);
  });
}
export function completionResult(state) {
  if (!freshResults(state, 'completion')) return 'regression';
  const data = state.ordinary;
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
    else if (baseline.exitStatus !== 0 && compareFailureIdentity(baseline.identity, red.identity) && !data.redCriteria.filter(item => item.commands.includes(red.command)).every(item => item.preExisting)) defects.push('Known-red baseline collision is not attributable RED; declare "Pre-existing: yes" on the criterion to adopt it.');
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
