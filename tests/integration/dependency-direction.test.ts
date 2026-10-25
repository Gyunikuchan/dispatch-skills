import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';
import { LanguageVariant, SyntaxKind } from 'typescript/unstable/ast';
import { createScanner } from 'typescript/unstable/ast/scanner';
import { extractImports, OVERLAY_ROOT, resolveRelative, scanOverlay, type FileTable } from './scan.ts';

const SCRIPTS = 'skills/dispatch/scripts/';
type Layer = 'dispatch' | 'policy' | 'providers' | 'lib' | 'toolkit';

// Design § Layers: anything not listed is forbidden (which also rules out cycles).
export const ALLOWED: { readonly [K in Layer]: readonly Layer[] } = {
  dispatch: ['lib', 'providers', 'policy', 'toolkit'],
  policy: [],
  providers: ['lib'],
  lib: [],
  toolkit: ['toolkit', 'providers', 'lib', 'policy'],
};

const PURE: readonly Layer[] = ['policy'];
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
    if (!file.endsWith('.ts') || !file.startsWith(SCRIPTS)) continue;
    if (!layer) {
      errors.push(`dependency rule: ${file} is outside the shipped layers; move it to toolkit/, providers/, lib/ or policy/`);
      continue;
    }
    for (const { specifier, typeOnly } of extractImports(text)) {
      if (PURE.includes(layer) && IMPURE_MODULES.some((name) => specifier === name || specifier === `node:${name}`)) {
        errors.push(`purity rule: ${file} (${layer}) imports ${specifier}; pure layers do no I/O, so move it to toolkit/ or lib/`);
      }
      const target = resolveRelative(file, specifier);
      const targetLayer = target ? layerOf(target) : null;
      if (target && !targetLayer) {
        errors.push(`dependency rule: ${file} imports ${specifier} outside the shipped layers; use a surviving owner`);
        continue;
      }
      if (targetLayer === 'toolkit' && layer !== 'toolkit' && layer !== 'dispatch') {
        if (typeOnly && [SCRIPTS + 'toolkit/types.ts', SCRIPTS + 'toolkit/domain/types.ts'].includes(target!)) continue;
        errors.push(`dependency rule: ${file} imports ${specifier}; shared layers may only type-import toolkit/types.ts or toolkit/domain/types.ts`);
        continue;
      }
      if (!targetLayer || targetLayer === layer) continue;
      if (!ALLOWED[layer].includes(targetLayer)) {
        errors.push(`dependency rule: ${file} (${layer}) imports ${specifier} (${targetLayer}); ${layer} may import only ${ALLOWED[layer].join(', ') || 'nothing'}, so invert the dependency or move the code`);
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

test('dispatch entry imports only portable services and toolkit', () => {
  for (const layer of ['lib', 'providers', 'policy', 'toolkit']) {
    assert.deepEqual(checkDependencies([file(SCRIPTS + 'dispatch.ts', IMPORT + ' { X } from "./' + layer + '/example.ts";')]), []);
  }
  for (const layer of ['core', 'machines', 'effects', 'domain']) {
    assert.equal(checkDependencies([file(SCRIPTS + 'dispatch.ts', IMPORT + ' { X } from "./' + layer + '/example.ts";')]).length, 1);
    assert.equal(checkDependencies([file(SCRIPTS + 'dispatch.ts', IMPORT + ' type { X } from "./' + layer + '/types.ts";')]).length, 1);
  }
});

describe('toolkit import boundary', () => {
  test('shipped layers refuse relative imports outside the scripts tree', () => {
    for (const layer of ['toolkit', 'lib']) {
      for (const type of ['', 'type ']) {
        const errors = checkDependencies([file(SCRIPTS + layer + '/example.ts', IMPORT + ' ' + type + '{ X } from "../../../../tests/example.ts";')]);
        assert.equal(errors.length, 1, `${layer}: ${type || 'value'}`);
        assert.match(errors[0]!, /outside the shipped layers; use a surviving owner/);
      }
    }
  });
  test('shipped layers allow external packages and builtins', () => {
    for (const layer of ['toolkit', 'lib']) {
      for (const specifier of ['node:fs', 'typescript/unstable/ast']) {
        assert.deepEqual(checkDependencies([file(SCRIPTS + layer + '/example.ts', IMPORT + ' { X } from ' + JSON.stringify(specifier) + ';')]), []);
      }
    }
  });
  test('toolkit refuses removed engine layers including git effects', () => {
    for (const [specifier, type] of [['../core/types.ts', 'type '], ['../core/interpreter.ts', ''], ['../machines/implement.ts', ''], ['../effects/git.ts', ''], ['../domain/plan.ts', '']]) {
      const errors = checkDependencies([file(SCRIPTS + 'toolkit/example.ts', IMPORT + ' ' + type + '{ X } from ' + JSON.stringify(specifier) + ';')]);
      assert.equal(errors.length, 1, specifier);
      assert.match(errors[0]!, /toolkit/);
    }
  });
  test('toolkit allows portable services and its own domain', () => {
    for (const specifier of ['./domain/plan.ts', '../providers/types.ts', '../lib/session.ts', '../policy/roster.ts']) {
      assert.deepEqual(checkDependencies([file(SCRIPTS + 'toolkit/example.ts', IMPORT + ' { X } from ' + JSON.stringify(specifier) + ';')]), []);
    }
  });
  test('shared layers allow only type imports from the two toolkit type modules', () => {
    for (const layer of ['policy', 'providers', 'lib']) {
      for (const specifier of ['../toolkit/types.ts', '../toolkit/domain/types.ts']) {
        assert.deepEqual(checkDependencies([file(SCRIPTS + layer + '/example.ts', IMPORT + ' type { X } from ' + JSON.stringify(specifier) + ';')]), []);
        assert.equal(checkDependencies([file(SCRIPTS + layer + '/example.ts', IMPORT + ' { X } from ' + JSON.stringify(specifier) + ';')]).length, 1);
      }
      assert.equal(checkDependencies([file(SCRIPTS + layer + '/example.ts', IMPORT + ' type { X } from "../toolkit/cli.ts";')]).length, 1);
    }
  });
});

test('purity checks ignore performance in strings and comments', () => {
  assert.deepEqual(checkDependencies([file(`${SCRIPTS}policy/example.ts`,
    `const family = 'performance';`,
    '// ' + 'performance' + '.now() is an example only',
    `/* performance['now']() is example text */`,
  )]), []);
});

test('purity checks reject direct, computed, and captured performance identifiers', () => {
  const errors = checkDependencies([
    file(`${SCRIPTS}policy/direct.ts`, 'performance' + '.now();'),
    file(`${SCRIPTS}policy/computed.ts`, "performance['now']();"),
    file(`${SCRIPTS}policy/captured.ts`, 'const clock = performance;'),
  ]);
  assert.equal(errors.length, 3);
  assert.ok(errors.every((error) => error.includes('uses performance')));
});

test('dependency and purity violations identify the broken layer rule and corrective action', () => {
  const errors = checkDependencies([
    file(`${SCRIPTS}policy/example.ts`, `${IMPORT} fs from 'node:fs';`, `${IMPORT} { run } from '../providers/runner.ts';`, 'const t = new Date();'),
    file(`${SCRIPTS}unknown/example.ts`, ''),
    file(`${SCRIPTS}lib/config.ts`, `${IMPORT} type { X } from '../core/types.ts';`),
  ]);
  assert.equal(errors.length, 5);
  assert.match(errors[0] ?? '', /^purity rule: .*policy\/example\.ts .*node:fs.*move it to toolkit\/ or lib\//);
  assert.match(errors[1] ?? '', /^dependency rule: .*\(policy\) imports .*providers.*may import only nothing/);
  assert.match(errors[2] ?? '', /^purity rule: .*uses Date/);
  assert.match(errors[3] ?? '', /outside the shipped layers; move it/);
  assert.match(errors[4] ?? '', /outside the shipped layers; use a surviving owner/);
});
