import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../helpers/fake-ports.ts';

import { load, ARMS, SETTINGS, NOW, readBrief, type Json, fixture, defects, controls, prepared, scenario, ids, high } from '../helpers/audit-calibration.ts';

test('audit calibration fixture curates four categorized defects and two controls with verified excerpts', async () => {
  const { validateFixture } = await load();
  const f = fixture();
  validateFixture(f as never);
  assert.deepEqual(defects(f).map((c: Json) => c['category']).sort(), ['ambiguity', 'efficiency', 'handoff', 'recovery']);
  assert.equal(controls(f).length, 2);
  assert.ok(high(f).length >= 1);
});

test('audit calibration prepare rejects a defect without source provenance', async () => {
  const { prepare } = await load();
  const f = fixture();
  delete defects(f)[0]['source']['parent'];
  assert.throws(() => prepare({ fixture: f as never, workDir: tempDir(), settings: SETTINGS, now: NOW, readBrief }), /parent/);
});

test('audit calibration prepare rejects an excerpt whose text no longer matches its hash', async () => {
  const { prepare } = await load();
  const f = fixture();
  defects(f)[1]['excerpts'][0]['text'] += 'tampered\n';
  assert.throws(() => prepare({ fixture: f as never, workDir: tempDir(), settings: SETTINGS, now: NOW, readBrief }), /sha256/);
});

test('audit calibration prepare rejects a corpus missing a required defect category', async () => {
  const { prepare } = await load();
  const f = fixture();
  defects(f)[2]['category'] = 'ambiguity';
  assert.throws(() => prepare({ fixture: f as never, workDir: tempDir(), settings: SETTINGS, now: NOW, readBrief }), /categor/);
});

test('audit calibration prepare rejects missing host or model settings', async () => {
  const { prepare } = await load();
  assert.throws(() => prepare({ fixture: fixture() as never, workDir: tempDir(), settings: { ...SETTINGS, model: '' }, now: NOW, readBrief }), /model/);
});

test('audit calibration packets withhold answer keys, labels and fix commits from both arms', async () => {
  const { workDir, f } = await prepared();
  const { packetIds } = JSON.parse(fs.readFileSync(path.join(workDir, 'calibration', 'manifest.json'), 'utf8'));
  for (const arm of ARMS) {
    assert.deepEqual(fs.readdirSync(path.join(workDir, 'calibration', 'packets', arm)).filter((name) => /defect|control/i.test(name)), [], `${arm} packet filenames reveal the case kind`);
    for (const c of f['cases']) {
      const text = fs.readFileSync(path.join(workDir, 'calibration', 'packets', arm, `${packetIds[c.id]}.json`), 'utf8');
      const packet = JSON.parse(text);
      assert.equal(packet.caseId, packetIds[c.id]);
      assert.equal(text.includes(c.id), false, `${arm}/${c.id} leaks the labelled case id`);
      assert.equal(packet.scenario, c.scenario);
      assert.equal(packet.constraints.probes, false);
      for (const key of ['answer', 'kind', 'category', 'severity']) assert.equal(key in packet, false, `${arm}/${c.id} leaks ${key}`);
      for (const secret of Object.values(c.answer as Record<string, string>)) assert.equal(text.includes(secret), false, `${arm}/${c.id} leaks the answer key`);
      if (c.kind === 'defect') assert.equal(text.includes(c.source.commit), false, `${arm}/${c.id} leaks the fix commit`);
      for (const excerpt of packet.excerpts) assert.doesNotMatch(excerpt.text, /\/\/\s*NOTE\b/, `${arm}/${c.id} keeps a rationale comment that would reveal the answer`);
    }
  }
});

test('audit calibration manifest records settings, briefs and source hashes for both arms', async () => {
  const { workDir, f } = await prepared();
  const manifest = JSON.parse(fs.readFileSync(path.join(workDir, 'calibration', 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.settings, SETTINGS);
  assert.deepEqual(Object.keys(manifest.arms).sort(), ['new', 'old']);
  assert.equal(manifest.arms.old.commit, f['briefs'].old.commit);
  assert.match(manifest.arms.new.paths[0].sha256, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(manifest.cases).sort(), ids(f['cases']).sort());
  assert.match(manifest.answerKeySha256, /^sha256:[0-9a-f]{64}$/);
});
