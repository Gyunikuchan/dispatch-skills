export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export const SESSION_ACTIONS = ["init", "reactivate", "quota-reprobe"] as const;

const FLAGS = new Set([
  "objective",
  "session-dir",
  "session-id",
  "provider",
  "model",
  "mode",
  "host",
]);

export interface ParsedCommand {
  action: string;
  flags: Record<string, string>;
}

const need = (flags: Record<string, string>, name: string) => {
  if (typeof flags[name] !== "string") {
    throw new UsageError(`--${name} is required`);
  }
};

const validateQuotaReprobe = (
  out: ParsedCommand,
  positional: boolean,
  quotaFlags: readonly string[]
) => {
  need(out.flags, "provider");
  need(out.flags, "mode");

  if (
    positional ||
    ["objective", "session-id", "host"].some(
      (name) => out.flags[name] !== undefined
    )
  ) {
    throw new UsageError(
      "quota-reprobe accepts only session-dir, provider, model, and mode"
    );
  }

  for (const name of quotaFlags) {
    const value = out.flags[name];

    if (value !== undefined && value.trim() === "") {
      throw new UsageError(`--${name} requires a nonempty value`);
    }
  }
};

export const parseCommand = (argv: readonly string[]) => {
  const args = [...argv];
  const command = args.shift();

  if (command !== "session") {
    throw new UsageError("Expected session");
  }

  // SAFETY: `flags` starts empty and only string values are written below.
  const flags: Record<string, string> = {};

  const out: ParsedCommand = {
    action: args.shift() ?? "",
    flags,
  };

  // SAFETY: SESSION_ACTIONS is a string tuple, so it is assignable to readonly string[] for includes.
  if (!(SESSION_ACTIONS as readonly string[]).includes(out.action)) {
    throw new UsageError(
      `session requires ${SESSION_ACTIONS.slice(0, -1).join(
        ", "
      )}, or ${SESSION_ACTIONS.at(-1)}`
    );
  }

  let positional = false;

  for (let token = args.shift(); token !== undefined; token = args.shift()) {
    if (token === "--") {
      positional = true;
      break;
    }

    if (!token.startsWith("--")) {
      throw new UsageError(
        `Unexpected argument ${token}; use -- before the objective`
      );
    }

    const name = token.slice(2);

    if (!FLAGS.has(name) || Object.hasOwn(out.flags, name)) {
      throw new UsageError(`Invalid or repeated flag ${token} for ${command}`);
    }

    const value = args.shift();

    if (value === undefined || value === "" || value.startsWith("--")) {
      throw new UsageError(`${token} requires a value`);
    }

    out.flags[name] = value;
  }

  if (command === "session") {
    if (out.action === "init") {
      need(out.flags, "objective");
    } else {
      need(out.flags, "session-dir");
    }

    if (out.action !== "quota-reprobe") {
      need(out.flags, "host");
    }

    const quotaFlags = ["provider", "model", "mode"];

    if (out.action === "quota-reprobe") {
      validateQuotaReprobe(out, positional, quotaFlags);
    } else if (quotaFlags.some((name) => out.flags[name] !== undefined)) {
      throw new UsageError("provider, model, and mode are for quota-reprobe");
    }
  }

  return out;
};
