import type { ProviderKey } from "../platform.ts";
import { agy } from "./agy.ts";
import { claudeCode } from "./claude.ts";
import { codex } from "./codex.ts";
import { copilot } from "./copilot.ts";
import { opencode } from "./opencode.ts";
import type { HostUsageAdapter } from "./rows.ts";

export const USAGE_ADAPTERS: Readonly<Record<ProviderKey, HostUsageAdapter>> = {
  agy,
  claude: claudeCode,
  codex,
  copilot,
  opencode,
};
