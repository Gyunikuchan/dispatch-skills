import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_CANDIDATES, loadConfig, validateConfig } from '../lib/config.ts';
import { checkIntegrity } from '../lib/integrity.ts';
import type { ProviderKey } from '../lib/platform.ts';
import { resolveLevel, resolveSubagent, resolveUtility, type LevelMap, type ResolvedSubagent, type SubagentEntry } from '../policy/roster.ts';
import { foldLedger, latest } from './ledger.ts';
import { ToolError } from './output.ts';
import type { Level } from './types.ts';

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export function doctorReport(session: string, skillRoot: string, requested?: unknown, host: ProviderKey | null = null) {
  if (requested !== undefined && !LEVELS.includes(requested as Level)) {
    throw new ToolError(1, 'invalid-input', 'level must be low, medium, high, xhigh or max');
  }
  const level = (requested ?? latest(foldLedger(session), 'level')?.data['level'] ?? 'medium') as Level;
  const integrity = checkIntegrity(skillRoot);
  let configPath = CONFIG_CANDIDATES.map(name => path.join(skillRoot, name)).find(file => fs.existsSync(file)) ?? null;
  let problems: string[] = [];
  const writers: Record<string, ResolvedSubagent> = {};
  const explorers: Record<string, ResolvedSubagent> = {};
  let utility: Record<string, ResolvedSubagent> = {};
  try {
    const loaded = loadConfig(skillRoot);
    configPath = loaded.path;
    problems = validateConfig(loaded.config);
    if (!problems.length) {
      const writerTable = loaded.config['write-subagents'] as Record<string, LevelMap<SubagentEntry>>;
      for (const [platform, levels] of Object.entries(writerTable)) writers[platform] = resolveSubagent(resolveLevel(levels, level)!);
      const explorerTable = loaded.config['explore-subagents'] as Record<string, SubagentEntry>;
      for (const [platform, entry] of Object.entries(explorerTable)) explorers[platform] = resolveSubagent(entry);
      utility = resolveUtility(explorerTable, writerTable);
    }
  } catch (error) {
    problems = [error instanceof Error ? error.message : String(error)];
  }
  const reason = integrity.status === 'drift' ? 'integrity-drift' : problems.length ? 'config-invalid' : undefined;
  return {
    ok: reason === undefined, ...(reason ? { reason } : {}),
    host: { platform: host, source: host ? 'declared' : 'none' },
    integrity,
    config: { path: configPath, problems }, level, writers, explorers, utility,
  };
}
