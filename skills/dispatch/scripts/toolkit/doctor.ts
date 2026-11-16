import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_CANDIDATES, HINT, loadConfig, validateConfig } from '../lib/config.ts';
import { checkIntegrity } from '../lib/integrity.ts';
import { pricingProblems } from '../lib/pricing.ts';
import { type ProviderKey } from '../lib/platform.ts';
import { normalizeProvider, resolveLevel, resolveRoster, resolveSubagent, resolveUtility, type LevelMap, type ReadDelegate, type ResolvedSubagent, type ResolvedUtility, type SubagentEntry, type UtilityEntry } from '../policy/roster.ts';
import { foldLedger, latest } from './ledger.ts';
import { ToolError } from './output.ts';
import type { Level } from './types.ts';

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export function doctorReport(session: string, skillRoot: string, requested?: unknown, host: ProviderKey | null = null, liveness?: Readonly<Record<string, boolean>>, sandboxSupported?: Readonly<Record<string, boolean>>) {
  if (requested !== undefined && !LEVELS.includes(requested as Level)) {
    throw new ToolError(1, 'invalid-input', 'level must be low, medium, high, xhigh or max');
  }
  const level = (requested ?? latest(foldLedger(session), 'level')?.data['level'] ?? 'medium') as Level;
  const integrity = checkIntegrity(skillRoot);
  let configPath = CONFIG_CANDIDATES.map(name => path.join(skillRoot, name)).find(file => fs.existsSync(file)) ?? null;
  let problems: string[] = [], warnings: string[] = [];
  const writers: Record<string, ResolvedSubagent> = {};
  let utility: Record<string, ResolvedUtility> = {};
  let sandboxRemoved: string[] = [], writeConcurrency = 1;
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
      sandboxRemoved = resolveRoster({
        level, readDelegates: loaded.config['read-delegates'] as Record<string, ReadDelegate>, orchestrator: host ? { platform: host } : null,
        ...(liveness ? { liveness } : {}), ...(sandboxSupported ? { sandboxSupported } : {}),
      }).underfill?.sandboxUnsupported ?? [];
    }
  } catch (error) {
    problems = [error instanceof Error ? error.message : String(error)];
  }
  const reason = integrity.status === 'drift' ? 'integrity-drift' : problems.length ? 'config-invalid' : undefined;
  return {
    ok: reason === undefined, ...(reason ? { reason } : {}),
    host: { platform: host, source: host ? 'declared' : 'none' },
    integrity,
    config: { path: configPath, problems, warnings }, level, writers, utility, sandboxRemoved,
    writeConcurrency,
  };
}
