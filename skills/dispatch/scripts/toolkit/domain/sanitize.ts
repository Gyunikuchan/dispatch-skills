// Delegate text sanitization before relay or render,
// plus comment-marker neutralisation so delegate text can never open hidden Markdown/HTML regions.

const TOOL_CALL_LINE = /^\s*(?:<\/?(?:invoke|parameter|function_calls|tool_use)\b|(?:invoke|parameter|function_calls|tool_use)\s*\(|[A-Z][A-Za-z]*\(.*\)\s*$|\$\s|>\s*\$)/;
const TOOL_MARKUP = /<\/?(?:invoke|parameter|function_calls|tool_use)\b.*$/;
// ANSI CSI/OSC sequences and C0/C1 controls other than tab and newline.
const CONTROL = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Replaces HTML comment delimiters with inert entities so rendered Markdown never hides text. */
export function neutralizeComments(text: string): string {
  return text.replace(/<!--/g, '&lt;!--').replace(/--!?>/g, '--&gt;');
}

/**
 * One-line relay text: drops fenced blocks, tool-call lines, embedded tool markup, and control sequences;
 * keeps code-span contents without delimiters; neutralises comment markers.
 */
export function sanitizeText(text: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of String(text).replace(CONTROL, '').replace(/\r\n?/g, '\n').split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      // A fence closes only on a bare line of the same character with at least the opener's length (CommonMark).
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && /^\s*(`+|~+)\s*$/.test(line)) fence = null;
      continue;
    }
    if (fence !== null || TOOL_CALL_LINE.test(line)) continue;
    kept.push(line.replace(TOOL_MARKUP, ''));
  }
  const collapsed = kept.join(' ').replace(/`/g, '').replace(/→/g, '->').replace(/\s+/g, ' ').trim();
  return neutralizeComments(collapsed);
}
