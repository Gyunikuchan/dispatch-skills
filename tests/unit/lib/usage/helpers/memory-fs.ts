import path from "node:path";

export const memoryFs = (
  files: Record<string, string | Buffer>,
  times: Record<string, number> = {}
) => {
  const entries = new Map(
    Object.entries(files).map(([name, data]) => [
      path.normalize(name),
      Buffer.from(data),
    ])
  );

  const mtimes = new Map(
    Object.entries(times).map(([name, value]) => [path.normalize(name), value])
  );

  const reads: string[] = [];

  return {
    reads,
    list(dir: string) {
      // eslint-disable-next-line typescript/no-unsafe-argument -- fixture/mock boundary: values are validated by helpers before use.
      const prefix = path.normalize(dir) + path.sep;
      const names = new Set<string>();

      for (const file of entries.keys()) {
        const name =
          file.startsWith(prefix) &&
          file.slice(prefix.length).split(path.sep)[0];

        // eslint-disable-next-line typescript/strict-boolean-expressions -- test predicate intentionally checks fixture value truthiness.
        if (name) {
          names.add(name);
        }
      }

      return [...names];
    },
    stat(file: string) {
      // eslint-disable-next-line typescript/no-unsafe-argument -- fixture/mock boundary: values are validated by helpers before use.
      const data = entries.get(path.normalize(file));

      return data
        ? {
            size: data.length,
            // eslint-disable-next-line typescript/no-unsafe-argument -- fixture/mock boundary: values are validated by helpers before use.
            mtimeMs: mtimes.get(path.normalize(file)) ?? 10_000,
          }
        : null;
    },
    read(file: string, max: number) {
      // eslint-disable-next-line typescript/no-unsafe-argument -- fixture/mock boundary: values are validated by helpers before use.
      const name = path.normalize(file);
      reads.push(name);
      const data = entries.get(name);

      if (!data) {
        throw new Error(`Missing fixture file ${file}`);
      }

      // eslint-disable-next-line typescript/no-unsafe-argument -- fixture/mock boundary: values are validated by helpers before use.
      return data.subarray(0, max);
    },
    decompress: null,
  };
};

export const lines = (...values: unknown[]) =>
  values.map((value) => JSON.stringify(value)).join("\n");

export const query = {
  sessionId: "host",
  startMs: 0,
  endMs: 10_000,
  home: "/home",
  // SAFETY: the host-environment contract returns a string or undefined; the mock has no variables.
  // eslint-disable-next-line unicorn/no-useless-undefined -- explicit undefined keeps the HostUsageQuery env contract.
  env: (_: string) => undefined,
  stages: [
    { stage: "spec" as const, atMs: 0 },
    { stage: "plan" as const, atMs: 2000 },
  ],
  budget: { remaining: 1024 * 1024 },
};
