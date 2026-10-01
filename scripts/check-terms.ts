import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
export function checkTerms(root: string): string[] {
  const errors: string[] = [], skills = path.resolve(root, 'skills');
  if (!fs.existsSync(skills)) return [`${skills}: skills directory missing`];
  const glossary = path.join(skills, 'dispatch/references/glossary.md');
  const banned: { word: string; term: string }[] = [];
  try {
    let column = -1;
    for (const line of fs.readFileSync(glossary, 'utf8').split(/\r?\n/)) {
      if (!line.startsWith('|')) { column = -1; continue; }
      const cells = line.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
      const header = cells.findIndex((cell) => /^Banned synonyms?$/i.test(cell));
      if (header >= 0) { column = header; continue; }
      if (column < 0 || cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
      for (const word of (cells[column] ?? '').split(/[,/]/).map((word) => word.trim()).filter(Boolean)) banned.push({ word, term: cells[0] ?? '' });
    }
  } catch (error) { return [`${glossary}: ${String(error)}`]; }
  if (!banned.length) return [`${glossary}: define a Banned synonym column`];
  for (const relative of fs.readdirSync(skills, { recursive: true })) {
    const file = path.join(skills, String(relative));
    if (!file.endsWith('.md') || !fs.statSync(file).isFile() || file === glossary || file.endsWith('README.md') || file.includes(`${path.sep}readme${path.sep}`)) continue;
    const text = fs.readFileSync(file, 'utf8');
    let fence = false;
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; } if (fence) continue;
      const prose = line.replace(/(`+)[^`]*?\1/g, ' ');
      for (const { word, term } of banned) if (new RegExp(`(?<![\\w-])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?(?![\\w-])`, 'i').test(prose)) errors.push(`${file}:${index + 1}: ${word} (use ${term})`);
    }
  }
  return errors;
}
export function toolingRoot(args: readonly string[]): string {
  const index = args.indexOf('--root');
  if (index < 0) return '.';
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error('--root requires a directory value');
  return value;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) { const errors = checkTerms(toolingRoot(process.argv.slice(2))); if (errors.length) { process.stderr.write(`${errors.join('\n')}\n`); process.exitCode = 1; } }
