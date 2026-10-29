import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { HandlerContext, HandlerResult } from './cli.ts';
import { askPrompt } from './domain/prompt.ts';
import { sanitizeText } from './domain/sanitize.ts';
import { fanOut, resolveSlots, underfillNote } from './fanout.ts';
import { foldLedger, latest, levelGate } from './ledger.ts';
import { withLockFile } from './lock.ts';
import { ToolError } from './output.ts';
import { LEVELS, type Level } from './types.ts';

export async function askRun({session, manifest, args, values, deps}: HandlerContext): Promise<HandlerResult> {
  let question: string;
  try {
    if (args.length !== 1) throw new Error();
    question = fs.readFileSync(path.resolve(args[0]!), 'utf8');
  } catch {throw new ToolError(1, 'invalid-input', 'ask requires one readable question file');}
  const fold = foldLedger(session);
  const selected = values['level'] ?? latest(fold, 'level')?.data['level'] ?? 'medium';
  if (typeof selected !== 'string' || !LEVELS.includes(selected as Level))
    throw new ToolError(1, 'invalid-input', 'invalid ask level');
  const decision = levelGate(fold, selected);
  if (!decision.allowed) throw new ToolError(4, 'level-unapproved', 'ask level requires user selection');
  const digest = crypto.createHash('sha256').update(question).digest('hex').slice(0, 16);
  const directory = path.join(session, '.state', 'asks', digest);
  return withLockFile(path.join(directory, 'claim'), 'ask', deps, 0, async () => {
    const attempts = fs.readdirSync(directory).flatMap(name => {
      const match = /^attempt-([1-9]\d*)$/.exec(name);
      return match && fs.statSync(path.join(directory, name)).isDirectory() ? [Number(match[1])] : [];
    });
    const last = Math.max(0, ...attempts);
    const attempt = last && !fs.existsSync(path.join(directory, 'attempt-' + last, 'answers.json')) ? last : last + 1;
    const dir = path.join(directory, 'attempt-' + attempt);
    const slots = resolveSlots('ask', selected as Level, deps);
    if (!slots.targets.length) throw new ToolError(1, 'invalid-input', 'ask requires a read delegate' + underfillNote(slots));
    const outcomes = await fanOut({dir, slots, prompt: askPrompt(question, ''), cwd: manifest.repositoryRoot,
      validate(raw) {
        const text = sanitizeText(raw);
        return text ? {ok: true, text} : {ok: false, cls: 'empty-output', reason: 'empty sanitized answer'};
      },
    }, deps);
    const answers = outcomes.flatMap(outcome => outcome.state === 'done' ? [{slot: outcome.slot,
      provider: outcome.responder?.provider ?? slots.targets.find(slot => slot.slot === outcome.slot)!.provider,
      ...(outcome.responder ? {responder: outcome.responder} : {}), text: outcome.text}] : []);
    const failed = outcomes.filter(outcome => outcome.state === 'failed');
    const native = outcomes.filter(outcome => outcome.state === 'native');
    const value = {answers, failed, native, ...(slots.underfill ? {underfill: slots.underfill} : {})};
    const summary = `ask: ${answers.length} answers, ${failed.length} failed` + underfillNote(slots);
    if (native.length) return {ok: false, exit: 4, reason: 'native-pending', summary, value};
    if (!answers.length) return {ok: false, exit: 2, reason: 'ask-failed', summary, value};
    const file = path.join(dir, 'answers.json');
    const temp = file + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temp, JSON.stringify(value) + '\n', {mode: 0o600});
      fs.renameSync(temp, file);
    } finally {fs.rmSync(temp, {force: true});}
    return {ok: true, exit: 0, summary, value};
  });
}
