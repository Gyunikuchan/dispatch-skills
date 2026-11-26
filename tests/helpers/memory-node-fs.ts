import fs from "node:fs";
import path from "node:path";

import { fakePorts } from "./fake-ports.ts";
import { memoryRunFs } from "./memory-run-fs.ts";

type SyncMethod = Extract<keyof typeof fs, `${string}Sync`>;

type WriteOptions = Parameters<typeof fs.writeFileSync>[2];

const fail = (code: string, file: string): never => {
  throw Object.assign(new Error(`${code}: ${file}`), { code });
};

/** Route contained logical fixtures through the existing memory filesystem. */
export const memoryNodeFs = (root: string) => {
  const paths = new Map<string, string>();

  const key = (file: string) => {
    let resolved = paths.get(file);

    if (resolved === undefined) {
      resolved =
        process.platform === "win32"
          ? path.resolve(file).toLowerCase()
          : path.resolve(file);
      paths.set(file, resolved);
    }

    return resolved;
  };

  const base = key(root);
  const containment = new Map<string, boolean>();

  const inside = (
    file: fs.PathOrFileDescriptor | undefined
  ): file is string => {
    if (typeof file !== "string") {
      return false;
    }

    const cached = containment.get(file);

    if (cached !== undefined) {
      return cached;
    }

    const relative = path.relative(base, key(file));

    const contained =
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative);

    containment.set(file, contained);

    return contained;
  };

  const ports = fakePorts();
  memoryRunFs(ports, base);
  const storage = ports.fs;
  storage.mkdir(base, { recursive: true });
  const directories = new Set<string>([base]);
  const descriptors = new Map<number, string>();
  let next = -1;
  const restores: (() => void)[] = [];

  const bytes = (file: string) =>
    Buffer.from(storage.readBase64(key(file)), "base64");

  const write = (
    file: string,
    data: string | NodeJS.ArrayBufferView,
    options?: WriteOptions
  ) => {
    const flags = typeof options === "object" ? options?.flag : undefined;

    // eslint-disable-next-line typescript/strict-boolean-expressions -- test predicate intentionally checks fixture value truthiness.
    if (flags?.includes("x") && storage.exists(key(file))) {
      fail("EEXIST", file);
    }

    const encoding = typeof options === "string" ? options : options?.encoding;

    if (typeof data === "string" && (!encoding || /^utf-?8$/u.test(encoding))) {
      storage.writeAtomic(key(file), data);
    } else {
      const buffer =
        typeof data === "string"
          ? Buffer.from(data, encoding ?? undefined)
          : Buffer.from(data.buffer, data.byteOffset, data.byteLength);

      storage.writeBase64Atomic(key(file), buffer.toString("base64"));
    }
  };

  const replace = <Name extends SyncMethod, Result>(
    name: Name,
    handler: (
      original: (typeof fs)[Name],
      ...args: Parameters<(typeof fs)[Name]>
    ) => Result
  ) => {
    const original = fs[name];

    // Avoid node:test call-history capture for each logical filesystem operation.
    const replacement = (...args: Parameters<(typeof fs)[Name]>) =>
      handler(original, ...args);

    Object.defineProperty(fs, name, {
      ...Object.getOwnPropertyDescriptor(fs, name),
      value: replacement,
    });
    restores.push(() =>
      // eslint-disable-next-line typescript/strict-void-return -- mock callback intentionally returns void through a wrapper.
      Object.defineProperty(fs, name, {
        ...Object.getOwnPropertyDescriptor(fs, name),
        value: original,
      })
    );

    return replacement;
  };

  replace("readFileSync", (real, file, options) => {
    if (!inside(file)) {
      return real(file, options);
    }

    const encoding = typeof options === "string" ? options : options?.encoding;

    // eslint-disable-next-line eslint/no-nested-ternary -- compact fixture expectation table.
    return encoding && /^utf-?8$/u.test(encoding)
      ? storage.readText(key(file))
      : encoding
        ? bytes(file).toString(encoding)
        : bytes(file);
  });
  replace("writeFileSync", (real, file, data, options) => {
    // eslint-disable-next-line eslint/no-unused-expressions -- intentional test pattern.
    inside(file) ? write(file, data, options) : real(file, data, options);
  });
  replace("appendFileSync", (real, file, data) => {
    // eslint-disable-next-line eslint/no-unused-expressions -- intentional test pattern.
    inside(file)
      ? write(
          file,
          Buffer.concat([
            storage.exists(key(file)) ? bytes(file) : Buffer.alloc(0),
            Buffer.from(data),
          ])
        )
      : real(file, data);
  });
  replace("copyFileSync", (real, source, target) => {
    // eslint-disable-next-line eslint/no-unused-expressions -- intentional test pattern.
    inside(target)
      ? storage.writeBase64Atomic(
          key(target),
          (inside(source) ? bytes(source) : fs.readFileSync(source)).toString(
            "base64"
          )
        )
      : real(source, target);
  });
  replace("mkdirSync", (real, file, options) => {
    if (!inside(file)) {
      return real(file, options);
    }

    // eslint-disable-next-line typescript/no-confusing-void-expression -- intentional test pattern.
    const result = storage.mkdir(key(file), {
      recursive: typeof options === "object" && !(options?.recursive !== true),
    });

    for (let dir = key(file); inside(dir); dir = path.dirname(dir)) {
      directories.add(dir);
    }

    return result;
  });
  replace("existsSync", (real, file) =>
    inside(file) ? storage.exists(key(file)) : real(file)
  );
  replace("statSync", (real, file) => {
    if (!inside(file)) {
      return real(file);
    }

    const entry = storage.inspectPath(key(file)) ?? fail("ENOENT", file);

    return {
      size: entry.kind === "file" ? bytes(file).length : 0,
      mode: entry.mode,
      isFile: () => entry.kind === "file",
      isDirectory: () => entry.kind === "directory",
      isSymbolicLink: () => entry.kind === "symlink",
    };
  });
  replace("lstatSync", (real, file, ...args) =>
    inside(file) ? fs.statSync(file, ...args) : real(file, ...args)
  );

  const resolve = (real: (file: fs.PathLike) => string, file: fs.PathLike) =>
    // eslint-disable-next-line eslint/no-nested-ternary -- compact fixture expectation table.
    inside(file)
      ? storage.exists(key(file))
        ? key(file)
        : fail("ENOENT", file)
      : real(file);

  const { native } = fs.realpathSync;
  const realpath = replace("realpathSync", resolve);
  Object.assign(realpath, {
    native: (file: fs.PathLike) => resolve(native, file),
  });
  replace("readdirSync", (real, file, options) => {
    if (!inside(file)) {
      return real(file, options);
    }

    const entry = storage.inspectPath(key(file)) ?? fail("ENOENT", file);

    if (entry.kind !== "directory") {
      fail("ENOTDIR", file);
    }

    const names = [
      ...new Set([
        ...storage.listFiles(key(file)).map((name) => name.split("/")[0] ?? ""),
        ...[...directories].flatMap((dir) =>
          dir !== key(file) && path.dirname(dir) === key(file)
            ? [path.basename(dir)]
            : []
        ),
      ]),
    ].toSorted();

    const encoding = typeof options === "string" ? options : options?.encoding;

    return names.map((name) => {
      const encoded = encoding === "buffer" ? Buffer.from(name) : name;

      if (!options?.withFileTypes) {
        return encoded;
      }

      const kind = storage.inspectPath(path.join(key(file), name))?.kind;

      return {
        name: encoded,
        parentPath: file,
        path: file,
        isFile: () => kind === "file",
        isDirectory: () => kind === "directory",
        isSymbolicLink: () => kind === "symlink",
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
        isFIFO: () => false,
        isSocket: () => false,
      };
    });
  });
  replace("renameSync", (real, source, target) => {
    if (!inside(source) || !inside(target)) {
      real(source, target);

      return;
    }

    storage.copyFileAtomic(key(source), key(target));
    storage.remove(key(source));
  });
  replace("unlinkSync", (real, file) => {
    if (!inside(file)) {
      real(file);

      return;
    }

    const entry = storage.inspectPath(key(file)) ?? fail("ENOENT", file);

    if (entry.kind === "directory") {
      fail("EISDIR", file);
    }

    storage.remove(key(file));
  });
  replace("rmSync", (real, file, options) => {
    if (!inside(file)) {
      real(file, options);

      return;
    }

    const entry = storage.inspectPath(key(file));

    if (!entry) {
      if (options?.force !== true) {
        fail("ENOENT", file);
      }

      return;
    }

    if (entry.kind === "directory") {
      if (options?.recursive !== true) {
        fail("ERR_FS_EISDIR", file);
      }

      for (const name of fs.readdirSync(file)) {
        fs.rmSync(path.join(file, name), options);
      }

      directories.delete(key(file));
    }

    storage.remove(key(file));
  });
  replace("openSync", (real, file, flags, mode) => {
    if (!inside(file)) {
      return real(file, flags, mode);
    }

    if (flags !== "a" && flags !== "wx") {
      throw new Error(`Unscripted virtual open flags ${flags}`);
    }

    if (flags === "wx" && storage.exists(key(file))) {
      fail("EEXIST", file);
    }

    if (!storage.exists(key(file))) {
      write(file, "");
    }

    const fd = next;
    next -= 1;
    descriptors.set(fd, key(file));

    return fd;
  });
  replace("writeSync", (real, fd, data, ...rest) => {
    const file = descriptors.get(fd);

    if (file === undefined || file === null || file === "") {
      return real(fd, data, ...rest);
    }

    const value = Buffer.from(data);
    write(file, Buffer.concat([bytes(file), value]));

    return value.length;
  });
  replace("fsyncSync", (real, fd) => {
    if (!descriptors.has(fd)) {
      real(fd);
    }
  });
  replace("closeSync", (real, fd) => {
    if (!descriptors.delete(fd)) {
      real(fd);
    }
  });
  replace("truncateSync", (real, file, length = 0) => {
    // eslint-disable-next-line eslint/no-unused-expressions -- intentional test pattern.
    inside(file) ? storage.truncate(key(file), length) : real(file, length);
  });

  return () => {
    for (const restore of restores.toReversed()) {
      restore();
    }
  };
};
