// Link-capable filesystem port for exclusive publication (wave claims) and atomic replacement
// (heartbeats, outcome files). Core `FsPort` has no hard link, so this lives beside it.

export interface LinkFs {
  /** Writes complete content to a fresh temp file beside `near` and fsyncs it; returns the temp path. */
  writeTemp(near: string, text: string): string;
  /** Hard-links `temp` to `final`; throws an error with code `EEXIST` when `final` exists. */
  link(temp: string, final: string): void;
  /** Temp file + fsync + rename over `file`. */
  writeAtomic(file: string, text: string): void;
  /** File text, or null when absent. */
  readText(file: string): string | null;
  /** Entry names in `dir`, or [] when absent. */
  list(dir: string): string[];
  remove(file: string): void;
}

export const isEexist = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EEXIST';

/**
 * Publishes `text` at `final` only when no file holds that name: temp write, fsync, then hard link, so a
 * reader never sees partial content. Returns false on `EEXIST`; the temp file is always removed.
 */
export function publishExclusive(fs: LinkFs, final: string, text: string): boolean {
  const temp = fs.writeTemp(final, text);
  try {
    fs.link(temp, final);
    return true;
  } catch (error) {
    if (isEexist(error)) return false;
    throw error;
  } finally {
    fs.remove(temp);
  }
}
