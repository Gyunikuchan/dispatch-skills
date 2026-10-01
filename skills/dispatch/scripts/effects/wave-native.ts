// All-native wave (two-wave native path): every roster entry carries the host's capture for one native slot.
// Each capture goes through the same report parse path as `finishWave` (ask slots yield one sanitized claim), and
// the handler returns one `WAVE_DONE`. No process is launched.

import type { Effect, Ports, ResultEvent } from '../core/types.ts';
import { parseReport } from '../domain/report.ts';
import { sanitizeText } from '../domain/sanitize.ts';
import type { ReviewKind } from '../domain/types.ts';
import { REPORT_CLASS, waveDone, type SlotFinal } from './wave.ts';

type WaveEffect = Extract<Effect, { kind: 'wave' }>;
type Row = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);

/** True when every roster entry carries a host capture (wave effect 2 of the native path). */
export const isNativeRoster = (roster: readonly Row[]): boolean => roster.length > 0 && roster.every((entry) => isRecord(entry['capture']));

function reviewOf(value: unknown): ReviewKind | 'ask' {
  return value === 'plan' || value === 'design' || value === 'ask' ? value : 'code';
}

function finalOf(entry: Row, ports: Ports): SlotFinal {
  const slot = String(entry['slot'] ?? 'native');
  const capture = entry['capture'] as Row;
  const sourceKey = typeof capture['sourceKey'] === 'string' ? capture['sourceKey'] : slot;
  const outputPath = typeof capture['outputPath'] === 'string' ? capture['outputPath'] : '';
  const text = outputPath && ports.fs.exists(outputPath) ? ports.fs.readText(outputPath) : '';
  const review = reviewOf(entry['review']);
  if (review === 'ask') {
    const claim = sanitizeText(text);
    return claim
      ? { state: 'native', slot, sourceKey, reason: 'native capture', records: [], drafts: [], claim }
      : { state: 'failed', slot, cls: 'empty-output', reason: `native ${sourceKey}: empty-output`, records: [] };
  }
  const report = parseReport({ kind: review, source: slot, text });
  return report.ok
    ? { state: 'native', slot, sourceKey, reason: 'native capture', records: [], drafts: report.findings }
    : { state: 'failed', slot, cls: REPORT_CLASS[report.failure.kind], reason: `native ${sourceKey}: ${report.failure.kind}: ${report.failure.detail}`, records: [] };
}

export async function nativeWave(effect: WaveEffect, ports: Ports): Promise<readonly ResultEvent[]> {
  try {
    return waveDone(effect, effect.roster.map((entry) => finalOf(entry, ports)));
  } catch (error) {
    return [{ type: 'EFFECT_FAILED', effectId: effect.id, cls: 'io', detail: `native capture: ${error instanceof Error ? error.message : String(error)}` }];
  }
}
