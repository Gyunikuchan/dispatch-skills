function sameState(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export function failureAttribution({ baseline = {}, taskStart = {}, failureSnapshot = {}, currentState = failureSnapshot, authorized = false }) {
  if (!authorized) return { allowed: false, paths: [], nonSeparable: [], reason: 'reversion-not-authorized' };
  if (!sameState(currentState, failureSnapshot)) return { allowed: false, paths: [], nonSeparable: [], reason: 'post-failure-drift' };
  const paths = [...new Set([...Object.keys(taskStart), ...Object.keys(failureSnapshot)])].sort();
  const changed = paths.filter(file => !sameState(taskStart[file], failureSnapshot[file]));
  const nonSeparable = changed.filter(file => Object.prototype.hasOwnProperty.call(baseline, file));
  if (nonSeparable.length) return { allowed: false, paths: [], nonSeparable, reason: 'caller-dirty-path' };
  return { allowed: true, paths: changed, nonSeparable: [], reason: null };
}

