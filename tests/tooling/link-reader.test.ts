import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// NOTE: literal dynamic import keeps each leaf test independently failing while the module is absent; tsc still types it.
import { main, parseLink, INNERTUBE_CLIENT } from '../../.agents/skills/link-reader/scripts/read-link.ts';

function makeDeps(
  overrides: Partial<{
    fetch: typeof globalThis.fetch;
    runYtDlp: (url: string, outDir: string) => Promise<string | null>;
    writeTemp: (name: string, text: string) => string;
  }> = {},
) {
  const out: Array<string> = [];
  const err: Array<string> = [];
  const tempCalls: Array<{ name: string; text: string }> = [];
  const deps = {
    fetch: overrides.fetch ?? (async () => new Response('{}', { status: 500 })),
    runYtDlp: overrides.runYtDlp ?? (async () => null),
    writeTemp:
      overrides.writeTemp ??
      ((name: string, text: string) => {
        tempCalls.push({ name, text });
        return `/tmp/${name}`;
      }),
    stdout: (text: string) => {
      out.push(text);
    },
    stderr: (text: string) => {
      err.push(text);
    },
  };
  return { deps, out, err, tempCalls };
}

function playerResponse(overrides: { captions?: unknown } = {}) {
  return {
    playabilityStatus: { status: 'OK' },
    videoDetails: {
      videoId: 'jP9yjEDlc4k',
      title: 'Opus just lost to the last company you would expect',
      author: 'Fireship',
      lengthSeconds: '271',
      viewCount: '123456',
      shortDescription: 'A short video description.',
    },
    microformat: {
      playerMicroformatRenderer: {
        publishDate: '2026-11-20',
      },
    },
    ...overrides,
  };
}

function requestUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
  if (typeof input === 'string') {
    return input;
  }
  return 'href' in input ? input.href : input.url;
}

// SECTION: X posts

test('X post renders author, text, counts, media URLs, quoted post, and same-author thread in order', async () => {
  const requests: Array<{ url: string; userAgent: string | null }> = [];
  const { deps, out, err } = makeDeps({
    fetch: async (input, init) => {
      const url = requestUrl(input);
      const headers = new Headers(init?.headers);
      requests.push({ url, userAgent: headers.get('user-agent') });
      return new Response(
        JSON.stringify({
          code: 200,
          status: {
            text: 'Main post text with https://example.com/expanded',
            author: { name: 'Andre Staltz', screen_name: 'andrestaltz' },
            created_at: '2026-11-24T00:00:00Z',
            replies: 7,
            reposts: 56,
            likes: 1234,
            views: 89_000,
            media: {
              all: [{ url: 'https://pbs.twimg.com/media/example.jpg', type: 'photo' }],
            },
            quote: {
              author: { screen_name: 'other' },
              text: 'Quoted post body',
            },
          },
          thread: [
            { author: { screen_name: 'andrestaltz' }, text: 'First in thread' },
            { author: { screen_name: 'bystander' }, text: 'Reply from another user' },
            { author: { screen_name: 'andrestaltz' }, text: 'Second in thread' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });

  const code = await main(['https://x.com/andrestaltz/status/2123503426218713176?s=20'], deps);
  assert.equal(code, 0);
  assert.equal(err.join(''), '');
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, 'https://api.fxtwitter.com/2/thread/2123503426218713176');
  assert.equal(requests[0]?.userAgent, 'link-reader (agent skill)');

  const markdown = out.join('');
  assert.match(markdown, /Andre Staltz/);
  assert.match(markdown, /@andrestaltz/);
  assert.match(markdown, /Main post text with https:\/\/example\.com\/expanded/);
  assert.match(markdown, /1,234/);
  assert.match(markdown, /56/);
  assert.match(markdown, /7/);
  assert.match(markdown, /89,000/);
  assert.match(markdown, /https:\/\/pbs\.twimg\.com\/media\/example\.jpg/);
  assert.match(markdown, /Quoted @other: Quoted post body/);
  assert.match(markdown, /First in thread/);
  assert.match(markdown, /Second in thread/);
  assert.doesNotMatch(markdown, /Reply from another user/);
  assert.ok(markdown.indexOf('First in thread') < markdown.indexOf('Second in thread'));
});

test('X post omits Thread section when thread contains only the requested post', async () => {
  const { deps, out } = makeDeps({
    fetch: async () =>
      new Response(
        JSON.stringify({
          code: 200,
          status: {
            text: 'Solo post',
            author: { name: 'Ada', screen_name: 'ada' },
            created_at: '2026-11-24T00:00:00Z',
            replies: 0,
            reposts: 1,
            likes: 2,
          },
          thread: [{ author: { screen_name: 'ada' }, text: 'Solo post' }],
        }),
        { status: 200 },
      ),
  });

  const code = await main(['https://vxtwitter.com/ada/status/999'], deps);
  assert.equal(code, 0);
  assert.doesNotMatch(out.join(''), /## Thread/);
});

// SECTION: YouTube URLs and metadata

test('YouTube URL parsing normalizes all accepted forms and rejects unsupported URLs', async () => {
  const accepted = [
    'https://youtu.be/jP9yjEDlc4k?is=033FAjzIUfXzy9F6',
    'https://www.youtube.com/watch?v=jP9yjEDlc4k&t=12s',
    'https://m.youtube.com/watch?v=jP9yjEDlc4k',
    'https://music.youtube.com/watch?v=jP9yjEDlc4k&si=abc',
    'https://youtube.com/shorts/jP9yjEDlc4k',
    'https://www.youtube.com/live/jP9yjEDlc4k',
    'https://www.youtube.com/embed/jP9yjEDlc4k',
  ];
  for (const url of accepted) {
    assert.deepEqual(parseLink(url), { site: 'youtube', id: 'jP9yjEDlc4k' }, url);
  }

  assert.deepEqual(parseLink('https://twitter.com/user/status/123456'), { site: 'x', id: '123456' });
  assert.deepEqual(parseLink('https://mobile.twitter.com/user/status/123456'), { site: 'x', id: '123456' });
  assert.deepEqual(parseLink('https://fxtwitter.com/user/status/123456'), { site: 'x', id: '123456' });
  assert.deepEqual(parseLink('https://fixupx.com/user/status/123456'), { site: 'x', id: '123456' });

  const rejected = [
    '',
    'not-a-url',
    'https://example.com/watch?v=jP9yjEDlc4k',
    'https://www.youtube.com/playlist?list=PL123',
    'https://www.youtube.com/watch?v=short',
    'https://x.com/andrestaltz',
    'https://x.com/andrestaltz/status/notnumeric',
  ];
  for (const url of rejected) {
    assert.equal(parseLink(url), null, url);
  }
});

test('YouTube metadata renders title, channel, duration, view count, publish date, and description', async () => {
  let sentClient: unknown;
  const { deps, out, err } = makeDeps({
    fetch: async (input, init) => {
      const url = requestUrl(input);
      if (url.includes('youtubei/v1/player')) {
        const body: { context?: { client?: unknown } } = JSON.parse(String(init?.body ?? '{}'));
        sentClient = body.context?.client ?? null;
        return new Response(JSON.stringify(playerResponse()), { status: 200 });
      }
      return new Response('', { status: 404 });
    },
  });

  const code = await main(['https://youtu.be/jP9yjEDlc4k?is=033FAjzIUfXzy9F6'], deps);
  assert.equal(code, 0);
  assert.equal(err.join(''), '');
  assert.deepEqual(sentClient, INNERTUBE_CLIENT);

  const markdown = out.join('');
  assert.match(markdown, /Opus just lost to the last company you would expect/);
  assert.match(markdown, /Fireship/);
  assert.match(markdown, /4:31/);
  assert.match(markdown, /123,456/);
  assert.match(markdown, /2026-11-20/);
  assert.match(markdown, /A short video description\./);
});

const runWithTracks = async (captionTracks: Array<{ baseUrl: string; languageCode: string; kind?: string }>) => {
  let fetchedCaptionUrl = '';
  const { deps, out, tempCalls } = makeDeps({
    fetch: async (input) => {
      const url = requestUrl(input);
      if (url.includes('youtubei/v1/player')) {
        return new Response(
          JSON.stringify(
            playerResponse({
              captions: { playerCaptionsTracklistRenderer: { captionTracks } },
            }),
          ),
          { status: 200 },
        );
      }
      fetchedCaptionUrl = url;
      return new Response(
        JSON.stringify({
          events: [
            { tStartMs: 0, segs: [{ utf8: 'Hello   world.' }] },
            { tStartMs: 5000, segs: [{ utf8: 'Second\nline.' }] },
            { tStartMs: 35_000, segs: [{ utf8: 'Later paragraph.' }] },
          ],
        }),
        { status: 200 },
      );
    },
  });
  const code = await main(['https://www.youtube.com/watch?v=jP9yjEDlc4k'], deps);
  assert.equal(code, 0);
  assert.equal(tempCalls.length, 0);
  return { fetchedCaptionUrl, markdown: out.join('') };
};

// SECTION: Transcript track selection and formatting

test('transcript track selection prefers English manual, then English asr, then first manual, then first track', async () => {
  // Prefers English manual over English asr and other manual
  const enManual = await runWithTracks([
    { baseUrl: 'https://captions.example/fr', languageCode: 'fr' },
    { baseUrl: 'https://captions.example/en-asr', languageCode: 'en', kind: 'asr' },
    { baseUrl: 'https://captions.example/en-man', languageCode: 'en' },
  ]);
  assert.match(enManual.fetchedCaptionUrl, /^https:\/\/captions\.example\/en-man.*fmt=json3/);
  assert.match(enManual.markdown, /## Transcript \(en\)/);
  assert.match(enManual.markdown, /\[0:00\] Hello world\. Second line\./);
  assert.match(enManual.markdown, /\[0:35\] Later paragraph\./);

  // Prefers English asr over non-English manual
  const enAsr = await runWithTracks([
    { baseUrl: 'https://captions.example/es', languageCode: 'es' },
    { baseUrl: 'https://captions.example/en-asr', languageCode: 'en', kind: 'asr' },
  ]);
  assert.match(enAsr.fetchedCaptionUrl, /^https:\/\/captions\.example\/en-asr.*fmt=json3/);
  assert.match(enAsr.markdown, /## Transcript \(en, auto-generated\)/);

  // Prefers first manual over non-English asr
  const otherManual = await runWithTracks([
    { baseUrl: 'https://captions.example/de-asr', languageCode: 'de', kind: 'asr' },
    { baseUrl: 'https://captions.example/ja', languageCode: 'ja' },
  ]);
  assert.match(otherManual.fetchedCaptionUrl, /^https:\/\/captions\.example\/ja.*fmt=json3/);
  assert.match(otherManual.markdown, /## Transcript \(ja\)/);
});

// SECTION: Long transcript bounding

test('long transcript over 60,000 bytes writes full Markdown via writeTemp and bounds stdout under 64 KB', async () => {
  const events = Array.from({ length: 800 }, (_, i) => ({
    tStartMs: i * 1000,
    segs: [
      { utf8: `Segment ${i} with enough repeated words to exceed sixty thousand bytes easily across the transcript.` },
    ],
  }));

  const { deps, out, tempCalls } = makeDeps({
    fetch: async (input) => {
      const url = requestUrl(input);
      if (url.includes('youtubei/v1/player')) {
        return new Response(
          JSON.stringify(
            playerResponse({
              captions: {
                playerCaptionsTracklistRenderer: {
                  captionTracks: [{ baseUrl: 'https://captions.example/en', languageCode: 'en', kind: 'asr' }],
                },
              },
            }),
          ),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ events }), { status: 200 });
    },
  });

  const code = await main(['https://youtu.be/jP9yjEDlc4k'], deps);
  assert.equal(code, 0);
  assert.equal(tempCalls.length, 1);
  assert.equal(tempCalls[0]?.name, 'link-reader-jP9yjEDlc4k.md');
  assert.ok(Buffer.byteLength(tempCalls[0].text, 'utf8') > 60_000);
  assert.match(tempCalls[0].text, /Segment 799/);

  const stdoutText = out.join('');
  assert.ok(Buffer.byteLength(stdoutText, 'utf8') < 65_536);
  assert.match(stdoutText, /\/tmp\/link-reader-jP9yjEDlc4k\.md/);
  assert.match(stdoutText, /Segment 0/);
});

// SECTION: Failures and fallbacks

test('failure: empty caption body with unavailable yt-dlp prints metadata and unavailable note with exit 0', async () => {
  let ytDlpCalled = false;
  const { deps, out } = makeDeps({
    fetch: async (input) => {
      const url = requestUrl(input);
      if (url.includes('youtubei/v1/player')) {
        return new Response(
          JSON.stringify(
            playerResponse({
              captions: {
                playerCaptionsTracklistRenderer: {
                  captionTracks: [{ baseUrl: 'https://captions.example/en', languageCode: 'en' }],
                },
              },
            }),
          ),
          { status: 200 },
        );
      }
      return new Response('', { status: 200 });
    },
    runYtDlp: async () => {
      ytDlpCalled = true;
      return null;
    },
  });

  const code = await main(['https://youtu.be/jP9yjEDlc4k'], deps);
  assert.equal(code, 0);
  assert.equal(ytDlpCalled, true);
  const markdown = out.join('');
  assert.match(markdown, /Opus just lost/);
  assert.match(markdown, /Transcript unavailable:/i);
});

test('failure fallback: when yt-dlp returns a json3 file, its transcript is rendered with fallback language label', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdlp-fixture-'));
  const json3Path = path.join(dir, 'jP9yjEDlc4k.en.json3');
  fs.writeFileSync(
    json3Path,
    JSON.stringify({
      events: [{ tStartMs: 12_000, segs: [{ utf8: 'Recovered via yt-dlp.' }] }],
    }),
    'utf8',
  );

  const { deps, out } = makeDeps({
    fetch: async (input) => {
      const url = requestUrl(input);
      if (url.includes('youtubei/v1/player')) {
        return new Response(
          JSON.stringify(
            playerResponse({
              captions: {
                playerCaptionsTracklistRenderer: {
                  captionTracks: [{ baseUrl: 'https://captions.example/ja', languageCode: 'ja', kind: 'asr' }],
                },
              },
            }),
          ),
          { status: 200 },
        );
      }
      return new Response('', { status: 200 });
    },
    runYtDlp: async () => json3Path,
  });

  const code = await main(['https://youtu.be/jP9yjEDlc4k'], deps);
  assert.equal(code, 0);
  const markdown = out.join('');
  assert.match(markdown, /## Transcript \(en\)/);
  assert.doesNotMatch(markdown, /ja, auto-generated/);
  assert.match(markdown, /\[0:12\] Recovered via yt-dlp\./);
});

test('failure fallback: when yt-dlp returns an .asr.json3 file, its transcript is labeled auto-generated', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdlp-asr-fixture-'));
  const asrJson3Path = path.join(dir, 'jP9yjEDlc4k.en.asr.json3');
  fs.writeFileSync(
    asrJson3Path,
    JSON.stringify({
      events: [{ tStartMs: 5000, segs: [{ utf8: 'Auto-generated via yt-dlp.' }] }],
    }),
    'utf8',
  );

  const { deps, out } = makeDeps({
    fetch: async (input) => {
      const url = requestUrl(input);
      if (url.includes('youtubei/v1/player')) {
        return new Response(JSON.stringify(playerResponse()), { status: 200 });
      }
      return new Response('', { status: 200 });
    },
    runYtDlp: async () => asrJson3Path,
  });

  const code = await main(['https://youtu.be/jP9yjEDlc4k'], deps);
  assert.equal(code, 0);
  const markdown = out.join('');
  assert.match(markdown, /## Transcript \(en, auto-generated\)/);
  assert.match(markdown, /\[0:05\] Auto-generated via yt-dlp\./);
});

test('failure: caption body read rejection falls back cleanly and exits 0', async () => {
  let ytDlpCalled = false;
  const { deps, out } = makeDeps({
    fetch: async (input) => {
      const url = requestUrl(input);
      if (url.includes('youtubei/v1/player')) {
        return new Response(
          JSON.stringify(
            playerResponse({
              captions: {
                playerCaptionsTracklistRenderer: {
                  captionTracks: [{ baseUrl: 'https://captions.example/en', languageCode: 'en' }],
                },
              },
            }),
          ),
          { status: 200 },
        );
      }
      return Object.assign(new Response('', { status: 200 }), {
        text: async (): Promise<string> => {
          throw new Error('stream reset');
        },
      });
    },
    runYtDlp: async () => {
      ytDlpCalled = true;
      return null;
    },
  });

  const code = await main(['https://youtu.be/jP9yjEDlc4k'], deps);
  assert.equal(code, 0);
  assert.equal(ytDlpCalled, true);
  const markdown = out.join('');
  assert.match(markdown, /Opus just lost/);
  assert.match(markdown, /Transcript unavailable: stream reset/);
});

test('failure: X 404 prints reason on stderr and exits 1', async () => {
  const { deps, out, err } = makeDeps({
    fetch: async () =>
      new Response(JSON.stringify({ code: 404, status: null, thread: null, message: 'NOT_FOUND' }), { status: 404 }),
  });

  const code = await main(['https://x.com/user/status/000'], deps);
  assert.equal(code, 1);
  assert.equal(out.join(''), '');
  assert.match(err.join(''), /cannot read X post 000: 404/);
});

test('failure: missing or unsupported URL prints usage on stderr and exits 2', async () => {
  const missing = makeDeps();
  assert.equal(await main([], missing.deps), 2);
  assert.match(missing.err.join(''), /Usage:/);

  const unsupported = makeDeps();
  assert.equal(await main(['https://example.com/article'], unsupported.deps), 2);
  assert.match(unsupported.err.join(''), /Usage:/);
});
