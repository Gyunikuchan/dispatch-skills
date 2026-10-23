import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';
import { LanguageVariant, SyntaxKind } from 'typescript/unstable/ast';
import { createScanner } from 'typescript/unstable/ast/scanner';
import { extractImports, OVERLAY_ROOT, resolveRelative, scanOverlay, type FileTable } from './scan.ts';

const SCRIPTS = 'skills/dispatch/scripts/';
type Layer = 'dispatch' | 'core' | 'machines' | 'policy' | 'domain' | 'effects' | 'providers' | 'lib' | 'toolkit';

// Design § Layers: anything not listed is forbidden (which also rules out cycles).
export const ALLOWED: { readonly [K in Layer]: readonly Layer[] } = {
  dispatch: ['core', 'policy', 'effects', 'providers', 'lib'],
  core: ['machines', 'policy', 'domain', 'effects', 'lib'],
  machines: ['policy', 'domain'],
  policy: ['domain'],
  domain: [],
  effects: ['providers', 'policy', 'domain', 'lib'],
  providers: ['lib'],
  lib: [],
  toolkit: ['toolkit', 'providers', 'lib', 'policy', 'effects'], // checkDependencies restricts effects to effects/git.ts.
};

const PURE: readonly Layer[] = ['machines', 'policy', 'domain'];
const IMPURE_MODULES = ['fs', 'child_process', 'os'];
const IMPURE_TOKENS: readonly [RegExp, string][] = [
  [/\bDate\b/, 'Date'], [/\bMath\.random\b/, 'Math.random'], [/\bprocess\.env\b/, 'process.env'], [/\bperformance\b/, 'performance'],
];
const REGEX_PREFIXES = new Set(['(', '[', '{', ',', ';', ':', '?', '=', '!', '~', '+', '-', '*', '%', '&', '|', '^', '&&', '||', '??', '=>', 'return', 'throw', 'case', 'delete', 'void', 'typeof', 'new', 'yield', 'await', 'else', 'do', 'instanceof', 'in', 'of']);

function hasIdentifier(text: string, name: string): boolean {
  const scanner = createScanner(true, LanguageVariant.Standard, text);
  let previous = '';
  for (let token = scanner.scan(); token !== SyntaxKind.EndOfFile; token = scanner.scan()) {
    if (token === SyntaxKind.SlashToken && REGEX_PREFIXES.has(previous)) token = scanner.reScanSlashToken();
    if (token === SyntaxKind.Identifier && scanner.getTokenText() === name) return true;
    previous = scanner.getTokenText();
  }
  return false;
}

function layerOf(file: string): Layer | null {
  if (!file.startsWith(SCRIPTS)) return null;
  const rest = file.slice(SCRIPTS.length);
  if (rest === 'dispatch.ts') return 'dispatch';
  const head = rest.split('/')[0] as Layer;
  return head in ALLOWED && rest.includes('/') ? head : null;
}

export function checkDependencies(files: FileTable): string[] {
  const errors: string[] = [];
  for (const { path: file, text } of files) {
    const layer = layerOf(file);
    if (!layer || !file.endsWith('.ts')) continue;
    const imports = extractImports(text);
    if (file === `${SCRIPTS}core/types.ts` && imports.length) {
      errors.push(`dependency rule: ${file} imports nothing (it is shared type-only by every layer); move the import's user out of core/types.ts`);
    }
    for (const { specifier, typeOnly } of imports) {
      if (PURE.includes(layer) && IMPURE_MODULES.some((name) => specifier === name || specifier === `node:${name}`)) {
        errors.push(`purity rule: ${file} (${layer}) imports ${specifier}; pure layers do no I/O, so move it to effects/ or lib/`);
      }
      const target = resolveRelative(file, specifier);
      const targetLayer = target ? layerOf(target) : null;
      if (layer === 'toolkit' && target) {
        if (!(targetLayer === 'toolkit' || targetLayer === 'providers' || targetLayer === 'lib' || targetLayer === 'policy' || target === SCRIPTS + 'effects/git.ts')) {
          errors.push('dependency rule: ' + file + ' (toolkit) imports ' + specifier + '; toolkit may import only toolkit/, providers/, lib/, policy/ and effects/git.ts');
        }
        continue;
      }
      if (targetLayer === 'toolkit' && layer !== 'toolkit') {
        errors.push('dependency rule: ' + file + ' imports toolkit/; legacy layers must not depend on toolkit');
        continue;
      }
      if (!targetLayer || targetLayer === layer) continue;
      if (layer !== 'toolkit' && typeOnly && target === `${SCRIPTS}core/types.ts`) continue;
      if (!ALLOWED[layer].includes(targetLayer)) {
        errors.push(`dependency rule: ${file} (${layer}) imports ${specifier} (${targetLayer}); ${layer} may import only ${ALLOWED[layer].join(', ') || 'nothing'}, so invert the dependency or move the code`);
      } else if (layer === 'core' && !typeOnly && (targetLayer === 'machines' || targetLayer === 'effects') && file !== `${SCRIPTS}core/interpreter.ts`) {
        errors.push(`dependency rule: ${file} value-imports ${targetLayer}/; only core/interpreter.ts may, so route the call through the interpreter`);
      }
    }
    if (PURE.includes(layer)) {
      for (const [pattern, token] of IMPURE_TOKENS) {
        if (pattern.test(text) && (token !== 'performance' || hasIdentifier(text, token))) errors.push(`purity rule: ${file} (${layer}) uses ${token}; pure layers read time and randomness only from events, so pass it in`);
      }
    }
  }
  return errors;
}

test('the overlay obeys the dependency matrix and purity rules', () => {
  const scriptsRoot = path.join(OVERLAY_ROOT, 'skills/dispatch/scripts');
  const files = scanOverlay(scriptsRoot).map((entry) => ({ ...entry, path: `${SCRIPTS}${entry.path}` }));
  assert.deepEqual(checkDependencies(files), []);
});

const IMPORT = 'imp' + 'ort';
const file = (path: string, ...lines: string[]) => ({ path, text: lines.join('\n') });

describe('toolkit import boundary', () => {
  test('toolkit refuses legacy engine and non git effects imports', () => {
    for (const [specifier, type] of [['../core/types.ts', 'type '], ['../core/interpreter.ts', ''], ['../machines/implement.ts', ''], ['../effects/parse-artifact.ts', '']]) {
      const errors = checkDependencies([file(SCRIPTS + 'toolkit/example.ts', IMPORT + ' ' + type + '{ X } from ' + JSON.stringify(specifier) + ';')]);
      assert.equal(errors.length, 1, specifier);
      assert.match(errors[0]!, /toolkit/);
    }
  });
  test('toolkit allows portable services and its own domain', () => {
    for (const specifier of ['./domain/plan.ts', '../providers/types.ts', '../lib/session.ts', '../policy/roster.ts', '../effects/git.ts']) {
      assert.deepEqual(checkDependencies([file(SCRIPTS + 'toolkit/example.ts', IMPORT + ' { X } from ' + JSON.stringify(specifier) + ';')]), []);
    }
  });
  test('legacy layers cannot depend on toolkit', () => {
    for (const layer of ['core', 'machines', 'policy', 'domain', 'effects', 'providers', 'lib']) {
      assert.equal(checkDependencies([file(SCRIPTS + layer + '/example.ts', IMPORT + ' type { X } from "../toolkit/types.ts";')]).length, 1);
    }
  });
});

test('purity checks ignore performance in strings and comments', () => {
  assert.deepEqual(checkDependencies([file(`${SCRIPTS}domain/report.ts`,
    `const family = 'performance';`,
    '// ' + 'performance' + '.now() is an example only',
    `/* performance['now']() is example text */`,
  )]), []);
});

test('purity checks reject direct, computed, and captured performance identifiers', () => {
  const errors = checkDependencies([
    file(`${SCRIPTS}domain/direct.ts`, 'performance' + '.now();'),
    file(`${SCRIPTS}domain/computed.ts`, "performance['now']();"),
    file(`${SCRIPTS}domain/captured.ts`, 'const clock = performance;'),
  ]);
  assert.equal(errors.length, 3);
  assert.ok(errors.every((error) => error.includes('uses performance')));
});

test('dependency and purity violations identify the broken layer rule and corrective action', () => {
  const errors = checkDependencies([
    file(`${SCRIPTS}machines/root.ts`, `${IMPORT} fs from 'node:fs';`, `${IMPORT} { run } from '../effects/wave.ts';`, 'const t = new Date();'),
    file(`${SCRIPTS}core/frame.ts`, `${IMPORT} { step } from '../machines/root.ts';`),
    file(`${SCRIPTS}core/types.ts`, `${IMPORT} type { X } from '../lib/x.ts';`),
    file(`${SCRIPTS}lib/config.ts`, `${IMPORT} type { Ports } from '../core/types.ts';`),
    file(`${SCRIPTS}core/interpreter.ts`, `${IMPORT} { step } from '../machines/root.ts';`),
  ]);
  assert.equal(errors.length, 5);
  assert.match(errors[0] ?? '', /^purity rule: .*machines\/root\.ts .*node:fs.*move it to effects\/ or lib\//);
  assert.match(errors[1] ?? '', /^dependency rule: .*\(machines\) imports .*effects.*may import only policy, domain/);
  assert.match(errors[2] ?? '', /^purity rule: .*uses Date/);
  assert.match(errors[3] ?? '', /only core\/interpreter\.ts may/);
  assert.match(errors[4] ?? '', /core\/types\.ts imports nothing/);
});
