const TOOL_CALL_LINE =
  /^\s*(?:<\/?(?:invoke|parameter|function_calls|tool_use)\b|(?:invoke|parameter|function_calls|tool_use)\s*\(|[A-Z][A-Za-z]*\(.*\)\s*$|\$\s|>\s*\$)/u;

const TOOL_MARKUP = /<\/?(?:invoke|parameter|function_calls|tool_use)\b.*$/u;

const ESC = String.raw`\u001b`;
const BEL = String.raw`\u0007`;
const CSI = String.raw`${ESC}\[[0-?]*[ -/]*[@-~]`;
const OSC = String.raw`${ESC}\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\)`;
const OTHER_CONTROLS = String.raw`[\u0000-\u0008\u000b-\u001f\u007f-\u009f]`;
const CONTROL = new RegExp(`${CSI}|${OSC}|${OTHER_CONTROLS}`, "gu");

/** Replaces HTML comment delimiters with inert entities so rendered Markdown never hides text. */
export const neutralizeComments = (text: string) =>
  text.replaceAll("<!--", "&lt;!--").replaceAll(/--!?>/gu, "--&gt;");

/**
 * One-line relay text: drops fenced blocks, tool-call lines, embedded tool markup, and control sequences;
 * keeps code-span contents without delimiters; neutralises comment markers.
 */
export const sanitizeText = (text: string) => {
  const kept: string[] = [];
  let fence: string | null = null;

  for (const line of text
    .replaceAll(CONTROL, "")
    .replaceAll(/\r\n?/gu, "\n")
    .split("\n")) {
    const marker = /^\s*(?<cap1>`{3,}|~{3,})/u.exec(line)?.[1];

    if (marker !== undefined) {
      if (fence === null) {
        fence = marker;
      } else if (
        marker.startsWith(fence.charAt(0)) &&
        marker.length >= fence.length &&
        /^\s*(?<cap1>`+|~+)\s*$/u.test(line)
      ) {
        fence = null;
      }

      continue;
    }

    if (fence !== null || TOOL_CALL_LINE.test(line)) {
      continue;
    }

    kept.push(line.replace(TOOL_MARKUP, ""));
  }

  const collapsed = kept
    .join(" ")
    .replaceAll("`", "")
    .replaceAll("→", "->")
    .replaceAll(/\s+/gu, " ")
    .trim();

  return neutralizeComments(collapsed);
};
