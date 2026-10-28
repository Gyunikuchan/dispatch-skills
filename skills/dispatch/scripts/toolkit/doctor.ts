import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_CANDIDATES, loadConfig, validateConfig } from '../lib/config.ts';
import { checkIntegrity } from '../lib/integrity.ts';
import { resolveLevel } from '../policy/roster.ts';
import { foldLedger, latest } from './ledger.ts';
import { ToolError } from './output.ts';
import type { Level } from './types.ts';

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Writer = { models: string[]; effort: string | null };
type Explorer = Writer & { deep: boolean };
type ExplorerConfig = { model: string | string[]; effort?: string; deep?: boolean };

export function doctorReport(session: string, skillRoot: string, requested?: unknown) {
  if (requested !== undefined && !LEVELS.includes(requested as Level)) {
    throw new ToolError(1, 'invalid-input', 'level must be low, medium, high, xhigh or max');
  }
  const level = (requested ?? latest(foldLedger(session), 'level')?.data['level'] ?? 'medium') as Level;
  const integrity = checkIntegrity(skillRoot);
  let configPath = CONFIG_CANDIDATES.map(name => path.join(skillRoot, name)).find(file => fs.existsSync(file)) ?? null;
  let problems: string[] = [];
  const writers: Record<string, Writer> = {};
  const explorers: Record<string, Explorer> = {};
  try {
    const loaded = loadConfig(skillRoot);
    configPath = loaded.path;
    problems = validateConfig(loaded.config);
    if (!problems.length) {
      const table = loaded.config['write-subagents'] as Record<string, Partial<Record<Level, { model: string | string[]; effort?: string }>>>;
      for (const [platform, levels] of Object.entries(table)) {
        const entry = resolveLevel(levels, level)!;
        writers[platform] = {
          models: typeof entry.model === 'string' ? [entry.model] : entry.model,
          effort: entry.effort ?? null,
        };
      }
      const explorerTable = loaded.config['explore-subagents'] as Record<string, ExplorerConfig>;
      for (const [platform, entry] of Object.entries(explorerTable)) {
        explorers[platform] = {
          models: typeof entry.model === 'string' ? [entry.model] : entry.model,
          effort: entry.effort ?? null,
          deep: entry.deep ?? false,
        };
      }
    }
  } catch (error) {
    problems = [error instanceof Error ? error.message : String(error)];
  }
  const reason = integrity.status === 'drift' ? 'integrity-drift' : problems.length ? 'config-invalid' : undefined;
  return {
    ok: reason === undefined, ...(reason ? { reason } : {}), integrity,
    config: { path: configPath, problems }, level, writers, explorers,
  };
}
