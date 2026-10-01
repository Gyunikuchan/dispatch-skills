// Fixed fill values for the review-prompt golden fixtures (one set per review kind).

export type ReviewPromptKind = 'code' | 'design' | 'plan';

const shared = { 'User Focus Areas': 'General review', 'Tool Turn Budget': 'Unspecified', 'Review Scope': 'Full review' };

export const REVIEW_PROMPT_INPUTS: Readonly<Record<ReviewPromptKind, Readonly<Record<string, string>>>> = {
  code: {
    ...shared,
    'Task Summary': 'Add a retry budget to the fetch helper',
    'Walkthrough Path': '.scratch/example/example.walkthrough.md',
    'Plan Path': '.scratch/example/example.plan.md',
  },
  design: {
    ...shared,
    'Design Path': '.scratch/example/example.design.md',
    Requirement: 'Split the importer into staged increments',
  },
  plan: {
    ...shared,
    'Plan Path': '.scratch/example/example.plan.md',
    Requirement: 'Add a retry budget to the fetch helper',
  },
};
