import { test } from 'node:test';
import { completionFlow } from './fixtures/flow-implement.ts';

// Split from flow-implement.test.ts to stay under the 1 s per-file budget.
for (const planMode of ['session','objective'] as const) test(`implement-completion-rules: ${planMode} flow binds a real walkthrough and replays completion`, () => completionFlow(planMode));
