// Fix clusters with bounded attempts. Accepted fixes group into
// clusters with disjoint paths and no dependency between members; a failed cluster splits into descendants
// sharing the remaining attempt budget. Cluster ids are a pure FNV-1a digest (no crypto import in domain/).

import type { FindingId } from '../core/types.ts';

export const DEFAULT_MAX_ATTEMPTS = 3;

export type FixInput = { id: FindingId; paths: readonly string[]; dependencies?: readonly FindingId[]; verification?: readonly string[] };
export type FixMember = { id: FindingId; paths: readonly string[]; dependencies: readonly FindingId[]; verification: readonly string[] };
export type FixCluster = {
  clusterId: string;
  findingIds: readonly FindingId[];
  paths: readonly string[];
  verification: readonly string[];
  attemptBudget: number;
  parentId: string | null;
  dependsOnClusters: readonly string[];
  members: readonly FixMember[];
};

// SECTION: Identity

function fnv1a(text: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Deterministic id from run, parent, and sorted finding ids. */
export function clusterId(runId: string, parentId: string | null, findingIds: readonly FindingId[]): string {
  if (!runId.trim()) throw new Error('runId must be a non-empty string');
  const payload = `${runId}|${parentId ?? ''}|${[...findingIds].sort().join(',')}`;
  return `C-${(fnv1a(payload, 0x811c9dc5) + fnv1a(payload, 0x9747b28c)).slice(0, 12)}`;
}

// SECTION: Clustering

const unique = <T>(items: readonly T[]) => [...new Set(items)];

function normalize(input: FixInput): FixMember {
  if (!input.id) throw new Error('Fix requires a finding id');
  return {
    id: input.id,
    paths: unique(input.paths).sort(),
    dependencies: unique(input.dependencies ?? []).sort(),
    verification: unique((input.verification ?? []).filter(Boolean)),
  };
}

function closure(id: FindingId, byId: ReadonlyMap<FindingId, FixMember>, visited = new Set<FindingId>()): Set<FindingId> {
  if (visited.has(id)) return visited;
  visited.add(id);
  for (const dependency of byId.get(id)?.dependencies ?? []) closure(dependency, byId, visited);
  return visited;
}

function conflicts(group: readonly FixMember[], member: FixMember, byId: ReadonlyMap<FindingId, FixMember>): boolean {
  const paths = new Set(member.paths);
  const own = closure(member.id, byId);
  return group.some((other) => other.paths.some((file) => paths.has(file)) || own.has(other.id) || closure(other.id, byId).has(member.id));
}

function build(groups: readonly FixMember[][], byId: ReadonlyMap<FindingId, FixMember>, runId: string, parentId: string | null, budget: number): FixCluster[] | null {
  const clusters = groups.map((group) => {
    const findingIds = group.map((member) => member.id).sort();
    return {
      clusterId: clusterId(runId, parentId, findingIds),
      findingIds,
      paths: unique(group.flatMap((member) => member.paths)).sort(),
      verification: unique(group.flatMap((member) => member.verification)),
      attemptBudget: budget,
      parentId,
      dependsOnClusters: [] as string[],
      members: group,
    };
  });
  const owner = new Map(clusters.flatMap((cluster) => cluster.findingIds.map((id) => [id, cluster] as const)));
  for (const cluster of clusters) {
    const deps = new Set<string>();
    for (const member of cluster.members) {
      for (const id of closure(member.id, byId)) {
        const dep = owner.get(id);
        if (dep && dep !== cluster) deps.add(dep.clusterId);
      }
    }
    cluster.dependsOnClusters = [...deps].sort();
  }
  const ordered: FixCluster[] = [];
  const done = new Set<string>();
  while (ordered.length < clusters.length) {
    const next = clusters.find((cluster) => !done.has(cluster.clusterId) && cluster.dependsOnClusters.every((id) => done.has(id)));
    if (!next) return null;
    done.add(next.clusterId);
    ordered.push(next);
  }
  return ordered;
}

/** Independent clusters in dependency order; greedy grouping falls back to singletons when groups interlock. */
export function clusterFixes(fixes: readonly FixInput[], options: { runId: string; maxAttempts?: number; parentId?: string | null }): FixCluster[] {
  const budget = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isSafeInteger(budget) || budget < 1) throw new Error('maxAttempts must be a positive integer');
  const members = fixes.map(normalize).sort((a, b) => a.id.localeCompare(b.id));
  const byId = new Map(members.map((member) => [member.id, member]));
  const groups: FixMember[][] = [];
  for (const member of members) {
    const group = groups.find((candidate) => !conflicts(candidate, member, byId));
    if (group) group.push(member);
    else groups.push([member]);
  }
  const parentId = options.parentId ?? null;
  const ordered = build(groups, byId, options.runId, parentId, budget) ?? build(members.map((member) => [member]), byId, options.runId, parentId, budget);
  if (!ordered) throw new Error('finding dependencies contain a cycle');
  return ordered;
}

// SECTION: Failure split

export type SplitResult = { completed: readonly FindingId[]; clusters: readonly FixCluster[]; remainingBudget: number; canProceed: boolean };

/**
 * Splits a failed cluster: completed findings are kept, the failed finding is isolated, the rest re-cluster;
 * descendants share `budget - attemptsConsumed` (capped at maxAttempts), so attempts stay bounded.
 */
export function splitFailedCluster(cluster: FixCluster, options: {
  runId: string; completed?: readonly FindingId[]; failed?: FindingId | null; attemptsConsumed?: number; maxAttempts?: number;
}): SplitResult {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const consumed = options.attemptsConsumed ?? 1;
  if (!Number.isSafeInteger(consumed) || consumed < 0) throw new Error('attemptsConsumed must be a non-negative integer');
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error('maxAttempts must be a positive integer');
  const completed = unique(options.completed ?? []);
  const done = new Set(completed);
  const remaining = cluster.members.filter((member) => !done.has(member.id));
  const remainingBudget = Math.max(0, Math.min(cluster.attemptBudget - consumed, maxAttempts));
  if (!remaining.length || remainingBudget <= 0) return { completed, clusters: [], remainingBudget, canProceed: false };

  const recluster = (members: readonly FixMember[]) =>
    clusterFixes(members, { runId: options.runId, maxAttempts: remainingBudget, parentId: cluster.clusterId });
  let clusters: FixCluster[];
  const failed = remaining.find((member) => member.id === options.failed);
  if (failed) {
    const others = remaining.filter((member) => member !== failed);
    clusters = [...recluster([failed]), ...(others.length ? recluster(others) : [])];
  } else {
    const candidate = recluster(remaining);
    // Splitting must shrink the failed unit, or retries cannot make progress.
    clusters = remaining.length > 1 && candidate.length === 1 ? remaining.flatMap((member) => recluster([member])) : candidate;
  }
  return { completed, clusters, remainingBudget, canProceed: clusters.length > 0 };
}
