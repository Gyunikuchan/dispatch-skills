import fs from 'node:fs';
import path from 'node:path';
import type { HandlerContext, HandlerResult } from './cli.ts';
import { currentSnapshot, gate, latest, withLedger } from './ledger.ts';
import { parsePlan, selectTaskBrief } from './domain/plan.ts';
import { checks } from './plan-view.ts';
import { launches } from './writers.ts';
import { ToolError } from './output.ts';

function taskParts(source: string, selected: NonNullable<ReturnType<typeof selectTaskBrief>>) {
  const lines = source.split(/\r?\n/);
  const taskEnd = lines.findIndex((line, i) => i >= selected.task.line && /^#{2,3} /.test(line));
  const section = lines.slice(selected.task.line - 1, taskEnd < 0 ? undefined : taskEnd).join('\n').trim();
  const criteria = selected.criteria.map(criterion => {
    const end = lines.findIndex((line, i) => i >= criterion.line && (/^## /.test(line) || /^- \[SC\d+\]/.test(line)));
    return lines.slice(criterion.line - 1, end < 0 ? undefined : end).join('\n').trim();
  }).join('\n\n');
  return {section, criteria};
}

export function taskMarkdown(source: string, brief: NonNullable<ReturnType<typeof selectTaskBrief>>): string {
  const {section, criteria} = taskParts(source, brief);
  return [section, criteria].filter(Boolean).join('\n\n');
}

export async function renderBrief(ctx: HandlerContext): Promise<HandlerResult> {
  if (ctx.args.length !== 1) throw new ToolError(1, 'invalid-input', 'One task ID is required');
  const task = ctx.args[0]!;
  const gated = await withLedger(ctx.session, 'brief render', ctx.deps, async tx => {
    const bind = latest(tx.fold, 'bind');
    const snapshot = currentSnapshot(ctx.manifest.repositoryRoot, bind);
    const decision = gate(tx.fold, snapshot.hashes);
    if (!decision.allowed) throw new ToolError(4, decision.reason!, decision.reason!);
    const source = snapshot.bytes.plan;
    if (!bind || source == null || snapshot.bytes.spec == null) throw new ToolError(4, 'lint-errors', 'Bound spec and plan must be readable');
    const parsed = parsePlan(source);
    if (!parsed.ok) throw new ToolError(4, 'lint-errors', JSON.stringify(parsed.defects));
    const selected = selectTaskBrief(parsed.plan, task);
    if (!selected) throw new ToolError(1, 'invalid-input', 'Unknown task ' + task);
    const launch = launches(tx.fold, task).at(-1);
    if (!launch || launch.finished || launch.abandoned || launch.superseded) throw new ToolError(4, 'no-open-launch', 'No open launch for ' + task);
    await ctx.deps.hook?.('brief:after-gate');
    return {bind, snapshot, launch, source, parsed, selected};
  });
  const {bind, snapshot, launch, source, parsed, selected} = gated;
  const markdown = taskMarkdown(source, selected);
  const {section} = taskParts(source, selected);
  const criteria = markdown.slice(section.length).trim();
  const templates = path.join(ctx.deps.skillRoot, 'references', 'templates');
  const bar = fs.readFileSync(path.join(templates, 'quality-bar.md'), 'utf8');
  const quality = ['shared', 'code'].map(name => {
    const body = new RegExp('^## ' + name + '\\r?\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))', 'm').exec(bar)?.[1]?.trim();
    if (!body) throw new Error('Missing quality section ' + name);
    // The toolkit has no legacy transport protocol.
    return name === 'shared' ? body.replace('the outcome envelope and verification protocol', 'verification requirements') : body;
  }).join('\n\n');
  const slots: Record<string, string> = {
    task, worktree: path.resolve(ctx.session, launch.record.data['path']),
    specPath: bind.data['spec'], specHash: snapshot.hashes.spec!,
    planPath: bind.data['plan'], planHash: snapshot.hashes.plan!,
    design: bind.data['design'] ? 'Governing design: `' + bind.data['design'] + '` (' + snapshot.hashes.design + ').' : '',
    shared: parsed.plan.sharedContext, section, criteria, quality,
    contracts: checks(parsed.plan).find(check => check.criterion === 'contract')!.commands.map(command => '- `' + command + '`').join('\n'),
  };
  const text = fs.readFileSync(path.join(templates, 'writer-brief.md'), 'utf8').replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    if (!Object.hasOwn(slots, name)) throw new Error('Unknown writer brief slot ' + name);
    return slots[name]!;
  });
  const directory = path.join(ctx.session, '.state', 'briefs');
  fs.mkdirSync(directory, {recursive: true});
  const file = path.join(directory, task + '-' + launch.launch + '.md');
  fs.writeFileSync(file, text);
  const value = {path: file, task, launch: launch.launch, bytes: Buffer.byteLength(text)};
  return {ok: true, exit: 0, value, summary: task + ' launch ' + launch.launch + ': ' + file + ' (' + value.bytes + ' bytes)'};
}
