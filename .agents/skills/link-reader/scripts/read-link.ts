import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type Link = { site: "x"; id: string } | { site: "youtube"; id: string };

export interface Deps {
  fetch: typeof globalThis.fetch;
  runYtDlp: (url: string, outDir: string) => Promise<string | null>;
  writeTemp: (name: string, text: string) => string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

// NOTE: WEB client returns UNPLAYABLE/empty captions; bump clientVersion from yt-dlp's InnerTube ANDROID client if captions stop returning.
export const INNERTUBE_CLIENT = {
  clientName: "ANDROID",
  clientVersion: "20.10.38",
} as const;

const USER_AGENT = "link-reader (agent skill)";
const REQUEST_TIMEOUT_MS = 15_000;
const TRANSCRIPT_INLINE_LIMIT_BYTES = 60_000;
const STDOUT_MAX_BYTES = 65_536;
const PARAGRAPH_WINDOW_MS = 30_000;

const X_HOSTS = new Set([
  "x.com",
  "www.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
  "fxtwitter.com",
  "fixupx.com",
  "vxtwitter.com",
]);

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
]);

const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/u;
const DIGITS_RE = /^\d+$/u;
const SPACES_RE = /\s+/gu;
const LEAD_SURROGATE_RE = /[\uD800-\uDBFF]$/u;
const YT_ASR_RE = /\.(?<lang>[^.]+)\.asr\.json3$/iu;
const YT_LANG_RE = /\.(?<lang>[^.]+)\.json3$/iu;

type JsonValue = string | number | boolean | null | JsonValue[] | JsonRecord;

interface JsonRecord {
  [key: string]: JsonValue | undefined;
}

const isJsonRecord = (value: unknown): value is JsonRecord =>
  Object.prototype.toString.call(value) === "[object Object]";

const isStringValue = (value: unknown): value is string =>
  Object.prototype.toString.call(value) === "[object String]";

const isFiniteNumber = (value: unknown): value is number =>
  Number.isFinite(value);

const recField = (record: JsonRecord, key: string) => {
  const value: unknown = record[key];

  return isJsonRecord(value) ? value : null;
};

const strField = (record: JsonRecord, key: string) => {
  const value: unknown = record[key];

  return isStringValue(value) ? value : null;
};

const numField = (record: JsonRecord, key: string) => {
  const value: unknown = record[key];

  if (isFiniteNumber(value)) {
    return value;
  }

  if (isStringValue(value) && value.trim() !== "") {
    const parsed = Number(value);

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
};

const validYouTubeId = (value: string | null | undefined) => {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  return YOUTUBE_ID_RE.test(value) ? value : null;
};

const parseXSegments = (segments: string[]) => {
  const [, route, id] = segments;

  if (
    route === "status" &&
    id !== undefined &&
    id !== "" &&
    DIGITS_RE.test(id)
  ) {
    return { site: "x", id } satisfies Link;
  }

  return null;
};

const parseYouTubeParts = (
  host: string,
  pathname: string,
  params: URLSearchParams,
  segments: string[]
) => {
  if (host === "youtu.be") {
    const [id] = segments;
    const valid = validYouTubeId(id);

    return valid === null
      ? null
      : ({ site: "youtube", id: valid } satisfies Link);
  }

  if (!YOUTUBE_HOSTS.has(host)) {
    return null;
  }

  if (pathname === "/watch") {
    const valid = validYouTubeId(params.get("v"));

    return valid === null
      ? null
      : ({ site: "youtube", id: valid } satisfies Link);
  }

  const [kind, id] = segments;

  if (
    segments.length >= 2 &&
    (kind === "shorts" || kind === "live" || kind === "embed")
  ) {
    const valid = validYouTubeId(id);

    return valid === null
      ? null
      : ({ site: "youtube", id: valid } satisfies Link);
  }

  return null;
};

/** Classifies an X/Twitter or YouTube URL into its site and canonical ID, or null if unsupported. */
export const parseLink = (input: string) => {
  let url: URL;

  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);

  if (X_HOSTS.has(host)) {
    return parseXSegments(segments);
  }

  return parseYouTubeParts(host, url.pathname, url.searchParams, segments);
};

const formatCount = (value: number | null) =>
  value === null ? "0" : value.toLocaleString("en-US");

const pad = (n: number) => String(n).padStart(2, "0");

const formatTimestamp = (ms: number) => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  }

  return `${minutes}:${pad(seconds)}`;
};

const addMediaItems = (
  media: JsonRecord,
  key: string,
  seen: Set<string>,
  urls: string[]
) => {
  const items = media[key];

  if (!Array.isArray(items)) {
    return;
  }

  for (const item of items) {
    if (!isJsonRecord(item)) {
      continue;
    }

    const { url }: { url?: unknown } = item;

    if (isStringValue(url) && url !== "" && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
};

const collectMediaUrls = (status: JsonRecord) => {
  const media = recField(status, "media");

  if (media === null) {
    return [];
  }

  const urls: string[] = [];
  const seen = new Set<string>();

  addMediaItems(media, "all", seen, urls);
  addMediaItems(media, "photos", seen, urls);
  addMediaItems(media, "videos", seen, urls);

  return urls;
};

const quoteLines = (status: JsonRecord) => {
  const quote = recField(status, "quote");

  if (quote === null) {
    return [];
  }

  const quoteAuthor = recField(quote, "author");

  const quoteHandle =
    (quoteAuthor === null ? null : strField(quoteAuthor, "screen_name")) ??
    "unknown";

  const quoteText = strField(quote, "text") ?? "";

  return [`> Quoted @${quoteHandle}: ${quoteText.replaceAll("\n", "\n> ")}`];
};

const threadLines = (payload: JsonRecord | null, screenName: string) => {
  const thread = payload === null ? null : payload["thread"];

  if (!Array.isArray(thread)) {
    return [];
  }

  const sameAuthorPosts: string[] = [];

  for (const entry of thread) {
    if (!isJsonRecord(entry)) {
      continue;
    }

    const postAuthor = recField(entry, "author");

    const postHandle =
      postAuthor === null ? null : strField(postAuthor, "screen_name");

    if (
      postHandle !== null &&
      postHandle !== "" &&
      postHandle.toLowerCase() !== screenName.toLowerCase()
    ) {
      continue;
    }

    const postText = strField(entry, "text");

    if (postText !== null && postText !== "") {
      sameAuthorPosts.push(postText);
    }
  }

  if (sameAuthorPosts.length <= 1) {
    return [];
  }

  const out = ["", "## Thread (same author)"];

  for (const [index, postText] of sameAuthorPosts.entries()) {
    out.push(`${index + 1}. ${postText}`);
  }

  return out;
};

const fetchXStatus = async (id: string, deps: Deps) => {
  let response: Response;

  try {
    response = await deps.fetch(`https://api.fxtwitter.com/2/thread/${id}`, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    deps.stderr(`cannot read X post ${id}: ${detail}\n`);

    return null;
  }

  let payload: JsonRecord | null = null;

  try {
    const body: unknown = await response.json();

    payload = isJsonRecord(body) ? body : null;
  } catch {
    payload = null;
  }

  return { response, payload };
};

const renderXPost = (
  id: string,
  response: Response,
  payload: JsonRecord | null,
  deps: Deps
) => {
  const status = payload === null ? null : recField(payload, "status");

  if (!response.ok || status === null) {
    const code =
      (payload === null ? null : numField(payload, "code")) ?? response.status;

    const message =
      (payload === null ? null : strField(payload, "message")) ??
      response.statusText ??
      "unavailable";

    deps.stderr(`cannot read X post ${id}: ${code} ${message}\n`);

    return 1;
  }

  const author = recField(status, "author");

  const authorName =
    (author === null ? null : strField(author, "name")) ?? "Unknown";

  const screenName =
    (author === null ? null : strField(author, "screen_name")) ?? "unknown";

  const createdAt = strField(status, "created_at");
  const rawText = recField(status, "raw_text");

  const text =
    strField(status, "text") ??
    (rawText === null ? null : strField(rawText, "text")) ??
    "";

  const views = numField(status, "views");

  const lines: string[] = [
    `# X post by ${authorName} (@${screenName})${createdAt === null ? "" : ` · ${createdAt}`}`,
    text,
    `Likes ${formatCount(numField(status, "likes"))} · Reposts ${formatCount(numField(status, "reposts"))} · Replies ${formatCount(numField(status, "replies"))}${views === null ? "" : ` · Views ${formatCount(views)}`}`,
  ];

  for (const mediaUrl of collectMediaUrls(status)) {
    lines.push(`Media: ${mediaUrl}`);
  }

  lines.push(...quoteLines(status), ...threadLines(payload, screenName));
  deps.stdout(`${lines.join("\n")}\n`);

  return 0;
};

const handleX = async (id: string, deps: Deps) => {
  const fetched = await fetchXStatus(id, deps);

  if (fetched === null) {
    return 1;
  }

  return renderXPost(id, fetched.response, fetched.payload, deps);
};

interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  isAsr: boolean;
}

const selectCaptionTrack = (player: JsonRecord) => {
  const captions = recField(player, "captions");

  const renderer =
    captions === null
      ? null
      : recField(captions, "playerCaptionsTracklistRenderer");

  const rawTracks = renderer === null ? null : renderer["captionTracks"];

  if (!Array.isArray(rawTracks)) {
    return null;
  }

  const tracks: CaptionTrack[] = [];

  for (const entry of rawTracks) {
    if (!isJsonRecord(entry)) {
      continue;
    }

    const baseUrl = strField(entry, "baseUrl");
    const languageCode = strField(entry, "languageCode");

    if (
      baseUrl === null ||
      baseUrl === "" ||
      languageCode === null ||
      languageCode === ""
    ) {
      continue;
    }

    const { kind }: { kind?: unknown } = entry;

    tracks.push({
      baseUrl,
      languageCode,
      isAsr: isStringValue(kind) && kind === "asr",
    });
  }

  const isEnglish = (t: CaptionTrack) =>
    t.languageCode === "en" || t.languageCode.startsWith("en-");

  return (
    tracks.find((t) => isEnglish(t) && !t.isAsr) ??
    tracks.find((t) => isEnglish(t) && t.isAsr) ??
    tracks.find((t) => !t.isAsr) ??
    tracks[0] ??
    null
  );
};

const parseJson3Transcript = (jsonText: string) => {
  let parsed: JsonRecord | null = null;

  try {
    const body: unknown = JSON.parse(jsonText);

    parsed = isJsonRecord(body) ? body : null;
  } catch {
    parsed = null;
  }

  const events = parsed === null ? null : parsed["events"];

  if (!Array.isArray(events)) {
    return [];
  }

  const paragraphs: string[] = [];
  let windowStartMs: number | null = null;
  let currentWords: string[] = [];

  for (const item of events) {
    if (!isJsonRecord(item)) {
      continue;
    }

    const { segs }: { segs?: unknown } = item;

    if (!Array.isArray(segs)) {
      continue;
    }

    const pieces: string[] = [];

    for (const seg of segs) {
      if (!isJsonRecord(seg)) {
        continue;
      }

      // eslint-disable-next-line unicorn/text-encoding-identifier-case -- JSON segment key, not a text-encoding identifier.
      const utf8 = strField(seg, "utf8") ?? strField(seg, "utf-8");

      if (utf8 !== null && utf8 !== "") {
        pieces.push(utf8);
      }
    }

    const text = pieces.join("").replaceAll(SPACES_RE, " ").trim();

    if (text === "") {
      continue;
    }

    const startMs = numField(item, "tStartMs") ?? 0;

    if (windowStartMs === null) {
      windowStartMs = startMs;
    } else if (
      startMs - windowStartMs >= PARAGRAPH_WINDOW_MS &&
      currentWords.length > 0
    ) {
      paragraphs.push(
        `[${formatTimestamp(windowStartMs)}] ${currentWords.join(" ")}`
      );
      windowStartMs = startMs;
      currentWords = [];
    }

    currentWords.push(text);
  }

  if (windowStartMs !== null && currentWords.length > 0) {
    paragraphs.push(
      `[${formatTimestamp(windowStartMs)}] ${currentWords.join(" ")}`
    );
  }

  return paragraphs;
};

const truncateUtf8 = (text: string, maxBytes: number) => {
  if (Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return text;
  }

  let low = 0;
  let high = text.length;

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);

    if (Buffer.byteLength(text.slice(0, mid), "utf-8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  const sliced = text.slice(0, low);

  return sliced.replace(LEAD_SURROGATE_RE, "");
};

const fetchCaptionJson3 = async (track: CaptionTrack, deps: Deps) => {
  let url: URL;

  try {
    url = new URL(track.baseUrl);
  } catch {
    return { paragraphs: [], reason: "invalid caption URL" };
  }

  url.searchParams.set("fmt", "json3");

  let body: string;

  try {
    const response = await deps.fetch(url.href, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      return { paragraphs: [], reason: `HTTP ${response.status}` };
    }

    body = await response.text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    return { paragraphs: [], reason: detail };
  }

  if (body.trim() === "") {
    return { paragraphs: [], reason: "empty caption body" };
  }

  const paragraphs = parseJson3Transcript(body);

  return paragraphs.length > 0
    ? { paragraphs }
    : { paragraphs: [], reason: "no caption segments" };
};

const fetchPlayer = async (id: string, deps: Deps) => {
  let response: Response;

  try {
    response = await deps.fetch("https://www.youtube.com/youtubei/v1/player", {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        context: { client: INNERTUBE_CLIENT },
        videoId: id,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    deps.stderr(`cannot read YouTube video ${id}: ${detail}\n`);

    return null;
  }

  if (!response.ok) {
    deps.stderr(
      `cannot read YouTube video ${id}: ${response.status} ${response.statusText}\n`
    );

    return null;
  }

  let player: JsonRecord | null = null;

  try {
    const body: unknown = await response.json();

    player = isJsonRecord(body) ? body : null;
  } catch {
    player = null;
  }

  return player;
};

const videoHeader = (id: string, player: JsonRecord) => {
  const videoDetails = recField(player, "videoDetails");

  if (videoDetails === null) {
    return null;
  }

  const title = strField(videoDetails, "title") ?? id;
  const author = strField(videoDetails, "author") ?? "Unknown";
  const durationSec = numField(videoDetails, "lengthSeconds") ?? 0;
  const views = numField(videoDetails, "viewCount");
  const description = strField(videoDetails, "shortDescription") ?? "";
  const microformat = recField(player, "microformat");

  const microRenderer =
    microformat === null
      ? null
      : recField(microformat, "playerMicroformatRenderer");

  const publishDate =
    microRenderer === null
      ? null
      : (strField(microRenderer, "publishDate") ??
        strField(microRenderer, "uploadDate"));

  const metaParts = [
    `Channel: ${author}`,
    `Duration ${formatTimestamp(durationSec * 1000)}`,
    `Views ${formatCount(views)}`,
  ];

  if (publishDate !== null && publishDate !== "") {
    metaParts.push(`Published ${publishDate}`);
  }

  const headerLines = [
    `# YouTube: ${title}`,
    metaParts.join(" · "),
    "",
    "## Description",
    description === "" ? "(none)" : description,
  ];

  return headerLines.join("\n");
};

const labelForFile = (json3Path: string) => {
  const base = path.basename(json3Path);
  const asrMatch = YT_ASR_RE.exec(base);
  const asrLang = asrMatch?.groups?.["lang"];

  if (asrLang !== undefined && asrLang !== "") {
    return `${asrLang}, auto-generated`;
  }

  const langMatch = YT_LANG_RE.exec(base);
  const lang = langMatch?.groups?.["lang"];

  return lang ?? "en";
};

const ytdlpTranscript = async (id: string, deps: Deps) => {
  const ytDlpDir = fs.mkdtempSync(path.join(os.tmpdir(), "link-reader-ytdlp-"));

  try {
    const json3Path = await deps.runYtDlp(
      `https://www.youtube.com/watch?v=${id}`,
      ytDlpDir
    );

    if (json3Path !== null && json3Path !== "" && fs.existsSync(json3Path)) {
      const paragraphs = parseJson3Transcript(
        fs.readFileSync(json3Path, "utf-8")
      );

      if (paragraphs.length > 0) {
        return { paragraphs, label: labelForFile(json3Path) };
      }
    }
  } finally {
    fs.rmSync(ytDlpDir, { recursive: true, force: true });
  }

  return { paragraphs: [], label: "en" };
};

const emitTranscript = (
  headerText: string,
  paragraphs: string[],
  label: string,
  failureReason: string,
  id: string,
  deps: Deps
) => {
  if (paragraphs.length === 0) {
    deps.stdout(`${headerText}\n\nTranscript unavailable: ${failureReason}\n`);

    return 0;
  }

  const transcriptSection = `## Transcript (${label})\n\n${paragraphs.join("\n\n")}`;
  const fullMarkdown = `${headerText}\n\n${transcriptSection}\n`;

  if (
    Buffer.byteLength(transcriptSection, "utf-8") >
    TRANSCRIPT_INLINE_LIMIT_BYTES
  ) {
    const writtenPath = deps.writeTemp(`link-reader-${id}.md`, fullMarkdown);
    const notice = `\nFull transcript (${Buffer.byteLength(transcriptSection, "utf-8")} bytes) written to: ${writtenPath}\n\n`;
    const suffix = `\n... [truncated; full transcript at ${writtenPath}]\n`;

    const budget =
      STDOUT_MAX_BYTES -
      Buffer.byteLength(headerText + notice + suffix, "utf-8") -
      64;

    const preview = truncateUtf8(transcriptSection, Math.max(0, budget));

    deps.stdout(`${headerText}${notice}${preview}${suffix}`);

    return 0;
  }

  deps.stdout(fullMarkdown);

  return 0;
};

const handleYouTube = async (id: string, deps: Deps) => {
  const player = await fetchPlayer(id, deps);

  if (player === null) {
    return 1;
  }

  const headerText = videoHeader(id, player);

  if (headerText === null) {
    const playability = recField(player, "playabilityStatus");

    const reason =
      (playability === null
        ? null
        : (strField(playability, "reason") ??
          strField(playability, "status"))) ?? "unavailable";

    deps.stderr(`cannot read YouTube video ${id}: ${reason}\n`);

    return 1;
  }

  const track = selectCaptionTrack(player);
  let paragraphs: string[] = [];
  let label = "en";
  let failureReason = "no caption tracks";

  if (track !== null) {
    label = track.isAsr
      ? `${track.languageCode}, auto-generated`
      : track.languageCode;

    const { paragraphs: fetchedParagraphs, reason } = await fetchCaptionJson3(
      track,
      deps
    );

    paragraphs = fetchedParagraphs;

    if (reason !== undefined && reason !== "") {
      failureReason = reason;
    }
  }

  if (paragraphs.length === 0) {
    const { paragraphs: fallbackParagraphs, label: fallbackLabel } =
      await ytdlpTranscript(id, deps);

    paragraphs = fallbackParagraphs;

    if (fallbackParagraphs.length > 0) {
      label = fallbackLabel;
    }
  }

  return emitTranscript(headerText, paragraphs, label, failureReason, id, deps);
};

const runYtDlpPass = async (
  url: string,
  outDir: string,
  flag: "--write-subs" | "--write-auto-subs"
) => {
  // NOTE: yt-dlp progress output would block on unconsumed pipes; ignore stdio and detect output via readdir.
  const child = spawn(
    "yt-dlp",
    [
      "--skip-download",
      flag,
      "--sub-langs",
      "en",
      "--sub-format",
      "json3",
      "-o",
      path.join(outDir, "%(id)s.%(ext)s"),
      url,
    ],
    { timeout: REQUEST_TIMEOUT_MS, stdio: "ignore" }
  );

  // NOTE: `once(child, "close")` rejects on a spawn error, so ENOENT must be caught to report missingBinary.
  let exitCode: number | null = null;

  try {
    const closed: unknown[] = await once(child, "close");
    const [code] = closed;

    exitCode = typeof code === "number" ? code : null;
  } catch (error) {
    const code: unknown =
      error instanceof Error && "code" in error ? error.code : undefined;

    return {
      file: null,
      missingBinary: isStringValue(code) && code === "ENOENT",
    };
  }

  // Non-zero exit or timeout kill: ignore partial output, as execFile did.
  if (exitCode !== 0) {
    return { file: null, missingBinary: false };
  }

  let file: string | null = null;

  try {
    const match = fs
      .readdirSync(outDir)
      .find((name) => name.endsWith(".json3"));

    file = match === undefined ? null : path.join(outDir, match);
  } catch {
    file = null;
  }

  return { file, missingBinary: false };
};

const defaultRunYtDlp = async (url: string, outDir: string) => {
  const manual = await runYtDlpPass(url, outDir, "--write-subs");

  if (manual.file !== null) {
    return manual.file;
  }

  if (manual.missingBinary) {
    return null;
  }

  const auto = await runYtDlpPass(url, outDir, "--write-auto-subs");

  if (auto.file === null) {
    return null;
  }

  const asrPath = auto.file.replace(/\.json3$/iu, ".asr.json3");

  fs.renameSync(auto.file, asrPath);

  return asrPath;
};

const defaultWriteTemp = (name: string, text: string) => {
  const filePath = path.join(os.tmpdir(), name);

  fs.writeFileSync(filePath, text, "utf-8");

  return filePath;
};

/** Reads an X post or YouTube video URL and prints Markdown to stdout. */
export const main = async (argv: string[], deps?: Partial<Deps>) => {
  const resolved: Deps = {
    fetch: deps?.fetch ?? globalThis.fetch,
    runYtDlp: deps?.runYtDlp ?? defaultRunYtDlp,
    writeTemp: deps?.writeTemp ?? defaultWriteTemp,
    stdout:
      deps?.stdout ??
      ((text: string) => {
        process.stdout.write(text);
      }),
    stderr:
      deps?.stderr ??
      ((text: string) => {
        process.stderr.write(text);
      }),
  };

  const [url] = argv;

  if (argv.length !== 1 || url === undefined) {
    resolved.stderr("Usage: node read-link.ts <x-or-youtube-url>\n");

    return 2;
  }

  const link = parseLink(url);

  if (link === null) {
    resolved.stderr(
      `Usage: unsupported URL ${JSON.stringify(url)}; expected an X/Twitter status or YouTube video URL\n`
    );

    return 2;
  }

  if (link.site === "x") {
    return await handleX(link.id, resolved);
  }

  return await handleYouTube(link.id, resolved);
};

if (
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
}
