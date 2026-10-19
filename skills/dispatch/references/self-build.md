# Build Dispatch with a fixed controller

Use this procedure when Dispatch implements changes to its own skill. The **controller** is a complete, inventoried copy of the selected skill. The **candidate** is the mutable target checkout. Keep the controller outside every writer scope until the run and its owned worktrees are complete.

## Prepare the session

Select the source bytes explicitly, including any verified local fixes and local configuration. Initialize a retained session from the target repository with the selected source driver. Use the existing [implement contract](verbs/implement.md) and configured model and effort from [providers](providers.md).

Set absolute paths: `target` is the candidate repository; `session` is its initialized session under `target/.scratch`; `source` is the complete skill to capture. Set `dest` to `session/.state/scratch/controller/skills/dispatch` and `inventory` to `session/.state/scratch/controller-inventory.json`. Helpers, snapshots and inventories stay in ignored local session scratch; local configuration must not enter commits.

Materialize the named blocks below as `.mjs` helpers under the session's `.state/scratch`. This wrapper accepts positional `reference`, `target`, `session`, and `Capture controller` or `Verify controller` arguments. Use canonical absolute paths. Run it with Node, then invoke the emitted helper with the required flags as separate argv values. It checks initialized-session ownership and every helper write path before creating scratch or publishing bytes, and refuses ambiguous sections or fences.

```javascript
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.length !== 4 || args.slice(0, 3).some(value => !path.isAbsolute(value) || path.resolve(value) !== value)) throw new Error('Canonical absolute reference, target and session plus helper heading required');
// macOS system aliases are fixed; mutable links remain invalid.
if (process.platform === 'darwin') for (let i = 0; i < 3; i++) {
  const alias = /^\/(var|tmp|etc)(?=\/|$)/.exec(args[i]);
  if (alias && fs.realpathSync('/' + alias[1]) === '/private/' + alias[1]) args[i] = '/private' + args[i];
}
const [reference, target, session, heading] = args;
if (!['Capture controller', 'Verify controller'].includes(heading)) throw new Error('Unknown helper');
const stat = value => { try { return fs.lstatSync(value); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const unlinked = value => { for (let current = value; ; current = path.dirname(current)) { if (stat(current)?.isSymbolicLink()) throw new Error('Linked preparation path'); if (current === path.dirname(current)) break; } };
const state = path.join(session, '.state'), scratch = path.join(state, 'scratch');
const manifestPath = path.join(session, 'manifest.json');
const helper = path.join(scratch, heading === 'Capture controller' ? 'capture-controller.mjs' : 'verify-controller.mjs');
for (const value of [reference, target, session, state, scratch, manifestPath, helper]) unlinked(value);
for (const value of [reference, target, session]) if (fs.realpathSync(value) !== value) throw new Error('Use canonical absolute input paths');
if (!stat(target)?.isDirectory() || (stat(state) && !stat(state).isDirectory()) || !stat(manifestPath)?.isFile()) throw new Error('Expected target repository and initialized session');
const repositoryRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: target, encoding: 'utf8', windowsHide: true, timeout: 25000 }).trim();
if (fs.realpathSync(repositoryRoot) !== target) throw new Error('Expected target repository root');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const canonicalTarget = target.normalize('NFC').replaceAll('\\', '/');
const safeId = value => /^[A-Za-z0-9][A-Za-z0-9._-]{0,11}$/.test(value) ? value : crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
if (!manifest || manifest.schemaVersion !== 1 || manifest.folderName !== path.basename(session) || !/^\d{8}T\d{4}Z-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.folderName) || typeof manifest.sessionId !== 'string' || manifest.safeSessionId !== safeId(manifest.sessionId) || manifest.repositoryRoot !== (process.platform === 'win32' ? canonicalTarget.toLowerCase() : canonicalTarget) || session !== path.join(target, '.scratch/dispatch-skills', manifest.folderName)) throw new Error('Invalid target session ownership');
if (stat(scratch) && !stat(scratch).isDirectory()) throw new Error('Expected scratch directory');
const text = fs.readFileSync(reference, 'utf8');
const sections = text.split(/^## /m).filter(section => section.split(/\r?\n/, 1)[0] === heading);
if (sections.length !== 1) throw new Error('Expected exactly one named section');
const blocks = [...sections[0].matchAll(/^```javascript\r?\n([\s\S]*?)^```\s*$/gm)];
if (blocks.length !== 1) throw new Error('Expected exactly one javascript block');
if (stat(helper)) {
  if (!stat(helper).isFile() || !fs.readFileSync(helper).equals(Buffer.from(blocks[0][1]))) throw new Error('Existing helper differs or is not a regular file');
} else {
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(helper, blocks[0][1], { flag: 'wx' });
}
console.log(helper);
```

## Capture controller

Run the materialized helper with all five flags: `--target <target> --session <session> --source <source> --dest <dest> --inventory <inventory>`. The source must contain the whole skill, including scripts, references, templates, configuration and integrity metadata. Capture refuses existing output paths, even empty directories. Use the canonical paths emitted in the inventory for all subsequent helper and driver calls. It records selected paths and a partial inventory before copying; preserve partial output on failure. Retry with fresh uniquely named paths, or clean only the recorded partial after checking absolute containment in owned session scratch.

```javascript
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const flags = new Map();
const allowed = ['target', 'session', 'source', 'dest', 'inventory'];
for (let i = 2; i < process.argv.length; i++) {
  const match = /^--([a-z]+)(?:=(.*))?$/.exec(process.argv[i]);
  if (!match || !allowed.includes(match[1]) || flags.has(match[1])) throw new Error('Invalid or duplicate flag');
  const value = match[2] ?? process.argv[++i];
  if (!value || value.startsWith('--')) throw new Error('Missing flag value');
  flags.set(match[1], path.resolve(value));
}
if (flags.size !== allowed.length) throw new Error('All five capture flags are required');
// macOS exposes these system aliases; normalize only those, retaining mutable-link checks.
if (process.platform === 'darwin') for (const [key, value] of flags) {
  const alias = /^\/(var|tmp|etc)(?=\/|$)/.exec(value);
  if (alias && fs.realpathSync('/' + alias[1]) === '/private/' + alias[1]) flags.set(key, '/private' + value);
}
const { target, session, source, dest, inventory } = Object.fromEntries(flags);
const inside = (root, value) => { const rel = path.relative(root, value); return rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel); };
const unlinked = value => {
  for (let current = value; ; current = path.dirname(current)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Linked path: ${current}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(current) === current) break;
  }
};
for (const value of [target, session, source, dest, inventory]) unlinked(value);
if (fs.realpathSync(target) !== target || fs.realpathSync(session) !== session || fs.realpathSync(source) !== source) throw new Error('Use canonical absolute input paths');
if (!inside(path.join(target, '.scratch'), session) || !fs.statSync(path.join(session, '.state')).isDirectory()) throw new Error('Expected initialized target session');
const scratch = path.join(session, '.state/scratch');
if (!inside(scratch, dest) || !inside(scratch, inventory) || inside(dest, inventory) || dest === inventory || inside(source, dest) || inside(dest, source)) throw new Error('Invalid snapshot containment');
const exists = value => { try { fs.lstatSync(value); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
if (exists(dest) || exists(inventory)) throw new Error('Snapshot destination and inventory must both be fresh');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const scan = root => {
  const files = [];
  const visit = (dir, prefix = '') => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), relative = prefix + name, stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`Linked skill input: ${relative}`);
      if (stat.isDirectory()) visit(file, relative + '/');
      else if (stat.isFile()) { const bytes = fs.readFileSync(file); files.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) }); }
      else throw new Error(`Unsupported skill input: ${relative}`);
    }
  };
  visit(root);
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
};
const files = scan(source);
for (const required of ['scripts/dispatch.ts', 'skill-hashes.json', 'config.sample.jsonc', 'SKILL.md']) if (!files.some(file => file.path === required)) throw new Error(`Incomplete skill: ${required}`);
if (!files.some(file => file.path.startsWith('references/templates/'))) throw new Error('Missing templates');
const git = args => execFileSync('git', args, { cwd: source, encoding: 'utf8', windowsHide: true, timeout: 25000 }).trim();
const record = { schemaVersion: 1, status: 'capturing', target, session, source, dest, inventory, controllerEntry: path.join(dest, 'scripts/dispatch.ts'), sourceHead: git(['rev-parse', 'HEAD']), sourceStatus: git(['status', '--porcelain=v1', '--untracked-files=all']), files, identity: digest(JSON.stringify(files)) };
fs.mkdirSync(path.dirname(inventory), { recursive: true });
fs.writeFileSync(inventory, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
fs.mkdirSync(dest, { recursive: true });
for (const file of files) { const output = path.join(dest, file.path); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.copyFileSync(path.join(source, file.path), output, fs.constants.COPYFILE_EXCL); }
if (JSON.stringify(scan(source)) !== JSON.stringify(files) || JSON.stringify(scan(dest)) !== JSON.stringify(files)) throw new Error('Source changed or copy differs; retain partial output');
record.status = 'complete';
fs.writeFileSync(inventory, JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify(record));
```

## Verify controller

Run this helper with `--dest <dest> --inventory <inventory>` before each host driver invocation, after each worker wave or receipt, at continuation, and after completion. A nonzero exit stops further controller effects. The inventory records the absolute controller entrypoint and its complete byte identity outside the snapshot. Retain that inventory with the session.

```javascript
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const flags = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const match = /^--(dest|inventory)(?:=(.*))?$/.exec(process.argv[i]);
  if (!match || flags.has(match[1])) throw new Error('Invalid or duplicate flag');
  const value = match[2] ?? process.argv[++i];
  if (!value || value.startsWith('--')) throw new Error('Missing flag value');
  flags.set(match[1], path.resolve(value));
}
if (flags.size !== 2) throw new Error('Both verification flags are required');
if (process.platform === 'darwin') for (const [key, value] of flags) {
  const alias = /^\/(var|tmp|etc)(?=\/|$)/.exec(value);
  if (alias && fs.realpathSync('/' + alias[1]) === '/private/' + alias[1]) flags.set(key, '/private' + value);
}
const { dest, inventory } = Object.fromEntries(flags);
const inside = (root, value) => { const rel = path.relative(root, value); return rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel); };
const unlinked = value => {
  for (let current = value; ; current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Linked path: ${current}`);
    if (path.dirname(current) === current) break;
  }
};
unlinked(inventory); unlinked(dest);
const record = JSON.parse(fs.readFileSync(inventory, 'utf8'));
const scratch = path.join(record.session, '.state/scratch');
if (record.schemaVersion !== 1 || record.status !== 'complete' || record.dest !== dest || record.inventory !== inventory || record.controllerEntry !== path.join(dest, 'scripts/dispatch.ts') || !inside(path.join(record.target, '.scratch'), record.session) || !inside(scratch, dest) || !inside(scratch, inventory) || inside(dest, inventory)) throw new Error('Invalid controller inventory binding');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const files = [];
const visit = (dir, prefix = '') => {
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name), relative = prefix + name, stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error(`Linked controller input: ${relative}`);
    if (stat.isDirectory()) visit(file, relative + '/');
    else if (stat.isFile()) { const bytes = fs.readFileSync(file); files.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) }); }
    else throw new Error(`Unsupported controller input: ${relative}`);
  }
};
visit(dest);
files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
if (JSON.stringify(files) !== JSON.stringify(record.files) || digest(JSON.stringify(files)) !== record.identity) throw new Error('Controller inventory mismatch');
console.log(JSON.stringify({ controllerEntry: record.controllerEntry, inventory, identity: record.identity, status: 'verified' }));
```

## Run implementation

Resolve the actual host platform, implementation level and level source through the normal implement contract before selecting writers. Set the shell variables `platform`, `level` and `levelSource` to those resolved values; use `explicit` only for a user-selected level. After verification, run the copied driver's `doctor --level <selected-level> --json` and require `integrity.status` to be `ok`. Repair stale hashes in the intended source and capture fresh bytes if this fails. Resolve writer model and effort from this controller's doctor output. Apply the normal [implement workflow](verbs/implement.md) to the candidate from its repository cwd.

PowerShell (variables hold absolute paths):

```powershell
Set-Location -LiteralPath $target
node $verifyHelper --dest $dest --inventory $inventory
if ($LASTEXITCODE -ne 0) { throw 'Controller verification failed' }
node $controllerEntry start implement --session-dir $session --orchestrator $platform --level $level --level-source $levelSource -- $plan
```

POSIX:

```sh
cd "$target"
node "$verifyHelper" --dest "$dest" --inventory "$inventory" &&
node "$controllerEntry" start implement --session-dir "$session" --orchestrator "$platform" --level "$level" --level-source "$levelSource" -- "$plan"
```

Use the recorded absolute entrypoint for every active-run `start`, `send`, `status`, `checkpoint`, and `doctor` command. Resolve every frame's `<skills-dir>` to the parent of the captured `dispatch` skill, including semantic replies, self-check and checkpoint commands. Read templates and quality inputs from the controller. Provider workers inherit its entrypoint. Keep the snapshot outside every writer scope.

Copy isolation, operational ownership, and repeated inventory checks keep the controller fixed. They are not OS write enforcement. Scripts-only runtime identity does not continuously check worker-time template or configuration reads; the complete inventory checks cover the host boundaries above.

## Verify the candidate

Run required target-checkout tests and final gates separately. For orchestration changes, exercise the candidate entrypoint in a separate disposable repository/session. Candidate checks never supply replies to the controller's active run. Record the controller inventory identity and absolute entrypoint separately from the candidate revision, changed-file digests, test results and candidate CLI results. A successful controller delivery alone does not prove candidate correctness. After all required gates pass, a verified candidate can supply a new run's controller; the active run retains its original controller.


## Resume or recover

After interruption, retain the whole session, original controller and inventory, accepted work, journals, checkpoints, sealed results, active worker handles and uncertain-effect evidence. Verify the original controller before `status --run <dir>` or eventless `send --run <dir>`. Follow [change handling](change-handling.md#checkpoints-and-runtime-continuation) to reconcile accepted prefixes and uncertain effects. Reattach proved live work; a missing receipt does not authorize another launch. Keep the controller while any run needs it, including a failed or blocked run.

A failed isolation proof leaves the repository's previous operating rule in force. Preserve its logs and correct the proved defect within approved scope before adopting this procedure.

For missing or corrupt controller bytes, stop driver calls. Restore only from a complete source whose files match the original inventory. The following `restore-controller.mjs` helper accepts `inventory`, `source`, and a fresh sibling `stage` directory in owned session scratch. It validates the source before copying, verifies staged bytes, preserves corrupt bytes in a uniquely named quarantine, and restores the original destination. Keep quarantine and partial stages for diagnosis on failure. Materialize this block as a scratch helper; invoke `node <helper> <inventory> <source> <stage>` with separate quoted arguments on either shell.

```javascript
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const [inventory, source, stage] = process.argv.slice(2).map(p => path.resolve(p));
const record = JSON.parse(fs.readFileSync(inventory, 'utf8'));
const inside = (root, value) => { const r = path.relative(root, value); return r !== '' && r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r); };
const stat = p => { try { return fs.lstatSync(p); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const unlinked = value => { for (let p = value; ; p = path.dirname(p)) { if (stat(p)?.isSymbolicLink()) throw new Error('Linked recovery path'); if (p === path.dirname(p)) break; } };
const scratch = path.join(record.session, '.state/scratch');
for (const p of [inventory, source, stage, record.dest]) unlinked(p);
if (record.status !== 'complete' || record.inventory !== inventory || !inside(scratch, record.dest) || !inside(scratch, stage) || inside(record.dest, stage) || inside(stage, record.dest) || inside(source, stage) || inside(stage, source) || stage === record.dest || stat(stage)) throw new Error('Unsafe recovery paths');
const digest = b => crypto.createHash('sha256').update(b).digest('hex');
const scan = root => { const files = []; const visit = (dir, prefix = '') => { for (const name of fs.readdirSync(dir).sort()) { const file = path.join(dir, name), rel = prefix + name, s = fs.lstatSync(file); if (s.isSymbolicLink()) throw new Error('Linked recovery input'); if (s.isDirectory()) visit(file, rel + '/'); else if (s.isFile()) { const b = fs.readFileSync(file); files.push({ path: rel, bytes: b.length, sha256: digest(b) }); } else throw new Error('Unsupported recovery input'); } }; visit(root); return files.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0); };
const check = root => { const files = scan(root); if (JSON.stringify(files) !== JSON.stringify(record.files) || digest(JSON.stringify(files)) !== record.identity) throw new Error('Recovery source mismatch'); };
check(source);
fs.cpSync(source, stage, { recursive: true, errorOnExist: true, force: false });
check(source); check(stage);
const quarantine = stat(record.dest) ? record.dest + '.corrupt-' + crypto.randomUUID() : null;
if (quarantine) fs.renameSync(record.dest, quarantine);
fs.mkdirSync(path.dirname(record.dest), { recursive: true });
fs.renameSync(stage, record.dest);
console.log(JSON.stringify({ restored: record.dest, quarantine, identity: record.identity }));
```

Run the authoritative verification helper against the restored destination **before** its `doctor --level <selected-level> --json`. Require the doctor's integrity status to be `ok` before using its writer configuration. Same-byte restoration cannot repair a semantic code defect.

For a demonstrated semantic defect, including unusable `doctor`, preserve the blocked run. Select and record a clean Git revision and the exact local configuration needed for a known-good source; obtain that revision in a separate owned checkout, not by resetting the candidate. Capture this complete source at fresh, separately named controller and inventory paths with the capture helper. Verify its inventory, then run its `doctor --level <selected-level> --json` and require integrity `ok`. Record its distinct entrypoint, identity, revision and configuration provenance before using its model/effort. A clean revision alone does not prove semantic correctness: check the blocking behavior against it. If no verified-good source is available, retain the blocked run and report that material blocker. Do not invoke the broken doctor for policy or automatically switch the active run.

Use compatible `rebind` only after the checks in [change handling](change-handling.md#checkpoints-and-runtime-continuation). Record the explicitly selected replacement identity and reason. Rebind preserves accepted work and launches no effects; send an exact validated event once afterward. Preserve incompatible runs. Start a new run only after those contracts permit it and accepted work and uncertain effects have been reconciled.

## Bounded manual repair

Use this fallback only when a demonstrated controller defect blocks normal execution and normal recovery cannot proceed. Preserve the original run and all recovery inputs above. Obtain a bounded approved repair plan before implementation. Resolve native writer model and effort from the restored original controller for corruption, or the separately captured verified-good controller for a semantic defect, after inventory and doctor integrity checks. Follow [implement](verbs/implement.md), [providers](providers.md), and [worktree cleanup](worktree-cleanup.md); this fallback grants no wider scope or replay authority.

Select and record `candidateBase` before the first task. Start from target HEAD. If selected verified caller inputs are needed, first create a fresh owned baseline worktree from that HEAD, export `git diff HEAD --binary -- <selected-paths>` into a retained patch, apply it there with `git apply --index <patch>`, and copy explicitly selected untracked inputs there. Inspect and commit only those selected inputs in the baseline worktree, then set `candidateBase` to that private commit. Keep unrelated caller dirt out of this baseline. Record baseline paths, patch digest and commit; register and clean the baseline worktree under the same ledger rules below. Record the initial caller status and inspect all caller collisions before delivery; preserve existing dirt. Each accepted task commit advances only this private candidate chain: use the latest `candidateBase` for subsequent worktrees so dependent tasks contain earlier accepted deltas. Serialize integration and base updates; parallel siblings from an older base must be reconciled and verified against the latest base before acceptance.

Before preparation, materialize the `register-worktree.mjs` helper below in session scratch and set `registerHelper` to its path. Serialize preparation and ledger updates through the orchestrator. For each dependency-ready task, up to configured write concurrency, choose a fresh owned `$taskTree`/`$taskLedger` (or POSIX equivalents) under session scratch. `taskLedger` is a fresh per-task JSON record. Set `invocationLedger` to the invocation's `scratch/worktrees.json` required by worktree cleanup. Record path, owner, host/lifecycle identity and status before writer launch.

PowerShell, from the target checkout:

```powershell
node $registerHelper $session $taskLedger $invocationLedger create $taskTree $taskId $env:COMPUTERNAME
if ($LASTEXITCODE -ne 0) { throw 'Worktree preparation rejected' }
git worktree add -q --detach $taskTree $candidateBase
if ($LASTEXITCODE -ne 0) { throw 'Worktree creation failed' }
New-Item -ItemType Junction -Path (Join-Path $taskTree 'node_modules') -Target (Join-Path $target 'node_modules') -ErrorAction Stop
```

POSIX:

```sh
node "$registerHelper" "$session" "$taskLedger" "$invocationLedger" create "$taskTree" "$taskId" "$(hostname)" &&
git worktree add -q --detach "$taskTree" "$candidateBase" &&
ln -s "$target/node_modules" "$taskTree/node_modules"
```

The helper validates the canonical session, both ledger paths and their ancestors, and the task worktree before its first write. Its `create` mode requires a fresh task record and absent task worktree, creates the record exclusively, then registers it before Git or dependency-link creation. Retain active records if later preparation fails and reconcile them before cleanup. It merges the per-task record into the invocation array without losing other tasks. Invoke `node $registerHelper $session $taskLedger $invocationLedger` in PowerShell or `node "$registerHelper" "$session" "$taskLedger" "$invocationLedger"` in POSIX. Both ledgers and the owned task worktree must be under this session's shared `.state/scratch` or an invocation's `.state/runs/<run>/scratch`. After cleanup, set the per-task record's status to `removed` and invoke it again. Serialize ledger updates through the orchestrator.

```javascript
import fs from 'node:fs';
import path from 'node:path';
const [sessionArg, taskArg, ledgerArg, mode, treeArg, owner, host] = process.argv.slice(2);
const create = mode === 'create';
if (process.argv.length !== (create ? 9 : 5)) throw new Error('Session, ledger paths and optional create tree owner host required');
const [session, taskFile, ledgerFile] = [sessionArg, taskArg, ledgerArg].map(p => path.resolve(p));
const inside = (root, value) => { const r = path.relative(root, value); return r !== '' && r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r); };
const stat = p => { try { return fs.lstatSync(p); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const unlinked = value => { for (let p = value; ; p = path.dirname(p)) { if (stat(p)?.isSymbolicLink()) throw new Error('Linked worktree ledger path'); if (p === path.dirname(p)) break; } };
unlinked(session);
if (fs.realpathSync(session) !== session || !stat(path.join(session, '.state'))?.isDirectory()) throw new Error('Expected canonical initialized session');
const owned = value => {
  if (inside(path.join(session, '.state/scratch'), value)) return true;
  const parts = path.relative(path.join(session, '.state/runs'), value).split(path.sep);
  return parts.length > 2 && parts[0] !== '..' && parts[1] === 'scratch' && inside(path.join(session, '.state/runs', parts[0], 'scratch'), value);
};
for (const value of [taskFile, ledgerFile]) { if (!owned(value)) throw new Error('Outside owned session scratch'); unlinked(value); }
if (taskFile === ledgerFile || (create ? stat(taskFile) : !stat(taskFile)?.isFile())) throw new Error('Expected separate fresh or existing task record');
const row = create ? { path: path.resolve(treeArg), owner, host, lifecycle: 'bounded-manual-repair', status: 'active' } : JSON.parse(fs.readFileSync(taskFile, 'utf8'));
if (!row.path || !row.owner || !row.host || !row.lifecycle || !['active','removed','retained','archived'].includes(row.status)) throw new Error('Invalid worktree record');
if (!path.isAbsolute(row.path) || !owned(path.resolve(row.path))) throw new Error('Outside owned task worktree');
unlinked(path.resolve(row.path));
if (create && stat(row.path)) throw new Error('Task worktree must be absent');
if ([taskFile, ledgerFile].some(p => p === row.path || inside(row.path, p))) throw new Error('Ledger overlaps task worktree');
const ledgerStat = stat(ledgerFile);
if (ledgerStat && !ledgerStat.isFile()) throw new Error('Expected invocation ledger file');
const rows = ledgerStat ? JSON.parse(fs.readFileSync(ledgerFile, 'utf8')) : [];
if (!Array.isArray(rows)) throw new Error('Expected invocation worktree array');
const index = rows.findIndex(r => r.path === row.path);
if (index >= 0 && (rows[index].owner !== row.owner || rows[index].host !== row.host)) throw new Error('Worktree ownership conflict');
if (index >= 0) rows[index] = row; else rows.push(row);
if (create) fs.writeFileSync(taskFile, JSON.stringify(row, null, 2) + '\n', { flag: 'wx' });
fs.writeFileSync(ledgerFile, JSON.stringify(rows, null, 2) + '\n');
```

Launch scoped native writers only after successful preparation and ledger registration. Each brief names the approved plan path/hash, task, worktree, allowed paths, criteria, and Verify commands. Writers read the plan through Task Map, then their own task, criteria and verification rows; they name any gap before reading more. Writers use no Git write commands. Preserve live handles; run dependent tasks after prerequisites pass. On writer failure, use the next model in the configured writer model array per [providers](providers.md); one model's quota failure does not prove provider-wide exhaustion.

Inspect the completed worktree delta against approved paths and caller collisions before integration. Preserve unrelated work and candidate evidence. The orchestrator runs these operations, with `candidateCommit` set to the resulting commit ID:

```powershell
git -C $taskTree diff --name-status
git -C $taskTree status --short --untracked-files=all
git -C $taskTree add -- $approvedPaths
if ($LASTEXITCODE -ne 0) { throw 'Candidate staging failed' }
git -C $taskTree commit -m "dispatch repair $taskId"
if ($LASTEXITCODE -ne 0) { throw 'Candidate commit failed' }
$candidateCommit = git -C $taskTree rev-parse HEAD
git -C $target cherry-pick --no-commit $candidateCommit
if ($LASTEXITCODE -ne 0) { throw 'Preserve conflict and reconcile before continuing' }
$candidateBase = $candidateCommit
```

```sh
git -C "$taskTree" diff --name-status
git -C "$taskTree" status --short --untracked-files=all
# Set positional arguments to the inspected approved paths, one argument per path.
# Example: set -- "skills/dispatch/SKILL.md" "skills/dispatch/references/self-build.md"
git -C "$taskTree" add -- "$@" &&
git -C "$taskTree" commit -m "dispatch repair $taskId" &&
candidateCommit=$(git -C "$taskTree" rev-parse HEAD) &&
git -C "$target" cherry-pick --no-commit "$candidateCommit" &&
candidateBase=$candidateCommit
```

Before each no-commit delivery, inspect the index and working tree for collisions with that task's delta; stop and reconcile collisions without discarding caller work. Keep target HEAD unchanged and include the full accumulated target delta in working-tree review. Run each task's Verify commands after integration. Remove dependency links and completed owned worktrees only after writers stop and results are preserved; update invocation and per-task records to `removed` and verify `git worktree list --porcelain`. Use `Remove-Item -LiteralPath (Join-Path $taskTree 'node_modules')` for a checked Windows junction, or `unlink "$taskTree/node_modules"` for a checked POSIX symlink, then `git worktree remove <taskTree>`. Resolve cleanup failures without force-deleting unpreserved work. Run independent code review at the approved level, trim only transient criterion tests, regenerate hashes when needed, and run required final gates including `npm test` and `git diff --check`. Keep the blocked original run and report its disposition; manual repair does not establish that its journal can resume.

## Retain or clean controller artifacts

Retain every controller, helper and recovery input needed by an unfinished run. Record `retained` with the run, live handles and reason in a session lifecycle log; verify those paths still exist. At terminal completion, after workers stop, owned worktrees are accounted for and required gates pass, preserve inventories, journal and proof/recovery logs. Record the exact controller, quarantine and helper paths eligible for removal; local configuration stays in ignored scratch.

The following `cleanup-controller.mjs` helper accepts `session`, lifecycle log, disposition (`retained` or `complete`), then an explicit list of owned controller/helper paths. The host establishes ownership and terminal state first. It preflights every path and ancestor before any deletion, refuses scratch itself or outside paths and links, records before/after listings, and deletes only on `complete`. Keep the log and inventories outside the removal list. Run with separate quoted arguments on PowerShell or POSIX.

```javascript
import fs from 'node:fs';
import path from 'node:path';
const [sessionArg, logArg, disposition, ...args] = process.argv.slice(2);
if (!['retained', 'complete'].includes(disposition) || args.length === 0) throw new Error('Explicit lifecycle disposition and owned paths required');
const session = fs.realpathSync(sessionArg), scratch = path.join(session, '.state/scratch'), log = path.resolve(logArg), targets = args.map(p => path.resolve(p));
const inside = (root, value) => { const r = path.relative(root, value); return r !== '' && r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r); };
const stat = p => { try { return fs.lstatSync(p); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
for (const value of [log, ...targets]) {
  if (!inside(scratch, value) || targets.some(t => log === t || inside(t, log))) throw new Error('Outside owned scratch or log targeted');
  for (let p = value; ; p = path.dirname(p)) { if (stat(p)?.isSymbolicLink()) throw new Error('Linked cleanup path'); if (p === path.dirname(p)) break; }
}
for (const value of targets) if (!stat(value)) throw new Error('Missing cleanup target');
const listing = p => stat(p) ? { path:p, entries:fs.statSync(p).isDirectory() ? fs.readdirSync(p).sort() : null } : { path:p, missing:true };
const before = targets.map(listing);
if (disposition === 'complete') for (const p of targets) fs.rmSync(p, { recursive:true, force:false });
fs.appendFileSync(log, JSON.stringify({ disposition, before, after:targets.map(listing) }) + '\n');
```
