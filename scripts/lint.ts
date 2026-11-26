import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const paths = [
  "oxlint.config.ts",
  "oxfmt.config.ts",
  "skills/dispatch/scripts",
  "scripts",
  "tests",
  ".agents/skills/optimise-tests/scripts",
  ".agents/skills/link-reader/scripts",
];

const root = fileURLToPath(new URL("../", import.meta.url));

const oxlint = fileURLToPath(
  new URL("../node_modules/oxlint/bin/oxlint", import.meta.url)
);

const options = {
  cwd: root,
  encoding: "utf-8",
  maxBuffer: 32 * 1024 * 1024,
} as const;

interface LineRange {
  first: number;
  last: number;
}

const git = (args: string[]) => {
  const result = spawnSync("git", args, options);

  if (result.status !== 0) {
    const { error, stderr } = result;
    const { message } = error ?? {};
    let detail = "Git could not read the working tree";

    if (stderr !== undefined && stderr !== "") {
      detail = stderr;
    }

    if (message !== undefined && message !== "") {
      detail = message;
    }

    throw new Error(detail);
  }

  return result.stdout;
};

const changedLines = () => {
  const patch = git([
    "-c",
    "core.quotePath=false",
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-prefix",
    "--find-renames",
    "--unified=0",
    "--inter-hunk-context=0",
    "HEAD",
    "--",
    ...paths,
  ]);

  const changed = new Map<string, LineRange[]>();
  let file = "";
  let inHeader = false;

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = "";
      inHeader = true;
    } else if (inHeader && line.startsWith("+++ ")) {
      const name = line.slice(4).replace(/\t$/u, "");
      const decoded: unknown = name.startsWith('"') ? JSON.parse(name) : name;

      if (typeof decoded !== "string") {
        // oxlint-disable-next-line unicorn/prefer-type-error -- contract is Error (instanceof Error); TypeError would break callers.
        throw new Error("Git returned an invalid diff path");
      }

      file = decoded;
      inHeader = false;
    } else if (file && line.startsWith("@@ ")) {
      const [, start, count] =
        / \+(?<start>\d+)(?:,(?<count>\d+))? @@/u.exec(line) ?? [];

      const first = Number(start);
      const size = Number(count ?? 1);

      if (size > 0) {
        const ranges = changed.get(file) ?? [];
        ranges.push({ first, last: first + size - 1 });
        changed.set(file, ranges);
      }
    }
  }

  for (const name of git([
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ...paths,
  ]).split("\0")) {
    if (name) {
      changed.set(name, [{ first: 1, last: Infinity }]);
    }
  }

  return changed;
};

if (process.argv.includes("--all")) {
  const result = spawnSync(process.execPath, [oxlint, ...paths], {
    cwd: root,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  process.exitCode = result.status ?? 1;
} else {
  // The annotation format supplies both ends of the primary diagnostic span.
  const changed = changedLines();

  const result = spawnSync(
    process.execPath,
    [oxlint, "--format", "github", ...paths],
    options
  );

  if (result.error) {
    throw result.error;
  }

  process.stderr.write(result.stderr);
  let errors = 0;

  for (const line of result.stdout.split(/\r?\n/u).filter(Boolean)) {
    if (
      /^(?:Found \d+ warnings? and \d+ errors?\.|Finished in .+ with \d+ rules using \d+ threads?\.)$/u.test(
        line
      )
    ) {
      continue;
    }

    const [, severity, file, first, last, rule, message] =
      /^::(?<severity>error|warning) file=(?<file>[^,]+),line=(?<first>\d+),endLine=(?<last>\d+),col=\d+,endColumn=\d+,title=(?<rule>.+?)::(?<message>.*)$/u.exec(
        line
      ) ?? [];

    if (file === undefined || message === undefined) {
      // Keep configuration and tool failures visible even when no source lines changed.
      process.stderr.write(`${line}\n`);
      errors += 1;
    } else if (
      changed
        .get(decodeURIComponent(file))
        ?.some(
          (range) => range.first <= Number(last) && Number(first) <= range.last
        ) === true
    ) {
      process.stderr.write(`${message} [${rule}]\n`);
      errors += Number(severity === "error");
    }
  }

  if (
    result.status === null ||
    result.status > 1 ||
    (result.status === 1 && (!result.stdout || result.stderr))
  ) {
    errors += 1;
  }

  process.exitCode = errors > 0 ? 1 : 0;
}
