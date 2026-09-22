import { captureRepositoryState, compareFailureIdentity, criterionMappings, diffRepositoryState, extractApprovedPathSet, failureIdentity, mapVerificationCommandsToPaths, outcomeFirstPacket } from '../verification-evidence.mjs';
import { baselineFingerprint, materializedFingerprint } from '../git-state.mjs';
import { checkRedQuality } from '../red-quality.mjs';
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
  }, ['Run this exact command on the host now. Return its exit status, stable failure identifiers, diagnostic, and the emitted scopeHash/mutationEpoch. The driver captures Git state before and after each command; do not reuse delegate results.']);
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
  const record = { command, exitStatus: result.exit, identifiers: result.identifiers ?? [], diagnostic: result.diagnostic ?? result.evidence,
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
export function validateRed(state, envelope) {
  const data = state.ordinary, defects = [];
  if (!freshResults(state, 'red')) defects.push('RED host evidence is stale or changed the repository.');
  const changed = diffRepositoryState(data.taskStart, snapshot(state)).changed;
  if (!changed.length || changed.some(file => !data.testsOnlyPaths.includes(file))) defects.push('Tests-only mutation must change only classified approved test paths.');
  const rows = envelope.evidence.filter(item => item.startsWith('RED-MATRIX '));
  for (const criterion of data.redCriteria) {
    const matches = rows.filter(row => row.startsWith(`RED-MATRIX ${criterion.id} |`));
    if (matches.length !== 1) defects.push(`Exactly one primary RED-MATRIX row required for ${criterion.id}.`);
    if (matches.some(row => /\|\s*N\/A\s*\|/.test(row))) defects.push(`${criterion.id} exception requires an explicit evidence-backed ruling.`);
  }
  const reds = data.redResults.filter(item => item.exitStatus !== 0);
  if (!reds.length) defects.push('No host-observed RED.');
  for (const red of reds) {
    const baseline = data.baselineResults.find(item => item.command === red.command);
    if (!baseline) defects.push(`RED command has no baseline result: ${red.command}`);
    else if (baseline.exitStatus !== 0 && compareFailureIdentity(baseline.identity, red.identity)) defects.push('Known-red baseline collision is not attributable RED.');
    defects.push(...checkRedQuality(source(state), envelope, red));
  }
  for (const criterion of data.redCriteria) {
    const row = rows.find(item => item.startsWith(`RED-MATRIX ${criterion.id} |`));
    const match = row && /^RED-MATRIX\s+(SC\d+)\s*\|\s*([^|]+?)\s*\|\s*(.+)$/.exec(row);
    if (!match) continue;
    const test = match[2].trim(), expected = match[3];
    if (!data.testsOnlyPaths.some(file => test === file || test.startsWith(`${file}:`) || test.startsWith(`${file} `))) defects.push(`${criterion.id} matrix test is outside classified test paths.`);
    const identifiers = expected.match(/\b(?:test|error|failure):[^\s]+/gi) ?? [];
    const exit = /\bexit\s+(\d+)\b/i.exec(expected);
    const expectedIdentity = failureIdentity({ exitStatus: exit ? Number(exit[1]) : 1, identifiers,
      diagnostic: expected.replace(/\bexit\s*\d+\b/i, '').replace(/\b(?:test|error|failure):[^\s]+/gi, '').trim() });
    if (!reds.some(red => criterion.commands.includes(red.command) && compareFailureIdentity(red.identity, expectedIdentity))) defects.push(`${criterion.id} has no matching stable failure in its mapped host command.`);
  }
  return [...new Set(defects)];
}
