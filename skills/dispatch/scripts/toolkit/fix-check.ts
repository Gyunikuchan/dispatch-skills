import fs from 'node:fs';
import path from 'node:path';
import type { HandlerContext, HandlerResult } from './cli.ts';
import { assertFilled, briefSummary, fillSlots, nextBriefPath, resolveHostUtility, utilityLaunchValues } from './brief.ts';
import { artifactHash, artifactKind } from './artifacts.ts';
import { reviewId } from './confirmations.ts';
import { DEFAULT_RESEARCH_REPLY_LIMIT } from './domain/context.ts';
import { addedCitations, consumerSearchText, safePathspec, type Citation } from './domain/fix-check.ts';
import { governedDesignText } from './domain/design.ts';
import { governedPlanText } from './domain/plan.ts';
import { qualityCriteria } from './domain/prompt.ts';
import { effectiveSeverity, RANK } from './domain/severity.ts';
import type { Severity } from './domain/types.ts';
import { git, gitPaths } from './git.ts';
import { foldLedger } from './ledger.ts';
import { safeRepoPath, within } from './lint.ts';
import { clipBytes, ToolError } from './output.ts';
import { line } from './review-findings.ts';
import { findSensitiveMatch } from '../providers/runner.ts';

type Round = { number: number; dir: string; metadata: Record<string, any>; findings: Record<string, any>[] };

const toPosix = (file: string): string => file.split(path.sep).join('/');
// Reviewer and path text must not add placeholders or relative links, which assertFilled refuses.
const safeText = (value: string): string => value.replace(/\{\{/g, '{ {').replace(/\}\}/g, '} }').replace(/\]\(/g, '] (');
const canonical = (file: string): string => { try { return fs.realpathSync.native(file); } catch { return path.resolve(file); } };
const realpathOrNull = (file: string): string | null => { try { return fs.realpathSync(file); } catch { return null; } };
const readText = (file: string): string | null => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const readJson = (file: string): Record<string, any> | null => {
  const text = readText(file);
  try { return text === null ? null : JSON.parse(text) as Record<string, any>; } catch { return null; }
};
const span = (citation: Citation): string =>
  citation.start === null ? citation.path : citation.start === citation.end ? `${citation.path}:${citation.start}` : `${citation.path}:${citation.start}-${citation.end}`;
const list = (items: readonly string[]): string => items.length ? items.join('\n') : '- None.';

// Completed rounds of one review, newest first; a round without findings.json is still running.
function completedRounds(reviewDir: string): Round[] {
  if (!fs.existsSync(reviewDir)) return [];
  const rounds: Round[] = [];
  for (const name of fs.readdirSync(reviewDir)) {
    const match = /^round-(\d+)$/.exec(name);
    if (!match) continue;
    const dir = path.join(reviewDir, name);
    const metadata = readJson(path.join(dir, 'round.json'));
    const findings = readJson(path.join(dir, 'findings.json'))?.['findings'];
    if (!metadata || !Array.isArray(findings)) continue;
    rounds.push({ number: Number(match[1]), dir, metadata, findings });
  }
  return rounds.sort((a, b) => b.number - a.number);
}

export async function renderFixCheckBrief(ctx: HandlerContext): Promise<HandlerResult> {
  if (ctx.args.length !== 1) throw new ToolError(1, 'invalid-input', 'One plan or design artifact path is required');
  const root = canonical(ctx.manifest.repositoryRoot);
  const artifact = path.resolve(ctx.manifest.repositoryRoot, ctx.args[0]!);
  const kind = artifactKind(artifact);
  if (kind !== 'plan' && kind !== 'design') throw new ToolError(1, 'invalid-input', 'fix-check reviews a plan or design artifact only');

  // NOTE: selection by recorded artifactPath, not the bind, so a same-basename artifact or an unbound session never picks the wrong round.
  const review = reviewId(kind, artifact);
  const reviewDir = path.join(ctx.session, '.state', 'reviews', review);
  const artifactReal = canonical(artifact);
  const round = completedRounds(reviewDir).find(candidate =>
    typeof candidate.metadata['artifactPath'] === 'string' && canonical(candidate.metadata['artifactPath']) === artifactReal);
  if (!round) throw new ToolError(4, 'nothing-to-review', 'No completed review round reviewed ' + artifact);

  const fold = foldLedger(ctx.session);
  const questions: string[] = [];
  for (const finding of round.findings) {
    if (typeof finding['id'] !== 'string') continue;
    const history = fold.records.filter(record => record.kind === 'ruling' && record.data['subject'] === `review:${review}:${finding['id']}`);
    const ruling = history.at(-1);
    if (!ruling || ruling.data['ruling'] !== 'accepted') continue;
    const stored = typeof finding['severity'] === 'string' ? finding['severity'] : 'unknown';
    const severity = stored in RANK ? effectiveSeverity(finding as {severity: Severity}, history) : stored;
    const rationale = typeof ruling.data['rationale'] === 'string' ? ruling.data['rationale'] : '';
    questions.push(clipBytes(safeText(`- ${line(finding['id'])} ${line(severity)} ${line(finding['locus'])}: ${line(finding['defect'])}`
      + ` — required: ${line(finding['requiredChange'])} — ruling: ${line(rationale)}`), 400));
  }
  if (!questions.length) throw new ToolError(4, 'nothing-to-review', 'No accepted finding in the reviewed round');

  const specMeta = round.metadata['spec'] as {path?: unknown; hash?: unknown} | undefined;
  const specPath = specMeta?.path;
  const specHash = specMeta?.hash;
  if (typeof specPath !== 'string' || typeof specHash !== 'string') throw new ToolError(1, 'invalid-input', 'Round records no spec path and hash');
  const specText = readText(specPath);
  if (specText === null) throw new ToolError(1, 'invalid-input', 'Cannot read spec ' + specPath);
  const source = readText(artifact);
  if (source === null) throw new ToolError(1, 'invalid-input', 'Cannot read artifact ' + artifact);

  const snapshot = path.join(round.dir, 'spec.snapshot.md');
  let specLine: string;
  if (artifactHash('spec', specText) === specHash) specLine = `Governing spec: \`${specPath}\`.`;
  else {
    const reviewed = readText(snapshot);
    specLine = reviewed !== null && artifactHash('spec', reviewed) === specHash
      ? `Governing spec: \`${specPath}\`, changed since the round. Reviewed spec text: \`${snapshot}\`.`
      : `Governing spec: \`${specPath}\`, changed since the round. The reviewed spec text is unavailable.`;
  }

  const listing = await gitPaths(ctx.deps, root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  const listed = new Set(listing);
  const sessionRel = toPosix(path.relative(root, ctx.session));
  const sessionsRootRel = toPosix(path.relative(root, path.dirname(ctx.session)));
  // The sessions root is excluded from search only when it sits inside the repository.
  const sessionsInside = sessionsRootRel !== '' && !sessionsRootRel.startsWith('..') && !path.isAbsolute(sessionsRootRel);
  const inSessions = (rel: string): boolean => sessionsInside && (rel === sessionsRootRel || rel.startsWith(sessionsRootRel + '/'));
  const ownSession = (rel: string): boolean => rel.startsWith(sessionRel + '/') && rel !== sessionRel + '/.state' && !rel.startsWith(sessionRel + '/.state/');

  const directory = path.join(ctx.session, '.state', 'briefs');
  fs.mkdirSync(directory, { recursive: true });
  const briefFile = nextBriefPath(directory, 'fix-check');
  const base = briefFile.slice(0, -'.md'.length);
  const governedFile = base + '.governed.md';
  const diffFile = base + '.diff';
  const inputFile = path.join(reviewDir, `round-${round.number}.input.md`);
  const written: string[] = [];
  try {
    fs.writeFileSync(governedFile, kind === 'plan' ? governedPlanText(source) : governedDesignText(source));
    written.push(governedFile);
    const diff = await git(ctx.deps, root, ['diff', '--no-index', '--no-color', '--no-ext-diff', '--', inputFile, governedFile]);
    if (diff.exit === 0) throw new ToolError(4, 'nothing-to-review', 'No change since the reviewed round input');
    // --no-index also exits 1 on an unreadable path, so exit 1 needs output.
    if (diff.exit !== 1 || !diff.stdout) throw new ToolError(2, 'fault', diff.stderr || 'git diff exited ' + diff.exit);
    fs.writeFileSync(diffFile, diff.stdout);
    written.push(diffFile);

    const kept: string[] = [];
    const withheld: string[] = [];
    const seen = new Set<string>();
    const unrenderable = new Set<string>();
    const citationReason = (rel: string): string | null => {
      // Template slots refuse `{{`, `}}` and `](`, so such a name is withheld, not rendered.
      if (/\{\{|\}\}|\]\(/.test(rel)) return 'unrenderable name';
      const abs = path.resolve(root, rel);
      if (!safeRepoPath(rel) || !within(root, abs)) return 'outside repository';
      if (inSessions(rel) && !ownSession(rel)) return 'session';
      const real = realpathOrNull(abs);
      if (real === null) return 'missing';
      if (!within(root, real)) return 'outside repository';
      if (findSensitiveMatch(abs, realpathOrNull)) return 'sensitive';
      if (!fs.statSync(real).isFile()) return 'missing';
      return listed.has(rel) ? null : 'not listed';
    };
    for (const citation of addedCitations(diff.stdout)) {
      // NOTE: normalize to the repository-relative POSIX path so `./a.ts:1` and `a.ts:1` share one entry and one check.
      const normalized: Citation = {...citation, path: path.posix.normalize(citation.path)};
      const key = span(normalized);
      if (seen.has(key)) continue;
      seen.add(key);
      const reason = citationReason(normalized.path);
      if (reason === null) kept.push('- `' + key + '`');
      else { withheld.push(safeText(`- \`${normalized.path}\`: ${reason}`)); if (reason === 'unrenderable name') unrenderable.add(normalized.path); }
    }

    // Flagged listed paths drop out of the search: sensitive ones and listed ones cited as unrenderable are excludes (glob-rendered when unsafe); an unsafe sensitive one is also withheld.
    const excludes: string[] = sessionsInside ? [sessionsRootRel] : [];
    for (const rel of listing) {
      const sensitive = findSensitiveMatch(path.resolve(root, rel), realpathOrNull);
      if (inSessions(rel) || !(sensitive || unrenderable.has(rel))) continue;
      excludes.push(rel);
      if (sensitive && !safePathspec(rel)) withheld.push(safeText(`- \`${rel}\`: sensitive`));
    }
    const consumerSearch = consumerSearchText(excludes);

    const notePrefix = `fix-check:${review}:${round.number}:`;
    const ordinal = Math.max(0, ...fold.records.filter(record => record.kind === 'note' && record.key.startsWith(notePrefix))
      .flatMap(record => /^[1-9]\d*$/.test(record.key.slice(notePrefix.length)) ? [Number(record.key.slice(notePrefix.length))] : [])) + 1;
    const noteKey = notePrefix + ordinal;

    const bar = fs.readFileSync(path.join(ctx.deps.skillRoot, 'references', 'templates', 'quality-bar.md'), 'utf8');
    const specStage = fs.readFileSync(path.join(ctx.deps.skillRoot, 'references', 'spec-stage.md'), 'utf8');
    const evidence = qualityCriteria(bar, 'explorer', 0, specStage).split('\n').find(text => text.startsWith('- Evidence:'));
    if (evidence === undefined) throw new ToolError(2, 'fault', 'Quality bar has no Evidence line');
    const template = fs.readFileSync(path.join(ctx.deps.skillRoot, 'references', 'templates', 'fix-check-brief.md'), 'utf8');
    const slots: Record<string, string> = {
      questions: questions.join('\n'),
      repositoryRoot: safeText(root),
      diffPath: safeText(diffFile),
      artifact: safeText(artifact),
      spec: safeText(specLine),
      citations: list(kept),
      withheld: list(withheld),
      consumerSearch,
      replyLimit: DEFAULT_RESEARCH_REPLY_LIMIT.toLocaleString('en-US'),
      evidence,
    };
    const text = fillSlots('fix-check', template, slots);
    assertFilled('fix-check', text);
    fs.writeFileSync(briefFile, text);

    const host = ctx.deps.orchestrator?.platform;
    const entry = resolveHostUtility(ctx.deps.skillRoot, host);
    const launch = utilityLaunchValues(ctx.deps.skillRoot, host);
    const value = {
      briefPath: briefFile, bytes: Buffer.byteLength(text), review, round: round.number, noteKey, diffPath: diffFile,
      citations: kept.length, withheld: withheld.length, contextLimit: entry ? entry.contextLimit : null, ...launch,
    };
    const summary = `fix-check brief ${review} round ${round.number}: ${questions.length} accepted, ${kept.length} citations, ${withheld.length} withheld`;
    return { ok: true, exit: 0, value, summary: briefSummary(summary, host, launch, briefFile, value.bytes) };
  } catch (error) {
    for (const file of written) fs.rmSync(file, { force: true });
    throw error;
  }
}
