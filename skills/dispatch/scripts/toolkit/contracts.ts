import { SESSION_ACTIONS } from '../lib/cli.ts';
import { recordSchemas } from './records.ts';

export const CALL_TABLE_MAX_BYTES = 12_288;

export type ActionContract = {
  readonly arguments: string;
};

export type SessionAction = (typeof SESSION_ACTIONS)[number];

export const CALL_TABLE_INTRO: readonly string[] = [
  'A subagent assigned a map may run `lint run` on that map only, without `--edit`. The host runs other tools. Native fields: `model`, `effort`, `launchAs`. Initialize first. Paths: artifact from repo root, record/question from cwd.',
  'Stdout is `{ok, summary, path, reason?}` (advisory `hint` <=240 B on `ok: true`); `summary` <=1024 B; `path` is session JSON or null on usage/write failure. Items: counts, `first <k>:` (<=5), `+<n> more in result`. Exit: 0 returned, 1 invalid input/usage, 2 fault, 3 lock held, 4 gate or `native-pending`.',
  '`node <skills-dir>/dispatch/scripts/dispatch.ts help <heading words...>` returns raw text, exit 0, without a session. Unknown/empty headings return `usage` and valid headings. Unreadable help returns `fault` (2). Refusals may include `help` (next heading), except `native-pending`.',
  'In the table, `\\|` separates alternatives and `?` marks optional record fields. `<...|->` reads a UTF-8 file or stdin (`-`, BOM ignored; on Windows PowerShell 5.1 set `$OutputEncoding = [Text.Encoding]::UTF8` or use a file for non-ASCII); prefer `-` or file over inline flags above 4,096 bytes. `ledger append <record.json|-> --session <session>` reads an object or array. `--cleanup` needs stdin. `help <kind>` lists fields.',
];

export const ACTION_CONTRACTS: Readonly<Record<string, ActionContract>> = {
  'ask run': {
    arguments:
      "ask run [<question-file|->|--text <text>] --session <session> --host <platform> [--level <level>] [--pins <pins>] [--native-failed '<attempt>=<reason>' ...]",
  },
  'review run': {
    arguments:
      "review run <target> --session <session> --host <platform> [--kind plan|design|code] [--spec <path>] [--level <level>] [--pins <pins>] [--native-failed '<attempt>=<reason>' ...] [--resume-ref <ref>]",
  },
  'report render': { arguments: 'report render --session <session>' },
  'report complete': { arguments: 'report complete --session <session>' },
  'brief render': { arguments: 'brief render <task> --session <session> --host <platform>' },
  'brief explorer': {
    arguments: 'brief explorer [<values.json|->] [--json <json>] --session <session> --host <platform>',
  },
  'brief fix-review-lite': { arguments: 'brief fix-review-lite <artifact> --session <session> --host <platform>' },
  'brief test-cleanup': {
    arguments:
      'brief test-cleanup [<values.json|->] [--json <json>] [--base <ref> --integration-path <path>] --session <session> --host <platform>',
  },
  'worktree integrate': { arguments: 'worktree integrate <task> --session <session> [--ack-stale <rationale>]' },
  'worktree continue': { arguments: 'worktree continue <task> --session <session>' },
  'worktree commit': {
    arguments:
      'worktree commit --session <session> --reason <reason> [--review-fix <json-file|-> | --review-fix-json <json> | --test-cleanup <json-file|-> | --test-cleanup-json <json>]',
  },
  'worktree abort': { arguments: 'worktree abort <task> --session <session> --reason <reason>' },
  'worktree deliver': {
    arguments: 'worktree deliver --session <session> [--commit <message-file|-> | --message <text>]',
  },
  'worktree close': { arguments: 'worktree close --session <session> --reason <reason>' },
  'worktree cleanup': { arguments: 'worktree cleanup --session <session>' },
  'worktree create': { arguments: 'worktree create <task> --session <session> [--relaunch]' },
  'worktree submit': { arguments: 'worktree submit <task> --session <session>' },
  'worktree abandon': { arguments: 'worktree abandon <task> --session <session> --reason <reason>' },
  'check run': {
    arguments: 'check run --session <session> [--criteria SC1,SC2,contract | --task T<n>] [--reuse | --fresh]',
  },
  'brief verifier': {
    arguments: 'brief verifier [<values.json|->] [--json <json>] --session <session> --host <platform>',
  },
  'ledger append': {
    arguments:
      'ledger append <record.json|-> --session <session> | ledger append - --cleanup <skip|zero> --session <session>',
  },
  'ledger query': { arguments: 'ledger query --session <session> [--kind <kind>] [--key <key>] [--since <seq>]' },
  'doctor run': { arguments: 'doctor run --session <session> --host <platform> [--level <level>] [--probe]' },
  'status show': { arguments: 'status show --session <session> [--resume]' },
  'lint run': { arguments: 'lint run <artifact> --session <session> [--edit <fields.json|-> | --json <json>]' },
  'diagnostics render': { arguments: 'diagnostics render --session <session>' },
};

// The action grammar governs both generated help and CLI flag registration.
function actionFlags(contracts: Readonly<Record<string, ActionContract>>): ReadonlyMap<string, readonly string[]> {
  const result = new Map<string, string[]>();
  for (const [action, contract] of Object.entries(contracts)) {
    const flags = new Set(Array.from(contract.arguments.matchAll(/--([a-z][a-z-]*)\b/g), (match) => match[1]!));
    for (const flag of flags) {
      const actions = result.get(flag) ?? [];
      actions.push(action);
      result.set(flag, actions);
    }
  }
  return result;
}

export const ACTION_FLAGS = actionFlags(ACTION_CONTRACTS);

export const SESSION_CONTRACTS: Readonly<Record<SessionAction, ActionContract>> = {
  init: { arguments: 'session init --objective "<objective>" --host <platform> [--session-id <id>]' },
  reactivate: { arguments: 'session reactivate --session-dir <session> --host <platform>' },
  'quota-reprobe': {
    arguments: 'session quota-reprobe --session-dir <session> --provider <id> --mode <mode> [--model <alias>]',
  },
};

const escapePipes = (text: string) => text.replaceAll('|', '\\|');
const formatFields = (required: readonly string[], optional: readonly string[]) =>
  [...required, ...optional.map((field) => `${field}?`)].join(', ');

/** Renders the bounded `### call table` help section from canonical action, record, and session contracts. */
export function renderCallTable(): string {
  const rows: string[] = [
    '| Type | Heading | Arguments |',
    '| --- | --- | --- |',
    ...Object.entries(ACTION_CONTRACTS).map(
      ([heading, contract]) => `| action | ${heading} | \`${escapePipes(contract.arguments)}\` |`,
    ),
  ];
  for (const schema of recordSchemas()) {
    if (!schema.phased) {
      rows.push(`| record | ${schema.kind} | ${formatFields(schema.required, schema.optional)} |`);
    } else {
      for (const phase of schema.phases) {
        rows.push(`| record | ${schema.kind} (${phase.phase}) | ${formatFields(phase.required, phase.optional)} |`);
      }
    }
  }
  for (const action of SESSION_ACTIONS) {
    rows.push(`| session | session ${action} | \`${escapePipes(SESSION_CONTRACTS[action].arguments)}\` |`);
  }
  return ['### call table', '', ...CALL_TABLE_INTRO.flatMap((line) => [line, '']), ...rows].join('\n').trimEnd() + '\n';
}

export const GENERATED_MARKER = /<!-- (END )?GENERATED: ([^\s<>]+) -->/g;
const HELP_MARKER = new RegExp(`^${GENERATED_MARKER.source}(?:\\r?\\n|$)|${GENERATED_MARKER.source}`, 'gm');

/** Removes generated delimiters from help while preserving surrounding bytes. */
export function stripGeneratedMarkers(markdown: string): string {
  return markdown.replace(HELP_MARKER, '');
}
