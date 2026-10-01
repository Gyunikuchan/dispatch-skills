// Hot-fix judgement (spec §8.6, ADR 0004; ports legacy driver/hotfix-limits.mjs over a pure input). The I04/I06
// effects compute `HotfixInput` from git and fs; this module returns violations and never reverts.

export const HOTFIX_MAX_FILES = 10;
export const HOTFIX_MAX_LINES = 150;

/** Legacy SENSITIVE_FILE_PATTERNS / _BASENAME_ / _DIR_ sources (runners/shared.mjs), matched case-insensitively. */
export const DEFAULT_SECRET_PATTERNS: SecretPatterns = {
  file: [
    '\\.env($|\\..+)', '\\.(pem|key|pkcs12|pfx|p12|kdbx|keystore|jks)$', '\\.(ovpn)$', 'id_(rsa|dsa|ecdsa|ed25519)($|\\.)',
    '\\.npmrc$', '\\.pypirc$', '\\.netrc$', '\\.htpasswd$', '\\.pgpass$', '\\.my\\.cnf$', '\\.s3cfg$', '\\.boto$', '\\.terraformrc$',
    'terraform\\.rc$', 'wp-config\\.php$', '\\.git[/\\\\]credentials', '\\.git-credentials$', '\\.aws[/\\\\]credentials',
    '\\.ssh[/\\\\]', '\\.gnupg[/\\\\]', '\\.docker[/\\\\]config\\.json$', '\\.vault-token$', 'credentials\\.json$',
    'service[-_]?account.*\\.json$',
  ],
  basename: ['\\btoken\\b', '\\bsecrets?\\b'],
  dir: [
    '[/\\\\]\\.ssh([/\\\\]|$)', '[/\\\\]\\.gnupg([/\\\\]|$)', '[/\\\\]\\.gpg([/\\\\]|$)', '[/\\\\]\\.aws([/\\\\]|$)',
    '[/\\\\]\\.azure([/\\\\]|$)', '[/\\\\]\\.docker([/\\\\]|$)', '[/\\\\]\\.password-store([/\\\\]|$)', '[/\\\\]\\.kube([/\\\\]|$)',
    '[/\\\\]\\.helm([/\\\\]|$)', '[/\\\\]\\.terraform\\.d([/\\\\]|$)', '[/\\\\]\\.config[/\\\\]gcloud([/\\\\]|$)',
    '[/\\\\]\\.config[/\\\\]gh([/\\\\]|$)', '[/\\\\]\\.config[/\\\\]op([/\\\\]|$)', '[/\\\\]\\.local[/\\\\]share[/\\\\]keyrings([/\\\\]|$)',
    '[/\\\\]AppData[/\\\\]Roaming[/\\\\]gcloud([/\\\\]|$)', '[/\\\\]AppData[/\\\\]Roaming[/\\\\]GitHub CLI([/\\\\]|$)',
    '[/\\\\]Microsoft[/\\\\]Credentials([/\\\\]|$)',
  ],
};

export type SecretPatterns = { file: readonly string[]; basename: readonly string[]; dir: readonly string[] };
export type ChangedPath = { path: string; added: number; removed: number; deleted: boolean; outsideRepo: boolean };
export type GitFingerprint = { head: string; index: string; stash: string; gitDir: string };
export type ManifestEntry = { path: string; hash: string };

export type HotfixInput = {
  /** Informational; every path below is already repo-relative. */
  repoRoot: string;
  changed: readonly ChangedPath[];
  external: readonly { path: string; reason: string }[];
  before: GitFingerprint;
  after: GitFingerprint;
  taskStartFiles: readonly string[];
  secretPatterns?: SecretPatterns;
  ignoredBefore: readonly ManifestEntry[];
  ignoredAfter: readonly ManifestEntry[];
  preRed: boolean;
  productionPaths: readonly string[];
  failureIdentityBefore: string | null;
  failureIdentityAfter: string | null;
};

export type HotfixJudgement = { violations: readonly string[]; withdrawn: boolean; files: number; lines: number };

const slash = (file: string) => file.replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * `file` patterns test the repo-relative path, `basename` its basename, `dir` the slash-prefixed path (legacy
 * defaults) or any single directory segment (caller-supplied segment patterns such as `^secrets$`).
 */
export function isSecretPath(file: string, patterns: SecretPatterns = DEFAULT_SECRET_PATTERNS): boolean {
  const rel = slash(file);
  const test = (sources: readonly string[], value: string) => sources.some((source) => new RegExp(source, 'i').test(value));
  const segments = rel.split('/').slice(0, -1);
  return test(patterns.file, rel) || test(patterns.basename, rel.slice(rel.lastIndexOf('/') + 1))
    || test(patterns.dir, `/${rel}`) || segments.some((segment) => test(patterns.dir, segment));
}

export function judgeHotfix(input: HotfixInput): HotfixJudgement {
  const patterns = input.secretPatterns ?? DEFAULT_SECRET_PATTERNS;
  const violations: string[] = [];
  // SECTION: Git writes, seen as fingerprint changes
  if (input.after.head !== input.before.head) violations.push('HEAD moved (history-writing git command)');
  if (input.after.index !== input.before.index) violations.push('index changed (staging or restore)');
  if (input.after.stash !== input.before.stash) violations.push('stash list changed');
  if (input.after.gitDir !== input.before.gitDir) violations.push('.git/ config, hooks, or info changed');

  // SECTION: Ignored manifest
  const after = new Map(input.ignoredAfter.map((entry) => [slash(entry.path), entry.hash]));
  const before = new Map(input.ignoredBefore.map((entry) => [slash(entry.path), entry.hash]));
  for (const [file, hash] of before) {
    if (!after.has(file)) violations.push(`${file}: deleted an ignored path`);
    else if (after.get(file) !== hash && isSecretPath(file, patterns)) violations.push(`${file}: secrets path (ignored)`);
  }
  for (const file of after.keys()) if (!before.has(file) && isSecretPath(file, patterns)) violations.push(`${file}: created an ignored secrets path`);

  // SECTION: Changed paths
  const external = new Map(input.external.map((entry) => [slash(entry.path), entry.reason.trim()]));
  for (const [file, reason] of external) if (!reason) violations.push(`${file}: external path needs a reason`);
  const taskStart = new Set(input.taskStartFiles.map(slash));
  const production = new Set(input.productionPaths.map(slash));
  let files = 0;
  let lines = 0;
  for (const change of input.changed) {
    const file = slash(change.path);
    if (change.outsideRepo) violations.push(`${file}: outside the repository`);
    if (file === '.git' || file.startsWith('.git/')) violations.push(`${file}: .git/ path`);
    if (isSecretPath(file, patterns)) violations.push(`${file}: secrets path`);
    if (change.deleted && taskStart.has(file)) violations.push(`${file}: deleted a file that existed at task start`);
    if (input.preRed && production.has(file)) violations.push(`${file}: production path before RED validates`);
    if (external.has(file)) continue;
    files += 1;
    lines += change.added + change.removed;
  }
  if (files > HOTFIX_MAX_FILES) violations.push(`budget: ${files} files changed (limit ${HOTFIX_MAX_FILES})`);
  if (lines > HOTFIX_MAX_LINES) violations.push(`budget: ${lines} lines changed (limit ${HOTFIX_MAX_LINES})`);

  // No-progress: the failure the hotfix targeted survives unchanged, so it is withdrawn for the stage.
  const withdrawn = input.failureIdentityBefore !== null && input.failureIdentityAfter === input.failureIdentityBefore;
  return { violations, withdrawn, files, lines };
}
