/** Invariant breach that aborts a send with exit 2. */
export class EngineFault extends Error {
  override name = 'EngineFault';
}
