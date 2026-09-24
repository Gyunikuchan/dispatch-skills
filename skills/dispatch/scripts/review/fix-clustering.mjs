import crypto from 'node:crypto';

/**
 * Computes deterministic cluster ID: `C-` + first 12 hex characters of SHA-256 over
 * `<runId>|<parentTaskId or ''>|<sorted member finding IDs joined by ','>`
 */
export function computeClusterId({ runId, parentTaskId = '', findingIds = [] }) {
  if (!runId || typeof runId !== 'string' || runId.trim().length === 0) {
    throw new Error('runId must be a non-empty string');
  }
  const sortedIds = [...findingIds].sort();
  const payload = `${runId}|${parentTaskId || ''}|${sortedIds.join(',')}`;
  const hash = crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
  return `C-${hash.slice(0, 12)}`;
}

/**
 * Normalizes finding input into standard structure.
 */
function normalizeFinding(f) {
  const id = f.findingId || f.id;
  if (!id || typeof id !== 'string') {
    throw new Error('Finding must have a valid findingId or id');
  }
  const affectedPaths = Array.isArray(f.affectedPaths) ? [...f.affectedPaths] : (f.paths ? [...f.paths] : []);
  const dependsOn = Array.isArray(f.dependsOn) ? [...f.dependsOn] : [];
  const verification = Array.isArray(f.verification) ? [...f.verification] : [];
  return {
    ...f,
    findingId: id,
    affectedPaths: [...new Set(affectedPaths)].sort(),
    dependsOn: [...new Set(dependsOn)].sort(),
    verification: [...new Set(verification.filter(Boolean))],
  };
}

/**
 * Computes transitive dependency closure for findingId across findingMap.
 */
function getTransitiveClosure(findingId, findingMap, visited = new Set()) {
  if (visited.has(findingId)) return visited;
  visited.add(findingId);
  const finding = findingMap.get(findingId);
  if (finding?.dependsOn) {
    for (const depId of finding.dependsOn) {
      getTransitiveClosure(depId, findingMap, visited);
    }
  }
  return visited;
}

/**
 * Checks whether finding conflicts with cluster members (path overlap or transitive dependency).
 */
function hasClusterConflict(clusterFindings, finding, findingMap) {
  const findingPaths = new Set(finding.affectedPaths);
  const findingClosure = getTransitiveClosure(finding.findingId, findingMap, new Set());

  for (const member of clusterFindings) {
    // Path overlap / same-file conflict
    for (const p of member.affectedPaths) {
      if (findingPaths.has(p)) {
        return true;
      }
    }

    // Transitive dependency conflict (either depends on the other)
    const memberClosure = getTransitiveClosure(member.findingId, findingMap, new Set());
    if (findingClosure.has(member.findingId) || memberClosure.has(finding.findingId)) {
      return true;
    }
  }

  return false;
}

/**
 * Groups findings into independent clusters:
 * - Pairwise disjoint affected paths (no file overlap, keep same-file findings separate).
 * - No declared ordering/interface/verification dependencies (transitive closure aware).
 * - Deterministic cluster IDs and union verification commands.
 */
export function createIndependenceClusters(findings, { runId, maxAttempts = 3 } = {}) {
  if (!runId || typeof runId !== 'string' || runId.trim().length === 0) {
    throw new Error('runId must be a non-empty string');
  }
  if (!Array.isArray(findings)) {
    throw new Error('findings must be an array');
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts must be a positive integer');
  }

  const normalized = findings.map(normalizeFinding).sort((a, b) => a.findingId.localeCompare(b.findingId));
  const findingMap = new Map(normalized.map((f) => [f.findingId, f]));
  const clusterGroups = [];

  for (const finding of normalized) {
    let placed = false;
    for (const group of clusterGroups) {
      if (!hasClusterConflict(group, finding, findingMap)) {
        group.push(finding);
        placed = true;
        break;
      }
    }
    if (!placed) {
      clusterGroups.push([finding]);
    }
  }

  // Greedy grouping can make two clusters depend on each other; singletons are then the safe order.
  return orderClusters(clusterGroups, findingMap, runId, maxAttempts) ??
    orderClusters(normalized.map((finding) => [finding]), findingMap, runId, maxAttempts) ??
    (() => { throw new Error('finding dependencies contain a cycle'); })();
}

/**
 * Builds clusters with `dependsOnClusters` and returns them in dependency order, or null on a cycle.
 */
function orderClusters(groups, findingMap, runId, maxAttempts) {
  const clusters = groups.map((group) => {
    const memberIds = group.map((f) => f.findingId).sort();
    return {
      clusterId: computeClusterId({ runId, parentTaskId: '', findingIds: memberIds }),
      findingIds: memberIds,
      affectedPaths: [...new Set(group.flatMap((f) => f.affectedPaths))].sort(),
      verification: [...new Set(group.flatMap((f) => f.verification))],
      attemptBudget: maxAttempts,
      parentTaskId: null,
      dependsOnClusters: [],
      findings: group,
    };
  });
  const owner = new Map(clusters.flatMap((cluster) => cluster.findingIds.map((id) => [id, cluster])));
  for (const cluster of clusters) {
    const deps = new Set();
    for (const finding of cluster.findings) {
      for (const depId of getTransitiveClosure(finding.findingId, findingMap, new Set())) {
        const dep = owner.get(depId);
        if (dep && dep !== cluster) deps.add(dep.clusterId);
      }
    }
    cluster.dependsOnClusters = [...deps].sort();
  }
  const ordered = [];
  const done = new Set();
  while (ordered.length < clusters.length) {
    const next = clusters.find((cluster) => !done.has(cluster.clusterId) &&
      cluster.dependsOnClusters.every((id) => done.has(id)));
    if (!next) return null;
    done.add(next.clusterId);
    ordered.push(next);
  }
  return ordered;
}

/**
 * Splits a failed cluster into smaller independently provable descendant clusters:
 * - Preserves completed findings without another dispatch.
 * - Isolates failedFindingId into its own cluster.
 * - Descendants inherit parent attempt lineage and share the remaining budget.
 * - Descendant attempt numbers continue the parent's; none exceeds maxAttempts.
 * - Sets parentTaskId to the failed cluster's ID.
 */
export function splitFailedCluster(cluster, {
  completedFindingIds = [],
  failedFindingId = null,
  attemptsConsumed = 1,
  runId,
  maxAttempts = 3,
} = {}) {
  if (!runId || typeof runId !== 'string' || runId.trim().length === 0) {
    throw new Error('runId must be a non-empty string');
  }
  if (!cluster || typeof cluster !== 'object') {
    throw new Error('cluster is required');
  }
  if (!Number.isSafeInteger(attemptsConsumed) || attemptsConsumed < 0) {
    throw new Error('attemptsConsumed must be a non-negative integer');
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new Error('maxAttempts must be a positive integer');
  }
  const completedSet = new Set(completedFindingIds);
  const rawFindings = cluster.findings || cluster.findingIds.map((id) => ({
    findingId: id,
    affectedPaths: cluster.affectedPaths || [],
    dependsOn: [],
    verification: cluster.verification || [],
  }));
  const remainingFindings = rawFindings.filter((f) => !completedSet.has(f.findingId || f.id || f));

  const budget = typeof cluster.attemptBudget === 'number' ? cluster.attemptBudget : maxAttempts;
  const remainingBudget = Math.max(0, Math.min(budget - attemptsConsumed, maxAttempts));

  if (remainingFindings.length === 0 || remainingBudget <= 0) {
    return {
      completedFindings: [...completedSet],
      remainingClusters: [],
      remainingBudget,
      canProceed: false,
    };
  }

  let subGroups = [];

  if (failedFindingId && remainingFindings.some((f) => (f.findingId || f.id) === failedFindingId)) {
    const failedItem = remainingFindings.find((f) => (f.findingId || f.id) === failedFindingId);
    const others = remainingFindings.filter((f) => (f.findingId || f.id) !== failedFindingId);
    subGroups.push([failedItem]);
    if (others.length > 0) {
      const otherClusters = createIndependenceClusters(others, { runId, maxAttempts: remainingBudget });
      for (const oc of otherClusters) {
        subGroups.push(oc.findings);
      }
    }
  } else {
    // Attempt standard regrouping
    const candidateClusters = createIndependenceClusters(remainingFindings, { runId, maxAttempts: remainingBudget });
    if (
      remainingFindings.length > 1 &&
      candidateClusters.length === 1 &&
      candidateClusters[0].findingIds.length === remainingFindings.length
    ) {
      // Must strictly reduce cluster size: fall back to singletons
      subGroups = remainingFindings.map((f) => [f]);
    } else {
      subGroups = candidateClusters.map((c) => c.findings);
    }
  }

  const descendantClusters = subGroups.map((group) => {
    const memberIds = group.map((f) => f.findingId || f.id).sort();
    const unionPaths = [...new Set(group.flatMap((f) => f.affectedPaths || []))].sort();
    const unionVerification = [...new Set(group.flatMap((f) => f.verification || []))];
    const clusterId = computeClusterId({
      runId,
      parentTaskId: cluster.clusterId,
      findingIds: memberIds,
    });
    return {
      clusterId,
      findingIds: memberIds,
      affectedPaths: unionPaths,
      verification: unionVerification,
      attemptBudget: remainingBudget,
      parentTaskId: cluster.clusterId,
      findings: group,
    };
  });

  return {
    completedFindings: [...completedSet],
    remainingClusters: descendantClusters,
    remainingBudget,
    canProceed: descendantClusters.length > 0 && remainingBudget > 0,
  };
}

/**
 * Formats user-facing opt-in sections for recommended follow-ups and out-of-scope / adjacent items.
 */
export function formatOptInSections({ recommendations = [], outOfScope = [] }) {
  const seenFindingIds = new Set();
  const dedupedRecommendations = [];
  for (const rec of recommendations) {
    const findingId = rec.findingId || rec.id;
    if (!findingId || seenFindingIds.has(findingId)) continue;
    seenFindingIds.add(findingId);
    dedupedRecommendations.push(rec);
  }

  const dedupedOutOfScope = [];
  for (const item of outOfScope) {
    const findingId = item.findingId || item.id;
    if (!findingId || seenFindingIds.has(findingId)) continue;
    seenFindingIds.add(findingId);
    dedupedOutOfScope.push(item);
  }

  if (dedupedRecommendations.length === 0 && dedupedOutOfScope.length === 0) {
    return {
      text: 'none',
      aliases: {},
      items: [],
    };
  }

  const aliases = {};
  const items = [];
  const lines = [];

  if (dedupedRecommendations.length > 0) {
    lines.push('### Recommended Follow-ups (Default: Included)');
    dedupedRecommendations.forEach((rec, idx) => {
      const alias = `R${idx + 1}`;
      const findingId = rec.findingId || rec.id;
      aliases[alias] = findingId;
      const checked = rec.defaultIncluded === false ? '[ ]' : '[x]';
      const desc = rec.summary || rec.defect || rec.text || findingId;
      const reason = rec.reason ? ` — ${rec.reason}` : '';
      lines.push(`- [${alias}] ${checked} ${desc}${reason}`);
      items.push({
        alias,
        findingId,
        type: 'recommendation',
        defaultIncluded: rec.defaultIncluded !== false,
        summary: desc,
        reason: rec.reason || null,
      });
    });
    lines.push('');
  }

  if (dedupedOutOfScope.length > 0) {
    lines.push('### Out-of-Scope / Adjacent Items (Default: Excluded)');
    dedupedOutOfScope.forEach((item, idx) => {
      const alias = `O${idx + 1}`;
      const findingId = item.findingId || item.id;
      aliases[alias] = findingId;
      const checked = item.defaultIncluded === true ? '[x]' : '[ ]';
      const desc = item.summary || item.defect || item.text || findingId;
      const reason = item.reason ? ` — ${item.reason}` : '';
      lines.push(`- [${alias}] ${checked} ${desc}${reason}`);
      items.push({
        alias,
        findingId,
        type: 'out-of-scope',
        defaultIncluded: item.defaultIncluded === true,
        summary: desc,
        reason: item.reason || null,
      });
    });
    lines.push('');
  }

  return {
    text: lines.join('\n').trim(),
    aliases,
    items,
  };
}

/**
 * Parses user responses to opt-in toggles (e.g. "exclude R2, include O1", "default", "all", "none").
 */
export function parseOptInResponse(response, { aliases = {}, items = [] }) {
  const raw = String(response ?? '').trim();
  const aliasMap = new Map();
  for (const item of items) {
    aliasMap.set(item.alias.toUpperCase(), item);
  }
  for (const [alias, findingId] of Object.entries(aliases)) {
    const upper = alias.toUpperCase();
    if (!aliasMap.has(upper)) {
      aliasMap.set(upper, { alias: upper, findingId, defaultIncluded: upper.startsWith('R') });
    }
  }

  if (raw.length === 0) {
    return {
      responseKind: 'empty',
      includedFindingIds: [],
      excludedFindingIds: [],
      includedAliases: [],
      excludedAliases: [],
      scopeChanges: [],
      unrecognizedTokens: [],
    };
  }

  const lower = raw.toLowerCase();
  const includedAliases = new Set();
  const excludedAliases = new Set();

  // Initialize with defaults
  for (const [alias, item] of aliasMap.entries()) {
    if (item.defaultIncluded) {
      includedAliases.add(alias);
    } else {
      excludedAliases.add(alias);
    }
  }

  if (lower === 'default' || lower === 'defaults' || lower === 'proceed' || lower === 'yes') {
    return {
      responseKind: 'explicit-default',
      includedFindingIds: [...includedAliases].map((a) => aliasMap.get(a)?.findingId).filter(Boolean).sort(),
      excludedFindingIds: [...excludedAliases].map((a) => aliasMap.get(a)?.findingId).filter(Boolean).sort(),
      includedAliases: [...includedAliases].sort(),
      excludedAliases: [...excludedAliases].sort(),
      scopeChanges: [],
      unrecognizedTokens: [],
    };
  }

  if (lower === 'all' || lower === 'include all') {
    for (const alias of aliasMap.keys()) {
      includedAliases.add(alias);
      excludedAliases.delete(alias);
    }
    return {
      responseKind: 'all',
      includedFindingIds: [...includedAliases].map((a) => aliasMap.get(a)?.findingId).filter(Boolean).sort(),
      excludedFindingIds: [],
      includedAliases: [...includedAliases].sort(),
      excludedAliases: [],
      scopeChanges: [...includedAliases].filter((a) => a.startsWith('O')).map((a) => aliasMap.get(a)?.findingId).filter(Boolean).sort(),
      unrecognizedTokens: [],
    };
  }

  if (lower === 'none' || lower === 'exclude all') {
    for (const alias of aliasMap.keys()) {
      excludedAliases.add(alias);
      includedAliases.delete(alias);
    }
    return {
      responseKind: 'none',
      includedFindingIds: [],
      excludedFindingIds: [...excludedAliases].map((a) => aliasMap.get(a)?.findingId).filter(Boolean).sort(),
      includedAliases: [],
      excludedAliases: [...excludedAliases].sort(),
      scopeChanges: [],
      unrecognizedTokens: [],
    };
  }

  const unrecognizedTokens = [];
  const words = raw.split(/[\s,;]+/);
  let currentAction = null; // 'include' | 'exclude' | null

  for (const word of words) {
    const w = word.trim();
    if (!w) continue;
    const wLower = w.toLowerCase();

    if (wLower === 'include' || wLower === 'add') {
      currentAction = 'include';
    } else if (wLower === 'exclude' || wLower === 'remove' || wLower === 'skip') {
      currentAction = 'exclude';
    } else if (w.startsWith('+')) {
      const candidate = w.slice(1).toUpperCase();
      if (aliasMap.has(candidate)) {
        includedAliases.add(candidate);
        excludedAliases.delete(candidate);
      } else {
        unrecognizedTokens.push(w);
      }
    } else if (w.startsWith('-')) {
      const candidate = w.slice(1).toUpperCase();
      if (aliasMap.has(candidate)) {
        excludedAliases.add(candidate);
        includedAliases.delete(candidate);
      } else {
        unrecognizedTokens.push(w);
      }
    } else {
      const upper = w.toUpperCase();
      if (aliasMap.has(upper)) {
        if (currentAction === 'exclude') {
          excludedAliases.add(upper);
          includedAliases.delete(upper);
        } else {
          includedAliases.add(upper);
          excludedAliases.delete(upper);
        }
      } else if (wLower !== 'and' && wLower !== 'the' && wLower !== 'with') {
        unrecognizedTokens.push(w);
      }
    }
  }

  if (unrecognizedTokens.length > 0) {
    return {
      responseKind: 'ambiguous',
      includedFindingIds: [],
      excludedFindingIds: [],
      includedAliases: [],
      excludedAliases: [],
      scopeChanges: [],
      unrecognizedTokens,
    };
  }

  const includedFindingIds = [...includedAliases].map((alias) => aliasMap.get(alias)?.findingId).filter(Boolean);
  const excludedFindingIds = [...excludedAliases].map((alias) => aliasMap.get(alias)?.findingId).filter(Boolean);
  const scopeChanges = [...includedAliases]
    .filter((alias) => alias.startsWith('O'))
    .map((alias) => aliasMap.get(alias)?.findingId)
    .filter(Boolean);

  return {
    responseKind: 'directives',
    includedFindingIds: [...new Set(includedFindingIds)].sort(),
    excludedFindingIds: [...new Set(excludedFindingIds)].sort(),
    includedAliases: [...includedAliases].sort(),
    excludedAliases: [...excludedAliases].sort(),
    scopeChanges: [...new Set(scopeChanges)].sort(),
    unrecognizedTokens: [],
  };
}
