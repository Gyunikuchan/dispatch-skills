// Link-capable filesystem port for exclusive publication (wave claims) and atomic replacement
// (heartbeats, outcome files). Core `FsPort` has no hard link, so this lives beside it.

export interface LinkFs {
  /** Writes complete content to a fresh temp file beside `near` and fsyncs it; returns the temp path. */
  writeTemp: (near: string, text: string) => string;
  /** Hard-links `temp` to `final`; throws an error with code `EEXIST` when `final` exists. */
  link: (temp: string, final: string) => void;
  /** Temp file + fsync + rename over `file`. */
  writeAtomic: (file: string, text: string) => void;
  /** File text, or null when absent. */
  readText: (file: string) => string | null;
  /** Entry names in `dir`, or [] when absent. */
  list: (dir: string) => string[];
  remove: (file: string) => void;
}

export const nodeErrorCode = (error: unknown) =>
  error !== null &&
  typeof error === "object" &&
  "code" in error &&
  typeof error.code === "string"
    ? error.code
    : undefined;

export const isEexist = (error: unknown) => nodeErrorCode(error) === "EEXIST";

/** Removes one leading UTF-8 BOM so agent-authored JSON parses; a second BOM still fails the parser. */
export const stripBom = (text: string) =>
  text.startsWith("\uFEFF") ? text.slice(1) : text;

/**
 * Publishes `text` at `final` only when no file holds that name: temp write, fsync, then hard link, so a
 * reader never sees partial content. Returns false on `EEXIST`; the temp file is always removed.
 */
export const publishExclusive = (fs: LinkFs, final: string, text: string) => {
  const temp = fs.writeTemp(final, text);

  try {
    fs.link(temp, final);

    return true;
  } catch (error) {
    if (isEexist(error)) {
      return false;
    }

    throw error;
  } finally {
    fs.remove(temp);
  }
};
