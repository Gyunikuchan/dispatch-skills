import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

interface BannedTerm {
  word: string;
  term: string;
}

const parseGlossaryTable = (source: string) => {
  const banned: BannedTerm[] = [];
  let column = -1;

  for (const line of source.split(/\r?\n/u)) {
    if (!line.startsWith("|")) {
      column = -1;

      continue;
    }

    const cells = line
      .replaceAll(/^\||\|$/gu, "")
      .split("|")
      .map((cell) => cell.trim());

    const header = cells.findIndex((cell) => /^Banned synonyms?$/iu.test(cell));

    if (header !== -1) {
      column = header;

      continue;
    }

    if (column < 0 || cells.every((cell) => /^:?-+:?$/u.test(cell))) {
      continue;
    }

    for (const word of (cells[column] ?? "")
      .split(/[,/]/u)
      .map((part) => part.trim())
      .filter(Boolean)) {
      banned.push({ word, term: cells[0] ?? "" });
    }
  }

  return banned;
};

const scanProseForTerms = (
  file: string,
  text: string,
  banned: readonly BannedTerm[]
) => {
  const errors: string[] = [];
  let fence = false;

  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (/^\s*(?<fence>```|~~~)/u.test(line)) {
      fence = !fence;

      continue;
    }

    if (fence) {
      continue;
    }

    const prose = line.replaceAll(/(?<tick>`+)[^`]*?\k<tick>/gu, " ");

    for (const { word, term } of banned) {
      const pattern = new RegExp(
        `(?<![\\w-])${word.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)}s?(?![\\w-])`,
        "iu"
      );

      if (pattern.test(prose)) {
        errors.push(`${file}:${index + 1}: ${word} (use ${term})`);
      }
    }
  }

  return errors;
};

export const checkTerms = (root: string) => {
  const skills = path.resolve(root, "skills");

  if (!fs.existsSync(skills)) {
    return [`${skills}: skills directory missing`];
  }

  const glossary = path.join(skills, "dispatch/references/glossary.md");

  let banned: BannedTerm[];

  try {
    banned = parseGlossaryTable(fs.readFileSync(glossary, "utf-8"));
  } catch (error) {
    return [`${glossary}: ${String(error)}`];
  }

  if (!banned.length) {
    return [`${glossary}: define a Banned synonym column`];
  }

  const errors: string[] = [];

  for (const relative of fs.readdirSync(skills, { recursive: true })) {
    const file = path.join(skills, String(relative));

    if (
      !file.endsWith(".md") ||
      !fs.statSync(file).isFile() ||
      file === glossary ||
      file.endsWith("README.md") ||
      file.includes(`${path.sep}readme${path.sep}`)
    ) {
      continue;
    }

    errors.push(
      ...scanProseForTerms(file, fs.readFileSync(file, "utf-8"), banned)
    );
  }

  return errors;
};

export const toolingRoot = (args: readonly string[]) => {
  const index = args.indexOf("--root");

  if (index === -1) {
    return ".";
  }

  const value = args[index + 1];

  if (value === undefined || value === "" || value.startsWith("--")) {
    throw new Error("--root requires a directory value");
  }

  return value;
};

if (
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const errors = checkTerms(toolingRoot(process.argv.slice(2)));

  if (errors.length) {
    process.stderr.write(`${errors.join("\n")}\n`);
    process.exitCode = 1;
  }
}
