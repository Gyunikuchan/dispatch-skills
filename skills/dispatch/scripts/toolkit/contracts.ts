import { SESSION_ACTIONS } from '../lib/cli.ts';
import { recordSchemas } from './records.ts';

export const CALL_TABLE_MAX_BYTES = 12_288;

export type ActionContract = {
  readonly arguments: string;
};

export type SessionAction = (typeof SESSION_ACTIONS)[number];

export const CALL_TABLE_INTRO: readonly string[] = [
  'Dispatched agents run no toolkit commands, except a subagent assigned a map may run `lint run` on that map only, without `--edit`. Briefs and descriptors return `model`, `effort` and `launchAs` for native launches. Initialize the session before calling tools. Resolve artifact paths from the repository root; resolve record and question files from the current directory.',
  'Stdout is `{ok, summary, path, reason?}` (optional advisory `hint` <=240 B on `ok: true`): `summary` <=1024 B, `path` is a session JSON file (null on usage/write failure). Itemized summaries show counts, `first <k>:` (<=5), `+<n> more in result`. Exit: 0 returned, 1 usage/invalid input, 2 fault, 3 held lock, 4 gate refusal or `native-pending`.',
  'Use `node <skills-dir>/dispatch/scripts/dispatch.ts help <heading words...>` (no session, raw text, exit 0). Unknown/empty headings refuse `usage` with valid headings; unreadable `references/toolkit.md` refuses `fault`, exit 2. Refusals may add `help` (next heading); `native-pending` and `ok:true` omit it.',
  'In the table, `\\|` separates alternatives and `?` marks optional record fields. `<...|->` reads a UTF-8 file or stdin (`-`, BOM ignored; on Windows PowerShell 5.1 set `$OutputEncoding = [Text.Encoding]::UTF8` or use a file for non-ASCII); prefer `-` or file over inline flags above 4,096 bytes. `ledger append <record.json|-> --session <session>` reads an object or array; `help <kind>` gives field rules.',
];

export const ACTION_CONTRACTS: Readonly<Record<string, ActionContract>> = {
  'ask run': { arguments: "ask run [<question-file|->] [--text <text>] --session <session> --host <platform> [--level <level>] [--pins <pins>] [--native-failed '<attempt>=<reason>' ...]" },
  'review run': { arguments: "review run <target> --session <session> --host <platform> [--kind plan|design|code] [--spec <path>] [--level <level>] [--pins <pins>] [--native-failed '<attempt>=<reason>' ...]" },
  'report render': { arguments: 'report render --session <session>' },
  'report complete': { arguments: 'report complete --session <session>' },
  'brief render': { arguments: 'brief render <task> --session <session> --host <platform>' },
  'brief explorer': { arguments: 'brief explorer [<values.json|->] [--json <json>] --session <session> --host <platform>' },
  'brief fix-check': { arguments: 'brief fix-check <artifact> --session <session> --host <platform>' },
  'brief test-cleanup': { arguments: 'brief test-cleanup [<values.json|->] [--json <json>] [--base <ref> --integration-path <path>] --session <session> --host <platform>' },
  'worktree integrate': { arguments: 'worktree integrate <task> --session <session> [--ack-stale <rationale>]' },
  'worktree continue': { arguments: 'worktree continue <task> --session <session>' },
  'worktree commit': { arguments: 'worktree commit --session <session> --reason <reason> [--review-fix <json-file|-> | --review-fix-json <json> | --test-cleanup <json-file|-> | --test-cleanup-json <json>]' },
  'worktree abort': { arguments: 'worktree abort <task> --session <session> --reason <reason>' },
  'worktree deliver': { arguments: 'worktree deliver --session <session> [--commit <message-file|-> | --message <text>]' },
  'worktree close': { arguments: 'worktree close --session <session> --reason <reason>' },
  'worktree cleanup': { arguments: 'worktree cleanup --session <session>' },
  'worktree create': { arguments: 'worktree create <task> --session <session> [--relaunch]' },
  'worktree submit': { arguments: 'worktree submit <task> --session <session>' },
  'worktree abandon': { arguments: 'worktree abandon <task> --session <session> --reason <reason>' },
  'check run': { arguments: 'check run --session <session> [--criteria SC1,SC2,contract | --task T<n>]' },
  'brief verifier': { arguments: 'brief verifier [<values.json|->] [--json <json>] --session <session> --host <platform>' },
  'ledger append': { arguments: 'ledger append <record.json|-> --session <session>' },
  'ledger query': { arguments: 'ledger query --session <session> [--kind <kind>] [--key <key>] [--since <seq>]' },
  'doctor run': { arguments: 'doctor run --session <session> --host <platform> [--level <level>]' },
  'status show': { arguments: 'status show --session <session>' },
  'lint run': { arguments: 'lint run <artifact> --session <session> [--edit <fields.json|-> | --json <json>]' },
  'diagnostics render': { arguments: 'diagnostics render --session <session>' },
};

export const SESSION_CONTRACTS: Readonly<Record<SessionAction, ActionContract>> = {
  init: { arguments: 'session init --objective "<objective>" --host <platform> [--session-id <id>]' },
  reactivate: { arguments: 'session reactivate --session-dir <session> --host <platform>' },
  'quota-reprobe': { arguments: 'session quota-reprobe --session-dir <session> --provider <id> --mode <mode> [--model <alias>]' },
};

const escapePipes = (text: string) => text.replaceAll('|', '\\|');
const formatFields = (required: readonly string[], optional: readonly string[]) =>
  [...required, ...optional.map((field) => `${field}?`)].join(', ');

/** Renders the bounded `### call table` help section from canonical action, record, and session contracts. */
export function renderCallTable(): string {
  const rows: string[] = [
    '| Type | Heading | Arguments |',
    '| --- | --- | --- |',
    ...Object.entries(ACTION_CONTRACTS).map(([heading, contract]) => `| action | ${heading} | \`${escapePipes(contract.arguments)}\` |`),
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
