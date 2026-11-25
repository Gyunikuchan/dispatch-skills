import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type Link = { site: 'x'; id: string } | { site: 'youtube'; id: string };

export interface Deps {
  fetch: typeof globalThis.fetch;
  runYtDlp: (url: string, outDir: string) => Promise<string | null>;
  writeTemp: (name: string, text: string) => string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

// NOTE: WEB client returns UNPLAYABLE/empty captions; bump clientVersion from yt-dlp's InnerTube ANDROID client if captions stop returning.
export const INNERTUBE_CLIENT = {
  clientName: 'ANDROID',
  clientVersion: '20.10.38',
} as const;

const USER_AGENT = 'link-reader (agent skill)';
const REQUEST_TIMEOUT_MS = 15_000;
const TRANSCRIPT_INLINE_LIMIT_BYTES = 60_000;
const STDOUT_MAX_BYTES = 65_536;
const PARAGRAPH_WINDOW_MS = 30_000;

const X_HOSTS = new Set([
  'x.com',
  'www.x.com',
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
  'fxtwitter.com',
  'fixupx.com',
  'vxtwitter.com',
]);

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);

const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Classifies an X/Twitter or YouTube URL into its site and canonical ID, or null if unsupported. */
export function parseLink(input: string): Link | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);

  if (X_HOSTS.has(host)) {
    const [, route, id] = segments;
    if (route === 'status' && id && /^\d+$/.test(id)) {
      return { site: 'x', id };
    }
    return null;
  }

  if (host === 'youtu.be') {
    const id = segments[0];
    return id && YOUTUBE_ID_RE.test(id) ? { site: 'youtube', id } : null;
  }

  if (YOUTUBE_HOSTS.has(host)) {
    if (url.pathname === '/watch') {
      const id = url.searchParams.get('v');
      return id && YOUTUBE_ID_RE.test(id) ? { site: 'youtube', id } : null;
    }
    if (segments.length >= 2 && (segments[0] === 'shorts' || segments[0] === 'live' || segments[0] === 'embed')) {
      const id = segments[1];
      return id && YOUTUBE_ID_RE.test(id) ? { site: 'youtube', id } : null;
    }
  }

  return null;
}

// SECTION: JSON and formatting helpers

type JsonValue = string | number | boolean | null | Array<JsonValue> | JsonRecord;
// A parsed JSON object; absent keys read as undefined.
interface JsonRecord {
  [key: string]: JsonValue | undefined;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord | null {
  return isJsonRecord(value) ? value : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function formatCount(value: number | undefined): string {
  return value === undefined ? '0' : value.toLocaleString('en-US');
}

const pad = (n: number) => String(n).padStart(2, '0');

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

// SECTION: X handler

function collectMediaUrls(status: JsonRecord): Array<string> {
  const media = asRecord(status['media']);
  if (!media) {
    return [];
  }
  const urls: Array<string> = [];
  const seen = new Set<string>();
  const addItems = (items: unknown) => {
    if (!Array.isArray(items)) {
      return;
    }
    for (const item of items) {
      const rec = asRecord(item);
      const url = rec ? asString(rec['url']) : undefined;
      if (url && !seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    }
  };
  addItems(media['all']);
  addItems(media['photos']);
  addItems(media['videos']);
  return urls;
}

async function handleX(id: string, deps: Deps): Promise<number> {
  let response: Response;
  try {
    response = await deps.fetch(`https://api.fxtwitter.com/2/thread/${id}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    deps.stderr(`cannot read X post ${id}: ${detail}\n`);
    return 1;
  }

  let payload: JsonRecord | null;
  try {
    payload = asRecord(await response.json());
  } catch {
    payload = null;
  }

  const status = payload ? asRecord(payload['status']) : null;
  if (!response.ok || !status) {
    const code = (payload ? asNumber(payload['code']) : undefined) ?? response.status;
    const message = (payload ? asString(payload['message']) : undefined) ?? response.statusText ?? 'unavailable';
    deps.stderr(`cannot read X post ${id}: ${code} ${message}\n`);
    return 1;
  }

  const author = asRecord(status['author']);
  const authorName = (author ? asString(author['name']) : undefined) ?? 'Unknown';
  const screenName = (author ? asString(author['screen_name']) : undefined) ?? 'unknown';
  const createdAt = asString(status['created_at']);
  const rawText = asRecord(status['raw_text']);
  const text = asString(status['text']) ?? (rawText ? asString(rawText['text']) : undefined) ?? '';

  const lines: Array<string> = [
    `# X post by ${authorName} (@${screenName})${createdAt ? ` · ${createdAt}` : ''}`,
    text,
    `Likes ${formatCount(asNumber(status['likes']))} · Reposts ${formatCount(asNumber(status['reposts']))} · Replies ${formatCount(asNumber(status['replies']))}${asNumber(status['views']) !== undefined ? ` · Views ${formatCount(asNumber(status['views']))}` : ''}`,
  ];

  for (const mediaUrl of collectMediaUrls(status)) {
    lines.push(`Media: ${mediaUrl}`);
  }

  const quote = asRecord(status['quote']);
  if (quote) {
    const quoteAuthor = asRecord(quote['author']);
    const quoteHandle = (quoteAuthor ? asString(quoteAuthor['screen_name']) : undefined) ?? 'unknown';
    const quoteText = asString(quote['text']) ?? '';
    lines.push(`> Quoted @${quoteHandle}: ${quoteText.replaceAll('\n', '\n> ')}`);
  }

  const thread = payload ? payload['thread'] : undefined;
  if (Array.isArray(thread)) {
    const sameAuthorPosts: Array<string> = [];
    for (const entry of thread) {
      const post = asRecord(entry);
      if (!post) {
        continue;
      }
      const postAuthor = asRecord(post['author']);
      const postHandle = postAuthor ? asString(postAuthor['screen_name']) : undefined;
      if (postHandle && postHandle.toLowerCase() !== screenName.toLowerCase()) {
        continue;
      }
      const postText = asString(post['text']);
      if (postText) {
        sameAuthorPosts.push(postText);
      }
    }
    if (sameAuthorPosts.length > 1) {
      lines.push('', '## Thread (same author)');
      sameAuthorPosts.forEach((postText, index) => {
        lines.push(`${index + 1}. ${postText}`);
      });
    }
  }

  deps.stdout(`${lines.join('\n')}\n`);
  return 0;
}

// SECTION: YouTube handler

type CaptionTrack = {
  baseUrl: string;
  languageCode: string;
  isAsr: boolean;
};

function selectCaptionTrack(player: JsonRecord): CaptionTrack | null {
  const captions = asRecord(player['captions']);
  const renderer = captions ? asRecord(captions['playerCaptionsTracklistRenderer']) : null;
  const rawTracks = renderer ? renderer['captionTracks'] : undefined;
  if (!Array.isArray(rawTracks)) {
    return null;
  }

  const tracks: Array<CaptionTrack> = [];
  for (const entry of rawTracks) {
    const rec = asRecord(entry);
    if (!rec) {
      continue;
    }
    const baseUrl = asString(rec['baseUrl']);
    const languageCode = asString(rec['languageCode']);
    if (!baseUrl || !languageCode) {
      continue;
    }
    tracks.push({ baseUrl, languageCode, isAsr: asString(rec['kind']) === 'asr' });
  }
  const isEnglish = (t: CaptionTrack) => t.languageCode === 'en' || t.languageCode.startsWith('en-');
  return (
    tracks.find((t) => isEnglish(t) && !t.isAsr) ??
    tracks.find((t) => isEnglish(t) && t.isAsr) ??
    tracks.find((t) => !t.isAsr) ??
    tracks[0] ??
    null
  );
}

function parseJson3Transcript(jsonText: string): Array<string> {
  let parsed: JsonRecord | null;
  try {
    parsed = asRecord(JSON.parse(jsonText));
  } catch {
    return [];
  }
  const events = parsed ? parsed['events'] : undefined;
  if (!Array.isArray(events)) {
    return [];
  }

  const paragraphs: Array<string> = [];
  let windowStartMs: number | null = null;
  let currentWords: Array<string> = [];

  for (const item of events) {
    const event = asRecord(item);
    if (!event) {
      continue;
    }
    const segs = event['segs'];
    if (!Array.isArray(segs)) {
      continue;
    }

    const pieces: Array<string> = [];
    for (const seg of segs) {
      const segRec = asRecord(seg);
      const utf8 = segRec ? asString(segRec['utf8']) : undefined;
      if (utf8) {
        pieces.push(utf8);
      }
    }
    const text = pieces.join('').replaceAll(/\s+/g, ' ').trim();
    if (!text) {
      continue;
    }

    const startMs = asNumber(event['tStartMs']) ?? 0;
    if (windowStartMs === null) {
      windowStartMs = startMs;
    } else if (startMs - windowStartMs >= PARAGRAPH_WINDOW_MS && currentWords.length > 0) {
      paragraphs.push(`[${formatTimestamp(windowStartMs)}] ${currentWords.join(' ')}`);
      windowStartMs = startMs;
      currentWords = [];
    }
    currentWords.push(text);
  }

  if (windowStartMs !== null && currentWords.length > 0) {
    paragraphs.push(`[${formatTimestamp(windowStartMs)}] ${currentWords.join(' ')}`);
  }
  return paragraphs;
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return text;
  }
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  // Avoid splitting a surrogate pair at the boundary.
  const sliced = text.slice(0, low);
  return sliced.replace(/[\uD800-\uDBFF]$/, '');
}

async function fetchCaptionJson3(
  track: CaptionTrack,
  deps: Deps,
): Promise<{ paragraphs: Array<string>; reason?: string }> {
  let url: URL;
  try {
    url = new URL(track.baseUrl);
  } catch {
    return { paragraphs: [], reason: 'invalid caption URL' };
  }
  url.searchParams.set('fmt', 'json3');

  let body: string;
  try {
    const response = await deps.fetch(url.href, {
      headers: { 'User-Agent': USER_AGENT },
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

  if (!body.trim()) {
    return { paragraphs: [], reason: 'empty caption body' };
  }
  const paragraphs = parseJson3Transcript(body);
  return paragraphs.length > 0 ? { paragraphs } : { paragraphs: [], reason: 'no caption segments' };
}

async function handleYouTube(id: string, deps: Deps): Promise<number> {
  let response: Response;
  try {
    response = await deps.fetch('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
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
    return 1;
  }

  if (!response.ok) {
    deps.stderr(`cannot read YouTube video ${id}: ${response.status} ${response.statusText}\n`);
    return 1;
  }

  let player: JsonRecord | null;
  try {
    player = asRecord(await response.json());
  } catch {
    player = null;
  }

  const videoDetails = player ? asRecord(player['videoDetails']) : null;
  if (!player || !videoDetails) {
    const playability = player ? asRecord(player['playabilityStatus']) : null;
    const reason =
      (playability ? (asString(playability['reason']) ?? asString(playability['status'])) : undefined) ?? 'unavailable';
    deps.stderr(`cannot read YouTube video ${id}: ${reason}\n`);
    return 1;
  }

  const title = asString(videoDetails['title']) ?? id;
  const author = asString(videoDetails['author']) ?? 'Unknown';
  const durationSec = asNumber(videoDetails['lengthSeconds']) ?? 0;
  const views = asNumber(videoDetails['viewCount']);
  const description = asString(videoDetails['shortDescription']) ?? '';

  const microformat = asRecord(player['microformat']);
  const microRenderer = microformat ? asRecord(microformat['playerMicroformatRenderer']) : null;
  const publishDate = microRenderer
    ? (asString(microRenderer['publishDate']) ?? asString(microRenderer['uploadDate']))
    : undefined;

  const metaParts = [
    `Channel: ${author}`,
    `Duration ${formatTimestamp(durationSec * 1000)}`,
    `Views ${formatCount(views)}`,
  ];
  if (publishDate) {
    metaParts.push(`Published ${publishDate}`);
  }

  const headerLines = [`# YouTube: ${title}`, metaParts.join(' · '), '', '## Description', description || '(none)'];
  const headerText = headerLines.join('\n');

  const track = selectCaptionTrack(player);
  let paragraphs: Array<string> = [];
  let label = 'en';
  let failureReason = 'no caption tracks';

  if (track) {
    label = track.isAsr ? `${track.languageCode}, auto-generated` : track.languageCode;
    const fetched = await fetchCaptionJson3(track, deps);
    paragraphs = fetched.paragraphs;
    if (fetched.reason) {
      failureReason = fetched.reason;
    }
  }

  if (paragraphs.length === 0) {
    const ytDlpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-reader-ytdlp-'));
    try {
      const json3Path = await deps.runYtDlp(`https://www.youtube.com/watch?v=${id}`, ytDlpDir);
      if (json3Path && fs.existsSync(json3Path)) {
        paragraphs = parseJson3Transcript(fs.readFileSync(json3Path, 'utf8'));
        if (paragraphs.length > 0) {
          const base = path.basename(json3Path);
          const asrMatch = /\.([^.]+)\.asr\.json3$/i.exec(base);
          if (asrMatch) {
            label = `${asrMatch[1]}, auto-generated`;
          } else {
            const langMatch = /\.([^.]+)\.json3$/i.exec(base);
            label = langMatch?.[1] ?? 'en';
          }
        }
      }
    } finally {
      fs.rmSync(ytDlpDir, { recursive: true, force: true });
    }
  }

  if (paragraphs.length === 0) {
    deps.stdout(`${headerText}\n\nTranscript unavailable: ${failureReason}\n`);
    return 0;
  }

  const transcriptSection = `## Transcript (${label})\n\n${paragraphs.join('\n\n')}`;
  const fullMarkdown = `${headerText}\n\n${transcriptSection}\n`;

  if (Buffer.byteLength(transcriptSection, 'utf8') > TRANSCRIPT_INLINE_LIMIT_BYTES) {
    const writtenPath = deps.writeTemp(`link-reader-${id}.md`, fullMarkdown);
    const notice = `\nFull transcript (${Buffer.byteLength(transcriptSection, 'utf8')} bytes) written to: ${writtenPath}\n\n`;
    const suffix = `\n... [truncated; full transcript at ${writtenPath}]\n`;
    const budget = STDOUT_MAX_BYTES - Buffer.byteLength(headerText + notice + suffix, 'utf8') - 64;
    const preview = truncateUtf8(transcriptSection, Math.max(0, budget));
    deps.stdout(`${headerText}${notice}${preview}${suffix}`);
    return 0;
  }

  deps.stdout(fullMarkdown);
  return 0;
}

// SECTION: Default IO and CLI entry point

function runYtDlpPass(
  url: string,
  outDir: string,
  flag: '--write-subs' | '--write-auto-subs',
): Promise<{ file: string | null; missingBinary: boolean }> {
  return new Promise((resolve) => {
    execFile(
      'yt-dlp',
      [
        '--skip-download',
        flag,
        '--sub-langs',
        'en',
        '--sub-format',
        'json3',
        '-o',
        path.join(outDir, '%(id)s.%(ext)s'),
        url,
      ],
      { timeout: REQUEST_TIMEOUT_MS },
      (error) => {
        if (error) {
          const missingBinary = error.code === 'ENOENT';
          resolve({ file: null, missingBinary });
          return;
        }
        let file: string | null;
        try {
          const match = fs.readdirSync(outDir).find((name) => name.endsWith('.json3'));
          file = match ? path.join(outDir, match) : null;
        } catch {
          file = null;
        }
        resolve({ file, missingBinary: false });
      },
    );
  });
}

async function defaultRunYtDlp(url: string, outDir: string): Promise<string | null> {
  const manual = await runYtDlpPass(url, outDir, '--write-subs');
  if (manual.file) {
    return manual.file;
  }
  if (manual.missingBinary) {
    return null;
  }

  const auto = await runYtDlpPass(url, outDir, '--write-auto-subs');
  if (!auto.file) {
    return null;
  }
  const asrPath = auto.file.replace(/\.json3$/i, '.asr.json3');
  fs.renameSync(auto.file, asrPath);
  return asrPath;
}

function defaultWriteTemp(name: string, text: string): string {
  const filePath = path.join(os.tmpdir(), name);
  fs.writeFileSync(filePath, text, 'utf8');
  return filePath;
}

/** Reads an X post or YouTube video URL and prints Markdown to stdout. */
export async function main(argv: Array<string>, deps?: Partial<Deps>): Promise<number> {
  const resolved: Deps = {
    fetch: deps?.fetch ?? globalThis.fetch,
    runYtDlp: deps?.runYtDlp ?? defaultRunYtDlp,
    writeTemp: deps?.writeTemp ?? defaultWriteTemp,
    stdout:
      deps?.stdout ??
      ((text) => {
        process.stdout.write(text);
      }),
    stderr:
      deps?.stderr ??
      ((text) => {
        process.stderr.write(text);
      }),
  };

  const [url] = argv;
  if (argv.length !== 1 || url === undefined) {
    resolved.stderr('Usage: node read-link.ts <x-or-youtube-url>\n');
    return 2;
  }

  const link = parseLink(url);
  if (!link) {
    resolved.stderr(
      `Usage: unsupported URL ${JSON.stringify(url)}; expected an X/Twitter status or YouTube video URL\n`,
    );
    return 2;
  }

  return link.site === 'x' ? handleX(link.id, resolved) : handleYouTube(link.id, resolved);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
