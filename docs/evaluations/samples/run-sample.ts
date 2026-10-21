import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type Task = {
  id: string;
  sizeClass: string;
  seed: string;
  acceptance: string;
  model: string;
  permissionMode: string;
  timeoutMinutes: number;
  prompt: string;
};

type Captured = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
};

const scriptPath = fileURLToPath(import.meta.url);
const samplesRoot = path.dirname(scriptPath);
const repositoryRoot = path.resolve(samplesRoot, '../../..');
const runJsonName = 'run.json';
const maxBufferBytes = 128 * 1024 * 1024;

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return '';
}

function runCaptured(command: string, args: string[], options: Record<string, unknown> = {}): Captured {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: maxBufferBytes,
    ...options,
  });
  const failure = result.error as { code?: unknown; message?: unknown } | undefined;
  const timedOut = options['timeout'] !== undefined &&
    (failure?.['code'] === 'ETIMEDOUT' || result.signal === 'SIGTERM');
  return {
    exitCode: typeof result.status === 'number' ? result.status : 1,
    stdout: asText(result.stdout),
    stderr: asText(result.stderr),
    timedOut,
    ...(failure ? { error: typeof failure['message'] === 'string' ? failure['message'] : String(result.error) } : {}),
  };
}

function runChecked(command: string, args: string[], options: Record<string, unknown> = {}): string {
  try {
    const output = execFileSync(command, args, {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: maxBufferBytes,
      ...options,
    });
    return asText(output);
  } catch (error) {
    const failure = error as { status?: unknown; stderr?: unknown; message?: unknown };
    const code = typeof failure['status'] === 'number' ? failure['status'] : 1;
    const detail = asText(failure['stderr']).trim() || (typeof failure['message'] === 'string' ? failure['message'] : 'no error details');
    throw new Error(command + ' failed (' + code + '): ' + detail);
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function realRepositoryRoot(): string {
  return fs.realpathSync(repositoryRoot);
}

function temporaryBase(): string {
  const base = fs.realpathSync(os.tmpdir());
  if (isWithin(realRepositoryRoot(), base)) {
    throw new Error('The temporary directory resolves inside the repository');
  }
  return base;
}

function assertOutsideRepository(candidate: string): void {
  const realCandidate = fs.realpathSync(candidate);
  if (isWithin(realRepositoryRoot(), realCandidate)) {
    throw new Error('The sample working copy resolves inside the repository: ' + realCandidate);
  }
}

function makeTemporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(temporaryBase(), prefix));
  assertOutsideRepository(directory);
  return fs.realpathSync(directory);
}

function removeTemporaryDirectory(directory: string): void {
  const base = temporaryBase();
  const realDirectory = fs.realpathSync(directory);
  if (realDirectory === base || !isWithin(base, realDirectory)) {
    throw new Error('Refusing to remove a path outside the temporary directory: ' + realDirectory);
  }
  fs.rmSync(realDirectory, { recursive: true, force: true });
}

function loadTasks(): Task[] {
  const value = JSON.parse(fs.readFileSync(path.join(samplesRoot, 'tasks.json'), 'utf8')) as { tasks?: unknown };
  if (!Array.isArray(value.tasks) || value.tasks.length === 0) throw new Error('tasks.json must contain at least one task');
  const tasks = value.tasks as Task[];
  const seen = new Set<string>();
  for (const task of tasks) {
    if (!task || typeof task !== 'object' || !/^[a-z0-9-]+$/.test(task.id) || seen.has(task.id)) {
      throw new Error('tasks.json contains an invalid or duplicate task id');
    }
    if (typeof task.seed !== 'string' || typeof task.acceptance !== 'string' ||
        typeof task.model !== 'string' || typeof task.permissionMode !== 'string' ||
        typeof task.prompt !== 'string' || !Number.isSafeInteger(task.timeoutMinutes) || task.timeoutMinutes < 1) {
      throw new Error('Task ' + task.id + ' has invalid run settings');
    }
    seen.add(task.id);
    const seedPath = path.resolve(samplesRoot, task.seed);
    const acceptancePath = path.resolve(samplesRoot, task.acceptance);
    if (!isWithin(samplesRoot, seedPath) || !isWithin(samplesRoot, acceptancePath)) {
      throw new Error('Task ' + task.id + ' path escapes the sample directory');
    }
    if (!fs.statSync(seedPath).isDirectory() || !fs.statSync(acceptancePath).isFile()) {
      throw new Error('Task ' + task.id + ' seed or acceptance file is missing');
    }
  }
  return tasks;
}

function taskById(taskId: string): Task {
  const task = loadTasks().find((candidate) => candidate.id === taskId);
  if (!task) throw new Error('Unknown task: ' + taskId);
  return task;
}

function ensureOutputDirectory(requested: string): string {
  const directory = path.resolve(requested);
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.statSync(directory).isDirectory()) throw new Error('Output path is not a directory: ' + directory);
  if (fs.readdirSync(directory).length > 0) {
    throw new Error('Output directory is not empty: ' + directory);
  }
  return directory;
}

function versionOf(command: string): string {
  let executable = command;
  if (command === 'claude') {
    try {
      executable = claudeExecutable();
    } catch {
      return 'unavailable';
    }
  }
  const result = runCaptured(executable, ['--version']);
  if (result.exitCode !== 0) return 'unavailable';
  return result.stdout.trim() || result.stderr.trim() || 'unavailable';
}

function claudeExecutable(): string {
  if (process.platform !== 'win32') return 'claude';
  const pathValue = process.env['Path'] ?? process.env['PATH'] ?? '';
  for (const entry of pathValue.split(path.delimiter).filter(Boolean)) {
    const directory = entry.replace(/^"|"$/g, '');
    const direct = path.join(directory, 'claude.exe');
    if (fs.existsSync(direct)) return direct;
    const wrapper = path.join(directory, 'claude.cmd');
    if (!fs.existsSync(wrapper)) continue;
    const source = fs.readFileSync(wrapper, 'utf8');
    const target = source.match(/"(%~?dp0%[\\/][^"]+\.exe)"/i)?.[1];
    if (!target) continue;
    const relative = target.replace(/^%~?dp0%[\\/]/i, '').replace(/[\\/]/g, path.sep);
    const executable = path.resolve(directory, relative);
    if (fs.existsSync(executable)) return executable;
  }
  throw new Error('Claude Code executable was not found on PATH');
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function prepareTask(task: Task, controllerRevision: string, requestedOutput: string) {
  if (!controllerRevision || controllerRevision.startsWith('-') || /[\s:]/.test(controllerRevision)) {
    throw new Error('Controller revision must be a single Git revision');
  }
  const controllerCommit = runChecked('git', [
    'rev-parse', '--verify', '--end-of-options', controllerRevision + '^{commit}',
  ], { cwd: repositoryRoot }).trim();
  const archive = execFileSync('git', [
    'archive', '--format=tar', controllerRevision + ':skills/dispatch',
  ], { cwd: repositoryRoot, windowsHide: true, maxBuffer: maxBufferBytes });
  const outputDirectory = ensureOutputDirectory(requestedOutput);
  const workingCopy = makeTemporaryDirectory('dispatch-sample-' + task.id + '-');
  assertOutsideRepository(workingCopy);

  fs.cpSync(path.resolve(samplesRoot, task.seed), workingCopy, { recursive: true });
  runChecked('git', ['init'], { cwd: workingCopy });
  runChecked('git', ['-c', 'core.autocrlf=false', 'add', '--all'], { cwd: workingCopy });
  runChecked('git', [
    '-c', 'core.autocrlf=false',
    '-c', 'user.name=Dispatch Sample',
    '-c', 'user.email=dispatch-sample@example.invalid',
    'commit', '-m', 'Sample seed',
  ], { cwd: workingCopy });
  const seedCommit = runChecked('git', ['rev-parse', 'HEAD'], { cwd: workingCopy }).trim();

  const dispatchDirectory = path.join(workingCopy, '.claude', 'skills', 'dispatch');
  fs.mkdirSync(dispatchDirectory, { recursive: true });
  execFileSync('tar', ['-x', '-C', dispatchDirectory], {
    cwd: workingCopy,
    input: archive,
    windowsHide: true,
    maxBuffer: maxBufferBytes,
  });

  const localConfig = path.join(repositoryRoot, 'skills', 'dispatch', 'config.local.jsonc');
  let configSha256 = 'absent';
  if (fs.existsSync(localConfig)) {
    const installedConfig = path.join(dispatchDirectory, 'config.local.jsonc');
    fs.copyFileSync(localConfig, installedConfig);
    configSha256 = sha256(installedConfig);
  }

  const excludeFile = path.join(workingCopy, '.git', 'info', 'exclude');
  const excludeText = fs.readFileSync(excludeFile, 'utf8');
  if (!excludeText.split(/\r?\n/).includes('.claude/')) {
    fs.appendFileSync(excludeFile, (excludeText.endsWith('\n') || excludeText.length === 0 ? '' : '\n') + '.claude/\n');
  }

  const run = {
    schemaVersion: 1,
    taskId: task.id,
    workingCopy,
    seedCommit,
    controllerRevision,
    controllerCommit,
    configSha256,
    model: task.model,
    permissionMode: task.permissionMode,
    nodeVersion: process.version,
    claudeCodeVersion: versionOf('claude'),
    startedAt: new Date().toISOString(),
  };
  const runFile = path.join(outputDirectory, runJsonName);
  fs.writeFileSync(runFile, JSON.stringify(run, null, 2) + '\n');
  return { task, outputDirectory, workingCopy, runFile, run };
}

function npmTest(workingCopy: string): Captured {
  if (process.platform === 'win32') {
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (fs.existsSync(npmCli)) return runCaptured(process.execPath, [npmCli, 'test'], { cwd: workingCopy });
    return runCaptured(process.env['ComSpec'] || 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd', 'test'], { cwd: workingCopy });
  }
  return runCaptured('npm', ['test'], { cwd: workingCopy });
}

function testCount(output: string): number {
  const match = output.match(/(?:^|\r?\n)# tests\s+(\d+)\s*(?:\r?\n|$)/m);
  return match ? Number(match[1]) : 0;
}

function acceptanceRun(task: Task, workingCopy: string, outputDirectory?: string) {
  const acceptancePath = path.resolve(samplesRoot, task.acceptance);
  const result = runCaptured(process.execPath, ['--test', '--test-reporter=tap', acceptancePath], {
    cwd: workingCopy,
    env: { ...process.env, TEXTSTATS_ROOT: workingCopy },
  });
  const output = result.stdout + result.stderr;
  const count = testCount(output);
  const failed = result.exitCode !== 0 || count === 0;
  const record = {
    exitCode: result.exitCode,
    output,
    testCount: count,
    failed,
  };
  if (outputDirectory) fs.writeFileSync(path.join(outputDirectory, 'acceptance.json'), JSON.stringify(record, null, 2) + '\n');
  return record;
}

function runTask(task: Task, controllerRevision: string, requestedOutput: string) {
  const prepared = prepareTask(task, controllerRevision, requestedOutput);
  let claude: Captured;
  try {
    claude = runCaptured(claudeExecutable(), [
      '-p', task.prompt,
      '--output-format', 'json',
      '--model', task.model,
      '--permission-mode', task.permissionMode,
    ], {
      cwd: prepared.workingCopy,
      timeout: task.timeoutMinutes * 60 * 1000,
    });
  } catch (error) {
    claude = {
      exitCode: 1,
      stdout: '',
      stderr: '',
      timedOut: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  let claudeResult: unknown;
  try {
    claudeResult = JSON.parse(claude.stdout);
  } catch {
    claudeResult = {
      parseError: 'Claude Code output was not a JSON value',
      stdout: claude.stdout,
      ...(claude.error ? { error: claude.error } : {}),
    };
  }
  fs.writeFileSync(path.join(prepared.outputDirectory, 'claude-result.json'), JSON.stringify(claudeResult, null, 2) + '\n');
  fs.writeFileSync(path.join(prepared.outputDirectory, 'claude-stderr.log'), claude.stderr);

  const sessionDirectory = path.join(prepared.workingCopy, '.scratch', 'dispatch-skills');
  const savedSessions = path.join(prepared.outputDirectory, 'sessions');
  if (fs.existsSync(sessionDirectory)) fs.cpSync(sessionDirectory, savedSessions, { recursive: true });

  const acceptance = acceptanceRun(task, prepared.workingCopy, prepared.outputDirectory);
  const runRecord = {
    ...prepared.run,
    endedAt: new Date().toISOString(),
    exitStatus: claude.exitCode,
    timedOut: claude.timedOut,
    acceptanceExitStatus: acceptance.exitCode,
    acceptanceTestCount: acceptance.testCount,
    acceptanceFailed: acceptance.failed,
  };
  fs.writeFileSync(prepared.runFile, JSON.stringify(runRecord, null, 2) + '\n');
  const ok = claude.exitCode === 0 && !claude.timedOut && !acceptance.failed;
  return {
    ok,
    task: task.id,
    workingCopy: prepared.workingCopy,
    outputDirectory: prepared.outputDirectory,
    claudeExitStatus: claude.exitCode,
    timedOut: claude.timedOut,
    acceptanceExitStatus: acceptance.exitCode,
    acceptanceTestCount: acceptance.testCount,
    acceptanceFailed: acceptance.failed,
  };
}

function checkWorkingCopyClean(workingCopy: string): void {
  const status = runChecked('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: workingCopy });
  if (status.trim()) throw new Error('Working copy is not clean: ' + status.trim());
}

function selfCheck(controllerRevision: string) {
  const temporaryDirectory = makeTemporaryDirectory('dispatch-sample-self-check-');
  const workingCopies: string[] = [];
  const results: Array<Record<string, unknown>> = [];
  try {
    for (const task of loadTasks()) {
      const outputDirectory = path.join(temporaryDirectory, task.id);
      const prepared = prepareTask(task, controllerRevision, outputDirectory);
      workingCopies.push(prepared.workingCopy);
      assertOutsideRepository(prepared.workingCopy);
      if (!fs.existsSync(path.join(prepared.workingCopy, '.claude', 'skills', 'dispatch', 'SKILL.md'))) {
        throw new Error('Controller skill was not installed for task ' + task.id);
      }
      if (fs.existsSync(path.join(prepared.workingCopy, 'acceptance'))) {
        throw new Error('Held-out acceptance tests were copied into task ' + task.id);
      }
      checkWorkingCopyClean(prepared.workingCopy);

      const seedTests = npmTest(prepared.workingCopy);
      if (seedTests.exitCode !== 0) {
        throw new Error('Seed npm test failed for ' + task.id + ': ' + (seedTests.stderr || seedTests.stdout).trim());
      }
      const acceptance = acceptanceRun(task, prepared.workingCopy, outputDirectory);
      if (!acceptance.failed || acceptance.testCount === 0) {
        throw new Error('Held-out acceptance test did not fail with executed tests for ' + task.id);
      }
      checkWorkingCopyClean(prepared.workingCopy);
      results.push({
        task: task.id,
        claudeCodeVersion: prepared.run.claudeCodeVersion,
        workingCopyOutsideRepository: true,
        controllerInstalled: true,
        seedTestsPassed: true,
        acceptanceFailedWithTests: true,
        workingCopyClean: true,
      });
    }
  } finally {
    for (const workingCopy of workingCopies) removeTemporaryDirectory(workingCopy);
    removeTemporaryDirectory(temporaryDirectory);
  }
  return { ok: true, tasks: results };
}

const structuralMetrics = [
  'driver TS LOC',
  'exported types',
  'event types',
  'decision kinds',
  'state tags',
  'always-loaded prose bytes',
];

function markdownCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;
  const body = trimmed.endsWith('|') ? trimmed.slice(1, -1) : trimmed.slice(1);
  return body.split('|').map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function isTableSeparator(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

function sectionLines(markdown: string, heading: string): string[] | null {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (/^##\s/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end);
}

function protocolFields(): string[] {
  const markdown = fs.readFileSync(path.join(repositoryRoot, 'docs', 'dispatch-efficiency-evaluation.md'), 'utf8');
  const lines = sectionLines(markdown, '## Observation table');
  if (!lines) throw new Error('Evaluation protocol has no Observation table section');
  const tableStart = lines.findIndex((line) => {
    const cells = markdownCells(line);
    return cells?.[0]?.toLowerCase() === 'field';
  });
  if (tableStart < 0) throw new Error('Evaluation protocol Observation table has no Field column');
  const fields: string[] = [];
  for (const line of lines.slice(tableStart + 1)) {
    const cells = markdownCells(line);
    if (!cells) break;
    if (isTableSeparator(cells)) continue;
    const field = cells[0]?.trim();
    if (field) fields.push(field);
  }
  if (fields.length === 0 || new Set(fields).size !== fields.length) {
    throw new Error('Evaluation protocol Observation table has no fields or has duplicate fields');
  }
  return fields;
}

function tableRows(lines: string[]): string[][] {
  return lines.flatMap((line) => {
    const cells = markdownCells(line);
    return cells && !isTableSeparator(cells) ? [cells] : [];
  });
}

function checkReport(markdown: string, taskIds: string[]): string[] {
  const defects: string[] = [];
  const fields = protocolFields();
  const metricSection = sectionLines(markdown, '## Structural metrics');
  if (!metricSection) {
    defects.push('Structural metrics section is missing');
  } else {
    const rows = tableRows(metricSection);
    const header = rows.find((row) => row[0]?.toLowerCase() === 'metric');
    if (!header || header[1]?.toLowerCase() !== 'value' || header[2]?.toLowerCase() !== 'command') {
      defects.push('Structural metrics table must have Metric, Value, and Command columns');
    }
    for (const metric of structuralMetrics) {
      const matches = rows.filter((row) => row[0]?.toLowerCase() === metric.toLowerCase());
      if (matches.length === 0) defects.push('Structural metrics row is missing: ' + metric);
      else if (matches.length > 1) defects.push('Structural metrics row is duplicated: ' + metric);
      else if (!matches[0][1]?.trim() || !matches[0][2]?.trim()) {
        defects.push('Structural metrics row needs Value and Command: ' + metric);
      }
    }
  }

  const observations = sectionLines(markdown, '## Observations');
  if (!observations) {
    defects.push('Observations section is missing');
    return defects;
  }
  const headings = observations
    .map((line) => line.match(/^###\s+(.+?)\s*$/)?.[1])
    .filter((heading): heading is string => heading !== undefined);
  for (const heading of headings) {
    if (!taskIds.includes(heading)) defects.push('Observations contains unexpected task: ' + heading);
  }
  for (const taskId of taskIds) {
    const occurrences = headings.filter((heading) => heading === taskId).length;
    if (occurrences === 0) {
      defects.push('Observations is missing task: ' + taskId);
      continue;
    }
    if (occurrences > 1) defects.push('Observations has duplicate task: ' + taskId);
    const start = observations.findIndex((line) => line.trim() === '### ' + taskId);
    let end = observations.length;
    for (let index = start + 1; index < observations.length; index++) {
      if (/^###\s/.test(observations[index])) {
        end = index;
        break;
      }
    }
    const rows = tableRows(observations.slice(start + 1, end));
    const header = rows.find((row) => row[0]?.toLowerCase() === 'field');
    if (!header || header[1]?.toLowerCase() !== 'value' || header[2]?.toLowerCase() !== 'source') {
      defects.push('Observations table for ' + taskId + ' must have Field, Value, and Source columns');
    }
    const fieldRows = rows.filter((row) => row[0] && row[0].toLowerCase() !== 'field');
    for (const field of fields) {
      const matches = fieldRows.filter((row) => row[0] === field);
      if (matches.length === 0) {
        defects.push('Observations field is missing for ' + taskId + ': ' + field);
        continue;
      }
      if (matches.length > 1) defects.push('Observations field is duplicated for ' + taskId + ': ' + field);
      const value = matches[0][1]?.trim() ?? '';
      const source = matches[0][2]?.trim() ?? '';
      if (!value) defects.push('Observations field has an empty Value for ' + taskId + ': ' + field);
      else if (value !== 'unavailable' && !source) {
        defects.push('Observations field has a Value without a Source for ' + taskId + ': ' + field);
      }
    }
  }
  return defects;
}

function reportFixture(fields: string[], taskIds: string[]): string {
  const metrics = structuralMetrics.map((metric) => '| ' + metric + ' | recorded | node scripts/measure.ts |').join('\n');
  const observations = taskIds.map((taskId) => {
    const rows = fields.map((field, index) => {
      const value = index === 0 ? 'unavailable' : 'recorded';
      const source = index === 0 ? '' : 'fixture.md';
      return '| ' + field + ' | ' + value + ' | ' + source + ' |';
    }).join('\n');
    return '### ' + taskId + '\n\n| Field | Value | Source |\n| --- | --- | --- |\n' + rows;
  }).join('\n\n');
  return '## Structural metrics\n\n| Metric | Value | Command |\n| --- | --- | --- |\n' + metrics +
    '\n\n## Observations\n\n' + observations + '\n';
}

function editObservationRow(markdown: string, taskId: string, field: string, edit: (cells: string[]) => string | null): string {
  const lines = markdown.split('\n');
  let inTask = false;
  let changed = false;
  const output: string[] = [];
  for (const line of lines) {
    const taskHeading = line.match(/^###\s+(.+?)\s*$/)?.[1];
    if (taskHeading !== undefined) inTask = taskHeading === taskId;
    if (/^##\s/.test(line)) inTask = false;
    const cells = markdownCells(line);
    if (inTask && !changed && cells?.[0] === field) {
      const replacement = edit(cells);
      if (replacement !== null) output.push(replacement);
      changed = true;
    } else {
      output.push(line);
    }
  }
  if (!changed) throw new Error('Report fixture has no row for ' + taskId + ': ' + field);
  return output.join('\n');
}

function removeTaskSection(markdown: string, taskId: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === '### ' + taskId);
  if (start < 0) throw new Error('Report fixture has no task section: ' + taskId);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (/^(?:##|###)\s/.test(lines[index])) {
      end = index;
      break;
    }
  }
  lines.splice(start, end - start);
  return lines.join('\n');
}

function selfCheckReport() {
  const fields = protocolFields();
  const taskIds = loadTasks().map((task) => task.id);
  const complete = reportFixture(fields, taskIds);
  if (checkReport(complete, taskIds).length) throw new Error('Report checker rejected a complete report with an unavailable value');

  const source = fs.readFileSync(scriptPath, 'utf8');
  const quoteCharacters = ['"', "'", String.fromCharCode(96)];
  const literalField = fields.find((field) => quoteCharacters.some((quote) => source.includes(quote + field + quote)));
  if (literalField) throw new Error('Report checker repeats a protocol field as a source literal: ' + literalField);

  const firstTask = taskIds[0];
  const firstField = fields[0];
  const measuredField = fields.find((field) => field !== firstField);
  if (!measuredField) throw new Error('Report protocol needs at least two fields for its self-check');

  const missingField = editObservationRow(complete, firstTask, firstField, () => null);
  if (!checkReport(missingField, taskIds).some((defect) => defect.includes(firstField))) {
    throw new Error('Report checker did not name a missing field');
  }
  const emptyValue = editObservationRow(complete, firstTask, measuredField, (cells) => {
    cells[1] = '';
    return '| ' + cells.join(' | ') + ' |';
  });
  if (!checkReport(emptyValue, taskIds).some((defect) => defect.includes(measuredField))) {
    throw new Error('Report checker did not name an empty Value field');
  }
  const missingSource = editObservationRow(complete, firstTask, measuredField, (cells) => {
    cells[1] = 'recorded';
    cells[2] = '';
    return '| ' + cells.join(' | ') + ' |';
  });
  if (!checkReport(missingSource, taskIds).some((defect) => defect.includes(measuredField))) {
    throw new Error('Report checker did not name a Value without a Source');
  }

  const missingMetric = complete.split('\n').filter((line) => {
    const cells = markdownCells(line);
    return cells?.[0]?.toLowerCase() !== structuralMetrics[0].toLowerCase();
  }).join('\n');
  if (!checkReport(missingMetric, taskIds).some((defect) => defect.includes(structuralMetrics[0]))) {
    throw new Error('Report checker did not name a missing structural metric');
  }
  const missingObservations = complete.slice(0, complete.indexOf('## Observations'));
  if (!checkReport(missingObservations, taskIds).some((defect) => defect.includes('Observations'))) {
    throw new Error('Report checker did not name a missing Observations section');
  }
  if (taskIds.length > 0) {
    const missingTask = removeTaskSection(complete, firstTask);
    if (!checkReport(missingTask, taskIds).some((defect) => defect.includes(firstTask))) {
      throw new Error('Report checker did not name a missing task subsection');
    }
  }
  return { ok: true, checkedFields: fields.length, checkedTasks: taskIds.length };
}

function parseFlags(args: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const item = args[index];
    if (!item.startsWith('--')) {
      positional.push(item);
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error('Missing value for ' + item);
    if (flags[item]) throw new Error('Duplicate option: ' + item);
    flags[item] = value;
    index++;
  }
  return { flags, positional };
}

function requireFlag(flags: Record<string, string>, name: string): string {
  const value = flags[name];
  if (!value) throw new Error('Required option is missing: ' + name);
  return value;
}

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function main(): number {
  try {
    const command = process.argv[2];
    if (!command) throw new Error('Expected prepare, run, self-check, self-check-report, or check-report');
    const { flags, positional } = parseFlags(process.argv.slice(3));
    let result: Record<string, unknown>;
    if (command === 'prepare') {
      if (positional.length) throw new Error('prepare accepts options only');
      const prepared = prepareTask(
        taskById(requireFlag(flags, '--task')),
        requireFlag(flags, '--controller'),
        requireFlag(flags, '--out'),
      );
      result = {
        ok: true,
        task: prepared.task.id,
        workingCopy: prepared.workingCopy,
        outputDirectory: prepared.outputDirectory,
        runFile: prepared.runFile,
      };
    } else if (command === 'run') {
      if (positional.length) throw new Error('run accepts options only');
      const run = runTask(
        taskById(requireFlag(flags, '--task')),
        requireFlag(flags, '--controller'),
        requireFlag(flags, '--out'),
      );
      result = run;
    } else if (command === 'self-check') {
      if (positional.length) throw new Error('self-check accepts options only');
      result = selfCheck(requireFlag(flags, '--controller'));
    } else if (command === 'self-check-report') {
      if (positional.length || Object.keys(flags).length) throw new Error('self-check-report accepts no arguments');
      result = selfCheckReport();
    } else if (command === 'check-report') {
      if (Object.keys(flags).length || positional.length !== 1) throw new Error('Usage: check-report <report.md>');
      const reportPath = path.resolve(positional[0]);
      const defects = checkReport(fs.readFileSync(reportPath, 'utf8'), loadTasks().map((task) => task.id));
      result = { ok: defects.length === 0, report: reportPath, defects };
    } else {
      throw new Error('Unknown command: ' + command);
    }
    printJson(result);
    return result['ok'] === false ? 1 : 0;
  } catch (error) {
    printJson({ ok: false, error: error instanceof Error ? error.message : String(error) });
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  process.exitCode = main();
}
