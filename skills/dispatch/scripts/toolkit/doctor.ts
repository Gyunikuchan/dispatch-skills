import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_CANDIDATES, HINT, loadConfig, validateConfig } from '../lib/config.ts';
import { checkIntegrity } from '../lib/integrity.ts';
import { pricingProblems } from '../lib/pricing.ts';
import { type ProviderKey } from '../lib/platform.ts';
import { SPECS, isProviderId } from '../providers/index.ts';
import { probeProviders, type ProbeDeps } from '../providers/probe.ts';
import { normalizeProvider, resolveLevel, resolveRoster, resolveSubagent, resolveUtility, type LevelMap, type ReadDelegate, type ResolvedSubagent, type ResolvedUtility, type SubagentEntry, type UtilityEntry } from '../policy/roster.ts';
import { foldLedger, latest, type Fold } from './ledger.ts';
import { ToolError } from './output.ts';
import type { Level } from './types.ts';

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

function readDoctor(session: string, skillRoot: string, requested: unknown, host: ProviderKey | null, liveness?: Readonly<Record<string, boolean>>, sandboxSupported?: Readonly<Record<string, boolean>>, fold?: Fold) {
  if (requested !== undefined && !LEVELS.includes(requested as Level)) {
    throw new ToolError(1, 'invalid-input', 'level must be low, medium, high, xhigh or max');
  }
  const level = (requested ?? latest(fold ?? foldLedger(session), 'level')?.data['level'] ?? 'medium') as Level;
  const integrity = checkIntegrity(skillRoot);
  let configPath = CONFIG_CANDIDATES.map(name => path.join(skillRoot, name)).find(file => fs.existsSync(file)) ?? null;
  let problems: string[] = [], warnings: string[] = [];
  const writers: Record<string, ResolvedSubagent> = {};
  let utility: Record<string, ResolvedUtility> = {};
  let sandboxRemoved: string[] = [], writeConcurrency = 1;
  let readDelegates: Record<string, ReadDelegate> = {};
  try {
    const loaded = loadConfig(skillRoot);
    configPath = loaded.path;
    problems = validateConfig(loaded.config);
    warnings = pricingProblems(loaded.config['pricing']);
    if (!problems.length) { writeConcurrency = (loaded.config['write-concurrency'] as number) ?? 1;
      const writerTable = (loaded.config['write-subagents'] ?? {}) as Record<string, LevelMap<SubagentEntry>>;
      for (const [platform, levels] of Object.entries(writerTable)) writers[normalizeProvider(platform)] = resolveSubagent(resolveLevel(levels, level)!);
      utility = resolveUtility((loaded.config['utility-subagents'] ?? {}) as Record<string, UtilityEntry>);
      if (host && !utility[normalizeProvider(host)]) problems.push(`Missing required entry "utility-subagents.${host}" (${HINT}).`);
      if (host && !writers[normalizeProvider(host)]) problems.push(`Missing required entry "write-subagents.${host}" (${HINT}).`);
      readDelegates = loaded.config['read-delegates'] as Record<string, ReadDelegate>;
      sandboxRemoved = resolveRoster({
        level, readDelegates, orchestrator: host ? { platform: host } : null,
        ...(liveness ? { liveness } : {}), ...(sandboxSupported ? { sandboxSupported } : {}),
      }).underfill?.sandboxUnsupported ?? [];
    }
  } catch (error) {
    problems = [error instanceof Error ? error.message : String(error)];
  }
  const reason = integrity.status === 'drift' ? 'integrity-drift' : problems.length ? 'config-invalid' : undefined;
  const report = {
    ok: reason === undefined, ...(reason ? { reason } : {}),
    host: { platform: host, source: host ? 'declared' : 'none' },
    integrity,
    config: { path: configPath, problems, warnings }, level, writers, utility, sandboxRemoved,
    writeConcurrency,
  };
  return { report, readDelegates };
}

export function doctorReport(session: string, skillRoot: string, requested?: unknown, host: ProviderKey | null = null, liveness?: Readonly<Record<string, boolean>>, sandboxSupported?: Readonly<Record<string, boolean>>, fold?: Fold) {
  return readDoctor(session, skillRoot, requested, host, liveness, sandboxSupported, fold).report;
}

export async function doctorReportWithProbe(
  session: string, skillRoot: string, requested?: unknown, host: ProviderKey | null = null,
  liveness?: Readonly<Record<string, boolean>>, sandboxSupported?: Readonly<Record<string, boolean>>,
  fold?: Fold, probeDeps?: ProbeDeps,
) {
  const { report, readDelegates } = readDoctor(session, skillRoot, requested, host, liveness, sandboxSupported, fold);
  if (report.config.problems.length) return report;
  const targets = Object.entries(readDelegates).flatMap(([key, delegate]) => {
    const provider = normalizeProvider(key);
    return isProviderId(provider) ? [{ provider, sandboxRequired: delegate.sandbox !== false && SPECS[provider].sandbox !== undefined }] : [];
  });
  const probe = await probeProviders(targets, probeDeps);
  return { ...report, ...probe, ...(probe.probeSummary.failed ? { ok: false, reason: 'probe-failed' } : {}) };
}
