export const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Level = (typeof LEVELS)[number];
export type FindingId = string;
export type SlotId = string;
