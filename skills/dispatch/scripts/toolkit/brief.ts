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

type SelectedTaskBrief = NonNullable<ReturnType<typeof selectTaskBrief>>;

// Base64url keeps plan commands and session paths opaque to cmd, PowerShell, and POSIX parsing.
const CAPTURE_BOOTSTRAP = [
  "const fs=require('node:fs');",
  "const path=require('node:path');",
  "const {spawnSync}=require('node:child_process');",
  "const data=JSON.parse(Buffer.from(process.argv[2],'base64url').toString('utf8'));",
  "fs.mkdirSync(data.logDir,{recursive:true});",
  "const stdoutPath=path.join(data.logDir,data.criterion+'.stdout');",
  "const stderrPath=path.join(data.logDir,data.criterion+'.stderr');",
  "let stdoutFd,stderrFd,result;",
  "try { stdoutFd=fs.openSync(stdoutPath,'w');stderrFd=fs.openSync(stderrPath,'w');try { result=spawnSync(data.command,{cwd:data.cwd,shell:true,stdio:['ignore',stdoutFd,stderrFd]}); } catch(error) { result={status:null,signal:null,error}; } }",
  "finally { try { if(stdoutFd!==undefined)fs.closeSync(stdoutFd); } finally { if(stderrFd!==undefined)fs.closeSync(stderrFd); } }",
  "const replay=(file,target)=>{const fd=fs.openSync(file,'r');try {const chunk=Buffer.alloc(65536);let size;while((size=fs.readSync(fd,chunk,0,chunk.length,null))>0){let offset=0;while(offset<size)offset+=fs.writeSync(target,chunk,offset,size-offset);}} finally {fs.closeSync(fd);}};",
  "fs.writeFileSync(path.join(data.logDir,data.criterion+'.exit'),JSON.stringify({status:result.status??null,signal:result.signal??null,error:result.error?String(result.error.message??result.error):null})+'\\n');",
  "replay(stdoutPath,1);replay(stderrPath,2);",
  "if(result.error)process.stderr.write(String(result.error.message??result.error));",
  "process.exitCode=result.status??1;",
].join('');

const CAPTURE_SHELL_META = new Set("!#$&()*;<>?[]\\^{|}~%".split('').concat(String.fromCharCode(96)));

function safeCapturePath(value: string): boolean {
  if (!value || value.trim() !== value || value.includes('\\') || path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.startsWith('~') ||
    path.posix.normalize(value) !== value || value.split('/').some(part => !part || part === '.' || part === '..') ||
    /[\x00-\x1f\x7f]/.test(value) || value.includes('"') || value.includes("'") ||
    value.includes(String.fromCharCode(96))) return false;
  return ![...value].some(character => CAPTURE_SHELL_META.has(character));
}

function quoteCapturePath(value: string): string {
  return process.platform === 'win32' ? '"' + value + '"' : "'" + value + "'";
}

function renderRedCapture(selected: SelectedTaskBrief, task: string, worktree: string, redLogDir: string): string {
  const lines: string[] = [];
  for (const criterion of selected.criteria) {
    // Keep this eligibility rule aligned with redGaps; verify-only and excepted criteria need no capture.
    if (!selected.task.criteria.includes(criterion.id) || criterion.evidence !== 'red' || !criterion.red || criterion.redException) continue;
    const testFiles = [...new Set(criterion.tests)];
    const unsafe = testFiles.find(file => !safeCapturePath(file));
    if (unsafe !== undefined) {
      lines.push('- RED capture omitted for task ' + task + ', criterion ' + criterion.id + ': unsafe test path ' + JSON.stringify(unsafe) + '.');
      continue;
    }
    if (criterion.red.includes('{files}') && !testFiles.length) {
      lines.push('- RED capture omitted for task ' + task + ', criterion ' + criterion.id + ': {files} has no test paths.');
      continue;
    }
    const command = criterion.red.replaceAll('{files}', testFiles.map(quoteCapturePath).join(' '));
    const bootstrap = Buffer.from(CAPTURE_BOOTSTRAP, 'utf8').toString('base64url');
    const data = Buffer.from(JSON.stringify({command, cwd: worktree, logDir: redLogDir, criterion: criterion.id}), 'utf8').toString('base64url');
    const wrapper = 'node -e "eval(Buffer.from(process.argv[1],\'base64url\').toString())" ' + bootstrap + ' ' + data;
    const tick = String.fromCharCode(96);
    lines.push('- ' + criterion.id + ': ' + tick + wrapper + tick);
  }
  return lines.join('\n');
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
  const worktree = path.resolve(ctx.session, launch.record.data['path']);
  const reportPath = path.join(ctx.session, '.state', 'briefs', task + '-' + launch.launch + '.report.md');
  const redLogDir = path.join(ctx.session, '.state', 'briefs', task + '-' + launch.launch + '.red');
  const templates = path.join(ctx.deps.skillRoot, 'references', 'templates');
  const bar = fs.readFileSync(path.join(templates, 'quality-bar.md'), 'utf8');
  const quality = ['shared', 'code'].map(name => {
    const body = new RegExp('^## ' + name + '\\r?\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))', 'm').exec(bar)?.[1]?.trim();
    if (!body) throw new Error('Missing quality section ' + name);
    return body;
  }).join('\n\n');
  const slots: Record<string, string> = {
    task, worktree,
    specPath: bind.data['spec'], specHash: snapshot.hashes.spec!,
    planPath: bind.data['plan'], planHash: snapshot.hashes.plan!,
    design: bind.data['design'] ? 'Governing design: `' + bind.data['design'] + '` (' + snapshot.hashes.design + ').' : '',
    shared: parsed.plan.sharedContext, section, criteria, quality,
    reportPath, redLogDir, redCapture: renderRedCapture(selected, task, worktree, redLogDir),
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
