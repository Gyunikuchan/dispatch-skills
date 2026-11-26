import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ACTION_CONTRACTS,
  GENERATED_MARKER,
  SESSION_CONTRACTS,
  renderCallTable,
} from "../skills/dispatch/scripts/toolkit/contracts.ts";
import { slug, validatePathLinks } from "./path-bytes.ts";

const TOOLKIT = "references/toolkit.md";
const TABLE_HEADING = "### call table";
const COMMAND_PREFIX = /^(?:\r?\n)*/u;

interface ContractRegion {
  heading: string;
  text: string;
  prefix: string;
}

const contractRegions = () => {
  const regions = new Map<string, ContractRegion>([
    [
      "call-table",
      {
        heading: TABLE_HEADING,
        text: renderCallTable().slice(TABLE_HEADING.length + 1),
        prefix: "",
      },
    ],
  ]);

  for (const [heading, { arguments: args }] of Object.entries(
    ACTION_CONTRACTS
  )) {
    regions.set(`action:${slug(heading)}`, {
      heading: `### ${heading}`,
      text: `\`${args}\``,
      prefix: "Arguments: ",
    });
  }

  for (const [action, { arguments: args }] of Object.entries(
    SESSION_CONTRACTS
  )) {
    regions.set(`session:${action}`, {
      heading: `### session ${action}`,
      text: `\`${args}\``,
      prefix: "",
    });
  }

  return regions;
};

export interface RenderedContracts {
  text: string;
  errors: string[];
  drift: string[];
}

/** Validates governed delimiters and replaces only the content between each pair. */
export const renderContractRegions = (markdown: string) => {
  const regions = contractRegions();

  const errors: string[] = [];
  const drift: string[] = [];

  const headings = [
    ...markdown.matchAll(/^(?<heading>#{1,3} [^\r\n]+)\r?\n/gmu),
  ];

  const seen = new Set<string>();
  let open: { id: string; index: number; end: number } | undefined;

  let cursor = 0;
  let text = "";

  for (const marker of markdown.matchAll(GENERATED_MARKER)) {
    // The id group is mandatory in GENERATED_MARKER; the default only satisfies the indexed type.
    const [token, closing, id = ""] = marker;
    const { index } = marker;
    const end = index + token.length;
    const region = regions.get(id);
    const label = `${TOOLKIT}: ${region?.heading ?? id}`;

    if (region === undefined) {
      errors.push(`${label}: unknown generated marker`);
    }

    if (closing === undefined || closing === "") {
      if (seen.has(id)) {
        errors.push(`${label}: duplicate opening marker`);
      }

      seen.add(id);

      if (open !== undefined) {
        errors.push(
          `${TOOLKIT}: ${open.id}: opening marker before closing marker`
        );
      }

      open = { id, index, end };
      continue;
    }

    if (open?.id !== id) {
      errors.push(`${label}: unmatched closing marker`);
      continue;
    }

    if (region !== undefined && open !== undefined) {
      const placement = resolvePlacement(
        markdown,
        headings,
        region,
        open,
        index,
        end,
        id
      );

      if (placement.correct) {
        if (placement.current !== placement.expected) {
          drift.push(`${label}: generated content differs`);
        }

        text +=
          markdown.slice(cursor, placement.bodyStart) + placement.expected;
        cursor = index;
      } else {
        errors.push(`${label}: generated markers at the wrong boundary`);
      }
    }

    open = undefined;
  }

  if (open !== undefined) {
    errors.push(`${TOOLKIT}: ${open.id}: missing closing marker`);
  }

  for (const [id, { heading }] of regions) {
    if (!seen.has(id)) {
      errors.push(`${TOOLKIT}: ${heading}: missing opening marker`);
    }
  }

  return {
    text: errors.length ? markdown : text + markdown.slice(cursor),
    errors,
    drift,
  };
};

const resolvePlacement = (
  markdown: string,
  headings: RegExpMatchArray[],
  region: ContractRegion,
  open: { id: string; index: number; end: number },
  index: number,
  end: number,
  id: string
) => {
  const headingIndex = headings.findIndex(
    (heading) => heading[1] === region.heading
  );

  const heading = headings[headingIndex];

  const sectionStart =
    heading === undefined || heading.index === undefined
      ? -1
      : heading.index + heading[0].length;

  const sectionEnd = headings[headingIndex + 1]?.index ?? markdown.length;
  const table = id === "call-table";
  // A session opener needs its own line so Markdown parses the command paragraph.
  const standalone = table || id.startsWith("session:");

  const delimiterNewline = standalone
    ? (/^\r?\n/u.exec(markdown.slice(open.end))?.[0] ?? "")
    : "";

  const bodyStart = open.end + delimiterNewline.length;
  const before = markdown.slice(sectionStart, open.index);
  const current = markdown.slice(bodyStart, index);

  const correct =
    sectionStart >= 0 &&
    open.index >= sectionStart &&
    index < sectionEnd &&
    (!standalone || delimiterNewline !== "") &&
    (table
      ? before === "" &&
        (current === "" || current.endsWith("\n")) &&
        /^(?:\r?\n)+$/u.test(markdown.slice(end, sectionEnd))
      : before.replace(COMMAND_PREFIX, "") === region.prefix &&
        /^`[^`\r\n]+`$/u.test(current));

  const expected =
    delimiterNewline === "\r\n"
      ? region.text.replaceAll("\n", "\r\n")
      : region.text;

  return { bodyStart, current, expected, correct };
};

/** Checks the checkout, writing only an updated contract in generation mode. */
export const maintain = (skillDir: string, check: boolean) => {
  const read = (relative: string) =>
    fs.readFileSync(path.join(skillDir, relative), "utf-8");

  const markdown = read(TOOLKIT);
  const result = renderContractRegions(markdown);

  const errors = [
    ...result.errors,
    ...validatePathLinks(read),
    ...(check ? result.drift : []),
  ];

  if (errors.length === 0 && !check && result.text !== markdown) {
    fs.writeFileSync(path.join(skillDir, TOOLKIT), result.text);
  }

  return errors;
};

const main = (args: readonly string[]) => {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    process.stderr.write("Usage: node scripts/maintain.ts [--check]\n");

    return 2;
  }

  try {
    const skillDir = fileURLToPath(
      new URL("../skills/dispatch/", import.meta.url)
    );

    const errors = maintain(skillDir, args[0] === "--check");

    for (const error of errors) {
      process.stderr.write(`${error}\n`);
    }

    return errors.length ? 1 : 0;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );

    return 1;
  }
};

if (
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  process.exitCode = main(process.argv.slice(2));
}
