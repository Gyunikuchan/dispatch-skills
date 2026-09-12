import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  COUNTS_PREFIX,
  SEVERITIES,
  STATUSES,
  cmdInit,
  cmdSet,
  isMain,
  loadReport,
  parseFindings,
  positionals,
  primaryFile,
  ranked,
  refreshCounts,
  selectBatch,
  statusLine,
  toPosix,
} from '../../../.agents/skills/audit-dispatch-skills-fix/scripts/status.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================================
// SECTION: Fixtures
// ============================================================================

/** Writes `body` to a fresh temp dir and returns its path. Never touches `.scratch/`. */
function fixture(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-fixture-'));
  const file = path.join(dir, 'report.md');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

/** One finding block in the § "5. Write the report" shape. */
function finding({ id, title = 'Title', severity = 'low', file = 'a/b.mjs', line = 1, status = null }) {
  return [
    `#### ${id}: ${title}`,
    `- **${severity}** · code · Verified · audit-dispatch-skills`,
    ...(status ? [`- **Status**: ${status}`] : []),
    `- **Location**: \`${file}:${line}\``,
    `- **Claim**: Something is wrong.`,
    '',
  ].join('\n');
}

function report(findings, { preamble = '', trailing = '' } = {}) {
  return ['# Audit', '', '## 3. Findings', preamble, '', ...findings, trailing].join('\n');
}

const readFindings = (file) => parseFindings(loadReport(file));

// ============================================================================
// SECTION: Parsing
// ============================================================================

describe('status.mjs parsing', () => {
  it('parses a report in the § "5. Write the report" shape', () => {
    const file = fixture(
      report([
        finding({ id: 'A-1', title: 'First', severity: 'high', file: 'x/one.mjs' }),
        finding({ id: 'A-2', title: 'Second', severity: 'low', file: 'y/two.mjs', status: 'fixed — landed in abc123' }),
      ]),
    );
    const findings = readFindings(file);
    assert.equal(findings.length, 2);
    assert.deepEqual(
      findings.map((f) => [f.id, f.severity, f.status, f.note, primaryFile(f.location)]),
      [
        ['A-1', 'high', 'open', '', 'x/one.mjs'],
        ['A-2', 'low', 'fixed', 'landed in abc123', 'y/two.mjs'],
      ],
    );
  });

  it('throws and names the finding when a meta line is missing a separator', () => {
    const broken = ['#### A-1: Broken', '- **low** code · Verified · sources', '- **Location**: `a/b.mjs:1`', ''].join('\n');
    const file = fixture(report([broken, finding({ id: 'A-2' })]));
    assert.throws(() => readFindings(file), (err) => /A-1/.test(err.message) && /severity/i.test(err.message));
  });

  it('throws and names the valid statuses on an unknown status token', () => {
    const file = fixture(report([finding({ id: 'A-1', status: 'wontfix' })]));
    assert.throws(() => readFindings(file), (err) => /A-1/.test(err.message) && /wontfix/.test(err.message));
  });

  it('ignores `#### A-<n>` headings outside the findings section', () => {
    const file = fixture(
      report([finding({ id: 'A-1' })], {
        trailing: ['## 4. Appendix', '', finding({ id: 'A-99', title: 'Refuted' })].join('\n'),
      }),
    );
    assert.deepEqual(
      readFindings(file).map((f) => f.id),
      ['A-1'],
    );
  });

  it('throws rather than returning [] when the findings section holds none', () => {
    const file = fixture(['# Audit', '', '## 3. Findings', '', 'Nothing here yet.', ''].join('\n'));
    assert.throws(() => readFindings(file), /yielded no findings/);
  });

  it('throws when the report has no findings section at all', () => {
    const file = fixture('# Audit\n\n## 2. Method\n\nNope.\n');
    assert.throws(() => loadReport(file), /no "## 3\. Findings" section/);
  });
});

// ============================================================================
// SECTION: Helpers
// ============================================================================

describe('status.mjs helpers', () => {
  it('ranks critical → nit and breaks ties numerically by id', () => {
    const rows = [
      { id: 'A-10', severity: 'low' },
      { id: 'A-2', severity: 'critical' },
      { id: 'A-9', severity: 'low' },
      { id: 'A-3', severity: 'nit' },
      { id: 'A-1', severity: 'high' },
    ];
    assert.deepEqual(
      ranked(rows).map((r) => r.id),
      ['A-2', 'A-1', 'A-9', 'A-10', 'A-3'],
    );
  });

  it('orders every severity in the declared order', () => {
    const rows = [...SEVERITIES].reverse().map((severity, i) => ({ id: `A-${i}`, severity }));
    assert.deepEqual(
      ranked(rows).map((r) => r.severity),
      SEVERITIES,
    );
  });

  it('extracts the first backticked path and falls back to (unlocated)', () => {
    assert.equal(primaryFile('`a/b.mjs:12`, `c/d.mjs:3`'), 'a/b.mjs');
    assert.equal(primaryFile('somewhere in the docs'), '(unlocated)');
  });

  it('skips --flag value pairs wherever they sit', () => {
    assert.deepEqual(positionals(['set', '--run', '2026-01-01-0000', 'A-3', 'fixed', '--note', 'x']), ['A-3', 'fixed']);
    assert.deepEqual(positionals(['set', 'A-3', '--note', 'x', 'fixed']), ['A-3', 'fixed']);
  });

  it('renders a status line with and without a note', () => {
    assert.equal(statusLine('open', ''), '- **Status**: open');
    assert.equal(statusLine('fixed', 'abc123'), '- **Status**: fixed — abc123');
  });

  it('converts platform separators to forward slashes', () => {
    assert.equal(toPosix(path.join('a', 'b', 'c.mjs')), 'a/b/c.mjs');
  });

  it('reports false for isMain when process.argv[1] is absent', () => {
    const saved = process.argv[1];
    try {
      process.argv[1] = undefined;
      assert.equal(isMain(import.meta.url), false);
    } finally {
      process.argv[1] = saved;
    }
  });

  it('reports false for isMain when the entry point is another file', () => {
    // status.mjs is imported here, never the entry point — so its own guard must not fire.
    const script = path.resolve(__dirname, '../../../.agents/skills/audit-dispatch-skills-fix/scripts/status.mjs');
    assert.equal(isMain(pathToFileURL(script).href), false);
  });

  it('reports true for isMain when reached through a symlinked path', function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-link-'));
    const target = path.join(dir, 'real.mjs');
    const link = path.join(dir, 'linked.mjs');
    fs.writeFileSync(target, '', 'utf8');
    try {
      fs.symlinkSync(target, link, 'file');
    } catch {
      // Windows without Developer Mode refuses symlinks to unprivileged processes.
      return this.skip('symlink creation not permitted');
    }
    const saved = process.argv[1];
    try {
      // Entry point is the symlink; the module URL Node computes is the realpath. A URL equality
      // check goes false here — the realpath comparison is what keeps the CLI running.
      process.argv[1] = link;
      assert.equal(isMain(pathToFileURL(target).href), true);
    } finally {
      process.argv[1] = saved;
    }
  });
});

// ============================================================================
// SECTION: Counts blockquote (A-61)
// ============================================================================

describe('refreshCounts', () => {
  it('inserts a blockquote when none exists, then rewrites rather than adds', () => {
    const file = fixture(report([finding({ id: 'A-1' }), finding({ id: 'A-2', status: 'fixed' })]));
    const first = refreshCounts(file);
    assert.equal(first.total, 2);
    assert.equal(first.counts.open, 1);
    assert.equal(first.counts.fixed, 1);
    refreshCounts(file);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    assert.equal(lines.filter((l) => l.startsWith(COUNTS_PREFIX)).length, 1);
  });

  it('rewrites a blockquote sitting five lines below the heading (A-61)', () => {
    const preamble = [
      '',
      'Legend: severity is the reviewer-assigned impact.',
      'Axes: code, tests, purpose, security, staleness.',
      '',
      `${COUNTS_PREFIX} open 9, fixed 9, false-positive 9, decision 9, deferred 9 (total 99).`,
    ].join('\n');
    const file = fixture(report([finding({ id: 'A-1' }), finding({ id: 'A-2' })], { preamble }));

    refreshCounts(file);
    refreshCounts(file);

    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const counts = lines.filter((l) => l.startsWith(COUNTS_PREFIX));
    assert.equal(counts.length, 1, 'a stale-window search duplicates the blockquote on every refresh');
    assert.match(counts[0], /open 2/);
    assert.match(counts[0], /total 2/);
    assert.ok(lines.includes('Legend: severity is the reviewer-assigned impact.'), 'preamble prose survives');
  });

  it('collapses duplicates left behind by the superseded fixed-window search', () => {
    const stale = `${COUNTS_PREFIX} open 9, fixed 9, false-positive 9, decision 9, deferred 9 (total 99).`;
    const file = fixture(report([finding({ id: 'A-1' })], { preamble: ['', stale, '', stale, '', stale].join('\n') }));

    refreshCounts(file);

    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const counts = lines.filter((l) => l.startsWith(COUNTS_PREFIX));
    assert.equal(counts.length, 1, 'a report corrupted by the old bug must converge back to one line');
    assert.match(counts[0], /open 1.*total 1/);
  });

  it('never rewrites a counts-shaped line quoted inside a finding body', () => {
    const quoting = [
      '#### A-1: Quotes the script output',
      '- **low** · code · Verified · sources',
      '- **Location**: `a/b.mjs:1`',
      '- **Evidence**: the banner reads',
      `${COUNTS_PREFIX} open 41, fixed 12, false-positive 0, decision 0, deferred 0 (total 53).`,
      '',
    ].join('\n');
    const file = fixture(report([quoting, finding({ id: 'A-2' })]));

    refreshCounts(file);

    const text = fs.readFileSync(file, 'utf8');
    assert.ok(
      text.includes(`${COUNTS_PREFIX} open 41, fixed 12, false-positive 0, decision 0, deferred 0 (total 53).`),
      'an unbounded search overwrites evidence inside a finding body',
    );
    const lines = text.split('\n');
    assert.equal(lines.filter((l) => l.startsWith(COUNTS_PREFIX)).length, 2, 'the quoted line plus one real blockquote');
    assert.ok(lines[lines.findIndex((l) => l === '## 3. Findings') + 2].startsWith(COUNTS_PREFIX));
  });
});

// ============================================================================
// SECTION: Batch composition (A-63)
// ============================================================================

describe('selectBatch', () => {
  const rows = (specs) => specs.map(([id, severity, file]) => ({ id, severity, location: `\`${file}:1\`` }));

  it('fills to --size from the remaining pool, lead group first (A-63)', () => {
    const open = ranked(
      rows([
        ['A-1', 'high', 'lead.mjs'],
        ['A-2', 'high', 'lead.mjs'],
        ['A-3', 'medium', 'lead.mjs'],
        ['A-4', 'medium', 'other.mjs'],
        ['A-5', 'medium', 'other.mjs'],
        ['A-6', 'low', 'third.mjs'],
        ['A-7', 'low', 'third.mjs'],
        ['A-8', 'low', 'fourth.mjs'],
        ['A-9', 'nit', 'fifth.mjs'],
        ['A-10', 'nit', 'sixth.mjs'],
      ]),
    );
    const batch = selectBatch(open, 8);
    assert.equal(batch.length, 8, 'a lead group of 3 must not cap a --size 8 batch');
    assert.deepEqual(batch.slice(0, 3).map((f) => f.id), ['A-1', 'A-2', 'A-3'], 'lead group stays first');
    assert.equal(new Set(batch.map((f) => f.id)).size, 8, 'no duplicates');
  });

  it('truncates to size when the lead group alone exceeds it', () => {
    const open = ranked(
      rows([
        ['A-1', 'high', 'lead.mjs'],
        ['A-2', 'high', 'lead.mjs'],
        ['A-3', 'high', 'lead.mjs'],
        ['A-4', 'low', 'other.mjs'],
      ]),
    );
    const batch = selectBatch(open, 2);
    assert.deepEqual(batch.map((f) => f.id), ['A-1', 'A-2']);
  });

  it('falls back to plain ranked order when the lead file holds a single finding', () => {
    const open = ranked(
      rows([
        ['A-1', 'high', 'lonely.mjs'],
        ['A-2', 'medium', 'other.mjs'],
        ['A-3', 'low', 'other.mjs'],
      ]),
    );
    assert.deepEqual(selectBatch(open, 8).map((f) => f.id), ['A-1', 'A-2', 'A-3']);
  });

  it('returns [] for an empty pool', () => {
    assert.deepEqual(selectBatch([], 8), []);
  });

  it('never returns more than size, nor a finding twice', () => {
    const open = ranked(
      rows([
        ['A-1', 'high', 'lead.mjs'],
        ['A-2', 'high', 'lead.mjs'],
        ['A-3', 'low', 'other.mjs'],
      ]),
    );
    const batch = selectBatch(open, 3);
    assert.equal(batch.length, 3);
    assert.equal(new Set(batch.map((f) => f.id)).size, 3);
  });
});

// ============================================================================
// SECTION: Commands
// ============================================================================

describe('cmdInit', () => {
  it('backfills a missing status line under the meta line, and is idempotent', () => {
    const file = fixture(report([finding({ id: 'A-1' }), finding({ id: 'A-2', status: 'deferred — needs Linux' })]));
    const root = path.dirname(file);

    cmdInit(root, file);
    const once = fs.readFileSync(file, 'utf8');
    const lines = once.split('\n');
    const head = lines.findIndex((l) => l.startsWith('#### A-1:'));
    assert.equal(lines[head + 2], '- **Status**: open', 'status lands directly under the meta line');
    assert.ok(once.includes('- **Status**: deferred — needs Linux'), 'an existing status and note survive');

    cmdInit(root, file);
    assert.equal(fs.readFileSync(file, 'utf8'), once, 'a second init must change nothing');
  });
});

describe('cmdSet', () => {
  it('writes a note when --note is given', () => {
    const file = fixture(report([finding({ id: 'A-1', status: 'open' }), finding({ id: 'A-2', status: 'open' })]));
    cmdSet(path.dirname(file), file, ['set', 'A-1', 'fixed', '--note', 'landed in abc123']);
    const findings = readFindings(file);
    const a1 = findings.find((f) => f.id === 'A-1');
    assert.equal(a1.status, 'fixed');
    assert.equal(a1.note, 'landed in abc123');
  });

  it('preserves the existing note when --note is omitted', () => {
    const file = fixture(report([finding({ id: 'A-1', status: 'open — raised by the probe' })]));
    cmdSet(path.dirname(file), file, ['set', 'A-1', 'deferred']);
    const a1 = readFindings(file).find((f) => f.id === 'A-1');
    assert.equal(a1.status, 'deferred');
    assert.equal(a1.note, 'raised by the probe');
  });

  it('inserts a status line for a finding that has none', () => {
    const file = fixture(report([finding({ id: 'A-1' })]));
    cmdSet(path.dirname(file), file, ['set', 'A-1', 'false-positive', '--note', 'contradicted by x.mjs:9']);
    const a1 = readFindings(file).find((f) => f.id === 'A-1');
    assert.equal(a1.status, 'false-positive');
    assert.equal(a1.note, 'contradicted by x.mjs:9');
  });

  it('rejects an unknown id and an unknown status', () => {
    const file = fixture(report([finding({ id: 'A-1' })]));
    assert.throws(() => cmdSet(path.dirname(file), file, ['set', 'A-77', 'fixed']), /A-77 is not in/);
    assert.throws(() => cmdSet(path.dirname(file), file, ['set', 'A-1', 'wontfix']), new RegExp(STATUSES.join('\\|')));
  });

  it('leaves the report outside the findings section byte-identical', () => {
    const file = fixture(
      report([finding({ id: 'A-1', status: 'open' })], {
        trailing: ['## 4. Appendix', '', 'Refuted claims live here.', ''].join('\n'),
      }),
    );
    const before = fs.readFileSync(file, 'utf8');
    cmdSet(path.dirname(file), file, ['set', 'A-1', 'fixed']);
    const after = fs.readFileSync(file, 'utf8');
    const tail = (text) => text.slice(text.indexOf('## 4. Appendix'));
    assert.equal(tail(after), tail(before));
  });
});
