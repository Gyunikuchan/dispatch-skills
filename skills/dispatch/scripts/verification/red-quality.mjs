import { criterionMappings, mapVerificationCommandsToPaths, compareFailureIdentity, failureIdentity, normalizeDiagnostic } from './evidence.mjs';

// Full identifier grammar: matches to the next `;` (or end), so names containing spaces stay whole.
const IDENTIFIER_PATTERN = /\b(?:test|error|failure):[^;]+/g;
export function parseIdentifiers(text) {
  // A bare prefix (`test:` with no name) carries no identity.
  return (String(text ?? '').match(IDENTIFIER_PATTERN) ?? []).map(value => value.trim()).filter(value => /:\s*\S/.test(value));
}
export function stripIdentifierSpans(text) { return String(text ?? '').replace(IDENTIFIER_PATTERN, ''); }
function commandMatches(commandText, command) { return commandText.includes(command.replace(/^.*?node --test\s*/, '')) || command === commandText; }
export function checkRedQuality(plan, evidence, red) {
  const allMappings = criterionMappings(plan);
  const mappings = allMappings.filter(item => item.evidence === 'red');
  const commands = [...new Set(mappings.flatMap(item => item.commands))];
  const scoped = mapVerificationCommandsToPaths(plan, commands);
  const rows = (evidence.evidence ?? []).filter(item => typeof item === 'string' && item.startsWith('RED-MATRIX '));
  const defects = [];
  const seen = new Set();
  const parsedRows = [];
  for (const raw of rows) {
    const match = /^RED-MATRIX\s+(SC\d+)\s*\|\s*([^|]+?)\s*\|\s*(.+)$/.exec(raw);
    if (!match) { defects.push('matrix row grammar is malformed'); continue; }
    const [, criterion, test, expected] = match;
    if (seen.has(criterion)) defects.push(`duplicate matrix row for ${criterion}`);
    seen.add(criterion);
    const item = mappings.find(entry => entry.id === criterion);
    if (!item) { defects.push(`unmapped criterion ${criterion}`); continue; }
    if (test.trim() === 'N/A') { if (!expected.trim()) defects.push(`${criterion} N/A requires a reason`); continue; }
    parsedRows.push({ id: criterion, item, expected: expected.trim() });
    const paths = scoped[item.commands[0]] ?? [];
    const scopeText = `${test} ${item.commands.join(' ')}`;
    const commandScope = item.commands.some(command => command.split(/\s+/).some(token => token.endsWith('.test.mjs') && test.trim().includes(token)));
    if (paths.length > 0 && !commandScope && !paths.some(p => scopeText.includes(p))) defects.push(`${criterion} test is unmapped`);
    if (!/exit\s*\d/i.test(expected) && parseIdentifiers(expected).length === 0) defects.push(`${criterion} expected failure lacks stable identity`);
    if (/durab|recover|resume/i.test(item.title + item.text) && !/interrupt|resume/i.test(expected)) defects.push(`${criterion} requires interruption and resume row`);
    if (/validat|secur|concurr/i.test(item.title + item.text) && !/adversarial|reject|invalid|negative/i.test(expected) && mappings.length > 2) defects.push(`${criterion} requires adversarial or rejection row`);
  }
  const normalizedRedDiagnostic = normalizeDiagnostic(red.diagnostic ?? '');
  for (const item of mappings) if (!seen.has(item.id) && !rows.some(raw => normalizeDiagnostic(stripIdentifierSpans(raw.split('|').at(-1)?.replace(/\bexit\s*1\b/i, '').trim() ?? '')) === normalizedRedDiagnostic)) defects.push(`missing matrix row for ${item.id}`);
  if (!mappings.length) {
    if (rows.length) defects.push('RED-MATRIX rows are invalid when the plan has no red criteria');
    return defects;
  }
  if (!red || red.exitStatus !== 1) defects.push('RED exit status mismatch');
  const commandText = red?.command ?? '';
  // Aggregate or non-red commands (e.g. `npm test`) are not RED identities; a command naming a test file
  // that no criterion maps is a mis-targeted RED run.
  const namesTestFile = /\S+\.(?:test|spec)\.[cm]?[jt]sx?\b/.test(commandText);
  if (namesTestFile && !allMappings.some(item => item.commands.some(command => commandMatches(commandText, command)))) defects.push(`RED result for unmapped command ${commandText}`);
  const forCommand = parsedRows.filter(row => row.item.commands.some(command => commandMatches(commandText, command)));
  for (const row of forCommand) {
    // The claimed RED exit is the token immediately before the identifiers, not an earlier prose mention.
    const exit = /\bexit\s*(\d+)\s+(?=(?:test|error|failure):)/i.exec(row.expected) ?? /\bexit\s*(\d+)\b/i.exec(row.expected);
    if (exit && red && Number(exit[1]) !== red.exitStatus) defects.push(`${row.id} RED exit status mismatch`);
  }
  const mappedForCommand = forCommand.filter(row => /\bexit\s*1\b/i.test(row.expected));
  if (mappedForCommand.length) {
    const stable = failureIdentity(red ?? {});
    const expectedIds = [...new Set(mappedForCommand.flatMap(row => parseIdentifiers(row.expected)))];
    const expectedDiagnostic = normalizeDiagnostic(stripIdentifierSpans(mappedForCommand[0].expected).replace(/\bexit\s*1\b/i, '').trim());
    const expectedIdentity = failureIdentity({ exitStatus: 1, identifiers: expectedIds, diagnostic: expectedDiagnostic });
    if (!compareFailureIdentity(stable, expectedIdentity)) defects.push('RED failure identity mismatch');
  }
  return defects;
}
