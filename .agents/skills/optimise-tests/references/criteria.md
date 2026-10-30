# Writer Criteria

Rules for one unit writer optimising one packet. The packet lists files, line counts, durations, slow tests, and duplicate or merge candidates. Candidates are leads; inspect the tests before changing them.

The canonical behavioral test bar lives in the [code section of the quality bar](../../../../skills/dispatch/references/templates/quality-bar.md#code). Apply it to new, changed, and retained tests. Use `AGENTS.md` § Code Comments for comment and `// SECTION:` conventions.

## Scope and file splitting

- Edit only packet files. Respect file-splitting rules by packet scope:
  - **Single-packet units**: The writer owns the packet's test files and may directly split dense or slow files (surfaced in packet `budgetOverruns` or `denseFiles`) in-place into logical sub-files within `<unit>` (adding new test files directly). Paths matching `excludeFromWriters` (shared helpers and fixtures) remain lead-owned. Map split tests using `split` or `rewrite` action records and retain records.
  - **Multi-packet units**: Parallel writers must not create new files directly to prevent path collisions. Propose required `move` or `split` actions in `<work>/ledger/<id>.jsonl` with explicit before and intended after references. The lead executes file creation and test moves serially in Step 4.
- Report helper, fixture, and cross-unit requests to the lead in the completion response; do not add unsupported ledger record kinds.
- Preserve every baseline failure. Leave a failing test unchanged and report any proposed action on it as a blocker for lead review.

## Evidence records

Classify every baseline test with an action record or a positive retained-scenario record. Do not default an unlisted test to keep. Related tests may share one retained scenario when they exercise the same consumer behavior; name each reference and explain the scenario's distinct contribution. Give a separate record to another boundary or failure mode.

Append one JSON object per line to `<work>/ledger/<id>.jsonl`. The gate accepts only `action`, `retain`, and `savings` record kinds. Writers own action and retain records. The lead owns optional savings reports after the full after snapshot. Unknown kinds, unresolved escalation records, malformed JSON, and unsupported fields fail the gate.

Each test reference uses the repo-relative file path and exact reported test name. Add `line` only when that file/name occurs more than once in the named inventory; then use its inventory line. Normalize path separators. `before` references resolve in the before inventory, and `after` references resolve in the full after inventory. Use separate references because line numbers can change between snapshots.

An action record has this shape:

```jsonl
{"kind":"action","id":"A1","action":"rewrite","before":[{"file":"tests/unit/transfer.test.ts","name":"rejects a duplicate transfer"}],"after":[{"file":"tests/unit/transfer.test.ts","name":"rejects replay without changing the balance"}],"reason":"Replace the self-derived assertion with the replay error and unchanged balance checks."}
{"kind":"retain","contract":"The transfer consumer rejects a repeated transaction without debiting the balance twice.","plausibleDefect":"A replay debits the account twice and corrupts its balance.","observableOutcome":"The caller receives the replay error and the account balance stays unchanged.","distinctContribution":"Covers durable replay protection after commit; static types cannot guarantee runtime transaction uniqueness.","before":[{"file":"tests/unit/transfer.test.ts","name":"rejects a duplicate transfer"}],"after":[{"file":"tests/unit/transfer.test.ts","name":"rejects replay without changing the balance"}]}
```

`action` is one of `delete`, `merge`, `add`, `rewrite`, `move`, or `split`. IDs are unique. Every record has `before`, `after`, and a nonblank `reason`; arrays may be empty only where the action allows it. `delete` and `merge` also require one `category` from this closed set:
- `trivial-spec`: mechanical checks without plausible severe failure, such as type-mirroring.
- `coverage-padding`: checks written solely to execute lines or branches without behavioral contract.
- `redundant-behavior`: tests that duplicate defect detection of another test, including parametric sweeps and fragmented micro-tests.
- `implementation-coupled-assertion`: checks asserting internal mocks, private state, or invocation counts instead of observable outcomes.
- `self-derived-assertion`: assertions comparing results against identical test-constructed values rather than independent expectations.
- `synthetic/no-required-contract`: placeholder or scaffold tests with no corresponding product requirement.

No other category is valid.

- `delete` needs at least one before reference. A `redundant-behavior` deletion also names one or more surviving tests in `after` and explains the same-defect coverage. A hollow deletion may have an empty `after`; its reason must name the missing required contract.
- `merge` needs before and surviving after references. Its evidence shape requires:
  - `before`: contains only absorbed tests that are removed; exclude tests that survive unchanged. Absorbed tests must not appear in the after snapshot and must not be listed in `retain.before`.
  - `after`: contains the surviving test reference(s) that preserve the required behavior.
  - `retain`: every surviving test in `action.after` must be classified in a `retain` record (`retain.after`, and `retain.before` if the survivor existed in baseline). Absorbed before tests cannot be listed in `retain.before`.
  - `reason`: explains why the survivors detect the same defect and preserve the contract.
  - `category`: one deletion category from the closed set, typically `redundant-behavior`.
- `add` has no before references and at least one after reference. `rewrite`, `move`, and `split` map at least one before reference to at least one after reference.
- Every action's surviving after reference also needs a retained-scenario record. New after tests need an `add` or mapping action. A renamed or moved retained test needs an explicit mapping action.

A retained-scenario record has this shape:

```json
{"kind":"retain","contract":"The transfer consumer rejects a repeated transaction without debiting the balance twice.","plausibleDefect":"A replay debits the account twice and corrupts its balance.","observableOutcome":"The caller receives the replay error and the account balance stays unchanged.","distinctContribution":"Covers durable replay protection after commit; static types cannot guarantee runtime transaction uniqueness.","before":[{"file":"tests/unit/transfer.test.ts","name":"rejects a duplicate transfer"}],"after":[{"file":"tests/unit/transfer.test.ts","name":"rejects a duplicate transfer"}]}
```

All four explanations are required and nonblank. `after` must name at least one surviving test. Every baseline test must occur in an action or retained scenario, and every after test must occur in a retained scenario. A deleted or merged before test cannot also be retained. Keep each retained record positive: name the consumer contract, plausible severe failure, observable result, distinct contribution and why static checks do not already guarantee it. The lead judges these explanations; the gate validates their presence and mappings.

Related tests may share one retained-scenario record only when they exercise the same consumer behavior. Name every identity and explain each contribution. For example, a transfer replay after restart checks persisted deduplication; a concurrent replay checks atomicity. Both protect account balances, but each detects a distinct state-corruption defect that static types do not guarantee against.

These records show a hollow deletion without a replacement, a duplicate deletion whose survivor is retained, and a merge whose survivor is retained:

```jsonl
{"kind":"action","id":"A2","action":"delete","before":[{"file":"tests/unit/config.test.ts","name":"returns the config it just built"}],"after":[],"reason":"The assertion compares the result with the same constructed value and protects no required behavior.","category":"self-derived-assertion"}
{"kind":"action","id":"A3","action":"delete","before":[{"file":"tests/unit/transfer.test.ts","name":"rejects replay before restart"}],"after":[{"file":"tests/unit/transfer.test.ts","name":"rejects transfer replay"}],"reason":"The survivor detects the same double-debit defect before and after restart.","category":"redundant-behavior"}
{"kind":"action","id":"A4","action":"merge","before":[{"file":"tests/unit/transfer.test.ts","name":"rejects negative amount"}],"after":[{"file":"tests/unit/transfer.test.ts","name":"validates transfer amount boundaries"}],"reason":"Merge boundary checks into a single scenario asserting amount limits.","category":"redundant-behavior"}
{"kind":"retain","contract":"The transfer consumer rejects replay without a second debit.","plausibleDefect":"A replay corrupts the balance with a second debit.","observableOutcome":"The caller receives the replay error and the balance stays unchanged.","distinctContribution":"Checks persisted deduplication across restart, which static types do not guarantee.","before":[{"file":"tests/unit/transfer.test.ts","name":"rejects transfer replay"}],"after":[{"file":"tests/unit/transfer.test.ts","name":"rejects transfer replay"}]}
{"kind":"retain","contract":"The transfer consumer rejects amounts outside configured limits.","plausibleDefect":"Negative or zero amounts bypass validation and debit account.","observableOutcome":"Caller receives amount validation error and balance is untouched.","distinctContribution":"Verifies amount boundaries; static types cannot enforce positive numbers.","before":[],"after":[{"file":"tests/unit/transfer.test.ts","name":"validates transfer amount boundaries"}]}
```

The names in examples must resolve in the inventories for a real run. These records illustrate field use; the full ledger must classify every baseline and after test without contradictory outcomes. A `move` record proposes before and intended after references, but the lead applies the move and confirms its destination in the final inventory. If a required contract is uncertain, leave the test unchanged and report a blocker outside the ledger; resolve it before a successful gate run. Do not invent an `escalate` record.

## Deletion and retention judgment

Aggressively challenge every test's right to exist under the high-value test bar. Retained tests must defend a plausible severe defect (consumer contract breakage, state corruption, data loss, security violations, or broken protocol transitions) distinct from static types or adjacent tests. Delete or merge any test that cannot articulate this defense. Coverage percentages never justify durable retention or gate deletion.

Assign each `delete` and `merge` action to one category from the closed set defined under [Evidence records](#evidence-records). Prune tests matching the five concrete anti-patterns below:

### Anti-pattern 1: Trivial spec / type-mirroring

- **Description**: Asserting property types, object shapes, or enum values that TypeScript static analysis already enforces at compile time, without exercising runtime validation or error handling.
- **Rationale**: Static types enforce compile-time interfaces on every build. Dedicated tests asserting `typeof x === 'string'` or checking non-null field existence on typed returns add runtime cost without catching defects.
- **Action & category**: `delete` with category `trivial-spec`.
- **Example**:
  ```ts
  // Anti-pattern: asserting types guaranteed by TypeScript interface
  test('returns user object with string fields', () => {
    const user = getUser('u1');
    assert.equal(typeof user.id, 'string');
    assert.equal(typeof user.name, 'string');
  });
  ```
  Ledger record:
  ```jsonl
  {"kind":"action","id":"D1","action":"delete","before":[{"file":"tests/unit/user.test.ts","name":"returns user object with string fields"}],"after":[],"reason":"Static types already guarantee User property shapes; test exercises no runtime boundary or validator.","category":"trivial-spec"}
  ```

### Anti-pattern 2: Parametric permutation sweeps

- **Description**: Loops or parameterized tables running across 5+ similar input values where one representative case plus 1–2 contract-defined edge boundaries (such as empty string, minimum length, maximum length, or delimiter) suffice to catch defects.
- **Rationale**: Sweeping intermediate values (e.g. testing ten valid alphanumeric names) traverses identical code paths. Boundaries and error transitions find defects; repetitive permutations consume the execution budget without adding assurance.
- **Action & category**: `merge` with category `redundant-behavior` into focused boundary and representative tests, or `delete` redundant iterations with category `redundant-behavior` pointing to surviving tests.
- **Example**:
  ```ts
  // Anti-pattern: sweeping across 5 similar valid alphanumeric strings
  for (const slug of ['alpha', 'bravo', 'charlie', 'delta', 'echo']) {
    test(`validates slug ${slug}`, () => { assert.ok(isValidSlug(slug)); });
  }
  // Refactored: verify representative valid format and empty boundary in one scenario
  test('validates representative slug format and rejects empty input', () => {
    assert.ok(isValidSlug('alpha'));
    assert.equal(isValidSlug(''), false);
  });
  ```
  Ledger record:
  ```jsonl
  {"kind":"action","id":"M1","action":"merge","before":[{"file":"tests/unit/slug.test.ts","name":"validates slug alpha"},{"file":"tests/unit/slug.test.ts","name":"validates slug bravo"},{"file":"tests/unit/slug.test.ts","name":"validates slug charlie"},{"file":"tests/unit/slug.test.ts","name":"validates slug delta"},{"file":"tests/unit/slug.test.ts","name":"validates slug echo"}],"after":[{"file":"tests/unit/slug.test.ts","name":"validates representative slug format and rejects empty input"}],"reason":"Consolidate repetitive slug permutation tests into representative format and empty boundary verification.","category":"redundant-behavior"}
  {"kind":"retain","contract":"Validates alphanumeric slug strings and rejects empty inputs.","plausibleDefect":"RegEx parsing bug rejects valid slugs or accepts empty strings.","observableOutcome":"Returns true for valid slug inputs and false for empty string.","distinctContribution":"Guarantees valid slug formatting and empty boundary protection without permutation loop overhead.","before":[],"after":[{"file":"tests/unit/slug.test.ts","name":"validates representative slug format and rejects empty input"}]}
  ```

### Anti-pattern 3: Fragmented micro-tests

- **Description**: Multiple adjacent test cases that invoke the same operation and assert individual properties of one returned result across separate `test()` blocks.
- **Rationale**: Each test block incurs runner setup and teardown overhead while asserting fields of the same computation. If the operation fails, all micro-tests fail together for the same underlying defect.
- **Action & category**: `merge` with category `redundant-behavior` into a single scenario asserting all required properties of the result.
- **Example**:
  ```ts
  // Anti-pattern: three separate tests for one payload
  test('parses status', () => { assert.equal(parseResponse(raw).status, 200); });
  test('parses body', () => { assert.equal(parseResponse(raw).body, 'ok'); });
  test('parses timestamp', () => { assert.ok(parseResponse(raw).timestamp > 0); });
  // Refactored: single consolidated scenario
  test('parses full response payload', () => {
    const res = parseResponse(raw);
    assert.equal(res.status, 200);
    assert.equal(res.body, 'ok');
    assert.ok(res.timestamp > 0);
  });
  ```
  Ledger record:
  ```jsonl
  {"kind":"action","id":"M2","action":"merge","before":[{"file":"tests/unit/parser.test.ts","name":"parses status"},{"file":"tests/unit/parser.test.ts","name":"parses body"},{"file":"tests/unit/parser.test.ts","name":"parses timestamp"}],"after":[{"file":"tests/unit/parser.test.ts","name":"parses full response payload"}],"reason":"Consolidate fragmented field assertions into a single scenario asserting the parsed response contract.","category":"redundant-behavior"}
  ```

### Anti-pattern 4: Implementation-coupled / mock assertions

- **Description**: Tests asserting mock invocations, spy call counts, private method calls, or intermediate execution order instead of observable outcomes, state changes, or emitted errors.
- **Rationale**: Mock-coupled tests act as change detectors: they break during internal refactorings even when observable behavior remains correct, while failing to detect bugs when mock contracts diverge from runtime reality. Asserting commands or payloads across an external process, network, or storage boundary verifies a required interface contract; asserting invocations of internal helper functions is implementation coupling.
- **Action & category**: `delete` with category `implementation-coupled-assertion`, or `rewrite` to assert observable outcomes.
- **Example**:
  ```ts
  // Anti-pattern: asserting internal mock invocation count
  test('calls internal logger spy', () => {
    const spy = mock.fn();
    runner._logger = spy;
    runner.execute(task);
    assert.equal(spy.mock.calls.length, 1);
  });
  // Refactored: verify observable task execution outcome
  test('executes task to completion', () => {
    const outcome = runner.execute(task);
    assert.equal(outcome.status, 'complete');
  });
  ```
  Ledger record:
  ```jsonl
  {"kind":"action","id":"D2","action":"delete","before":[{"file":"tests/unit/runner.test.ts","name":"calls internal logger spy"}],"after":[],"reason":"Asserts internal logger mock invocation count rather than observable execution outcome.","category":"implementation-coupled-assertion"}
  ```

### Anti-pattern 5: Heavy repeated setup

- **Description**: Unit tests that repeatedly execute physical filesystem I/O, spawn subprocesses, initialize disk git repositories, or perform expensive serialization inside each `test()` block rather than using in-memory fixtures or sharing read-only state via `before()`.
- **Rationale**: Physical operations dominate test duration and easily breach the per-file execution budget (surfaced in packet `budgetOverruns`). Real subprocess and git flows belong in `tests/e2e/`; unit tests must remain fast and in-memory.
- **Action & category**: Rewrite setup to use in-memory structures or share read-only fixtures in `before()`. Consolidate repetitive tests with `merge` (category `redundant-behavior`) and record setup savings. If physical subprocesses are strictly required, propose a `move` to `tests/e2e/`.
- **Example**:
  ```ts
  // Anti-pattern: spawning physical git subprocesses in every unit test
  test('reads commit message', () => {
    const dir = fs.mkdtempSync('test-repo');
    child_process.execSync('git init && git commit --allow-empty -m "initial"', { cwd: dir });
    assert.equal(getCommitMessage(dir), 'initial');
    fs.rmSync(dir, { recursive: true });
  });
  // Refactored: inject in-process runner that verifies command arguments and cwd without subprocess spawning
  test('reads commit message with verified runner arguments', () => {
    const calls: { args: string[]; cwd: string }[] = [];
    const runner = {
      execGit: (args: string[], cwd: string) => {
        calls.push({ args, cwd });
        return 'initial\n';
      },
    };
    assert.equal(getCommitMessage('test-repo', runner), 'initial');
    assert.deepEqual(calls, [{ args: ['log', '-1', '--format=%B'], cwd: 'test-repo' }]);
  });
  ```
  Ledger record:
  ```jsonl
  {"kind":"action","id":"R2","action":"rewrite","before":[{"file":"tests/unit/git.test.ts","name":"reads commit message"}],"after":[{"file":"tests/unit/git.test.ts","name":"reads commit message with verified runner arguments"}],"reason":"Inject in-process runner asserting command arguments and cwd to preserve contract verification without physical subprocess spawning."}
  {"kind":"retain","contract":"Issues git log with exact format options in repository directory and returns trimmed message.","plausibleDefect":"Wrong git arguments, missing cwd, or trimming error corrupts commit message retrieval.","observableOutcome":"Passes correct git arguments and cwd to runner and returns expected message string.","distinctContribution":"Verifies git command wiring and output processing without physical subprocess disk I/O.","before":[{"file":"tests/unit/git.test.ts","name":"reads commit message"}],"after":[{"file":"tests/unit/git.test.ts","name":"reads commit message with verified runner arguments"}]}
  ```

## Proof and savings

Inspection is the default proof. Use targeted temporary fault injection only when it resolves uncertainty about whether a retained test distinguishes the intended defect.

The comparison report measures reported leaf-test counts and suite wall-clock duration. Ledger claims are separate: the optional single `savings` record may report `scenariosRemoved`, `casesRemoved`, `cosmeticTableMerges`, and `repeatedSetupCallsReduced`, with concrete `evidence`. Each count is a nonnegative integer. The report labels these values as ledger-reported, not inventory-measured; omitted values remain unmeasured. Count removed cases or reduced setup only when the evidence supports those changes. A table merge that retains every case is cosmetic and is not removed work.

## Timing rules

- Replace real sleeps and timeouts with injected clocks, resolved promises, or event waits.
- Build expensive setup once per `describe` block with `before`/`after` when tests only read it.
- Use in-process calls instead of subprocesses outside `tests/e2e/`; propose a `move` for tests that need real subprocesses or Git flows.
- Keep every non-e2e file under `FILE_BUDGET_MS` in `scripts/test-reporter.ts`; split a file that cannot meet it.

**Completion criterion:** Every baseline test in the packet has valid action or retain evidence; every after test has a retained-scenario record; mappings and deletion claims resolve against the correct snapshots; and the focused verification command passes over the packet files. Return unresolved intent or out-of-scope requests as blockers for the lead.
