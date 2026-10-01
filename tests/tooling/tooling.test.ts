import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../helpers/fake-ports.ts';
import { hashes } from '../../scripts/generate-hashes.ts';
import { checkTerms, toolingRoot } from '../../scripts/check-terms.ts';
import { validateConfigs } from '../../scripts/validate-configs.ts';
import { diagram, writeDiagram } from '../../scripts/diagram.ts';
test('root-aware hash fixture recognizes contract and catches drift', () => {
  const root = tempDir(), skill = path.join(root, 'skills/dispatch'); fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), 'contract'); hashes(root);
  assert.deepEqual(hashes(root, true), []);
  fs.writeFileSync(path.join(skill, 'SKILL.md'), 'changed');
  assert.match(hashes(root, true).join(), /SKILL\.md/);
  hashes(root);
  assert.deepEqual(hashes(root, true), []);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(skill, 'skill-hashes.json'), 'utf8'))), ['SKILL.md']);
});
test('root-aware terminology fixture reports actionable paths while skipping code and glossary', () => {
  assert.equal(toolingRoot([]), '.'); assert.equal(toolingRoot(['--check']), '.'); assert.equal(toolingRoot(['--check', '--root', '.']), '.');
  for (const args of [['--root'], ['--root', '--check'], ['--check', '--root']]) assert.throws(() => toolingRoot(args), /--root requires a directory value/);
  const root = tempDir(), skill = path.join(root, 'skills/dispatch'); fs.mkdirSync(path.join(skill, 'references'), { recursive: true });
  fs.writeFileSync(path.join(skill, 'references/glossary.md'), '| Term | Banned synonym |\n|---|---|\n| subagent | sub-agent |\n');
  fs.writeFileSync(path.join(skill, 'SKILL.md'), 'Use a sub-agent.\n`sub-agent`\n```\nsub-agent\n```\n');
  const errors = checkTerms(root); assert.equal(errors.length, 1); assert.match(errors[0]!, /SKILL\.md:1.*subagent/);
});
test('root-aware strict config fixture validates sample without reading ignored local config', () => {
  const root = tempDir(), skill = path.join(root, 'skills/dispatch'); fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'config.sample.jsonc'), '{"read-delegates":{"codex":{"targets":[{"low":{"model":"test"}}]}}}');
  fs.writeFileSync(path.join(skill, 'config.local.jsonc'), 'invalid'); assert.deepEqual(validateConfigs(root), []);
  fs.writeFileSync(path.join(skill, 'config.sample.jsonc'), '{"unknown":true}'); assert.match(validateConfigs(root).join(), /config.sample.jsonc.*Unrecognized/);
});
test('machine diagrams are deterministic declared transitions written under the supplied root', () => {
  const root = tempDir(), rendered = diagram(); writeDiagram(root);
  assert.equal(fs.readFileSync(path.join(root, 'docs/dispatch-notes.md'), 'utf8'), rendered);
  assert.equal(diagram(), rendered); assert.match(rendered, /booting --> ask: RUN_STARTED/); assert.match(rendered, /## implement/);
});
