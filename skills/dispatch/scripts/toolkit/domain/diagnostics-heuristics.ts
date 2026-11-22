import { measured, uncached } from './diagnostics-gates.ts';
import { CATEGORIES, DASH, type Category, type Finding, type InvocationFacts, type RunFacts } from './diagnostics-types.ts';


// Share heuristics need `minSamples`, so one or two data points never read as a pattern.
const DIAGNOSTIC_THRESHOLDS = { reviewRounds: 3, minSamples: 3, rejectedShare: 0.5, cacheReadShare: 0.5, invocationShare: 0.5 } as const;

// SECTION: Heuristics

const RANK = Object.keys(CATEGORIES);
export const bySeverity = <T extends { category: Category }>(items: readonly T[]): T[] => [...items].sort((a, b) => RANK.indexOf(a.category) - RANK.indexOf(b.category));
export const pct = (share: number) => `${Math.round(share * 100)}%`;
export const num = (n: number | undefined) => n === undefined ? DASH : String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const tally = (values: readonly string[]) => [...new Set(values)].map((v) => `${v} ×${values.filter((x) => x === v).length}`).join(', ');
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : /(?:s|sh|ch|x)$/.test(word) ? 'es' : 's'}`;
export const phaseName = (run: RunFacts, key: string | undefined) => {
  const name=run.phases.find(p=>p.key===key)?.name??DASH;
  return key&&/^review-[a-f0-9]{16}$/.test(key)?`${name} · subject ${key.slice(7)}`:name;
};

export const sum = (values: readonly (number | undefined)[]): number | undefined => values.some((v) => v !== undefined) ? values.reduce<number>((a, v) => a + (v ?? 0), 0) : undefined;

function groups<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) out.set(key(item), [...(out.get(key(item)) ?? []), item]);
  return out;
}

const PREFLIGHT = ['scripts/toolkit/doctor.ts', 'Detect this condition in the preflight check and skip the provider before launch.'] as const;
const FAILURE_FIXES: Record<string, readonly [string, string]> = {
  'model-not-found': ['scripts/policy/cascade.ts', 'Check configured model names in the preflight and cascade past unknown models before launch.'],
  'model-not-loaded': ['references/providers.md', 'Check that the configured model is installed and loadable on the provider, or replace it in config.'],
  quota: ['references/providers.md', 'Reorder or remove the exhausted model alias, or check its quota; quota limits may be shared.'],
  capacity: ['references/providers.md', 'Check the provider capacity and retry delay; reduce concurrent launches on that provider or wait before re-running.'],
  'no-report': ['references/templates/review-prompt.md', 'Keep the required report JSON in the prompt and inspect the slot log when an answer ends without a report.'],
  timeout: ['references/providers.md', 'Inspect the slot log nudge rows: if the stall persisted through three resumes, check provider health and model load before re-running.'],
  blocked: ['references/providers.md', 'Read the blocked reason; fix the denied path or brief, or replace the model.'],
  'context-overflow': ['scripts/toolkit/prompts.ts', 'Bound prompt and attachment bytes per voice before launch so prompts fit the model context.'],
  auth: PREFLIGHT, 'cli-outdated': PREFLIGHT, 'not-found': PREFLIGHT, 'sandbox-unsupported': PREFLIGHT, config: PREFLIGHT,
};

const DEFAULT_FIX = ['references/providers.md', "Inspect the slot log for the delegate's last output and consider replacing the model or provider."] as const;

// The domain layer cannot import cli.ts, so this table mirrors its handler map.
const TOOL_MODULES: Readonly<Record<string, string>> = {
  'ask run': 'ask', 'review run': 'review', 'diagnostics render': 'diagnostics', 'brief render': 'brief', 'brief explorer': 'brief', 'brief test-cleanup': 'brief', 'brief verifier': 'brief', 'brief fix-check': 'fix-check', 'check run': 'check', 'doctor run': 'doctor', 'status show': 'status', 'lint run': 'lint',
  'report render': 'report', 'report complete': 'report', 'ledger append': 'ledger', 'ledger query': 'ledger',
  'worktree integrate': 'integrate', 'worktree continue': 'integrate', 'worktree commit': 'integrate', 'worktree abort': 'integrate',
  'worktree deliver': 'deliver', 'worktree close': 'deliver', 'worktree cleanup': 'deliver',
  'worktree create': 'writers', 'worktree submit': 'writers', 'worktree abandon': 'writers',
};

/** Deterministic findings (H1–H5, H8, H9) for one run, in severity order. */

export function selectFindings(run: RunFacts, formatDuration: (ms: number | undefined) => string): Finding[] {
  const T = DIAGNOSTIC_THRESHOLDS;
  const out: Finding[] = [];
  const add = (source: string, category: Category, component: string, evidence: string, impact: string, proposedFix: string) => out.push({ source, category, component, evidence, impact, proposedFix });
  // Quota-store skips never launch, so they cost no driver time and are not attempts.
  const cli = run.invocations.filter((i) => i.surface === 'cli' && i.launched);
  // A single failure absorbed by a retry or reserve is designed behavior; only repeated failures waste work.
  const isOk = (i: InvocationFacts) => i.outcome === 'ok' && (i.validationOutcome === undefined || i.validationOutcome === 'ok');
  const isFailure = (i: InvocationFacts) => i.outcome !== 'ok' || (i.validationOutcome !== undefined && i.validationOutcome !== 'ok');
  const identity = (i: InvocationFacts) => [i.subject ?? i.phase, i.slot, i.provider, i.model].join('\0');
  const cliIndex = new Map(cli.map((row, index) => [row, index] as const));
  // A stall or missing report that a resume chain recovers is not waste: consecutive resume attempts of the same subject, slot, provider and model must end in a valid ok row for the whole chain to leave the failure set.
  const recoveredByResume = (row: InvocationFacts): boolean => {
    if (row.slot === undefined || row.attempt === undefined) return false;
    const start = cliIndex.get(row);
    if (start === undefined) return false;
    const key = identity(row);
    let attempt = row.attempt;
    for (let index = start + 1; index < cli.length; index++) {
      const next = cli[index]!;
      if (identity(next) !== key) continue;
      if (next.nudge !== true || next.attempt !== attempt + 1) return false;
      attempt = next.attempt;
      if (isOk(next)) return true;
    }
    return false;
  };
  const failed = cli.filter(isFailure).filter((row) => !recoveredByResume(row));
  const failureClass = (i:InvocationFacts) => i.outcome !== 'ok' ? i.outcome : i.validationOutcome!;
  const count = (key: (i: InvocationFacts) => string) => { const m = new Map<string, number>(); for (const i of failed) m.set(key(i), (m.get(key(i)) ?? 0) + 1); return m; };
  const bySlot = count((i) => `${i.subject??i.phase}|${i.slot ?? ''}`);
  const byProvider = count((i) => i.provider);
  const wasted = failed.filter((i) => (i.slot !== undefined && (bySlot.get(`${i.subject??i.phase}|${i.slot}`) ?? 0) >= 2) || (byProvider.get(i.provider) ?? 0) >= 2);
  for (const [cls, items] of groups(wasted, failureClass)) {
    const [component, fix] = FAILURE_FIXES[cls] ?? DEFAULT_FIX;
    const spent = sum(items.map((i) => i.durationMs));
    const quota = cls === 'quota';
    const attempts = tally(items.map((i) => quota ? `${i.provider}/${i.model}` : i.provider));
    let recovery = '';
    if (quota) {
      const indexOf = new Map(run.invocations.map((item, index) => [item, index]));
      const routed = new Set(['next-model', 'next-mode', 'reserve']);
      const recovered = items.filter((failedItem) => {
        if (!failedItem.subject || !failedItem.slot || !routed.has(failedItem.routingOutcome ?? '')) return false;
        const failedIndex = indexOf.get(failedItem);
        if (failedIndex === undefined) return false;
        return run.invocations.slice(failedIndex + 1).some((later) => {
          if (later.surface !== 'cli' || !later.launched || later.subject !== failedItem.subject || later.outcome !== 'ok'
            || (later.validationOutcome !== undefined && later.validationOutcome !== 'ok')) return false;
          const retried = later.slot === failedItem.slot && failedItem.attempt !== undefined
            && later.attempt !== undefined && later.attempt > failedItem.attempt;
          const reserved = later.slot !== undefined && later.slot !== failedItem.slot && later.targetSlot === failedItem.slot;
          return retried || reserved;
        });
      }).length;
      recovery = `, ${recovered} recovered by fallback`;
    }
    add('H1', 'correctness', component, `\`${cls}\`: ${items.length} of ${plural(cli.length, 'CLI attempt')} failed (${attempts})${recovery}${spent === undefined ? '' : `, ${formatDuration(spent)} of driver time`}.`, 'Failed attempts delay the wave and trigger retries or cascade launches.', fix);
  }
  for (const [key, rows] of groups(run.reviews, (r) => r.phase ?? '')) {
    const rounds = Math.max(...rows.map((r) => r.round));
    const reraised = [...new Set(rows.flatMap((r) => r.reraised ?? []))];
    const escalation = rows.map((r) => r.escalation).filter((e) => e !== undefined).at(-1);
    // Known-cap continuation is designed; only a run without a recorded cap uses the fixed threshold.
    const cap = rows.map((r) => r.cap).filter((c) => c !== undefined).at(-1);
    const fallback = cap === undefined && rounds >= T.reviewRounds;
    if (!fallback && !reraised.length && !escalation) continue;
    const ids = (values: readonly string[]) => values.length ? ` (${values.slice(0, 5).join(', ')})` : '';
    // NOTE: a deadlock in the cap round without re-raised findings is the cap-ending refresh label; past the cap it marks designed continuation, so its fix must not raise the cap.
    const capReached = cap !== undefined && escalation?.kind === 'deadlock' && rounds === cap && !reraised.length;
    const pastCap = cap !== undefined && rounds > cap && (!escalation ? reraised.length > 0 : escalation.kind === 'deadlock' && !reraised.length);
    const detail = [
      plural(rounds, 'round'),
      ...(capReached ? [`cap reached (${cap})`] : []),
      ...(pastCap ? [`continued past the cap (${cap})`] : []),
      ...(reraised.length ? [`${plural(reraised.length, 'finding')} re-raised across rounds${ids(reraised)}`] : []),
      ...(escalation && !capReached ? [`${escalation.kind} escalation${ids(escalation.ids)}`] : []),
    ];
    add('H2', 'review-convergence', 'references/review-rules.md', `${phaseName(run, key)}: ${detail.join('; ')}.`, 'Each extra round adds voice launches and a host ruling turn.', capReached ? 'Raise the round cap or narrow scope.' : 'Require reviewers to cite new code or requirement evidence before re-raising a settled finding; otherwise the earlier ruling stays closed.');
  }
  for (const r of run.reviews) {
    const all = r.accepted + r.rejected;
    if (all < T.minSamples || r.rejected / all <= T.rejectedShare) continue;
    add('H3', 'review-convergence', 'references/templates/review-prompt.md', `${phaseName(run, r.phase)} round ${r.round}: ${r.rejected} of ${plural(all, 'finding')} rejected (${pct(r.rejected / all)}).`, 'Rejected findings cost reviewer tokens and host ruling time without changing the artifact.', 'Read the rejection rulings; where reviewers misread scope or criteria, state that boundary in the artifact the prompt cites.');
  }
  const metered = run.invocations.filter((i) => measured(i));
  for (const [provider, items] of groups(metered, (i) => i.provider)) {
    const reporting = items.filter((i) => i.usage!.cacheRead !== undefined);
    const cacheRead = sum(reporting.map((i) => i.usage!.cacheRead)) ?? 0, input = cacheRead + (sum(reporting.map((i) => i.usage!.input)) ?? 0);
    if (!reporting.length || !input || cacheRead / input >= T.cacheReadShare) continue;
    add('H4', 'token-economy', 'scripts/toolkit/domain/prompt.ts', `${provider}: cache read ${pct(cacheRead / input)} of input (${num(cacheRead)} of ${num(input)} tokens) across ${plural(reporting.length, 'invocation')}.`, 'Uncached input is billed and processed in full on every launch.', 'Put stable content (rules, templates, shared context) before per-voice and per-round content so provider prompt caches hit.');
  }
  // Cache reads are cheap and dominate long sessions, so rank launches by uncached tokens; zero-usage failures are not samples.
  const sizes = metered.map((i) => [i, uncached(i.usage!)] as const).filter(([, n]) => n > 0);
  if (sizes.length >= T.minSamples) {
    const all = sum(sizes.map(([, n]) => n)) ?? 0;
    const [top, n] = sizes.reduce((a, b) => b[1] > a[1] ? b : a);
    // Above an even share (2/n) the largest invocation stands out; at small n, even shares already reach half.
    if (all && n / all > Math.max(T.invocationShare, 2 / sizes.length)) add('H5', 'token-economy', 'scripts/toolkit/prompts.ts', `${top.provider} ${top.model} in ${phaseName(run, top.phase)}: ${num(n)} of ${num(all)} measured uncached tokens (${pct(n / all)}).`, 'One invocation dominates token spend; its own repository exploration likely drives most of it.', 'Lower that slot\'s turn budget or effort, or assign it a cheaper model.');
  }
  // One clear refusal is not a pattern.
  const rejection = (item: { tool: string; action: string; cls: string }) => item.tool + ' ' + item.action + ': ' + item.cls;
  const repeated = [...groups(run.rejectedTools ?? [], rejection).values()].filter((items) => items.length >= 2).flat();
  for (const [component, items] of groups(repeated, (item) => `scripts/toolkit/${TOOL_MODULES[item.tool + ' ' + item.action] ?? 'cli'}.ts`)) {
    add('H8', 'correctness', component, `${plural(items.length, 'toolkit operation')} rejected (${tally(items.map(rejection))}).`, 'Rejected operations can require another host turn.', 'Return the allowed input shape and current preconditions with the rejection.');
  }
  // One relaunch without a recorded cause is not a pattern.
  if ((run.relaunches ?? 0) >= 2) add('H9','correctness','scripts/toolkit/brief.ts',`${plural(run.relaunches!,'writer relaunch')}; rework evidence, cause unavailable.`,'Additional launches repeat context and may repeat verification.','Read the writer launch reports at `.state/briefs/<task>-<launch>.report.md` for the relaunch cause.');
  return bySeverity(out);
}
