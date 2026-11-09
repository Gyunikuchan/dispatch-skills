import fs from 'node:fs';
import path from 'node:path';
import type { HandlerContext, HandlerResult } from './cli.ts';
import { currentSnapshot, foldLedger, gate, latest, withLedger } from './ledger.ts';
import { parsePlan, selectTaskBrief } from './domain/plan.ts';
import { qualityCriteria } from './domain/prompt.ts';
import { DEFAULT_MAP_BUDGET } from './domain/context.ts';
import { checks } from './plan-view.ts';
import { launches } from './writers.ts';
import { ToolError } from './output.ts';
import { stripBom } from '../lib/fs-ext.ts';
import { loadConfig, validateConfig } from '../lib/config.ts';
import { opencodeSubagentModels } from '../lib/platform.ts';
import { normalizeProvider, resolveLevel, resolveSubagent, resolveUtility, type LevelMap, type ResolvedSubagent, type SubagentEntry } from '../policy/roster.ts';
import type { Level } from './types.ts';

type LaunchValues = { model: string[] | null; effort: string | null; subagentModels?: string[] };

/** Writer launch values from `write-subagents` at the ledger level; null when the host or config does not resolve. */
function writerLaunchValues(skillRoot: string, host: string | undefined, level: Level): LaunchValues {
  const none: LaunchValues = {model: null, effort: null};
  try {
    if (!host) return none;
    const normalized = normalizeProvider(host);
    const {config} = loadConfig(skillRoot);
    if (validateConfig(config).length) return none;
    const writerTable = config['write-subagents'] as Record<string, LevelMap<SubagentEntry>> | undefined;
    const key = writerTable ? Object.keys(writerTable).find((candidate) => normalizeProvider(candidate) === normalized) : undefined;
    const entry = key && writerTable ? resolveLevel(writerTable[key], level) : undefined;
    if (!entry) return none;
    const resolved = resolveSubagent(entry);
    const subagentModels = normalized === 'opencode' ? opencodeSubagentModels(resolved.models, resolved.effort) : undefined;
    return {model: resolved.models, effort: resolved.effort, ...(subagentModels !== undefined ? {subagentModels} : {})};
  } catch { return none; }
}

/** Explorer and test-cleanup launch values from the `utility` entry; null when the host or config does not resolve. */
function utilityLaunchValues(skillRoot: string, host: string | undefined): LaunchValues {
  const none: LaunchValues = {model: null, effort: null};
  try {
    if (!host) return none;
    const normalized = normalizeProvider(host);
    const {config} = loadConfig(skillRoot);
    if (validateConfig(config).length) return none;
    const writerTable = config['write-subagents'] as Record<string, LevelMap<SubagentEntry>> | undefined ?? {};
    const explorerTable = config['explore-subagents'] as Record<string, SubagentEntry> | undefined ?? {};
    const resolved = resolveUtility(explorerTable, writerTable)[normalized];
    if (!resolved) return none;
    const subagentModels = normalized === 'opencode' ? opencodeSubagentModels(resolved.models, resolved.effort) : undefined;
    return {model: resolved.models, effort: resolved.effort, ...(subagentModels !== undefined ? {subagentModels} : {})};
  } catch { return none; }
}

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

// Base64url keeps the payload opaque to shell parsing.
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
  const capturePath = path.join(redLogDir, 'capture.cjs');
  let written = false;
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
    if (!written) {
      fs.mkdirSync(redLogDir, {recursive: true});
      fs.writeFileSync(capturePath, CAPTURE_BOOTSTRAP);
      written = true;
    }
    const bootstrap = Buffer.from(CAPTURE_BOOTSTRAP, 'utf8').toString('base64url');
    const data = Buffer.from(JSON.stringify({command, cwd: worktree, logDir: redLogDir, criterion: criterion.id}), 'utf8').toString('base64url');
    const shellPath = process.platform === 'win32' && /^[A-Za-z]:/.test(capturePath) ? capturePath.slice(2) : capturePath;
    const safe = path.isAbsolute(capturePath) && !/[\x00-\x1f\x7f"':]/.test(shellPath) &&
      ![...shellPath].some(character => !(process.platform === 'win32' && character === '\\') && CAPTURE_SHELL_META.has(character));
    const wrapper = safe ? 'node ' + quoteCapturePath(capturePath) + ' ' + data : 'node -e "eval(Buffer.from(process.argv[1],\'base64url\').toString())" ' + bootstrap + ' ' + data;
    const tick = String.fromCharCode(96);
    lines.push('- ' + criterion.id + ': ' + tick + wrapper + tick);
  }
  return lines.join('\n');
}

/** The host's utility entry as brief text; an undetected host or unusable config never refuses the render. */
function explorerText(skillRoot: string, platform: string | undefined): string {
  let entry: ResolvedSubagent | undefined;
  try {
    const {config} = loadConfig(skillRoot);
    const tables = [config['explore-subagents'], config['write-subagents']] as [Record<string, SubagentEntry>, Record<string, LevelMap<SubagentEntry>>];
    if (platform && !validateConfig(config).length) entry = resolveUtility(...tables)[normalizeProvider(platform)];
  } catch { /* Missing or unparsable config resolves nothing. */ }
  if (!entry) return 'none resolves';
  const models = 'model ' + entry.models.map(model => '`' + model + '`').join(' or ');
  return entry.effort ? models + ', effort `' + entry.effort + '`' : models + ', no effort set';
}

/** Shared `{{slot}}` substitution; an unknown slot name refuses instead of emitting raw braces. */
function fillSlots(label: string, text: string, slots: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    if (!Object.hasOwn(slots, name)) throw new Error(`Unknown ${label} brief slot ${name}`);
    return slots[name]!;
  });
}

function assertFilled(label: string, text: string): void {
  if (/\{\{\w+\}\}/.test(text)) throw new ToolError(2, 'fault', `Unfilled ${label} brief placeholder`);
  if (/\[[^\]]+\]\((?![a-zA-Z][a-zA-Z0-9+.-]*:)(?![#<])[^)]+\)/.test(text)) throw new ToolError(2, 'fault', `Rendered ${label} brief contains a relative link`);
}

function nextBriefPath(directory: string, base: string): string {
  let index = 1;
  for (;;) {
    const file = path.join(directory, `${base}-${index}.md`);
    if (!fs.existsSync(file)) return file;
    index++;
  }
}

/** Reads a JSON values file; a missing, unreadable, unknown or blank value refuses before anything is written. */
function readValues<const Keys extends string>(valuesPath: string, expected: readonly Keys[]): Record<Keys, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(fs.readFileSync(path.resolve(valuesPath), 'utf8')));
  } catch {
    throw new ToolError(1, 'invalid-input', 'Cannot read values file ' + valuesPath);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ToolError(1, 'invalid-input', 'Values file must hold a JSON object: ' + valuesPath);
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(expected as readonly string[]).includes(key)) throw new ToolError(1, 'invalid-input', 'Unknown value ' + key);
  }
  const out = {} as Record<Keys, string>;
  for (const key of expected) {
    const value = record[key];
    if (typeof value !== 'string' || !value.trim()) throw new ToolError(1, 'invalid-input', 'Missing value ' + key);
    out[key] = value;
  }
  return out;
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
    const level = (latest(tx.fold, 'level')?.data['level'] ?? 'medium') as Level;
    return {bind, snapshot, launch, source, parsed, selected, level};
  });
  const {bind, snapshot, launch, source, parsed, selected, level} = gated;
  const markdown = taskMarkdown(source, selected);
  const {section} = taskParts(source, selected);
  const criteria = markdown.slice(section.length).trim();
  const worktree = path.resolve(ctx.session, launch.record.data['path']);
  const reportPath = path.join(ctx.session, '.state', 'briefs', task + '-' + launch.launch + '.report.md');
  const redLogDir = path.join(ctx.session, '.state', 'briefs', task + '-' + launch.launch + '.red');
  const templates = path.join(ctx.deps.skillRoot, 'references', 'templates');
  const bar = fs.readFileSync(path.join(templates, 'quality-bar.md'), 'utf8');
  const specStage = fs.readFileSync(path.join(ctx.deps.skillRoot, 'references', 'spec-stage.md'), 'utf8');
  const quality = qualityCriteria(bar, 'writer', 0, specStage);
  const slots: Record<string, string> = {
    task, worktree,
    specPath: path.resolve(ctx.manifest.repositoryRoot, bind.data['spec']), specHash: snapshot.hashes.spec!,
    planPath: path.resolve(ctx.manifest.repositoryRoot, bind.data['plan']), planHash: snapshot.hashes.plan!,
    design: bind.data['design'] ? 'Governing design: `' + path.resolve(ctx.manifest.repositoryRoot, bind.data['design']) + '` (governed hash ' + snapshot.hashes.design + ').' : '',
    shared: parsed.plan.sharedContext, section, criteria, quality,
    explorer: explorerText(ctx.deps.skillRoot, ctx.deps.orchestrator?.platform),
    reportPath, redLogDir, redCapture: renderRedCapture(selected, task, worktree, redLogDir),
    contracts: checks(parsed.plan).find(check => check.criterion === 'contract')!.commands.map(command => '- `' + command + '`').join('\n'),
  };
  const text = fillSlots('writer', fs.readFileSync(path.join(templates, 'writer-brief.md'), 'utf8'), slots);
  const directory = path.join(ctx.session, '.state', 'briefs');
  fs.mkdirSync(directory, {recursive: true});
  const file = path.join(directory, task + '-' + launch.launch + '.md');
  fs.writeFileSync(file, text);
  const launchValues = writerLaunchValues(ctx.deps.skillRoot, ctx.deps.orchestrator?.platform, level);
  const value = {path: file, task, launch: launch.launch, bytes: Buffer.byteLength(text), ...launchValues};
  return {ok: true, exit: 0, value, summary: task + ' launch ' + launch.launch + ': ' + file + ' (' + value.bytes + ' bytes)'};
}

const EXPLORER_VALUES = ['objective', 'questions', 'outputPath'] as const;
const TEST_CLEANUP_VALUES = ['base', 'integrationPath'] as const;

export async function renderExplorerBrief(ctx: HandlerContext): Promise<HandlerResult> {
  if (ctx.args.length !== 1) throw new ToolError(1, 'invalid-input', 'One values file is required');
  const values = readValues(ctx.args[0]!, EXPLORER_VALUES);
  const templates = path.join(ctx.deps.skillRoot, 'references', 'templates');
  const bar = fs.readFileSync(path.join(templates, 'quality-bar.md'), 'utf8');
  const specStage = fs.readFileSync(path.join(ctx.deps.skillRoot, 'references', 'spec-stage.md'), 'utf8');
  const slots: Record<string, string> = {
    objective: values.objective,
    questions: values.questions,
    outputPath: values.outputPath,
    cliPath: path.join(ctx.deps.skillRoot, 'scripts', 'dispatch.ts'),
    session: ctx.session,
    mapBudget: DEFAULT_MAP_BUDGET.toLocaleString('en-US'),
    contextMapTemplate: fs.readFileSync(path.join(templates, 'context-map.md'), 'utf8'),
    quality: qualityCriteria(bar, 'explorer', 0, specStage),
  };
  const text = fillSlots('explorer', fs.readFileSync(path.join(templates, 'explorer-brief.md'), 'utf8'), slots);
  assertFilled('explorer', text);
  const directory = path.join(ctx.session, '.state', 'briefs');
  fs.mkdirSync(directory, {recursive: true});
  const file = nextBriefPath(directory, 'explorer');
  fs.writeFileSync(file, text);
  const launchValues = utilityLaunchValues(ctx.deps.skillRoot, ctx.deps.orchestrator?.platform);
  const value = {briefPath: file, bytes: Buffer.byteLength(text), ...launchValues};
  return {ok: true, exit: 0, value, summary: 'explorer brief: ' + file + ' (' + value.bytes + ' bytes)'};
}

export async function renderTestCleanupBrief(ctx: HandlerContext): Promise<HandlerResult> {
  if (ctx.args.length !== 1) throw new ToolError(1, 'invalid-input', 'One values file is required');
  const values = readValues(ctx.args[0]!, TEST_CLEANUP_VALUES);
  const bind = latest(foldLedger(ctx.session), 'bind');
  if (!bind || typeof bind.data['plan'] !== 'string' || !bind.data['plan'].trim()) throw new ToolError(4, 'lint-errors', 'No bound plan');
  const templates = path.join(ctx.deps.skillRoot, 'references', 'templates');
  const bar = fs.readFileSync(path.join(templates, 'quality-bar.md'), 'utf8');
  const specStage = fs.readFileSync(path.join(ctx.deps.skillRoot, 'references', 'spec-stage.md'), 'utf8');
  const slots: Record<string, string> = {
    base: values.base,
    integrationPath: values.integrationPath,
    planPath: path.resolve(ctx.manifest.repositoryRoot, bind.data['plan']),
    quality: qualityCriteria(bar, 'cleanup', 0, specStage),
  };
  const text = fillSlots('test-cleanup', fs.readFileSync(path.join(templates, 'test-cleanup-brief.md'), 'utf8'), slots);
  assertFilled('test-cleanup', text);
  const directory = path.join(ctx.session, '.state', 'briefs');
  fs.mkdirSync(directory, {recursive: true});
  const file = nextBriefPath(directory, 'test-cleanup');
  fs.writeFileSync(file, text);
  const launchValues = utilityLaunchValues(ctx.deps.skillRoot, ctx.deps.orchestrator?.platform);
  const value = {briefPath: file, bytes: Buffer.byteLength(text), ...launchValues};
  return {ok: true, exit: 0, value, summary: 'test-cleanup brief: ' + file + ' (' + value.bytes + ' bytes)'};
}
