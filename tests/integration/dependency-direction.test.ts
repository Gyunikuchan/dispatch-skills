import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractImports, resolveRelative, scanOverlay, type FileTable } from './scan.ts';

const SCRIPTS = 'skills/dispatch/scripts/';
type Layer = 'dispatch' | 'core' | 'machines' | 'policy' | 'domain' | 'effects' | 'providers' | 'lib';

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
};

const PURE: readonly Layer[] = ['machines', 'policy', 'domain'];
const IMPURE_MODULES = ['fs', 'child_process', 'os'];
const IMPURE_TOKENS: readonly [RegExp, string][] = [
  [/\bDate\b/, 'Date'], [/\bMath\.random\b/, 'Math.random'], [/\bprocess\.env\b/, 'process.env'], [/\bperformance\b/, 'performance'],
];

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
      if (!targetLayer || targetLayer === layer) continue;
      if (typeOnly && target === `${SCRIPTS}core/types.ts`) continue;
      if (!ALLOWED[layer].includes(targetLayer)) {
        errors.push(`dependency rule: ${file} (${layer}) imports ${specifier} (${targetLayer}); ${layer} may import only ${ALLOWED[layer].join(', ') || 'nothing'}, so invert the dependency or move the code`);
      } else if (layer === 'core' && !typeOnly && (targetLayer === 'machines' || targetLayer === 'effects') && file !== `${SCRIPTS}core/interpreter.ts`) {
        errors.push(`dependency rule: ${file} value-imports ${targetLayer}/; only core/interpreter.ts may, so route the call through the interpreter`);
      }
    }
    if (PURE.includes(layer)) {
      for (const [pattern, token] of IMPURE_TOKENS) {
        if (pattern.test(text)) errors.push(`purity rule: ${file} (${layer}) uses ${token}; pure layers read time and randomness only from events, so pass it in`);
      }
    }
  }
  return errors;
}

test('the overlay obeys the dependency matrix and purity rules', () => {
  assert.deepEqual(checkDependencies(scanOverlay()), []);
});

const IMPORT = 'imp' + 'ort';
const file = (path: string, ...lines: string[]) => ({ path, text: lines.join('\n') });

test('violations name the rule and the fix', () => {
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
