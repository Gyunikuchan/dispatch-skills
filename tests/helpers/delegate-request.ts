import type { DelegateRequest } from "../../skills/dispatch/scripts/providers/types.ts";

/** A complete request around the fields a test cares about; the others are inert placeholders. */
export const delegateRequest = (
  overrides: Pick<DelegateRequest, "logPath"> & Partial<DelegateRequest>
) => ({
  promptPath: "",
  model: null,
  effort: null,
  sandbox: false,
  schemaPath: null,
  resume: null,
  cwd: "",
  timeoutMs: 0,
  outputCapBytes: 0,
  attachments: [],
  briefPath: "",
  ...overrides,
});
