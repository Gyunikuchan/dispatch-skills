import fs from "node:fs";
import path from "node:path";

export interface FakeGitCall {
  argv: string[];
  locked: boolean;
}

export interface FakeGitState {
  session: string;
  head: string;
  tree: string;
  testedTree: string;
  changes: { status: string; path: string }[];
  calls: FakeGitCall[];
  onCall?: (call: FakeGitCall, state: FakeGitState) => void;
}

const output = (stdout = "") => ({ exit: 0, stdout, stderr: "" });

/** Scripts only the Git reads used by report handlers and records their lock boundary. */
// oxlint-disable-next-line eslint/require-await, eslint/complexity -- GitDeps requires a Promise return from synchronous logic; 21 branches script every Git read the report handlers use
export const fakeGit = (state: FakeGitState) => async (argv: string[]) => {
  const call = {
    argv: [...argv],
    locked: fs.existsSync(path.join(state.session, ".state", "lock")),
  };

  state.calls.push(call);
  state.onCall?.(call, state);
  const args = argv.slice(1);

  if (args.length === 2 && args[0] === "rev-parse" && args[1] === "HEAD") {
    return output(`${state.head}\n`);
  }

  if (
    args.length === 2 &&
    args[0] === "rev-parse" &&
    args[1] === "HEAD^{tree}"
  ) {
    return output(`${state.tree}\n`);
  }

  if (args.length === 2 && args[0] === "read-tree" && args[1] === "HEAD") {
    return output();
  }

  if (args.length === 2 && args[0] === "add" && args[1] === "-A") {
    return output();
  }

  if (args.length === 1 && args[0] === "write-tree") {
    return output(`${state.testedTree}\n`);
  }

  if (
    args[0] === "diff" &&
    args[1] === "--name-status" &&
    args[2] === "--no-renames" &&
    args[3] === "-z"
  ) {
    return output(
      state.changes
        .flatMap(({ status, path: file }) => [status, file])
        .join("\0") + (state.changes.length ? "\0" : "")
    );
  }

  throw new Error(`Unexpected Git argv: ${JSON.stringify(argv)}`);
};
