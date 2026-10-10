import type { DiagnosticUsage } from '../core/types.ts';
type Row = Record<string, unknown>;
const row = (v: unknown): Row | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null;
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
function counters(value: unknown, names: Record<string, string>, provenance: string, inputSemantics: DiagnosticUsage['inputSemantics']): DiagnosticUsage | undefined {
  const r = row(value);
  if (!r || !count(r[names['input']!]) || !count(r[names['output']!])) return undefined;
  const out: DiagnosticUsage = { input: r[names['input']!] as number, output: r[names['output']!] as number, scope: 'invocation', provenance, inputSemantics };
  for (const key of ['cacheRead', 'cacheWrite', 'reasoning'] as const) {
    const field = names[key];
    if (field && r[field] !== undefined) { if (!count(r[field])) return undefined; out[key] = r[field]; }
  }
  return out;
}
export function codexUsage(raw: string): DiagnosticUsage | undefined {
  let latest: DiagnosticUsage | undefined;
  let completed = 0;
  for (const line of raw.split(/\r?\n/).filter((v) => v.trim())) {
    let event: Row | null;
    try { event = row(JSON.parse(line)); } catch { return undefined; }
    if (event?.['type'] !== 'turn.completed') continue;
    const usage = counters(event['usage'], { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cached_input_tokens', cacheWrite: 'cache_write_input_tokens', reasoning: 'reasoning_output_tokens' }, 'codex.turn.completed', 'includes-cache');
    if (!usage) return undefined;
    if (latest && JSON.stringify(latest) !== JSON.stringify(usage)) completed++;
    latest = usage;
  }
  // v1 supports one completed turn; distinct multi-turn scopes need explicit delta evidence.
  return completed === 0 ? latest : undefined;
}
export function claudeUsage(raw: string): DiagnosticUsage | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  const event = row(Array.isArray(parsed) ? parsed.findLast((v: unknown) => row(v)?.['type'] === 'result') : parsed);
  if (event?.['type'] !== 'result') return undefined;
  const models = row(event['modelUsage']);
  if (models && Object.keys(models).length > 0 && Object.keys(models).length <= 8) {
    const parts = Object.values(models).map((v) => counters(v, { input: 'inputTokens', output: 'outputTokens', cacheRead: 'cacheReadInputTokens', cacheWrite: 'cacheCreationInputTokens', reasoning: 'thinkingTokens' }, 'claude.result.modelUsage', 'uncached'));
    if (parts.some((v) => !v)) return undefined;
    const out: DiagnosticUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, scope: 'invocation', provenance: 'claude.result.modelUsage', inputSemantics: 'uncached', actualModels: Object.keys(models) };
    for (const part of parts) for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const) if (part?.[key] !== undefined) out[key] = (out[key] ?? 0) + part[key];
    // Per-model counters let the report split a cascade's cost by the model that actually ran.
    out.models = Object.fromEntries(Object.keys(models).map((name, index) => {
      const part = parts[index]!;
      return [name, { input: part.input, output: part.output, ...(part.cacheRead === undefined ? {} : { cacheRead: part.cacheRead }), ...(part.cacheWrite === undefined ? {} : { cacheWrite: part.cacheWrite }) }];
    }));
    return Object.values(out).some((v) => typeof v === 'number' && !count(v)) ? undefined : out;
  }
  return counters(event['usage'], { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cache_read_input_tokens', cacheWrite: 'cache_creation_input_tokens' }, 'claude.result.usage', 'uncached');
}
export function agyUsage(raw: string): DiagnosticUsage | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  // agy reports cache reads beside input_tokens, so input is uncached; agy has no cache-write counter.
  return counters(row(parsed)?.['usage'], { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cache_read_tokens', reasoning: 'thinking_tokens' }, 'agy.usage', 'uncached');
}
