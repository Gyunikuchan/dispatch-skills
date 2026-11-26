// Pure diagnostics retrospective: toolkit facts in, a severity-ordered, shareable Markdown report out.
// The caller supplies captured facts; diagnostics does not read session state.
export {
  normalizeUsage,
  retroObservations,
  sanitizeFacts,
} from "./diagnostics-gates.ts";

export {
  billedTokens,
  costCoverage,
  efficiencyOf,
  formatDuration,
  heuristics,
  renderDiagnostics,
  unitsOf,
} from "./diagnostics-render.ts";

export {
  addYield,
  CATEGORIES,
  COMPONENTS,
  DIAGNOSTIC_LIMITS,
} from "./diagnostics-types.ts";

export type {
  DiagnosticEvent,
  Finding,
  InvocationFacts,
  Phase,
  ReviewFacts,
  RoundWorkload,
  RunFacts,
  SlotYieldFacts,
  Usage,
} from "./diagnostics-types.ts";
