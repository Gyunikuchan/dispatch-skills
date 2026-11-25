import { readDelegateSession } from '../lib/usage/delegate.ts';
import type { DelegateQuery, HostUsageFs } from '../lib/usage/rows.ts';
import type { ProviderSpec, ProviderUsageContext } from './types.ts';

export function sessionUsageReader(
  platform: DelegateQuery['platform'],
  findSession: (raw: string, context: ProviderUsageContext) => string | null | undefined,
  options?: (
    context: ProviderUsageContext,
    fs: HostUsageFs,
  ) => Partial<Pick<DelegateQuery, 'appDataDir' | 'cwd' | 'fs'>>,
): NonNullable<ProviderSpec['sessionUsage']> {
  return (raw, context) => {
    const { transcripts, launchStartMs, launchEndMs } = context;
    if (!transcripts || launchStartMs === undefined || launchEndMs === undefined) return undefined;
    const sessionId = findSession(raw, context);
    if (sessionId === undefined) return undefined;
    if (!sessionId) return { complete: false };
    return readDelegateSession({
      platform,
      sessionId,
      startMs: launchStartMs,
      endMs: launchEndMs,
      resumed: context.resumed ?? false,
      ...(context.collectResponses ? { collectResponses: true } : {}),
      home: context.platform.home,
      env: (name) => context.env[name],
      fs: transcripts.fs,
      budget: transcripts.budget,
      ...options?.(context, transcripts.fs),
    });
  };
}
