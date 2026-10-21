const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

export function tokenize(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  return Array.from(text.matchAll(WORD), ([word]) => word.toLowerCase());
}

export function countWords(text) {
  return tokenize(text).length;
}
