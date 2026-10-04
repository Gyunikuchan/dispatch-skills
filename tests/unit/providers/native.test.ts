import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nativeDescriptor, retryPosition } from '../../../skills/dispatch/scripts/providers/native.ts';

test('delegates-native-fallback-descriptors: descriptors carry every closed field', () => {
  const fallback = nativeDescriptor({
    slot: 'agy[0]', platform: 'agy', models: ['gemini-pro', 'gemini-flash'], effort: 'high', substitutes: true, cascadePosition: 1,
    promptPath: '/r/p.md', outputPath: '/r/o.md', attachments: ['/a.ts'],
  });
  assert.deepEqual(fallback, {
    sourceKey: 'agy[0]#fallback', agentType: 'research', model: 'gemini-flash', reasoningEffort: 'high', substitutesFor: 'agy[0]',
    cascadePosition: 1, modelCascade: ['gemini-pro', 'gemini-flash'], promptPath: '/r/p.md', outputPath: '/r/o.md', attachments: ['/a.ts'],
  });
  const only = nativeDescriptor({ slot: 'claude[1]', platform: 'claude', models: [], effort: null, substitutes: false, cascadePosition: 0, promptPath: '/p', outputPath: '/o', attachments: [] });
  assert.equal(only.sourceKey, 'claude[1]');
  assert.equal(only.substitutesFor, null);
  assert.equal(only.agentType, 'explore');
  assert.equal(only.model, null);
  assert.equal(nativeDescriptor({ ...{ slot: 's', models: ['m'], effort: null, substitutes: true, cascadePosition: 0, promptPath: '', outputPath: '', attachments: [] }, platform: 'codex' }).agentType, 'explore');
});

test('delegates-early-fallbacks: an empty early capture retries at its position; a confirmed rejection advances', () => {
  assert.equal(retryPosition('empty', 0), 0);
  assert.equal(retryPosition('rejected', 0), 1);
});
