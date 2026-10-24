import fs from 'node:fs';
import path from 'node:path';

export type FakeGitCall = { argv: string[]; locked: boolean };
export type FakeGitState = {
  session: string;
  head: string;
  tree: string;
  testedTree: string;
  changes: { status: string; path: string }[];
  calls: FakeGitCall[];
  onCall?: (call: FakeGitCall, state: FakeGitState) => void;
};

/** Scripts only the Git reads used by report handlers and records their lock boundary. */
export function fakeGit(state: FakeGitState) {
  return async (argv: string[]) => {
    const call = { argv: [...argv], locked: fs.existsSync(path.join(state.session, '.state', 'lock')) };
    state.calls.push(call);
    state.onCall?.(call, state);
    const args = argv.slice(1);
    const output = (stdout = '') => ({ exit: 0, stdout, stderr: '' });

    if (args.length === 2 && args[0] === 'rev-parse' && args[1] === 'HEAD') return output(state.head + '\n');
    if (args.length === 2 && args[0] === 'rev-parse' && args[1] === 'HEAD^{tree}') return output(state.tree + '\n');
    if (args.length === 2 && args[0] === 'read-tree' && args[1] === 'HEAD') return output();
    if (args.length === 2 && args[0] === 'add' && args[1] === '-A') return output();
    if (args.length === 1 && args[0] === 'write-tree') return output(state.testedTree + '\n');
    if (args[0] === 'diff' && args[1] === '--name-status' && args[2] === '--no-renames' && args[3] === '-z') {
      return output(state.changes.flatMap(({ status, path: file }) => [status, file]).join('\0') + (state.changes.length ? '\0' : ''));
    }
    throw new Error('Unexpected Git argv: ' + JSON.stringify(argv));
  };
}
