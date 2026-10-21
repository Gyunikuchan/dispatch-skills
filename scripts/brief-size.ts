import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type BriefSectionSize = { heading: string | null; occurrence: number; bytes: number };
export type BriefMeasurement = { totalBytes: number; sections: BriefSectionSize[] };

type Line = { start: number; end: number; content: string };

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  for (let start = 0; start < text.length;) {
    const newline = text.indexOf('\n', start);
    const end = newline < 0 ? text.length : newline + 1;
    const contentEnd = newline < 0 ? text.length : newline > start && text[newline - 1] === '\r' ? newline - 1 : newline;
    lines.push({ start, end, content: text.slice(start, contentEnd) });
    start = end;
  }
  return lines;
}

/** Measures each top-level `## ` section as additive UTF-8 bytes, including unsectioned text. */
export function measureBrief(text: string): BriefMeasurement {
  const headings: { start: number; heading: string }[] = [];
  let fence: { marker: '`' | '~'; length: number } | null = null;

  for (const line of linesOf(text)) {
    const content = line.start === 0 ? line.content.replace(/^\uFEFF/, '') : line.content;
    if (fence) {
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(content)?.[1];
      if (closing && closing[0] === fence.marker && closing.length >= fence.length) fence = null;
      continue;
    }

    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
    const marker = opening?.[1];
    if (marker && (marker[0] === '~' || !opening![2]!.includes('`'))) {
      fence = { marker: marker[0] as '`' | '~', length: marker.length };
      continue;
    }

    if (content.startsWith('## ')) headings.push({ start: line.start, heading: content.slice(3).trim() });
  }

  const sections: BriefSectionSize[] = [];
  const occurrences = new Map<string, number>();
  const add = (heading: string | null, start: number, end: number) => {
    const occurrence = heading === null ? 1 : (occurrences.get(heading) ?? 0) + 1;
    if (heading !== null) occurrences.set(heading, occurrence);
    sections.push({ heading, occurrence, bytes: Buffer.byteLength(text.slice(start, end), 'utf8') });
  };

  if (!headings.length) {
    if (text.length) add(null, 0, text.length);
  } else {
    if (headings[0]!.start > 0) add(null, 0, headings[0]!.start);
    for (let index = 0; index < headings.length; index++) {
      const current = headings[index]!;
      add(current.heading, current.start, headings[index + 1]?.start ?? text.length);
    }
  }

  return { totalBytes: Buffer.byteLength(text, 'utf8'), sections };
}

export type BriefSizeIo = {
  readText(file: string): string;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
};

/** Prints one JSON report per input, in operand order, without changing the source files. */
export function runBriefSize(files: readonly string[], io: BriefSizeIo): number {
  if (!files.length) {
    io.writeStderr('Usage: node scripts/brief-size.ts <brief-file> [<brief-file> ...]\n');
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
}

/** CLI entry point; input files must contain valid UTF-8. */
export function main(files: readonly string[] = process.argv.slice(2)): number {
  return runBriefSize(files, {
    readText: (file) => fs.readFileSync(file, 'utf8'),
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.exitCode = main();
