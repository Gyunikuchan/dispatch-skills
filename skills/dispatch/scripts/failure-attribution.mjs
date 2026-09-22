function sameState(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export function attributablePaths({ baseline = {}, taskStart = {}, failureSnapshot = {}, currentState, authorized = false }) {
  if (!authorized) return [];
  // Attribution is valid only while the live tree still matches the captured failure.
  if (currentState && !sameState(currentState, failureSnapshot)) return [];
  // Legacy callers mark an invalidated capture explicitly; newer callers pass currentState.
  if (!currentState && Object.values(failureSnapshot).some(entry => entry?.objectId === 'drifted')) return [];
  const paths = new Set([...Object.keys(taskStart), ...Object.keys(failureSnapshot)]);
  return [...paths].filter((file) => {
    if (Object.prototype.hasOwnProperty.call(baseline, file)) return false;
    const before = taskStart[file];
    const after = failureSnapshot[file];
    return before && after && !sameState(before, after);
  }).sort();
}
