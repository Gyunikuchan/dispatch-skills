import path from 'node:path';
import { storeSessionPaths } from './session.ts';
export const effectSessionRoot = (runDir?: string): string | undefined => runDir && path.basename(path.dirname(runDir)) === 'runs' && path.basename(path.dirname(path.dirname(runDir))) === '.state' ? path.dirname(path.dirname(path.dirname(runDir))) : undefined;
export const portableEffect = <T>(effect: T, runDir?: string): T => { const root = effectSessionRoot(runDir); return root ? storeSessionPaths(effect, root) : effect; };
