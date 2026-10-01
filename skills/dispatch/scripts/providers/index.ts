// Provider registry: one declarative spec per provider over the shared runner.

import { agy } from './agy.ts';
import { claude } from './claude.ts';
import { codex } from './codex.ts';
import { copilot } from './copilot.ts';
import { opencode } from './opencode.ts';
import type { ProviderId, ProviderSpec } from './types.ts';

export const SPECS: Readonly<Record<ProviderId, ProviderSpec>> = { claude, agy, copilot, opencode, codex };

export const isProviderId = (value: string): value is ProviderId => Object.hasOwn(SPECS, value);
