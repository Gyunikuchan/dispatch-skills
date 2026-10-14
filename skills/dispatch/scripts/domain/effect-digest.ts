import crypto from 'node:crypto';
import { stableValue } from './stable-value.ts';
export const effectDigest = (effect: unknown): string => crypto.createHash('sha256').update(stableValue(effect)).digest('hex');
