// @ts-check
import {
  compareFailureIdentity,
  criterionMappings,
  failureIdentity,
  mapVerificationCommandsToPaths,
  normalizeDiagnostic,
} from './evidence.mjs';

// SECTION: RED policy

// Matches through the next semicolon so full test names containing spaces retain identity.
const IDENTIFIER_PATTERN = /\b(?:test|error|failure):[^;]+/g;
const MATRIX_PATTERN = /^RED-MATRIX\s+(SC\d+)\s*\|\s*([^|]+?)\s*\|\s*(.+)$/;
const TEST_FILE_PATTERN = /\S+\.(?:test|spec)\.[cm]?[jt]sx?\b/;
const EXIT_PATTERN = /\bexit\s*(\d+)\b/i;
const EXIT_BEFORE_IDENTITY_PATTERN = /\bexit\s*(\d+)\s+(?=(?:test|error|failure):)/i;

/** @param {unknown} text */
export function parseIdentifiers(text) {
  // A bare prefix (`test:` with no name) carries no identity.
  return (String(text ?? '').match(IDENTIFIER_PATTERN) ?? [])
    .map(value => value.trim())
    .filter(value => /:\s*\S/.test(value));
}

/** @param {unknown} text */
export function stripIdentifierSpans(text) {
  return String(text ?? '').replace(IDENTIFIER_PATTERN, '');
}

/** @param {string} commandText @param {string} command */
function commandMatches(commandText, command) {
  return commandText.includes(command.replace(/^.*?node --test\s*/, '')) || command === commandText;
}

/** @param {string} expected */
function expectedDiagnostic(expected) {
  return normalizeDiagnostic(stripIdentifierSpans(expected.replace(/\bexit\s*1\b/i, '').trim()));
}

/**
 * Return every RED evidence defect without short-circuiting, preserving full failure attribution.
 *
 * @param {string} plan
 * @param {{ evidence?: unknown[] }} evidence
 * @param {{ exitStatus?: number, identifiers?: unknown[], diagnostic?: unknown, command?: string }} red
 */
export function checkRedQuality(plan, evidence, red) {
  const allMappings = criterionMappings(plan);
  const mappings = allMappings.filter(item => item.evidence === 'red');
  const commands = [...new Set(mappings.flatMap(item => item.commands))];
  const scopedPaths = mapVerificationCommandsToPaths(plan, commands);
  const rows = (evidence.evidence ?? [])
    .filter((item) => typeof item === 'string' && item.startsWith('RED-MATRIX '))
    .map(String);
  const defects = [];
  const seen = new Set();
  const parsedRows = [];

  // SECTION: Matrix validation

  for (const raw of rows) {
    const match = MATRIX_PATTERN.exec(raw);
    if (!match) {
      defects.push('matrix row grammar is malformed');
      continue;
    }

    const [, criterion, test, expectedValue] = match;
    const expected = expectedValue.trim();
    if (seen.has(criterion)) defects.push(`duplicate matrix row for ${criterion}`);
    seen.add(criterion);

    const item = mappings.find(entry => entry.id === criterion);
    if (!item) {
      defects.push(`unmapped criterion ${criterion}`);
      continue;
    }
    if (test.trim() === 'N/A') {
      if (!expected) defects.push(`${criterion} N/A requires a reason`);
      continue;
    }

    parsedRows.push({ id: criterion, item, expected });
    const paths = scopedPaths[item.commands[0]] ?? [];
    const scopeText = `${test} ${item.commands.join(' ')}`;
    const commandScope = item.commands.some(command =>
      command.split(/\s+/).some(token => token.endsWith('.test.mjs') && test.trim().includes(token))
    );
    if (paths.length > 0 && !commandScope && !paths.some(file => scopeText.includes(file))) {
      defects.push(`${criterion} test is unmapped`);
    }
    if (!/exit\s*\d/i.test(expected) && parseIdentifiers(expected).length === 0) {
      defects.push(`${criterion} expected failure lacks stable identity`);
    }
    if (/durab|recover|resume/i.test(item.title + item.text) && !/interrupt|resume/i.test(expected)) {
      defects.push(`${criterion} requires interruption and resume row`);
    }
    if (/validat|secur|concurr/i.test(item.title + item.text) &&
        !/adversarial|reject|invalid|negative/i.test(expected) && mappings.length > 2) {
      defects.push(`${criterion} requires adversarial or rejection row`);
    }
  }

  const redDiagnostic = normalizeDiagnostic(red.diagnostic ?? '');
  for (const item of mappings) {
    const diagnosticMatches = rows.some(raw => expectedDiagnostic(raw.split('|').at(-1) ?? '') === redDiagnostic);
    if (!seen.has(item.id) && !diagnosticMatches) defects.push(`missing matrix row for ${item.id}`);
  }
  if (!mappings.length) {
    if (rows.length) defects.push('RED-MATRIX rows are invalid when the plan has no red criteria');
    return defects;
  }

  // SECTION: Observed RED validation

  if (red.exitStatus !== 1) defects.push('RED exit status mismatch');
  const commandText = red.command ?? '';
  // Aggregate commands are not RED identities; named test files must map to a criterion.
  if (TEST_FILE_PATTERN.test(commandText) &&
      !allMappings.some(item => item.commands.some(command => commandMatches(commandText, command)))) {
    defects.push(`RED result for unmapped command ${commandText}`);
  }

  const commandRows = parsedRows.filter(row =>
    row.item.commands.some(command => commandMatches(commandText, command))
  );
  for (const row of commandRows) {
    // Prefer the exit immediately before identifiers because prose may mention another exit first.
    const exit = EXIT_BEFORE_IDENTITY_PATTERN.exec(row.expected) ?? EXIT_PATTERN.exec(row.expected);
    if (exit && Number(exit[1]) !== red.exitStatus) defects.push(`${row.id} RED exit status mismatch`);
  }

  const identityRows = commandRows.filter(row => /\bexit\s*1\b/i.test(row.expected));
  if (identityRows.length) {
    const expectedIds = [...new Set(identityRows.flatMap(row => parseIdentifiers(row.expected)))];
    const expected = failureIdentity({
      exitStatus: 1,
      identifiers: expectedIds,
      diagnostic: expectedDiagnostic(identityRows[0].expected),
    });
    if (!compareFailureIdentity(failureIdentity(red), expected)) {
      defects.push('RED failure identity mismatch');
    }
  }
  return defects;
}
