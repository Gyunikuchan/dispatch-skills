// Pure tracked-file plan; executing it is an explicit I09 operation.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
export type Operation = { kind: 'remove'; path: string } | { kind: 'move'; from: string; to: string };
const SKILLS = ['dispatch', 'dispatch-code-review', 'dispatch-design-review', 'dispatch-plan-review', 'dispatch-implement'];
const safe = (file: string): boolean => !file.startsWith('/') && !file.includes('\\') && !file.split('/').some((part) => part === '..' || part === '.' || !part) && !/^[a-z]:/i.test(file);
function legacy(file: string): boolean {
  return SKILLS.some((name) => file.startsWith(`skills/${name}/`)) || file.startsWith('tests/') || /^scripts\/[^/]+\.mjs$/.test(file) || file === 'tsconfig.json' || ['docs/dispatch-notes.md', 'docs/dispatch-implement-notes.md'].includes(file);
}
export function planCutover(tracked: readonly string[], exists: (destination: string) => boolean): Operation[] {
  if (tracked.some((file) => !safe(file))) throw new Error('Unsafe tracked path');
  const known = new Set(tracked), destinations = new Set<string>();
  const moves: Extract<Operation, { kind: 'move' }>[] = tracked.filter((file) => file.startsWith('next/') && file !== 'next/scripts/cutover.ts').sort().map((from) => {
    const to = from.slice(5).replace(/\/SKILL\.next\.md$/, '/SKILL.md');
    if (!(legacy(to) || /^scripts\/[^/]+\.ts$/.test(to))) throw new Error(`Overlay path outside designated cutover trees: ${from}`);
    if (destinations.has(to)) throw new Error(`Duplicate destination ${to}`); destinations.add(to);
    if (exists(to) && (!known.has(to) || !legacy(to))) throw new Error(`Existing untracked or unrelated destination: ${to}`);
    return { kind: 'move', from, to };
  });
  return [...tracked.filter((file) => legacy(file) && !file.startsWith('next/')).sort().map((file): Operation => ({ kind: 'remove', path: file })), ...moves];
}
export function cutoverCli(argv: readonly string[]): void {
  const args = [...argv];
  if (args.length !== 1 || !['--dry-run', '--execute'].includes(args[0]!)) throw new Error('Use --dry-run or --execute');
  if (['DISPATCH_IMPLEMENTATION_RUN', 'DISPATCH_LEGACY_SESSION', 'DISPATCH_STATE_FILE', 'DISPATCH_SESSION_DIR', 'DISPATCH_RUN_ID'].some((key) => process.env[key])) throw new Error('Cutover requires an ordinary I09 session outside an implementation driver');
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const plan = planCutover(tracked, (file) => fs.existsSync(path.join(root, file)));
  if (args[0] === '--dry-run') { process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`); return; }
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim()) throw new Error('Tracked checkout must be clean before execute');
  for (const op of plan) {
    if (op.kind === 'remove') execFileSync('git', ['rm', '--', op.path], { cwd: root });
    else { fs.mkdirSync(path.dirname(path.join(root, op.to)), { recursive: true }); execFileSync('git', ['mv', '--', op.from, op.to], { cwd: root }); }
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) { try { cutoverCli(process.argv.slice(2)); } catch (error) { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; } }
