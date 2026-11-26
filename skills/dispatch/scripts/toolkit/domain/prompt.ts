import { defined } from "./defined.ts";

export const extractDocumentLayers = (specStageMarkdown: string) => {
  const lines = specStageMarkdown.replaceAll("\r\n", "\n").split("\n");

  const headingIndex = lines.findIndex((line) =>
    /^##\s+Readers and document layers\s*$/u.test(line)
  );

  if (headingIndex === -1) {
    throw new Error('Section "Readers and document layers" not found');
  }

  const paragraph: string[] = [];
  let started = false;

  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (/^#{1,6}\s/u.test(line)) {
      break;
    }

    if (!line.trim()) {
      if (started) {
        break;
      }

      continue;
    }

    started = true;
    paragraph.push(line.trim());
  }

  if (!paragraph.length) {
    throw new Error('Section "Readers and document layers" has no paragraph');
  }

  return paragraph.join(" ");
};

export interface Settled {
  id: string;
  locus: string;
  defect: string;
  ruling: string;
  reason: string;
  revision?: string;
  severity?: string;
  rejectionConfirmed?: boolean;
}

export interface UserDecision {
  id: string;
  summary: string;
  quote: string;
}

export type SettledEntry = Settled | UserDecision;

const isDecision = (entry: SettledEntry): entry is UserDecision =>
  "quote" in entry;

const clip = (value: string, limit: number) =>
  value.length > limit ? `${value.slice(0, limit - 1)}…` : value;

const head = (value: string) => value.split(/\r\n|\n|\r/u)[0] ?? "";

export const settledSection = (
  settled: readonly SettledEntry[],
  revisions = false,
  acceptedNew?: ReadonlySet<string>
) => {
  const visible = settled.filter(
    (entry) =>
      isDecision(entry) ||
      entry.severity !== "MUST" ||
      entry.rejectionConfirmed === true ||
      (entry.rejectionConfirmed === undefined && entry.ruling !== "rejected")
  );

  if (!visible.length) {
    return "";
  }

  const row = (entry: SettledEntry) => {
    if (isDecision(entry)) {
      return `- ${entry.id} — user decision: ${clip(head(entry.summary), 120)} — quote: "${clip(head(entry.quote), 120)}"`;
    }

    const suffix =
      revisions && entry.revision !== undefined && entry.revision !== ""
        ? ` (reviewed revision ${entry.revision})`
        : "";

    const firstLine = entry.defect.split(/\r\n|\n|\r/u)[0] ?? "";
    const reasonLine = entry.reason.split(/\r\n|\n|\r/u)[0] ?? "";

    if (entry.ruling === "accepted") {
      return `- ${entry.id} ${entry.locus}: ${entry.severity === "MUST" ? entry.defect : clip(firstLine, 120)} — accepted${acceptedNew?.has(entry.id) === true ? " (new)" : ""}${reasonLine ? `: ${clip(reasonLine, 120)}` : ""}${suffix}`;
    }

    if (entry.ruling === "duplicate") {
      const reason = entry.reason || "no reason recorded";
      const labeled = /duplicate\s+of\s+(?<cap1>R\d+-F\d+)/iu.exec(reason)?.[1];

      const cited = [...reason.matchAll(/\bR\d+-F\d+\b/gu)].flatMap(([id]) =>
        id === entry.id ? [] : [id]
      );

      const target =
        labeled !== undefined && labeled !== entry.id ? labeled : cited[0];

      return target !== undefined && target !== ""
        ? `- ${entry.id} ${entry.locus} — duplicate of ${target}${suffix}`
        : `- ${entry.id} ${entry.locus} — duplicate: ${clip(reason, 120)}${suffix}`;
    }

    return `- ${entry.id} ${entry.locus}: ${entry.defect} — ${entry.ruling}: ${entry.reason || "no reason recorded"}${suffix}`;
  };

  return `\n\n### Settled in earlier rounds\n${visible.map(row).join("\n")}\n`;
};

export interface InterRound {
  diff: string;
  accepted: readonly { id: string; locus: string }[];
}

const acceptedLines = (accepted: readonly { id: string; locus: string }[]) =>
  accepted.length > 0
    ? [
        "Check these accepted-finding loci and their interactions first:",
        ...accepted.map((entry) => `- ${entry.id} ${entry.locus}`),
      ]
    : ["No accepted findings since the previous round."];

/** The section's text serves both prompt builders; the compact confirmation prompt has no template to carry it. */
export const interRoundSection = (info: InterRound, includeAccepted = true) => {
  const list = includeAccepted ? acceptedLines(info.accepted) : [];

  return [
    "### Since the previous round",
    `Inter-round diff: ${info.diff}`,
    ...list,
  ].join("\n");
};

export const askPrompt = (question: string, context: string) =>
  [
    "# Ask",
    "",
    "### Objective",
    question.trim() || "(empty question)",
    "",
    ...(context.trim() ? ["### Context", context.trim(), ""] : []),
    "### Evidence",
    "Read the workspace read-only. Cite each claim with `<file>:L<line>` or a command you ran.",
    "",
    "### Stop condition",
    "Stop once the objective is answered or evidence is exhausted; say what remains unknown. CLI delegates receive a `[DEADLINE]` header: return your final answer before it, and if a wrap-up prompt arrives (~5m before the run deadline), stop tool calls and answer from work completed so far.",
    "",
    "### Output",
    "Plain text: a short answer first, then the supporting claims, one per line.",
    "",
  ].join("\n");

const DEFAULT_SECTION = "Prompt template";
const SLOT_PATTERN = /<<slot:(?<cap1>[A-Za-z0-9_-]+)>>/gu;
const VARIABLE_BULLET = /^-\s+`<(?<cap1>[^>]+)>`/u;

const escapeRegExp = (text: string) =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

/** Declared variables and fenced body of one `#… <section>` block. */
export const extractTemplate = (
  markdown: string,
  section = DEFAULT_SECTION
) => {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const heading = new RegExp(`^#{1,6}\\s+${escapeRegExp(section)}\\s*$`, "u");
  const headingIndex = lines.findIndex((line) => heading.test(line));

  if (headingIndex === -1) {
    throw new Error(`Section "${section}" not found`);
  }

  const variables: string[] = [];
  let open = -1;
  let marker = "";

  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fence = /^(?<cap1>`{3,}|~{3,})/u.exec(line)?.[1];

    if (fence !== undefined) {
      open = index;
      marker = fence;
      break;
    }

    const variable = VARIABLE_BULLET.exec(line)?.[1];

    if (variable !== undefined) {
      variables.push(variable);
    }
  }

  if (open === -1) {
    throw new Error(`No fenced block found under section "${section}"`);
  }

  const closer = new RegExp(
    `^${escapeRegExp(marker[0] ?? "`")}{${marker.length},}\\s*$`,
    "u"
  );

  const close = lines.findIndex(
    (line, index) => index > open && closer.test(line)
  );

  if (close === -1) {
    throw new Error(`Unterminated fenced block under section "${section}"`);
  }

  return { variables, template: lines.slice(open + 1, close).join("\n") };
};

const parseKindBlock = (markdown: string) => {
  const variables: string[] = [];
  const raw = new Map<string, string[]>();
  let current: string[] | null = null;
  let fence: string | null = null;

  for (const line of markdown.replaceAll("\r\n", "\n").split("\n")) {
    const fenceMarker = /^(?<cap1>`{3,}|~{3,})\s*\S*\s*$/u.exec(line)?.[1];

    if (fenceMarker !== undefined) {
      if (fence === null) {
        fence = fenceMarker;
      } else if (
        fenceMarker.startsWith(fence.charAt(0)) &&
        fenceMarker.length >= fence.length &&
        /^(?<cap1>`+|~+)\s*$/u.test(line)
      ) {
        fence = null;
      }
    }

    const heading =
      fence !== null || fenceMarker !== undefined
        ? null
        : /^##\s+(?<cap1>\S.*?)\s*$/u.exec(line)?.[1];

    if (heading !== undefined && heading !== null) {
      if (raw.has(heading)) {
        throw new Error(`Kind block declares section "${heading}" twice`);
      }

      current = [];
      raw.set(heading, current);
      continue;
    }

    if (current === null) {
      const variable = VARIABLE_BULLET.exec(line)?.[1];

      if (variable !== undefined) {
        variables.push(variable);
      }
    } else {
      current.push(line);
    }
  }

  const sections = new Map<string, string>();

  for (const [name, body] of raw) {
    sections.set(
      name,
      body
        .join("\n")
        .replace(/^(?:[ \t]*\n)+/u, "")
        .replace(/\s+$/u, "")
    );
  }

  return { variables, sections };
};

export type QualityConsumer =
  | "code"
  | "plan"
  | "design"
  | "writer"
  | "cleanup"
  | "verifier"
  | "explorer";

export const qualitySections = {
  code: ["shared", "code", "testing"],
  writer: ["shared", "code", "testing"],
  plan: ["shared", "spec", "plan", "testing"],
  design: ["shared", "spec", "design"],
  cleanup: ["shared", "testing"],
  verifier: ["shared", "testing"],
  explorer: ["shared"],
} as const satisfies Record<QualityConsumer, readonly string[]>;

const REQUIRED_TAGGED = {
  code: 5,
  writer: 6,
  plan: 5,
  design: 4,
  cleanup: 6,
  verifier: 4,
  explorer: 3,
} as const satisfies Record<QualityConsumer, number>;

const FOR_TAG_PATTERN = /^\s*<!--\s*for:\s*(?<cap1>[^>]+?)\s*-->\s*$/u;

const DOCUMENT_LAYERS_LINK =
  "[document layers](../spec-stage.md#readers-and-document-layers); cite upstream IDs, not earlier layers.";

const parseAudienceTag = (line: string) => {
  const match = FOR_TAG_PATTERN.exec(line);

  if (!match) {
    return [];
  }

  return defined(match[1])
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
};

const audienceAllows = (
  tags: readonly string[] | null,
  consumer: QualityConsumer
) => {
  if (tags === null) {
    return consumer !== "explorer";
  }

  if (tags.includes("author")) {
    return false;
  }

  if (tags.includes("all") || tags.includes(consumer)) {
    return true;
  }

  return false;
};

const rotate = <T>(items: readonly T[], by: number) => {
  if (!items.length) {
    return [];
  }

  const shift = ((by % items.length) + items.length) % items.length;

  return [...items.slice(shift), ...items.slice(0, shift)];
};

const rotateLines = (
  markdown: string,
  by: number,
  isRotated: (line: string) => boolean
) => {
  const lines = markdown.split("\n");

  const positions = lines.flatMap((line, index) =>
    isRotated(line) ? [index] : []
  );

  const rotated = rotate(
    positions.map((index) => defined(lines[index])),
    by
  );

  for (const [index, position] of positions.entries()) {
    lines[position] = defined(rotated[index]);
  }

  return lines.join("\n");
};

/** Joined bodies of the consumer's selected quality sections. */
export const qualityCriteria = (
  markdown: string,
  consumer: QualityConsumer,
  rotation: number,
  specStageMarkdown: string
) => {
  if (!Object.hasOwn(qualitySections, consumer)) {
    throw new Error(`Unknown quality consumer: ${consumer}`);
  }

  const { sections } = parseKindBlock(markdown);
  const layers = extractDocumentLayers(specStageMarkdown);
  let totalTagged = 0;

  const rendered = qualitySections[consumer]
    .map((section) => {
      const raw = sections.get(section);

      if (raw === undefined) {
        throw new Error(`Missing quality section: ${section}`);
      }

      if (!raw.trim()) {
        throw new Error(`Empty quality section: ${section}`);
      }

      const { body, tagged } = filterSection(raw, consumer, section);
      totalTagged += tagged;
      let out = body;

      if (!out.trim()) {
        throw new Error(`Empty quality section: ${section}`);
      }

      if (section === "shared" && consumer !== "explorer") {
        if (!out.includes(DOCUMENT_LAYERS_LINK)) {
          throw new Error(`Missing document layers link in shared section`);
        }

        out = out.replace(
          DOCUMENT_LAYERS_LINK,
          () => `document layers (${layers})`
        );
      }

      return rotateLines(out.trim(), rotation, (line) =>
        /^- \*\*[^*]+\*\* —/u.test(line)
      );
    })
    .join("\n\n");

  const expected = REQUIRED_TAGGED[consumer];

  if (totalTagged !== expected) {
    throw new Error(
      `Tagged bullet count mismatch for consumer "${consumer}": expected ${expected}, got ${totalTagged}`
    );
  }

  return rendered;
};

const validateAudienceTags = (line: string) => {
  const tags = parseAudienceTag(line);

  for (const tag of tags) {
    if (
      !Object.hasOwn(qualitySections, tag) &&
      tag !== "all" &&
      tag !== "author"
    ) {
      throw new Error(`Unknown audience tag: ${tag}`);
    }
  }

  if (!tags.length) {
    throw new Error(`Audience tag names no consumer: ${line.trim()}`);
  }

  return tags;
};

const filterSection = (
  body: string,
  consumer: QualityConsumer,
  _section: string
) => {
  const lines = body.replaceAll("\r\n", "\n").split("\n");
  const out: string[] = [];
  let tagged = 0;
  let pending: string[] | null = null;
  let active: string[] | null = null;

  for (const line of lines) {
    if (FOR_TAG_PATTERN.test(line)) {
      const tags = validateAudienceTags(line);

      if (pending) {
        throw new Error(`Audience tag without target: ${line.trim()}`);
      }

      while (out.at(-1)?.trim() === "") {
        out.pop();
      }

      pending = tags;
      continue;
    }

    const subheading = /^###\s/u.test(line);

    if (subheading) {
      if (pending) {
        active = pending;
        pending = null;
      } else {
        active = null;
      }

      const tags = active;
      const taggedHeading = tags !== null;

      if (!audienceAllows(tags, consumer)) {
        continue;
      }

      out.push(line);
      void taggedHeading;
      continue;
    }

    if (pending) {
      if (line.trim() === "") {
        continue;
      }

      if (!line.startsWith("- ")) {
        throw new Error(
          `Audience tag must precede a bullet or subsection: ${pending.join(",")}`
        );
      }

      const tags = pending;
      pending = null;

      if (!audienceAllows(tags, consumer)) {
        continue;
      }

      out.push(line);
      tagged += 1;
      continue;
    }

    if (line.startsWith("- ")) {
      const tags = active;

      if (!audienceAllows(tags, consumer)) {
        continue;
      }

      out.push(line);

      if (tags !== null) {
        tagged += 1;
      }

      continue;
    }

    const tags = active;

    if (!audienceAllows(tags, consumer)) {
      continue;
    }

    out.push(line);
  }

  if (pending) {
    throw new Error(`Audience tag without target: ${pending.join(",")}`);
  }

  return { body: out.join("\n"), tagged };
};

/** Selects the consumer's criteria as the frame's single `quality` slot section. */
export const qualityBar = (
  markdown: string,
  consumer: QualityConsumer,
  rotation: number,
  specStageMarkdown: string
) =>
  `## quality\n\n${qualityCriteria(markdown, consumer, rotation, specStageMarkdown)}`;

/**
 * Fills every `<<slot:NAME>>` of the frame's template with the `## NAME` body of the kind block or a shared
 * kind block; variables are the union of all declarations. A slot without a section, a section without a
 * slot, or a section declared by more than one input throws.
 */
export const assembleTemplate = (
  frameMarkdown: string,
  kindMarkdown: string,
  section = DEFAULT_SECTION,
  shared: readonly string[] = []
) => {
  const frame = extractTemplate(frameMarkdown, section);
  const kind = parseKindBlock(kindMarkdown);

  for (const block of shared.map(parseKindBlock)) {
    kind.variables.push(...block.variables);

    for (const [name, body] of block.sections) {
      if (kind.sections.has(name)) {
        throw new Error(`Kind block declares section "${name}" twice`);
      }

      kind.sections.set(name, body);
    }
  }

  const slots = new Set(
    [...frame.template.matchAll(SLOT_PATTERN)].map((match) => match[1] ?? "")
  );

  const missing = [...slots].filter((name) => !kind.sections.has(name));

  if (missing.length) {
    throw new Error(
      `Kind block has no section for slot(s): ${missing.join(", ")}`
    );
  }

  const unused = [...kind.sections.keys()].filter((name) => !slots.has(name));

  if (unused.length) {
    throw new Error(
      `Kind block declares section(s) with no frame slot: ${unused.join(", ")}`
    );
  }

  const template = frame.template
    .replaceAll(
      /^[ \t]*<<slot:(?<cap1>[A-Za-z0-9_-]+)>>[ \t]*\n/gmu,
      (line, name: string) => {
        const replacement = kind.sections.get(name);

        return replacement !== undefined && replacement !== "" ? line : "";
      }
    )
    .replaceAll(
      SLOT_PATTERN,
      (_match, name: string) => kind.sections.get(name) ?? ""
    );

  return {
    variables: [...new Set([...frame.variables, ...kind.variables])],
    template,
  };
};

/** Substitutes declared placeholders; a missing declared value or an undeclared value name throws. */
export const fillTemplate = (
  template: string,
  variables: readonly string[],
  values: Readonly<Record<string, string>>
) => {
  const declared = new Set(variables);
  const missing = variables.filter((name) => !Object.hasOwn(values, name));

  if (missing.length) {
    throw new Error(
      `Missing value(s) for declared variable(s): ${missing.join(", ")}`
    );
  }

  const unknown = Object.keys(values).filter((name) => !declared.has(name));

  if (unknown.length) {
    throw new Error(
      `Unknown variable(s) not declared by this template: ${unknown.join(", ")}`
    );
  }

  if (!variables.length) {
    return template;
  }

  const pattern = new RegExp(
    `<(${variables.map(escapeRegExp).join("|")})>`,
    "gu"
  );

  return template.replaceAll(
    pattern,
    (_match, name: string) => values[name] ?? ""
  );
};
