import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { designRootSlug } from '../../../skills/dispatch/scripts/ledger.mjs';

describe('design promotion identity', () => {
  it('reuses the ordinary root slug for a design path', () => {
    assert.equal(designRootSlug('.scratch/plan/2026-09-20-platform-design.md'), 'platform');
  });
});
