import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let runtime: string | undefined;
/** Bind the runtime once per process; source changes require a new process and explicit rebind. */
export function runtimeIdentity(): string {
  if (runtime) return runtime;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), digest = crypto.createHash('sha256');
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.endsWith('.ts')) digest.update(path.relative(root, file).replaceAll('\\', '/')).update('\0').update(fs.readFileSync(file));
    }
  };
  walk(root);
  runtime = `dispatch:${digest.digest('hex')}:node-${process.versions.node.split('.')[0]}`;
  return runtime;
}
