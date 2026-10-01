// Leaf diagnostics over entrypoint-injected probes.
export type DoctorInput = { node: string; configPath: string | null; problems: readonly string[]; integrity: unknown; level: string; roster: unknown; phases: unknown; writers: unknown; probes: readonly { provider: string; mode: string; status: string; path: string | null; sandbox: boolean | null }[] };
export function doctorReport(input: DoctorInput): DoctorInput & { diagnostics: string[] } {
  const unsupported = new Set(input.probes.filter((row) => row.sandbox === false).map((row) => row.provider));
  return { ...input, diagnostics: [...input.problems, ...[...unsupported].map((provider) => `${provider}: sandbox-unsupported; set sandbox: false in config.local.jsonc`)] };
}
export function formatDoctor(input: ReturnType<typeof doctorReport>): string {
  return [`Node ${input.node}`, `Config ${input.configPath ?? 'missing'}`, `Level ${input.level}`, `Integrity ${JSON.stringify(input.integrity)}`,
    'Provider\tMode\tStatus\tSandbox\tPath', ...input.probes.map((row) => `${row.provider}\t${row.mode}\t${row.status}\t${row.sandbox === null ? 'n/a' : row.sandbox ? 'supported' : 'unsupported'}\t${row.path ?? '-'}`),
    `Roster ${JSON.stringify(input.roster)}`, `Phases ${JSON.stringify(input.phases)}`, `Write subagents ${JSON.stringify(input.writers)}`, ...input.diagnostics].join('\n');
}
