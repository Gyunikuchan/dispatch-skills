import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import quietReporter, { formatDuration, formatFailure, formatSlowFiles } from '../../scripts/test-reporter.mjs';

describe('test-reporter', () => {
  describe('formatDuration', () => {
    it('formats millisecond durations (< 1000ms)', () => {
      assert.equal(formatDuration(0), '0ms');
      assert.equal(formatDuration(42.6), '43ms');
      assert.equal(formatDuration(999), '999ms');
    });

    it('formats second durations (>= 1000ms)', () => {
      assert.equal(formatDuration(1000), '1.00s');
      assert.equal(formatDuration(2500), '2.50s');
      assert.equal(formatDuration(16120), '16.12s');
    });
  });

  describe('formatFailure', () => {
    it('formats failure with location and error message', () => {
      const eventData = {
        name: 'test foo',
        file: '/repo/tests/foo.test.mjs',
        line: 12,
        column: 5,
        details: {
          error: {
            message: 'something broke',
            stack: 'Error: something broke\n    at /repo/tests/foo.test.mjs:12:5',
          },
        },
      };

      const out = formatFailure(eventData, '/repo');
      assert.ok(out.includes('✖ test foo'));
      assert.ok(out.includes('Location: tests/foo.test.mjs:12:5'));
      assert.ok(out.includes('Error: something broke'));
    });

    it('formats assertion failure with cause', () => {
      const eventData = {
        name: 'test bar',
        file: '/repo/tests/bar.test.mjs',
        line: 20,
        details: {
          error: {
            code: 'ERR_TEST_FAILURE',
            cause: {
              code: 'ERR_ASSERTION',
              message: 'expected true to equal false',
              stack: 'AssertionError: expected true to equal false\n    at /repo/tests/bar.test.mjs:20:5',
              operator: 'strictEqual',
              actual: true,
              expected: false,
            },
          },
        },
      };

      const out = formatFailure(eventData, '/repo');
      assert.ok(out.includes('✖ test bar'));
      assert.ok(out.includes('Location: tests/bar.test.mjs:20'));
      assert.ok(out.includes('AssertionError: expected true to equal false'));
      assert.ok(out.includes('Operator: strictEqual'));
    });
  });

  describe('quietReporter generator', () => {
    it('outputs concise success summary on all tests passing', async () => {
      async function* mockEvents() {
        yield {
          type: 'test:pass',
          data: { name: 'test 1', file: '/repo/test1.mjs', details: { type: 'test', duration_ms: 50 } },
        };
        yield {
          type: 'test:pass',
          data: { name: 'test 2', file: '/repo/test2.mjs', details: { type: 'test', duration_ms: 60 } },
        };
        yield {
          type: 'test:summary',
          data: {
            counts: { passed: 2, failed: 0, tests: 2, skipped: 1, todo: 0, topLevel: 2 },
            duration_ms: 110,
          },
        };
      }

      const chunks = [];
      for await (const chunk of quietReporter(mockEvents())) {
        chunks.push(chunk);
      }
      const output = chunks.join('');

      assert.ok(output.startsWith('✔ All 2 test(s) passed (110ms across 2 file(s), 1 skipped)'));
    });

    it('prints the first failure and exits without consuming later events', async () => {
      let consumedLaterEvent = false;
      async function* mockEvents() {
        yield {
          type: 'test:fail',
          data: {
            name: 'broken test',
            file: '/repo/test1.mjs',
            line: 15,
            details: {
              type: 'test',
              error: {
                message: 'assertion failed',
                stack: 'Error: assertion failed\n    at /repo/test1.mjs:15:3',
              },
            },
          },
        };
        consumedLaterEvent = true;
        yield { type: 'test:pass', data: { name: 'later test', file: '/repo/test2.mjs', details: { type: 'test' } } };
      }

      let output = '';
      let exitCode;
      const stderr = { write: (chunk) => { output += chunk; return true; } };
      for await (const chunk of quietReporter(mockEvents(), { stderr, exit: (code) => { exitCode = code; } })) {
        output += chunk;
      }

      assert.equal(exitCode, 1);
      assert.equal(consumedLaterEvent, false);
      assert.match(output, /--- Test Failure \(fail-fast\) ---/);
      assert.match(output, /✖ broken test/);
      assert.match(output, /Error: assertion failed/);
    });

    it('names the slowest files by summed top-level duration once one crosses 10s', async () => {
      const pass = (file, ms, nesting = 0) => ({ type: 'test:pass', data: { name: 't', file, nesting, details: { type: 'test', duration_ms: ms } } });
      async function* mockEvents() {
        yield pass('/repo/slow.mjs', 6000);
        yield pass('/repo/slow.mjs', 6000);
        yield pass('/repo/slow.mjs', 9000, 1);
        yield pass('/repo/fast.mjs', 200);
        yield { type: 'test:summary', data: { counts: { passed: 3, failed: 0, tests: 3, topLevel: 3 }, duration_ms: 12000 } };
      }
      const chunks = [];
      for await (const chunk of quietReporter(mockEvents())) chunks.push(chunk);
      assert.match(chunks.join(''), /\n {2}Slowest files: \S*slow\.mjs 12\.00s, \S*fast\.mjs 200ms\n$/);
      assert.match(formatSlowFiles(new Map([['/repo/slow.mjs', 12000], ['/repo/fast.mjs', 200]]), '/repo'), /Slowest files: slow\.mjs 12\.00s, fast\.mjs 200ms/);
      assert.equal(formatSlowFiles(new Map([['/repo/fast.mjs', 9999]])), '');
    });
  });
});
