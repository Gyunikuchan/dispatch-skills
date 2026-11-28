import { defined } from "./defined.ts";
import { measured, uncached } from "./diagnostics-gates.ts";
import { CATEGORIES, DASH } from "./diagnostics-types.ts";
import type {
  Category,
  Finding,
  InvocationFacts,
  ReviewFacts,
  RunFacts,
} from "./diagnostics-types.ts";

// Share heuristics need `minSamples`, so one or two data points never read as a pattern.
const DIAGNOSTIC_THRESHOLDS = {
  reviewRounds: 3,
  minSamples: 3,
  rejectedShare: 0.5,
  cacheReadShare: 0.5,
  invocationShare: 0.5,
  minCacheTokens: 100_000,
  singleAgentTurnChurn: 60,
  stageTurnChurn: 120,
} as const;

const NON_REVIEW_STAGES = new Set([
  "spec",
  "design",
  "plan",
  "implementation",
  "ask",
]);

const cacheReadMetrics = (
  items: readonly { input: number; cacheRead?: number }[]
) => {
  const cacheRead = sum(items.map((item) => item.cacheRead)) ?? 0;
  const total = cacheRead + (sum(items.map((item) => item.input)) ?? 0);

  return { cacheRead, total, share: total > 0 ? cacheRead / total : undefined };
};

// SECTION: Heuristics

const isMetered = (
  i: InvocationFacts
): i is InvocationFacts & { usage: NonNullable<InvocationFacts["usage"]> } =>
  measured(i) !== undefined;

const RANK = Object.keys(CATEGORIES);

export const bySeverity = <T extends { category: Category }>(
  items: readonly T[]
) =>
  [...items].toSorted(
    (a, b) => RANK.indexOf(a.category) - RANK.indexOf(b.category)
  );

type AddFinding = (
  source: string,
  category: Category,
  component: string,
  evidence: string,
  impact: string,
  proposedFix: string
) => void;

type MeteredInvocation = InvocationFacts & {
  usage: NonNullable<InvocationFacts["usage"]>;
};

type HostRow = NonNullable<RunFacts["hostUsage"]>["rows"][number];

type Escalation = NonNullable<ReviewFacts["escalation"]>;

export const pct = (share: number) => `${Math.round(share * 100)}%`;

export const num = (n: number | undefined) =>
  n === undefined
    ? DASH
    : String(Math.round(n)).replaceAll(/\B(?=(?<cap1>\d{3})+(?!\d))/gu, ",");

const tally = (values: readonly string[]) =>
  [...new Set(values)]
    .map((v) => `${v} ×${values.filter((x) => x === v).length}`)
    .join(", ");

const pluralSuffix = (word: string) =>
  /(?:s|sh|ch|x)$/u.test(word) ? "es" : "s";

export const plural = (n: number, word: string) =>
  `${n} ${word}${n === 1 ? "" : pluralSuffix(word)}`;

export const phaseName = (run: RunFacts, key: string | undefined) => {
  const name = run.phases.find((p) => p.key === key)?.name ?? DASH;

  return key !== undefined && key !== "" && /^review-[a-f0-9]{16}$/u.test(key)
    ? `${name} · subject ${key.slice(7)}`
    : name;
};

export const sum = (values: readonly (number | undefined)[]) =>
  values.some((v) => v !== undefined)
    ? values.reduce<number>((a, v) => a + (v ?? 0), 0)
    : undefined;

const groups = <T>(items: readonly T[], key: (item: T) => string) => {
  const out = new Map<string, T[]>();

  for (const item of items) {
    out.set(key(item), [...(out.get(key(item)) ?? []), item]);
  }

  return out;
};

const PREFLIGHT = [
  "scripts/toolkit/doctor.ts",
  "Detect this condition in the preflight check and skip the provider before launch.",
] as const;

// Keyed by a recorded failure class or tool action, so any string may be looked up.
interface FailureFixes {
  [cls: string]: readonly [string, string] | undefined;
}

interface ToolModules {
  readonly [action: string]: string | undefined;
}

const FAILURE_FIXES: FailureFixes = {
  "model-not-found": [
    "scripts/policy/cascade.ts",
    "Check configured model names in the preflight and cascade past unknown models before launch.",
  ],
  "model-not-loaded": [
    "references/providers.md",
    "Check that the configured model is installed and loadable on the provider, or replace it in config.",
  ],
  quota: [
    "references/providers.md",
    "Reorder or remove the exhausted model alias, or check its quota; quota limits may be shared.",
  ],
  capacity: [
    "references/providers.md",
    "Check the provider capacity and retry delay; reduce concurrent launches on that provider or wait before re-running.",
  ],
  "no-report": [
    "references/templates/review-prompt.md",
    "Keep the required report JSON in the prompt and inspect the slot log when an answer ends without a report.",
  ],
  timeout: [
    "references/providers.md",
    "Inspect the slot log nudge rows: if the stall persisted through three resumes, check provider health and model load before re-running.",
  ],
  blocked: [
    "references/providers.md",
    "Read the blocked reason; fix the denied path or brief, or replace the model.",
  ],
  "context-overflow": [
    "scripts/toolkit/prompts.ts",
    "Bound prompt and attachment bytes per voice before launch so prompts fit the model context.",
  ],
  auth: PREFLIGHT,
  "cli-outdated": PREFLIGHT,
  "not-found": PREFLIGHT,
  "sandbox-unsupported": PREFLIGHT,
  config: PREFLIGHT,
};

const DEFAULT_FIX = [
  "references/providers.md",
  "Inspect the slot log for the delegate's last output and consider replacing the model or provider.",
] as const;

// The domain layer cannot import cli.ts, so this table mirrors its handler map.
const TOOL_MODULES: ToolModules = {
  "ask run": "ask",
  "review run": "review",
  "diagnostics render": "diagnostics",
  "brief render": "brief",
  "brief explorer": "brief",
  "brief test-cleanup": "brief",
  "brief verifier": "brief",
  "brief fix-review-lite": "fix-review-lite",
  "check run": "check",
  "doctor run": "doctor",
  "status show": "status",
  "lint run": "lint",
  "report render": "report",
  "report complete": "report",
  "ledger append": "ledger",
  "ledger query": "ledger",
  "worktree integrate": "integrate",
  "worktree continue": "integrate",
  "worktree commit": "integrate",
  "worktree abort": "integrate",
  "worktree deliver": "deliver",
  "worktree close": "deliver",
  "worktree cleanup": "deliver",
  "worktree create": "writers",
  "worktree submit": "writers",
  "worktree land": "land",
  "worktree abandon": "writers",
};

// A single failure absorbed by a retry or reserve is designed behavior; only repeated failures waste work.
const isOk = (i: InvocationFacts) =>
  i.outcome === "ok" &&
  (i.validationOutcome === undefined || i.validationOutcome === "ok");

const isFailure = (i: InvocationFacts) =>
  i.outcome !== "ok" ||
  (i.validationOutcome !== undefined && i.validationOutcome !== "ok");

const attemptIdentity = (i: InvocationFacts) =>
  [i.subject ?? i.phase, i.slot, i.provider, i.model].join("\0");

const failureClass = (i: InvocationFacts) =>
  i.outcome === "ok" ? defined(i.validationOutcome) : i.outcome;

// One clear refusal is not a pattern.
const rejection = (item: { tool: string; action: string; cls: string }) =>
  `${item.tool} ${item.action}: ${item.cls}`;

const idList = (values: readonly string[]) =>
  values.length ? ` (${values.slice(0, 5).join(", ")})` : "";

// A stall or missing report that a resume chain recovers is not waste: consecutive resume attempts of the same subject, slot, provider and model must end in a valid ok row for the whole chain to leave the failure set.
const recoveredByResume = (
  row: InvocationFacts,
  cli: readonly InvocationFacts[],
  cliIndex: ReadonlyMap<InvocationFacts, number>
) => {
  if (row.slot === undefined || row.attempt === undefined) {
    return false;
  }

  const start = cliIndex.get(row);

  if (start === undefined) {
    return false;
  }

  const key = attemptIdentity(row);
  let { attempt } = row;

  for (let index = start + 1; index < cli.length; index += 1) {
    const next = defined(cli[index]);

    if (attemptIdentity(next) !== key) {
      continue;
    }

    if (next.nudge !== true || next.attempt !== attempt + 1) {
      return false;
    }

    ({ attempt } = next);

    if (isOk(next)) {
      return true;
    }
  }

  return false;
};

const quotaRecoveries = (items: readonly InvocationFacts[], run: RunFacts) => {
  const indexOf = new Map(
    run.invocations.map((item, index) => [item, index] as const)
  );

  const routed = new Set(["next-model", "next-mode", "reserve"]);

  return items.filter((failedItem) => {
    if (
      failedItem.subject === undefined ||
      failedItem.subject === "" ||
      failedItem.slot === undefined ||
      failedItem.slot === "" ||
      !routed.has(failedItem.routingOutcome ?? "")
    ) {
      return false;
    }

    const failedIndex = indexOf.get(failedItem);

    if (failedIndex === undefined) {
      return false;
    }

    return run.invocations.slice(failedIndex + 1).some((later) => {
      if (
        later.surface !== "cli" ||
        !later.launched ||
        later.subject !== failedItem.subject ||
        later.outcome !== "ok" ||
        (later.validationOutcome !== undefined &&
          later.validationOutcome !== "ok")
      ) {
        return false;
      }

      const retried =
        later.slot === failedItem.slot &&
        failedItem.attempt !== undefined &&
        later.attempt !== undefined &&
        later.attempt > failedItem.attempt;

      const reserved =
        later.slot !== undefined &&
        later.slot !== failedItem.slot &&
        later.targetSlot === failedItem.slot;

      return retried || reserved;
    });
  }).length;
};

const h1Failures = (
  run: RunFacts,
  cli: readonly InvocationFacts[],
  add: AddFinding,
  formatDuration: (ms: number | undefined) => string
) => {
  const cliIndex = new Map(cli.map((row, index) => [row, index] as const));

  const failed = cli
    .filter(isFailure)
    .filter((row) => !recoveredByResume(row, cli, cliIndex));

  const count = (key: (i: InvocationFacts) => string) => {
    const m = new Map<string, number>();

    for (const i of failed) {
      m.set(key(i), (m.get(key(i)) ?? 0) + 1);
    }

    return m;
  };

  const bySlot = count((i) => `${i.subject ?? i.phase}|${i.slot ?? ""}`);
  const byProvider = count((i) => i.provider);

  const wasted = failed.filter(
    (i) =>
      (i.slot !== undefined &&
        (bySlot.get(`${i.subject ?? i.phase}|${i.slot}`) ?? 0) >= 2) ||
      (byProvider.get(i.provider) ?? 0) >= 2
  );

  for (const [cls, items] of groups(wasted, failureClass)) {
    const [component, fix] = FAILURE_FIXES[cls] ?? DEFAULT_FIX;
    const spent = sum(items.map((i) => i.durationMs));
    const quota = cls === "quota";

    const attempts = tally(
      items.map((i) => (quota ? `${i.provider}/${i.model}` : i.provider))
    );

    const recovery = quota
      ? `, ${quotaRecoveries(items, run)} recovered by fallback`
      : "";

    add(
      "H1",
      "correctness",
      component,
      `\`${cls}\`: ${items.length} of ${plural(cli.length, "CLI attempt")} failed (${attempts})${recovery}${spent === undefined ? "" : `, ${formatDuration(spent)} of driver time`}.`,
      "Failed attempts delay the wave and trigger retries or cascade launches.",
      fix
    );
  }
};

const convergenceDetail = (
  run: RunFacts,
  key: string,
  rounds: number,
  reraised: readonly string[],
  escalation: Escalation | undefined,
  cap: number | undefined
) => {
  // NOTE: a deadlock in the cap round without re-raised findings is the cap-ending refresh label; past the cap it marks designed continuation, so its fix must not raise the cap.
  const capReached =
    cap !== undefined &&
    escalation?.kind === "deadlock" &&
    rounds === cap &&
    !reraised.length;

  const pastCap =
    cap !== undefined &&
    rounds > cap &&
    (escalation
      ? escalation.kind === "deadlock" && !reraised.length
      : reraised.length > 0);

  const detail = [
    plural(rounds, "round"),
    ...(capReached ? [`cap reached (${cap})`] : []),
    ...(pastCap ? [`continued past the cap (${cap})`] : []),
    ...(reraised.length
      ? [
          `${plural(reraised.length, "finding")} re-raised across rounds${idList(reraised)}`,
        ]
      : []),
    ...(escalation && !capReached
      ? [`${escalation.kind} escalation${idList(escalation.ids)}`]
      : []),
  ];

  return {
    capReached,
    evidence: `${phaseName(run, key)}: ${detail.join("; ")}.`,
  };
};

const h2Reviews = (run: RunFacts, add: AddFinding) => {
  const T = DIAGNOSTIC_THRESHOLDS;

  for (const [key, rows] of groups(run.reviews, (r) => r.phase ?? "")) {
    const rounds = Math.max(...rows.map((r) => r.round));
    const reraised = [...new Set(rows.flatMap((r) => r.reraised ?? []))];

    const escalation = rows.findLast(
      (r) => r.escalation !== undefined
    )?.escalation;

    // Known-cap continuation is designed; only a run without a recorded cap uses the fixed threshold.
    const cap = rows.findLast((r) => r.cap !== undefined)?.cap;

    const fallback = cap === undefined && rounds >= T.reviewRounds;

    if (!fallback && !reraised.length && !escalation) {
      continue;
    }

    const { capReached, evidence } = convergenceDetail(
      run,
      key,
      rounds,
      reraised,
      escalation,
      cap
    );

    add(
      "H2",
      "review-convergence",
      "references/review-rules.md",
      evidence,
      "Each extra round adds voice launches and a host ruling turn.",
      capReached
        ? "Follow the step-back procedure: record a step-back outcome, rewrite the churning units or re-author the artifact, or narrow scope."
        : "Reject re-raised findings that cite no new code or requirement evidence by citing the earlier ruling."
    );
  }
};

const h3Rejections = (run: RunFacts, add: AddFinding) => {
  const T = DIAGNOSTIC_THRESHOLDS;

  for (const r of run.reviews) {
    const all = r.accepted + r.rejected;

    if (all < T.minSamples || r.rejected / all <= T.rejectedShare) {
      continue;
    }

    add(
      "H3",
      "review-convergence",
      "references/templates/review-prompt.md",
      `${phaseName(run, r.phase)} round ${r.round}: ${r.rejected} of ${plural(all, "finding")} rejected (${pct(r.rejected / all)}).`,
      "Rejected findings cost reviewer tokens and host ruling time without changing the artifact.",
      "Read the rejection rulings; where reviewers misread scope or criteria, state that boundary in the artifact the prompt cites."
    );
  }
};

const h4ProviderCache = (
  run: RunFacts,
  metered: readonly MeteredInvocation[],
  add: AddFinding
) => {
  const T = DIAGNOSTIC_THRESHOLDS;

  for (const [provider, items] of groups(metered, (i) => i.provider)) {
    const reporting = items.filter((i) => i.usage.cacheRead !== undefined);

    const {
      cacheRead,
      total: input,
      share,
    } = cacheReadMetrics(reporting.map((i) => i.usage));

    if (!reporting.length || share === undefined || share >= T.cacheReadShare) {
      continue;
    }

    add(
      "H4",
      "token-economy",
      "scripts/toolkit/domain/prompt.ts",
      `${provider}: cache read ${pct(share)} of input (${num(cacheRead)} of ${num(input)} tokens) across ${plural(reporting.length, "invocation")}.`,
      "Uncached input is billed and processed in full on every launch.",
      "Put stable content (rules, templates, shared context) before per-voice and per-round content so provider prompt caches hit."
    );
  }
};

const h10HostCache = (run: RunFacts, add: AddFinding) => {
  const T = DIAGNOSTIC_THRESHOLDS;

  for (const [role, rows] of groups(run.hostUsage?.rows ?? [], (r) => r.role)) {
    const reporting = rows.filter((r) => r.cacheRead !== undefined);
    const { cacheRead, total, share } = cacheReadMetrics(reporting);

    if (
      !reporting.length ||
      total < T.minCacheTokens ||
      share === undefined ||
      share >= T.cacheReadShare
    ) {
      continue;
    }

    const platform = run.hostUsage?.platform ?? "host";

    add(
      "H10",
      "token-economy",
      "SKILL.md",
      `${platform} ${role}: cache-read share of non-write input ${pct(share)} (${num(cacheRead)} of ${num(total)} tokens).`,
      "Low prompt-cache reuse forces the host or subagents to reprocess stable context at full input rates.",
      "Keep stable repository context and skill rules ahead of changing task state to preserve prompt-cache prefixes."
    );
  }
};

const stageOfName = (run: RunFacts, i: InvocationFacts) => {
  const phase = run.phases.find((p) => p.key === i.phase)?.name;

  return phase === "integration review" ? "code review" : (phase ?? DASH);
};

const hostStageOk = (run: RunFacts, hRows: readonly HostRow[]) =>
  !run.hostUsage?.unavailable &&
  (hRows.length === 0
    ? !Object.keys(run.hostUsage?.notes?.host ?? {}).length
    : hRows.every(
        (r) =>
          r.turns !== undefined &&
          !Object.keys(run.hostUsage?.notes?.[r.role] ?? {}).length &&
          !Object.keys(run.hostUsage?.notes?.host ?? {}).length
      ));

const delegateStageOk = (dRows: readonly InvocationFacts[]) =>
  dRows.every(
    (i) =>
      i.usageSource === "session" &&
      i.coverage?.includes("transcript unavailable") !== true &&
      i.usage?.turns !== undefined
  );

const h11StageChurn = (
  run: RunFacts,
  cli: readonly InvocationFacts[],
  add: AddFinding
) => {
  const T = DIAGNOSTIC_THRESHOLDS;

  const hostRowsByStage = groups(
    (run.hostUsage?.rows ?? []).filter((r) => NON_REVIEW_STAGES.has(r.stage)),
    (r) => r.stage
  );

  const cliByStage = groups(
    cli.filter((i) => NON_REVIEW_STAGES.has(stageOfName(run, i))),
    (i) => stageOfName(run, i)
  );

  for (const stage of new Set([
    ...hostRowsByStage.keys(),
    ...cliByStage.keys(),
  ])) {
    const hRows = hostRowsByStage.get(stage) ?? [];
    const dRows = cliByStage.get(stage) ?? [];

    if (!hostStageOk(run, hRows) || !delegateStageOk(dRows)) {
      continue;
    }

    const turns =
      (sum(hRows.map((r) => r.turns)) ?? 0) +
      (sum(dRows.map((i) => i.usage?.turns)) ?? 0);

    if (turns < T.stageTurnChurn) {
      continue;
    }

    add(
      "H11",
      "token-economy",
      "SKILL.md",
      `${stage}: ${plural(turns, "LLM turn")} across host, subagents, and session-measured delegates.`,
      "High turn counts in one non-review stage multiply repeated context tokens and latency.",
      "Split broad tasks into smaller increments or tighten explorer/writer scope before launching."
    );
  }

  for (const [agent, items] of groups(
    (run.hostUsage?.responses ?? []).filter(
      (r) => NON_REVIEW_STAGES.has(r.stage) && r.agent !== undefined
    ),
    (r) => defined(r.agent)
  )) {
    const complete =
      !run.hostUsage?.unavailable &&
      items.every(
        (r) =>
          r.coverage === "complete" &&
          r.observed !== undefined &&
          !Object.keys(run.hostUsage?.notes?.[r.role] ?? {}).length &&
          !Object.keys(run.hostUsage?.notes?.host ?? {}).length
      );

    if (!complete) {
      continue;
    }

    const turns = sum(items.map((r) => r.observed)) ?? 0;

    if (turns < T.singleAgentTurnChurn) {
      continue;
    }

    add(
      "H11",
      "token-economy",
      "SKILL.md",
      `${agent} (${defined(items[0]).role}): ${plural(turns, "LLM turn")} across non-review stages.`,
      "One agent accumulated excessive round-trips, multiplying repeated input tokens.",
      "Tighten the agent brief and turn budget, or delegate focused sub-tasks."
    );
  }
};

const h5DominantInvocation = (
  run: RunFacts,
  metered: readonly MeteredInvocation[],
  add: AddFinding
) => {
  const T = DIAGNOSTIC_THRESHOLDS;

  // Cache reads are cheap and dominate long sessions, so rank launches by uncached tokens; zero-usage failures are not samples.
  const sizes = metered.flatMap((i) => {
    const value = uncached(i.usage);

    return value > 0 ? [[i, value] as const] : [];
  });

  if (sizes.length < T.minSamples) {
    return;
  }

  const all = sum(sizes.map(([, n]) => n)) ?? 0;
  let [top, n] = defined(sizes[0]);

  for (const [candidate, value] of sizes.slice(1)) {
    if (value > n) {
      top = candidate;
      n = value;
    }
  }

  // Above an even share (2/n) the largest invocation stands out; at small n, even shares already reach half.
  if (!all || n / all <= Math.max(T.invocationShare, 2 / sizes.length)) {
    return;
  }

  add(
    "H5",
    "token-economy",
    "scripts/toolkit/prompts.ts",
    `${top.provider} ${top.model} in ${phaseName(run, top.phase)}: ${num(n)} of ${num(all)} measured uncached tokens (${pct(n / all)}).`,
    "One invocation dominates token spend; its own repository exploration likely drives most of it.",
    "Lower that slot's turn budget or effort, or assign it a cheaper model."
  );
};

const h8RejectedTools = (run: RunFacts, add: AddFinding) => {
  const repeated = [...groups(run.rejectedTools ?? [], rejection).values()]
    .filter((items) => items.length >= 2)
    .flat();

  for (const [component, items] of groups(
    repeated,
    (item) =>
      `scripts/toolkit/${TOOL_MODULES[`${item.tool} ${item.action}`] ?? "cli"}.ts`
  )) {
    add(
      "H8",
      "correctness",
      component,
      `${plural(items.length, "toolkit operation")} rejected (${tally(items.map(rejection))}).`,
      "Rejected operations can require another host turn.",
      "Return the allowed input shape and current preconditions with the rejection."
    );
  }
};

const h9Relaunches = (run: RunFacts, add: AddFinding) => {
  // One relaunch without a recorded cause is not a pattern.
  const relaunches = run.relaunches ?? 0;

  if (relaunches < 2) {
    return;
  }

  add(
    "H9",
    "correctness",
    "scripts/toolkit/brief.ts",
    `${plural(relaunches, "writer relaunch")}; rework evidence, cause unavailable.`,
    "Additional launches repeat context and may repeat verification.",
    "Read the writer launch reports at `.state/briefs/<task>-<launch>.report.md` for the relaunch cause."
  );
};

/** Deterministic findings (H1–H5, H8, H9) for one run, in severity order. */
export const selectFindings = (
  run: RunFacts,
  formatDuration: (ms: number | undefined) => string
) => {
  const out: Finding[] = [];

  const add: AddFinding = (
    source,
    category,
    component,
    evidence,
    impact,
    proposedFix
  ) => {
    out.push({ source, category, component, evidence, impact, proposedFix });
  };

  // Quota-store skips never launch, so they cost no driver time and are not attempts.
  const cli = run.invocations.filter((i) => i.surface === "cli" && i.launched);
  const metered = run.invocations.filter(isMetered);

  h1Failures(run, cli, add, formatDuration);
  h2Reviews(run, add);
  h3Rejections(run, add);
  h4ProviderCache(run, metered, add);
  h10HostCache(run, add);
  h11StageChurn(run, cli, add);
  h5DominantInvocation(run, metered, add);
  h8RejectedTools(run, add);
  h9Relaunches(run, add);

  return bySeverity(out);
};
