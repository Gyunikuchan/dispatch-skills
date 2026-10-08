export type Relevance = 'expected' | 'irrelevant' | 'relevant' | 'unknown';
export type ChangeInput = { paths: readonly string[]; expectedPaths: readonly string[]; ownedPaths: readonly string[]; inputs: readonly string[]; dependenciesComplete: boolean; identityChanged?: boolean };
export const normalizePath = (file: string): string => file.replace(/\\/g, '/').replace(/^\.\//, '');
export function classifyChange(input: ChangeInput): { relevance: Relevance; reason: string; paths: string[] } {
  const paths = [...new Set(input.paths.map(normalizePath))].sort();
  const expected = new Set([...input.expectedPaths, ...input.ownedPaths].map(normalizePath));
  const material = paths.filter((file) => !expected.has(file));
  if (!input.identityChanged && !material.length) return { relevance: 'expected', reason: 'Valid scoped output or exact driver ownership.', paths };
  if (input.identityChanged) return { relevance: 'relevant', reason: 'Git comparison, index or ignore-rule identity changed.', paths };
  const inputs = new Set(input.inputs.map(normalizePath));
  if (material.some((file) => inputs.has(file))) return { relevance: 'relevant', reason: 'A governed input changed.', paths };
  if (input.dependenciesComplete) return { relevance: 'irrelevant', reason: 'Complete dependency coverage establishes disjointness.', paths };
  return { relevance: 'unknown', reason: 'Dependency coverage does not establish disjointness.', paths };
}
