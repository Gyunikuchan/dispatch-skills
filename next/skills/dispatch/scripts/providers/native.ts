// Native fallback descriptors and model-mapping verification (spec §6.5; ports legacy native fallback).
// A descriptor is what the host needs to launch one native subagent; the wave reconciles its capture by `sourceKey`.

import type { ProviderId } from './types.ts';

export const NATIVE_AGENT_TYPES: Readonly<Partial<Record<ProviderId, string>>> = { claude: 'explore', agy: 'research', copilot: 'explore', opencode: 'explore' };
export const DEFAULT_NATIVE_AGENT_TYPE = 'explore';

export type NativeDescriptor = {
  /** `<slot>` for a native slot, `<slot>#fallback` for a CLI slot served natively. */
  sourceKey: string;
  agentType: string;
  model: string | null;
  reasoningEffort: string | null;
  /** The CLI slot this subagent replaces; null for a `nativeSubagentsOnly` slot. */
  substitutesFor: string | null;
  cascadePosition: number;
  modelCascade: readonly string[];
  promptPath: string;
  outputPath: string;
  attachments: readonly string[];
};

export type DescriptorInput = {
  slot: string;
  platform: ProviderId;
  models: readonly string[];
  effort: string | null;
  substitutes: boolean;
  cascadePosition: number;
  promptPath: string;
  outputPath: string;
  attachments: readonly string[];
};

export function nativeDescriptor(input: DescriptorInput): NativeDescriptor {
  const position = Math.min(Math.max(0, input.cascadePosition), Math.max(0, input.models.length - 1));
  return {
    sourceKey: input.substitutes ? `${input.slot}#fallback` : input.slot,
    agentType: NATIVE_AGENT_TYPES[input.platform] ?? DEFAULT_NATIVE_AGENT_TYPE,
    model: input.models[position] ?? null,
    reasoningEffort: input.effort,
    substitutesFor: input.substitutes ? input.slot : null,
    cascadePosition: position,
    modelCascade: input.models,
    promptPath: input.promptPath,
    outputPath: input.outputPath,
    attachments: input.attachments,
  };
}

/** Retry position: an empty early capture retries the same model; a confirmed rejection moves on. */
export const retryPosition = (reason: 'empty' | 'rejected', current: number): number => (reason === 'empty' ? current : current + 1);

export type ModelMapping = { configuredModel: string; launcherModel: string; provider: string };
export type MappingVerdict = 'match' | 'mismatch' | 'availability';

/**
 * Whether the launcher ran the configured model: exact, or a verified mapping entry. A mismatch seen again for the
 * same configured model is an availability failure (the host cannot serve it), not a retryable mismatch.
 */
export function verifyMapping(input: { configured: string; launched: string; provider: string; mappings: readonly ModelMapping[]; priorMismatches: readonly string[] }): MappingVerdict {
  if (input.configured === input.launched) return 'match';
  const mapped = input.mappings.some((entry) => entry.configuredModel === input.configured && entry.launcherModel === input.launched && entry.provider === input.provider);
  if (mapped) return 'match';
  return input.priorMismatches.includes(input.configured) ? 'availability' : 'mismatch';
}
