#!/usr/bin/env node
import fs from 'node:fs';
import { isMainModule } from './common.mjs';
import { criterionMappings, mapVerificationCommandsToPaths, compareFailureIdentity, failureIdentity, normalizeDiagnostic } from './verification-evidence.mjs';

function arg(name, argv) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; }
function load(file) { return file === '-' ? JSON.parse(fs.readFileSync(0, 'utf8')) : JSON.parse(fs.readFileSync(file, 'utf8')); }
export function checkRedQuality(plan, evidence, red) {
  const mappings = criterionMappings(plan).filter(item => item.evidence === 'red');
  const commands = [...new Set(mappings.flatMap(item => item.commands))];
  const scoped = mapVerificationCommandsToPaths(plan, commands);
  const rows = (evidence.evidence ?? []).filter(item => typeof item === 'string' && item.startsWith('RED-MATRIX '));
  const defects = [];
  const seen = new Set();
  for (const raw of rows) {
    const match = /^RED-MATRIX\s+(SC\d+)\s*\|\s*([^|]+?)\s*\|\s*(.+)$/.exec(raw);
    if (!match) { defects.push('matrix row grammar is malformed'); continue; }
    const [, criterion, test, expected] = match;
    if (seen.has(criterion)) defects.push(`duplicate matrix row for ${criterion}`);
    seen.add(criterion);
    const item = mappings.find(entry => entry.id === criterion);
    if (!item) { defects.push(`unmapped criterion ${criterion}`); continue; }
    if (test.trim() === 'N/A') { if (!expected.trim()) defects.push(`${criterion} N/A requires a reason`); continue; }
    const paths = scoped[item.commands[0]] ?? [];
    const scopeText = `${test} ${item.commands.join(' ')}`;
    const commandScope = item.commands.some(command => command.split(/\s+/).some(token => token.endsWith('.test.mjs') && test.trim().includes(token)));
    if (paths.length > 0 && !commandScope && !paths.some(p => scopeText.includes(p))) defects.push(`${criterion} test is unmapped`);
    if (!/(?:exit\s*\d|\b(?:test|error|failed|failure):[^\s]+)/i.test(expected)) defects.push(`${criterion} expected failure lacks stable identity`);
    if (/durab|recover|resume/i.test(item.title + item.text) && !/interrupt|resume/i.test(expected)) defects.push(`${criterion} requires interruption and resume row`);
    if (/validat|secur|concurr/i.test(item.title + item.text) && !/adversarial|reject|invalid|negative/i.test(expected) && mappings.length > 2) defects.push(`${criterion} requires adversarial or rejection row`);
  }
  const normalizedRedDiagnostic = normalizeDiagnostic(red.diagnostic ?? '');
  for (const item of mappings) if (!seen.has(item.id) && !rows.some(raw => normalizeDiagnostic(raw.split('|').at(-1)?.replace(/\bexit\s*1\b/i, '').trim() ?? '') === normalizedRedDiagnostic)) defects.push(`missing matrix row for ${item.id}`);
  if (!mappings.length) {
    if (rows.length) defects.push('RED-MATRIX rows are invalid when the plan has no red criteria');
    return defects;
  }
  if (!red || red.exitStatus !== 1) defects.push('RED exit status mismatch');
  const commandText = red?.command ?? '';
  if (commands.length && !commands.some(command => commandText.includes(command.replace(/^.*?node --test\s*/, '')) || command === commandText)) defects.push('RED command mismatch');
  const stable = failureIdentity(red ?? {});
  const expected = rows.map(raw => raw.split('|').at(-1)?.trim()).filter(Boolean).find(value => /exit\s*1/i.test(value));
  if (expected) {
    const expectedIds = expected.match(/\b(?:test|error|failure):[^\s]+/gi) ?? [];
    const expectedDiagnostic = expected.replace(/\bexit\s*1\b/i, '').replace(/\b(?:test|error|failure):[^\s]+/gi, '').trim();
    const expectedIdentity = failureIdentity({ exitStatus: 1, identifiers: expectedIds, diagnostic: expectedDiagnostic });
    if (!compareFailureIdentity(stable, expectedIdentity)) defects.push('RED failure identity mismatch');
  }
  return defects;
}

function main(argv) {
  const planPath = arg('--plan', argv), evidencePath = arg('--evidence', argv), redPath = arg('--red', argv);
  if (!planPath || !evidencePath || !redPath) throw new Error('Usage: red-quality.mjs --plan <path> --evidence <json-file|-> --red <json-file|->');
  const plan = fs.readFileSync(planPath, 'utf8');
  const defects = checkRedQuality(plan, load(evidencePath), load(redPath));
  if (defects.length) { process.stderr.write(`[red-quality] ${defects.join('; ')}\n`); process.exitCode = 1; return; }
  process.stdout.write(JSON.stringify({ status: 'valid', criteria: criterionMappings(plan).filter(item => item.evidence === 'red').map(item => item.id) }) + '\n');
}
if (isMainModule(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { process.stderr.write(`[red-quality] ${error.message}\n`); process.exitCode = 2; }
}
