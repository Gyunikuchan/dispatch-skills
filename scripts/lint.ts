import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const paths = [
  'oxlint.config.ts',
  'skills/dispatch/scripts',
  'scripts',
  'tests',
  '.agents/skills/audit-dispatch-skills/scripts',
  '.agents/skills/optimise-tests/scripts',
  '.agents/skills/link-reader/scripts',
];
const root = fileURLToPath(new URL('../', import.meta.url));
const oxlint = fileURLToPath(new URL('../node_modules/oxlint/bin/oxlint', import.meta.url));
const options = { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 } as const;

type LineRange = { first: number; last: number };

function git(args: Array<string>): string {
  const result = spawnSync('git', args, options);
  if (result.status !== 0) {
    throw new Error(result.error?.message || result.stderr || 'Git could not read the working tree');
  }
  return result.stdout;
}

function changedLines(): Map<string, Array<LineRange>> {
  const patch = git([
    '-c',
    'core.quotePath=false',
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--no-prefix',
    '--find-renames',
    '--unified=0',
    '--inter-hunk-context=0',
    'HEAD',
    '--',
    ...paths,
  ]);
  const changed = new Map<string, Array<LineRange>>();
  let file = '';
  let inHeader = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = '';
      inHeader = true;
    } else if (inHeader && line.startsWith('+++ ')) {
      const name = line.slice(4).replace(/\t$/, '');
      const decoded: unknown = name.startsWith('"') ? JSON.parse(name) : name;
      if (typeof decoded !== 'string') {
        throw new Error('Git returned an invalid diff path');
      }
      file = decoded;
      inHeader = false;
    } else if (file && line.startsWith('@@ ')) {
      const [, start, count] = / \+(\d+)(?:,(\d+))? @@/.exec(line) ?? [];
      const first = Number(start);
      const size = Number(count ?? 1);
      if (size > 0) {
        const ranges = changed.get(file) ?? [];
        ranges.push({ first, last: first + size - 1 });
        changed.set(file, ranges);
      }
    }
  }

  for (const name of git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...paths]).split('\0')) {
    if (name) {
      changed.set(name, [{ first: 1, last: Infinity }]);
    }
  }
  return changed;
}

if (process.argv.includes('--all')) {
  const result = spawnSync(process.execPath, [oxlint, ...paths], { cwd: root, stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
} else {
  // The annotation format supplies both ends of the primary diagnostic span.
  const changed = changedLines();
  const result = spawnSync(process.execPath, [oxlint, '--format', 'github', ...paths], options);
  if (result.error) {
    throw result.error;
  }
  process.stderr.write(result.stderr);
  let errors = 0;
  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    if (/^(?:Found \d+ warnings? and \d+ errors?\.|Finished in .+ with \d+ rules using \d+ threads?\.)$/.test(line)) {
      continue;
    }
    const [, severity, file, first, last, rule, message] =
      /^::(error|warning) file=([^,]+),line=(\d+),endLine=(\d+),col=\d+,endColumn=\d+,title=(.+?)::(.*)$/.exec(line) ??
      [];
    if (file === undefined || message === undefined) {
      // Keep configuration and tool failures visible even when no source lines changed.
      process.stderr.write(`${line}\n`);
      errors++;
    } else if (
      changed.get(decodeURIComponent(file))?.some((range) => range.first <= Number(last) && Number(first) <= range.last)
    ) {
      process.stderr.write(`${message} [${rule}]\n`);
      errors += Number(severity === 'error');
    }
  }
  if (result.status === null || result.status > 1 || (result.status === 1 && (!result.stdout || result.stderr))) {
    errors++;
  }
  process.exitCode = errors > 0 ? 1 : 0;
}
