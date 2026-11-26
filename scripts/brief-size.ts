import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface BriefSectionSize {
  heading: string | null;
  occurrence: number;
  bytes: number;
}

export interface BriefMeasurement {
  totalBytes: number;
  sections: BriefSectionSize[];
}

interface Line {
  start: number;
  end: number;
  content: string;
}

const linesOf = (text: string) => {
  const lines: Line[] = [];

  for (let start = 0; start < text.length;) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline + 1;

    let contentEnd: number;

    if (newline === -1) {
      contentEnd = text.length;
    } else if (newline > start && text[newline - 1] === "\r") {
      contentEnd = newline - 1;
    } else {
      contentEnd = newline;
    }

    lines.push({ start, end, content: text.slice(start, contentEnd) });
    start = end;
  }

  return lines;
};

const collectHeadings = (text: string) => {
  const headings: { start: number; heading: string }[] = [];
  let fence: { marker: "`" | "~"; length: number } | null = null;

  for (const line of linesOf(text)) {
    const content =
      line.start === 0 ? line.content.replace(/^\uFEFF/u, "") : line.content;

    if (fence !== null) {
      const closing = /^ {0,3}(?<close>`{3,}|~{3,})[ \t]*$/u.exec(content)?.[1];

      if (
        closing !== undefined &&
        closing !== "" &&
        closing.startsWith(fence.marker) &&
        closing.length >= fence.length
      ) {
        fence = null;
      }

      continue;
    }

    const opening = /^ {0,3}(?<run>`{3,}|~{3,})(?<rest>.*)$/u.exec(content);
    const run = opening?.[1];
    const marker = run?.[0];

    if (
      run !== undefined &&
      (marker === "~" ||
        (marker === "`" && opening?.[2]?.includes("`") === false))
    ) {
      fence = { marker, length: run.length };
      continue;
    }

    if (content.startsWith("## ")) {
      headings.push({ start: line.start, heading: content.slice(3).trim() });
    }
  }

  return headings;
};

/** Measures each top-level `## ` section as additive UTF-8 bytes, including unsectioned text. */
export const measureBrief = (text: string) => {
  const headings = collectHeadings(text);

  const sections: BriefSectionSize[] = [];
  const occurrences = new Map<string, number>();

  const add = (heading: string | null, start: number, end: number) => {
    const occurrence =
      heading === null ? 1 : (occurrences.get(heading) ?? 0) + 1;

    if (heading !== null) {
      occurrences.set(heading, occurrence);
    }

    sections.push({
      heading,
      occurrence,
      bytes: Buffer.byteLength(text.slice(start, end), "utf-8"),
    });
  };

  const preambleEnd = headings[0]?.start ?? text.length;

  if (preambleEnd > 0) {
    add(null, 0, preambleEnd);
  }

  for (const [index, current] of headings.entries()) {
    add(
      current.heading,
      current.start,
      headings[index + 1]?.start ?? text.length
    );
  }

  return { totalBytes: Buffer.byteLength(text, "utf-8"), sections };
};

export interface BriefSizeIo {
  readText: (file: string) => string;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
}

/** Prints one JSON report per input, in operand order, without changing the source files. */
export const runBriefSize = (files: readonly string[], io: BriefSizeIo) => {
  if (!files.length) {
    io.writeStderr(
      "Usage: node scripts/brief-size.ts <brief-file> [<brief-file> ...]\n"
    );

    return 1;
  }

  const reports: (BriefMeasurement & { file: string })[] = [];

  for (const file of files) {
    try {
      reports.push({ file, ...measureBrief(io.readText(file)) });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      io.writeStderr(`Unable to read ${JSON.stringify(file)}: ${detail}\n`);

      return 1;
    }
  }

  io.writeStdout(`${JSON.stringify(reports, null, 2)}\n`);

  return 0;
};

/** CLI entry point; input files must contain valid UTF-8. */
export const main = (files: readonly string[] = process.argv.slice(2)) =>
  runBriefSize(files, {
    readText: (file) => fs.readFileSync(file, "utf-8"),
    writeStdout: (text) => {
      process.stdout.write(text);
    },
    writeStderr: (text) => {
      process.stderr.write(text);
    },
  });

if (
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  process.exitCode = main();
}
