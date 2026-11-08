import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../../../skills/dispatch/scripts/toolkit/cli.ts';
import { foldLedger } from '../../../skills/dispatch/scripts/toolkit/ledger.ts';
import { sessionFixture } from './helpers/session.ts';

function fixture(native = false) {
  const f = sessionFixture({ memory: true });
  const skill = path.join(f.root, 'skill'); fs.mkdirSync(skill);
  fs.writeFileSync(path.join(skill, 'config.jsonc'), JSON.stringify({'read-delegates': {
    codex: {nativeSubagentsOnly: native, targets: [{medium: {model: 'answer'}}]},
  }}));
  f.deps.skillRoot = skill;
  if (native) f.deps.orchestrator = {platform: 'codex', model: null};
  const question = f.artifact('q.md', 'Why does this work?');
  const call = async (...options: string[]) => {
    f.lines.length = 0;
    const exit = await main(['ask', 'run', question, '--session', f.session, ...options], f.deps);
    const output = f.output();
    return {exit, output, value: output.path ? JSON.parse(fs.readFileSync(output.path, 'utf8')) : null};
  };
  return {...f, question, call};
}

test('ask run returns sanitized source answers and launches a new completed attempt', async () => {
  const f = fixture(); try {
    f.script('codex', 'answer', '\u001b[31mUseful `answer`\u001b[0m\n```sh\nsecret\n```\n<!--visible-->');
    const first = await f.call();
    assert.equal(first.exit, 0);
    assert.deepEqual(first.value.answers, [{slot: 'codex[0]', provider: 'codex', responder: {slot: 'codex[0]', provider: 'codex', model: 'answer', native: false}, text: 'Useful answer &lt;!--visible--&gt;'}]);
    assert.match(first.output.summary, /^ask: 1 answers, 0 failed$/);
    assert.equal((await f.call()).exit, 0);
    assert.equal(f.launches.length, 2);
    assert.match(f.launches[1]!.request.promptPath, /attempt-2/);
    assert.match(fs.readFileSync(f.launches[0]!.request.promptPath, 'utf8'), /Why does this work\?/);
    assert.equal(f.launches[0]?.request.sessionRoot, f.session);
    assert.deepEqual(foldLedger(f.session).records, []);
  } finally {f.cleanup();}
});

test('ask run refuses missing input and unapproved high levels before launch', async () => {
  const f = fixture(); try {
    const unapproved = await f.call('--level', 'xhigh');
    assert.equal(unapproved.output.reason, 'level-unapproved');
    assert.equal(unapproved.exit, 4);
    fs.unlinkSync(f.question);
    const missing = await f.call();
    assert.equal(missing.exit, 1); assert.equal(missing.output.reason, 'invalid-input');
    assert.equal(f.launches.length, 0);
  } finally {f.cleanup();}
});

test('ask run exposes provider failures and retries the unfinished attempt', async () => {
  const f = fixture(); try {
    f.script('codex', 'answer', {status: 'fail', cls: 'auth', detail: 'login required'});
    const failed = await f.call();
    assert.equal(failed.exit, 2); assert.equal(failed.output.reason, 'ask-failed');
    assert.equal(failed.value.failed[0].cls, 'auth');
    f.script('codex', 'answer', 'recovered');
    assert.equal((await f.call()).exit, 0);
    assert.match(f.launches[1]!.request.promptPath, /attempt-1/);
  } finally {f.cleanup();}
});

test('ask run holds an exclusive claim while a delegate is active', async () => {
  const f = fixture(); try {
    let release!: () => void;
    let started!: () => void;
    const active = new Promise<void>(resolve => {started = resolve;});
    const waiting = new Promise<void>(resolve => {release = resolve;});
    f.deps.delegate = async () => {started(); await waiting; return {outcome: {status: 'ok', text: 'done', resume: null, sessionId: null}, invocations: []};};
    f.deps.isAlive = () => true;
    const first = main(['ask', 'run', f.question, '--session', f.session], {...f.deps, stdout: () => {}});
    await Promise.race([active, first.then(exit => {assert.equal(exit, 0);})]);
    const held = await f.call();
    assert.equal(held.exit, 3); assert.equal(held.output.reason, 'lock-held');
    release(); assert.equal(await first, 0);
  } finally {f.cleanup();}
});

test('ask run promotes native replies before publishing answers', async () => {
  const f = fixture(true); try {
    const pending = await f.call();
    assert.equal(pending.exit, 4); assert.equal(pending.output.reason, 'native-pending');
    const native = pending.value.native[0];
    assert.match(fs.readFileSync(native.promptPath, 'utf8'), /Why does this work\?/);
    const answers = path.join(path.dirname(path.dirname(native.promptPath)), 'answers.json');
    assert.equal(fs.existsSync(answers), false);
    fs.writeFileSync(native.replyPath, '```sh\ninvalid\n```');
    const invalid = await f.call();
    assert.equal(invalid.exit, 4); assert.match(invalid.value.native[0].error, /empty/i);
    assert.equal(fs.existsSync(answers), false);
    fs.writeFileSync(native.replyPath, 'Native `answer`');
    const done = await f.call();
    assert.equal(done.exit, 0); assert.equal(done.value.answers[0].text, 'Native answer');
    assert.deepEqual(done.value.answers[0].responder, {slot: 'codex[0]', provider: 'codex', model: 'answer', native: true});
    assert.deepEqual(JSON.parse(fs.readFileSync(answers, 'utf8')).answers, done.value.answers);
    assert.equal(fs.existsSync(answers), true); assert.equal(f.launches.length, 0);
    assert.deepEqual(foldLedger(f.session).records, []);
  } finally {f.cleanup();}
});

test('ask run follows native-first launch wave consume order', async () => {
  const f = fixture(); try {
    fs.writeFileSync(path.join(f.deps.skillRoot, 'config.jsonc'), JSON.stringify({'read-delegates': {
      claude: {targets: [{medium: {model: 'target'}}]},
    }, phases: {ask: {targets: {medium: 1}}}}));
    f.deps.orchestrator = {platform: 'claude', model: null};
    f.deps.liveness = {claude: true, agy: true};
    const launched = await f.call();
    assert.equal(launched.output.reason, 'native-pending');
    assert.equal(launched.value.cliWave, 'pending');
    assert.equal(launched.value.native.length, 1);
    assert.equal(f.launches.length, 0);
    const waved = await f.call();
    assert.equal(waved.output.reason, 'native-pending');
    assert.equal(waved.value.cliWave, 'done');
    assert.equal(f.launches.length, 0);
    fs.writeFileSync(waved.value.native[0].replyPath, 'Native answer');
    const done = await f.call();
    assert.equal(done.exit, 0);
    assert.equal(done.value.answers.length, 1);
  } finally {f.cleanup();}
});

test('ask run attributes reserve and cross-provider native answers to their actual responder', async () => {
  for (const native of [false, true]) {
    const f = fixture(); try {
      fs.writeFileSync(path.join(f.deps.skillRoot, 'config.jsonc'), JSON.stringify({'read-delegates': {
        claude: {targets: [{medium: {model: 'target'}}]},
        ...(native ? {codex: {nativeSubagentsOnly: true, targets: [{medium: {model: 'reserve'}}]}} : {copilot: {targets: [{medium: {model: 'reserve'}}]}}),
      }, phases: {ask: {targets: {medium: 1}}}}));
      f.script('claude', 'target', {status: 'fail', cls: 'not-found', detail: 'unavailable'});
      if (native) f.deps.orchestrator = {platform: 'codex', model: 'host-model'};
      else f.script('copilot', 'reserve', 'Reserve answer');
      let result = await f.call();
      let directory: string;
      if (native) {
        assert.equal(result.output.reason, 'native-pending');
        const pending = result.value.native[0];
        directory = path.dirname(path.dirname(pending.promptPath));
        fs.writeFileSync(pending.replyPath, 'Native answer');
        result = await f.call();
        assert.equal(f.launches.length, 1);
      } else directory = path.dirname(path.dirname(f.launches[0]!.request.promptPath));
      assert.equal(result.exit, 0);
      const provider = native ? 'codex' : 'copilot';
      assert.deepEqual(result.value.answers, [{slot: 'claude[0]', provider,
        responder: {slot: native ? 'claude[0]' : 'copilot[0]', provider, model: 'reserve', native},
        text: native ? 'Native answer' : 'Reserve answer'}]);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'answers.json'), 'utf8')).answers, result.value.answers);
    } finally {f.cleanup();}
  }
});

function nativeExclusionFixture() {
  const f = fixture();
  fs.writeFileSync(path.join(f.deps.skillRoot, 'config.jsonc'), JSON.stringify({'read-delegates': {
    codex: {targets: [{medium: {model: 'answer'}}]},
    copilot: {nativeSubagentsOnly: true, targets: [{medium: {model: 'native'}}]},
  }}));
  f.deps.orchestrator = {platform: 'claude', model: null};
  return f;
}

test('ask summary reports underfill for native-only providers excluded for another host', async () => {
  const f = nativeExclusionFixture(); try {
    f.script('codex', 'answer', 'Useful answer');
    const result = await f.call();
    assert.equal(result.exit, 0);
    assert.deepEqual(result.value.underfill, {host: 'claude', configured: 1, resolved: 1, excluded: ['copilot']});
    assert.equal(result.output.summary, 'ask: 1 answers, 0 failed; underfill 1/1 targets, host claude, excluded native-only: copilot');

    fs.writeFileSync(path.join(f.deps.skillRoot, 'config.jsonc'), JSON.stringify({'read-delegates': {
      copilot: {nativeSubagentsOnly: true, targets: [{medium: {model: 'native'}}]},
    }}));
    const refused = await f.call();
    assert.equal(refused.exit, 1); assert.equal(refused.output.reason, 'invalid-input');
    assert.equal(refused.output.summary, 'ask requires a read delegate; underfill 0/1 targets, host claude, excluded native-only: copilot');
  } finally {f.cleanup();}
});

test('ask run refuses host-undetected without a recorded host when a native-only provider would drop', async () => {
  const f = fixture(true); try {
    f.deps.orchestrator = null;
    const refused = await f.call();
    assert.equal(refused.exit, 4);
    assert.equal(refused.output.reason, 'host-undetected');
    assert.match(refused.output.summary, /codex.*session reactivate --session-dir <session> --host <platform>/);
    assert.equal(f.launches.length, 0);
  } finally {f.cleanup();}
});

test('ask run quarantines a blocked native reply and returns the cli answer', async () => {
  const f = fixture(); try {
    fs.writeFileSync(path.join(f.deps.skillRoot, 'config.jsonc'), JSON.stringify({'read-delegates': {
      claude: {targets: [{medium: {model: 'target'}}]},
    }, phases: {ask: {targets: {medium: 1}}}}));
    f.deps.orchestrator = {platform: 'claude', model: null};
    f.deps.liveness = {claude: true, agy: true};
    const launched = await f.call();
    assert.equal(launched.output.reason, 'native-pending');
    assert.equal(launched.value.cliWave, 'pending');
    const waved = await f.call();
    assert.equal(waved.output.reason, 'native-pending');
    assert.equal(waved.value.cliWave, 'done');
    const replyPath = waved.value.native[0].replyPath as string;
    f.script('claude', 'target', 'CLI answer');
    fs.writeFileSync(replyPath, 'BLOCKED: cannot access\npartial');
    const done = await f.call();
    assert.equal(done.exit, 0);
    assert.equal(done.value.answers.length, 1);
    assert.equal(done.value.answers[0].text, 'CLI answer');
    assert.ok(!done.value.answers[0].text.includes('cannot access'));
    assert.ok(fs.existsSync(replyPath + '.invalid-1'));
    assert.ok(f.launches.some(launch => launch.provider === 'claude'));
  } finally {f.cleanup();}
});

test('ask run runs the reserve cli when a native attempt fails', async () => {
  const f = fixture(); try {
    fs.writeFileSync(path.join(f.deps.skillRoot, 'config.jsonc'), JSON.stringify({'read-delegates': {
      claude: {targets: [{medium: {model: 'target'}}]},
      codex: {targets: [{medium: {model: 'reserve'}}]},
    }, phases: {ask: {targets: {medium: 1}}}}));
    f.deps.orchestrator = {platform: 'codex', model: null};
    f.deps.liveness = {claude: true, codex: true};
    f.script('claude', 'target', {status: 'fail', cls: 'not-found', detail: 'unavailable'});
    const launched = await f.call();
    assert.equal(launched.output.reason, 'native-pending');
    const waved = await f.call();
    assert.equal(waved.output.reason, 'native-pending');
    const attempt = waved.value.native[0].attempt as string;
    assert.ok(attempt.startsWith('codex[0]#'));
    f.script('codex', 'reserve', 'Reserve answer');
    const done = await f.call('--native-failed', attempt + '=voice unavailable');
    assert.equal(done.exit, 0);
    assert.equal(done.value.answers.length, 1);
    assert.equal(done.value.answers[0].text, 'Reserve answer');
    assert.equal(done.value.answers[0].responder.provider, 'codex');
    assert.ok(f.launches.some(launch => launch.provider === 'claude'));
    assert.ok(f.launches.some(launch => launch.provider === 'codex'));
  } finally {f.cleanup();}
});

test('ask run prefers a failure report over a partial native file', async () => {
  const f = fixture(); try {
    fs.writeFileSync(path.join(f.deps.skillRoot, 'config.jsonc'), JSON.stringify({'read-delegates': {
      claude: {targets: [{medium: {model: 'target'}}]},
    }, phases: {ask: {targets: {medium: 1}}}}));
    f.deps.orchestrator = {platform: 'claude', model: null};
    f.deps.liveness = {claude: true, agy: true};
    assert.equal((await f.call()).output.reason, 'native-pending');
    const waved = await f.call();
    assert.equal(waved.output.reason, 'native-pending');
    const pending = waved.value.native[0];
    fs.writeFileSync(pending.replyPath, 'partial answer');
    const attempt = pending.attempt as string;
    f.script('claude', 'target', 'CLI answer');
    const done = await f.call('--native-failed', attempt + '=voice gone');
    assert.equal(done.exit, 0);
    assert.equal(done.value.answers[0].text, 'CLI answer');
    assert.ok(!done.value.answers[0].text.includes('partial'));
    assert.ok(fs.existsSync((pending.replyPath as string) + '.invalid-1'));
  } finally {f.cleanup();}
});

test('ask diagnostics retain a host native-only reserve attempt reported failed', async () => {
  const f = fixture(); try {
    fs.writeFileSync(path.join(f.deps.skillRoot, 'config.jsonc'), JSON.stringify({'read-delegates': {
      claude: {targets: [{medium: {model: 'target'}}]},
      codex: {nativeSubagentsOnly: true, targets: [{medium: {model: 'reserve'}}]},
    }, phases: {ask: {targets: {medium: 1}}}}));
    f.deps.orchestrator = {platform: 'codex', model: null};
    f.deps.liveness = {claude: true, codex: true};
    f.script('claude', 'target', {status: 'fail', cls: 'auth', detail: 'denied'});
    const events: unknown[] = [];
    f.deps.diagnostics = (event: unknown) => { events.push(event); };
    const launched = await f.call();
    assert.equal(launched.output.reason, 'native-pending');
    const attempt = launched.value.native[0].attempt as string;
    assert.ok(attempt.startsWith('codex[0]#'), 'the host reserve mints the native attempt: ' + attempt);
    const reported = await f.call('--native-failed', attempt + '=BLOCKED: host reserve denied');
    assert.equal(reported.output.reason, 'ask-failed');
    assert.equal(reported.value.failed[0].cls, 'blocked');
    const pendingEvent = events.find((event: any) => event.kind === 'native' && event.state === 'pending') as any;
    assert.ok(pendingEvent, 'the reserve mint keeps its native pending marker: ' + JSON.stringify(events.filter((event: any) => event.kind === 'native')));
    assert.equal(pendingEvent.slot, 'claude[0]', 'the pending marker keeps the logical target slot');
    assert.equal(pendingEvent.provider, 'codex', 'the pending marker names the reserve provider');
    assert.equal(pendingEvent.model, 'reserve', 'the pending marker names the reserve model');
    assert.ok(events.some((event: any) => event.kind === 'native' && event.state === 'failed' && event.provider === 'codex'), 'a reported native-only reserve failure emits a native failed event: ' + JSON.stringify(events.filter((event: any) => event.kind === 'native')));
  } finally {f.cleanup();}
});

test('ask run falls back to cli when the host changes before the reply', async () => {
  const f = fixture(); try {
    fs.writeFileSync(path.join(f.deps.skillRoot, 'config.jsonc'), JSON.stringify({'read-delegates': {
      claude: {targets: [{medium: {model: 'target'}}]},
    }, phases: {ask: {targets: {medium: 1}}}}));
    f.deps.orchestrator = {platform: 'claude', model: null};
    f.deps.liveness = {claude: true, agy: true};
    assert.equal((await f.call()).output.reason, 'native-pending');
    const waved = await f.call();
    assert.equal(waved.output.reason, 'native-pending');
    const replyPath = waved.value.native[0].replyPath as string;
    fs.writeFileSync(replyPath, 'Native answer');
    f.deps.orchestrator = {platform: 'agy', model: null};
    f.script('claude', 'target', 'Fallback answer');
    const done = await f.call();
    assert.equal(done.exit, 0);
    assert.equal(done.value.answers.length, 1);
    assert.equal(done.value.answers[0].text, 'Fallback answer');
    assert.ok(fs.existsSync(replyPath + '.invalid-1'));
  } finally {f.cleanup();}
});

test('ask runs the deferred cli wave in the same call when no native voice is launchable', async () => {
  const f = fixture(); try {
    fs.writeFileSync(path.join(f.deps.skillRoot, 'config.jsonc'), JSON.stringify({'read-delegates': {
      claude: {targets: [{medium: {model: 'target'}}]},
      agy: {targets: [{medium: {model: 'answer'}}]},
    }, phases: {ask: {targets: {medium: 2}}}}));
    f.deps.orchestrator = {platform: 'claude', model: null};
    // Claude is not live, so the roster holds only the agy cli target while
    // the seeded claude answer stays saved: the launch holds no launchable
    // native, so the deferred wave reconciles both in the same call.
    f.deps.liveness = {claude: false, agy: true};
    f.script('agy', 'answer', 'Deferred cli answer');
    // A saved done orphan plus an unsaved cli target: the launch holds no
    // launchable native, so the deferred wave reconciles both at once.
    const digest = crypto.createHash('sha256').update(fs.readFileSync(f.question, 'utf8')).digest('hex').slice(0, 16);
    const dir = path.join(f.session, '.state', 'asks', digest, 'attempt-1');
    for (const sub of ['slots', 'prompts', 'replies']) fs.mkdirSync(path.join(dir, sub), {recursive: true});
    fs.writeFileSync(path.join(dir, 'prompts', 'claude[0].md'), 'Why does this work?');
    fs.writeFileSync(path.join(dir, 'slots', 'claude[0].json'), JSON.stringify({slot: 'claude[0]', state: 'done', text: 'kept', responder: {slot: 'claude[0]', provider: 'claude', model: 'target', native: false}}));
    const done = await f.call();
    assert.equal(done.exit, 0, JSON.stringify(done.output));
    assert.equal(done.value.answers.length, 2, JSON.stringify(done.value.answers));
    assert.equal(done.value.answers.find((answer: {slot: string}) => answer.slot === 'agy[0]')?.text, 'Deferred cli answer');
    assert.equal(done.value.answers.find((answer: {slot: string}) => answer.slot === 'claude[0]')?.text, 'kept');
    assert.equal(f.launches.length, 1, 'only the unsaved cli voice launches');
  } finally {f.cleanup();}
});

test('ask reconciles a saved native-first reserve attempt after a host change', async () => {
  const f = fixture(); try {
    fs.writeFileSync(path.join(f.deps.skillRoot, 'config.jsonc'), JSON.stringify({'read-delegates': {
      claude: {targets: [{medium: {model: 'target'}}]},
      codex: {targets: [{medium: {model: 'reserve'}}]},
    }, phases: {ask: {targets: {medium: 1}}}}));
    f.deps.orchestrator = {platform: 'codex', model: null};
    f.deps.liveness = {claude: true, codex: true};
    f.script('claude', 'target', {status: 'fail', cls: 'not-found', detail: 'unavailable'});
    const launched = await f.call();
    assert.equal(launched.output.reason, 'native-pending');
    const attempt = launched.value.native[0].attempt as string;
    assert.ok(attempt.startsWith('codex[0]#'), JSON.stringify(launched.value.native));
    // The session moves to the claude host: codex becomes the target, claude
    // the reserve, and the saved codex attempt under claude[0] reconciles
    // through its physical cli instead of dropping with its report.
    f.deps.orchestrator = {platform: 'claude', model: null};
    f.script('codex', 'reserve', 'Reserve answer');
    const done = await f.call('--native-failed', attempt + '=voice gone');
    assert.equal(done.exit, 0, JSON.stringify(done.output));
    assert.equal(done.value.answers.length, 2, 'the saved attempt reconciles beside the recomputed target: ' + JSON.stringify(done.value.answers));
    const reconciled = done.value.answers.find((answer: {slot: string}) => answer.slot === 'claude[0]');
    assert.equal(reconciled?.text, 'Reserve answer');
    assert.equal(reconciled?.responder.provider, 'codex');
    assert.equal(done.value.ignoredFailureReports, undefined, 'the matching report is consumed, not ignored: ' + JSON.stringify(done.value));
  } finally {f.cleanup();}
});

test('ask run keeps a responder-less saved orphan without throwing', async () => {
  const f = fixture(); try {
    fs.writeFileSync(path.join(f.deps.skillRoot, 'config.jsonc'), JSON.stringify({'read-delegates': {
      claude: {targets: [{medium: {model: 'target'}}]},
      agy: {targets: [{medium: {model: 'answer'}}]},
    }, phases: {ask: {targets: {medium: 2}}}}));
    f.deps.orchestrator = {platform: 'claude', model: null};
    // Claude is not live, so the roster holds only the agy cli target while
    // the seeded claude answer stays saved with no responder object.
    f.deps.liveness = {claude: false, agy: true};
    f.script('agy', 'answer', 'Deferred cli answer');
    const digest = crypto.createHash('sha256').update(fs.readFileSync(f.question, 'utf8')).digest('hex').slice(0, 16);
    const dir = path.join(f.session, '.state', 'asks', digest, 'attempt-1');
    for (const sub of ['slots', 'prompts', 'replies']) fs.mkdirSync(path.join(dir, sub), {recursive: true});
    fs.writeFileSync(path.join(dir, 'prompts', 'claude[0].md'), 'Why does this work?');
    fs.writeFileSync(path.join(dir, 'slots', 'claude[0].json'), JSON.stringify({slot: 'claude[0]', state: 'done', text: 'kept', provider: 'claude', model: 'target'}));
    const done = await f.call();
    assert.equal(done.exit, 0, JSON.stringify(done.output));
    assert.equal(done.value.answers.length, 2, JSON.stringify(done.value.answers));
    assert.equal(done.value.answers.find((answer: {slot: string}) => answer.slot === 'claude[0]')?.text, 'kept');
    assert.equal(done.value.answers.find((answer: {slot: string}) => answer.slot === 'claude[0]')?.provider, 'claude');
    assert.equal(f.launches.length, 1, 'only the unsaved cli voice launches');
  } finally {f.cleanup();}
});

test('ask diagnostics name the reserve voice on invalid and completed native replies', async () => {
  const f = fixture(); try {
    fs.writeFileSync(path.join(f.deps.skillRoot, 'config.jsonc'), JSON.stringify({'read-delegates': {
      claude: {targets: [{medium: {model: 'target'}}]},
      codex: {nativeSubagentsOnly: true, targets: [{medium: {model: ['first-alias', 'second-alias']}}]},
    }, phases: {ask: {targets: {medium: 1}}}}));
    f.deps.orchestrator = {platform: 'codex', model: null};
    f.deps.liveness = {claude: true, codex: true};
    f.script('claude', 'target', {status: 'fail', cls: 'auth', detail: 'denied'});
    const events: any[] = [];
    f.deps.diagnostics = (event: unknown) => { events.push(event); };
    const launched = await f.call();
    assert.equal(launched.output.reason, 'native-pending');
    const minted = events.filter(event => event.kind === 'native' && event.state === 'pending').pop();
    assert.deepEqual([minted?.slot, minted?.provider], ['claude[0]', 'codex'], 'the reserve mint keeps the logical slot and names the reserve: ' + JSON.stringify(events));
    assert.equal(minted?.model, 'first-alias', 'the pending marker names the first configured alias: ' + JSON.stringify(minted));
    const replyPath = launched.value.native[0].replyPath as string;
    fs.writeFileSync(replyPath, ' ');
    await f.call();
    const invalid = events.filter(event => event.kind === 'native' && event.state === 'invalid').pop();
    assert.deepEqual([invalid?.slot, invalid?.provider], ['claude[0]', 'codex'], 'the invalid reserve reply keeps the logical slot and names the reserve: ' + JSON.stringify(events));
    fs.writeFileSync(replyPath, 'Reserve answer');
    const done = await f.call();
    assert.equal(done.exit, 0, JSON.stringify(done.output));
    const completed = events.filter(event => event.kind === 'native' && event.state === 'completed').pop();
    assert.deepEqual([completed?.slot, completed?.provider], ['claude[0]', 'codex'], 'the completed reserve reply names the reserve voice: ' + JSON.stringify(events));
  } finally {f.cleanup();}
});
