import { test } from 'node:test';
import assert from 'node:assert/strict';
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
    assert.deepEqual(foldLedger(f.session).records, []);
  } finally {f.cleanup();}
});

test('ask run refuses missing input and unapproved high levels before launch', async () => {
  const f = fixture(); try {
    assert.equal((await f.call('--level', 'xhigh')).output.reason, 'level-unapproved');
    assert.equal((await f.call('--level', 'xhigh')).exit, 4);
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
    assert.deepEqual(done.value.answers[0].responder, {slot: 'codex[0]', provider: 'codex', model: null, native: true});
    assert.deepEqual(JSON.parse(fs.readFileSync(answers, 'utf8')).answers, done.value.answers);
    assert.equal(fs.existsSync(answers), true); assert.equal(f.launches.length, 0);
    assert.deepEqual(foldLedger(f.session).records, []);
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
        responder: {slot: native ? 'claude[0]' : 'copilot[0]', provider, model: native ? 'host-model' : 'reserve', native},
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
  } finally {f.cleanup();}
});

test('ask run refusal with zero targets names the underfill cause', async () => {
  const f = nativeExclusionFixture(); try {
    fs.writeFileSync(path.join(f.deps.skillRoot, 'config.jsonc'), JSON.stringify({'read-delegates': {
      copilot: {nativeSubagentsOnly: true, targets: [{medium: {model: 'native'}}]},
    }}));
    const refused = await f.call();
    assert.equal(refused.exit, 1); assert.equal(refused.output.reason, 'invalid-input');
    assert.equal(refused.output.summary, 'ask requires a read delegate; underfill 0/1 targets, host claude, excluded native-only: copilot');
    assert.equal(f.launches.length, 0);
  } finally {f.cleanup();}
});
