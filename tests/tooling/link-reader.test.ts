import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  main,
  parseLink,
  INNERTUBE_CLIENT,
} from "../../.agents/skills/link-reader/scripts/read-link.ts";

const makeDeps = (
  overrides: Partial<{
    fetch: typeof globalThis.fetch;
    runYtDlp: (url: string, outDir: string) => Promise<string | null>;
    writeTemp: (name: string, text: string) => string;
  }> = {}
) => {
  const out: string[] = [];
  const err: string[] = [];
  const tempCalls: { name: string; text: string }[] = [];

  const deps = {
    fetch:
      overrides.fetch ??
      (async () => {
        await Promise.resolve();

        return new Response("{}", { status: 500 });
      }),
    runYtDlp:
      overrides.runYtDlp ??
      (async () => {
        await Promise.resolve();

        return null;
      }),
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
};

const playerResponse = (overrides: { captions?: unknown } = {}) => ({
  playabilityStatus: { status: "OK" },
  videoDetails: {
    videoId: "jP9yjEDlc4k",
    title: "Opus just lost to the last company you would expect",
    author: "Fireship",
    lengthSeconds: "271",
    viewCount: "123456",
    shortDescription: "A short video description.",
  },
  microformat: {
    playerMicroformatRenderer: {
      publishDate: "2026-11-20",
    },
  },
  ...overrides,
});

const requestUrl = (input: Parameters<typeof globalThis.fetch>[0]) => {
  if (typeof input === "string") {
    return input;
  }

  return "href" in input ? input.href : input.url;
};

test("X post renders author, text, counts, media URLs, quoted post, and same-author thread in order", async () => {
  const requests: { url: string; userAgent: string | null }[] = [];

  const { deps, out, err } = makeDeps({
    fetch: async (input, init) => {
      await Promise.resolve();
      const url = requestUrl(input);
      const headers = new Headers(init?.headers);
      requests.push({ url, userAgent: headers.get("user-agent") });

      return new Response(
        // eslint-disable-next-line unicorn/prefer-response-static-json -- intentional test pattern.
        JSON.stringify({
          code: 200,
          status: {
            text: "Main post text with https://example.com/expanded",
            author: { name: "Andre Staltz", screen_name: "andrestaltz" },
            created_at: "2026-11-24T00:00:00Z",
            replies: 7,
            reposts: 56,
            likes: 1234,
            views: 89_000,
            media: {
              all: [
                {
                  url: "https://pbs.twimg.com/media/example.jpg",
                  type: "photo",
                },
              ],
            },
            quote: {
              author: { screen_name: "other" },
              text: "Quoted post body",
            },
          },
          thread: [
            { author: { screen_name: "andrestaltz" }, text: "First in thread" },
            {
              author: { screen_name: "bystander" },
              text: "Reply from another user",
            },
            {
              author: { screen_name: "andrestaltz" },
              text: "Second in thread",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    },
  });

  const code = await main(
    ["https://x.com/andrestaltz/status/2123503426218713176?s=20"],
    deps
  );

  assert.equal(code, 0);
  assert.equal(err.join(""), "");
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]?.url,
    "https://api.fxtwitter.com/2/thread/2123503426218713176"
  );
  assert.equal(requests[0]?.userAgent, "link-reader (agent skill)");

  const markdown = out.join("");
  assert.match(markdown, /Andre Staltz/u);
  assert.match(markdown, /@andrestaltz/u);
  assert.match(
    markdown,
    /Main post text with https:\/\/example\.com\/expanded/u
  );
  assert.match(markdown, /1,234/u);
  assert.match(markdown, /56/u);
  assert.match(markdown, /7/u);
  assert.match(markdown, /89,000/u);
  assert.match(markdown, /https:\/\/pbs\.twimg\.com\/media\/example\.jpg/u);
  assert.match(markdown, /Quoted @other: Quoted post body/u);
  assert.match(markdown, /First in thread/u);
  assert.match(markdown, /Second in thread/u);
  assert.doesNotMatch(markdown, /Reply from another user/u);
  assert.ok(
    markdown.indexOf("First in thread") < markdown.indexOf("Second in thread")
  );
});

test("X post omits Thread section when thread contains only the requested post", async () => {
  const { deps, out } = makeDeps({
    fetch: async () => {
      await Promise.resolve();

      return new Response(
        // eslint-disable-next-line unicorn/prefer-response-static-json -- intentional test pattern.
        JSON.stringify({
          code: 200,
          status: {
            text: "Solo post",
            author: { name: "Ada", screen_name: "ada" },
            created_at: "2026-11-24T00:00:00Z",
            replies: 0,
            reposts: 1,
            likes: 2,
          },
          thread: [{ author: { screen_name: "ada" }, text: "Solo post" }],
        }),
        { status: 200 }
      );
    },
  });

  const code = await main(["https://vxtwitter.com/ada/status/999"], deps);
  assert.equal(code, 0);
  assert.doesNotMatch(out.join(""), /## Thread/u);
});

test("YouTube URL parsing normalizes all accepted forms and rejects unsupported URLs", async () => {
  await Promise.resolve();

  const accepted = [
    "https://youtu.be/jP9yjEDlc4k?is=033FAjzIUfXzy9F6",
    "https://www.youtube.com/watch?v=jP9yjEDlc4k&t=12s",
    "https://m.youtube.com/watch?v=jP9yjEDlc4k",
    "https://music.youtube.com/watch?v=jP9yjEDlc4k&si=abc",
    "https://youtube.com/shorts/jP9yjEDlc4k",
    "https://www.youtube.com/live/jP9yjEDlc4k",
    "https://www.youtube.com/embed/jP9yjEDlc4k",
  ];

  for (const url of accepted) {
    assert.deepEqual(
      parseLink(url),
      { site: "youtube", id: "jP9yjEDlc4k" },
      url
    );
  }

  assert.deepEqual(parseLink("https://twitter.com/user/status/123456"), {
    site: "x",
    id: "123456",
  });
  assert.deepEqual(parseLink("https://mobile.twitter.com/user/status/123456"), {
    site: "x",
    id: "123456",
  });
  assert.deepEqual(parseLink("https://fxtwitter.com/user/status/123456"), {
    site: "x",
    id: "123456",
  });
  assert.deepEqual(parseLink("https://fixupx.com/user/status/123456"), {
    site: "x",
    id: "123456",
  });

  const rejected = [
    "",
    "not-a-url",
    "https://example.com/watch?v=jP9yjEDlc4k",
    "https://www.youtube.com/playlist?list=PL123",
    "https://www.youtube.com/watch?v=short",
    "https://x.com/andrestaltz",
    "https://x.com/andrestaltz/status/notnumeric",
  ];

  for (const url of rejected) {
    assert.equal(parseLink(url), null, url);
  }
});

test("YouTube metadata renders title, channel, duration, view count, publish date, and description", async () => {
  let sentClient: unknown;

  const { deps, out, err } = makeDeps({
    fetch: async (input, init) => {
      await Promise.resolve();
      const url = requestUrl(input);

      if (url.includes("youtubei/v1/player")) {
        // eslint-disable-next-line typescript/no-unsafe-assignment -- fixture/mock boundary: values are validated by helpers before use.
        const body: { context?: { client?: unknown } } = JSON.parse(
          // eslint-disable-next-line typescript/no-base-to-string -- fixture value is a validated string at runtime.
          String(init?.body ?? "{}")
        );

        sentClient = body.context?.client ?? null;

        // eslint-disable-next-line unicorn/prefer-response-static-json -- intentional test pattern.
        return new Response(JSON.stringify(playerResponse()), { status: 200 });
      }

      return new Response("", { status: 404 });
    },
  });

  const code = await main(
    ["https://youtu.be/jP9yjEDlc4k?is=033FAjzIUfXzy9F6"],
    deps
  );

  assert.equal(code, 0);
  assert.equal(err.join(""), "");
  assert.deepEqual(sentClient, INNERTUBE_CLIENT);

  const markdown = out.join("");
  assert.match(
    markdown,
    /Opus just lost to the last company you would expect/u
  );
  assert.match(markdown, /Fireship/u);
  assert.match(markdown, /4:31/u);
  assert.match(markdown, /123,456/u);
  assert.match(markdown, /2026-11-20/u);
  assert.match(markdown, /A short video description\./u);
});

const runWithTracks = async (
  captionTracks: { baseUrl: string; languageCode: string; kind?: string }[]
) => {
  let fetchedCaptionUrl = "";

  const { deps, out, tempCalls } = makeDeps({
    fetch: async (input) => {
      await Promise.resolve();
      const url = requestUrl(input);

      if (url.includes("youtubei/v1/player")) {
        return new Response(
          // eslint-disable-next-line unicorn/prefer-response-static-json -- intentional test pattern.
          JSON.stringify(
            playerResponse({
              captions: { playerCaptionsTracklistRenderer: { captionTracks } },
            })
          ),
          { status: 200 }
        );
      }

      fetchedCaptionUrl = url;

      return new Response(
        // eslint-disable-next-line unicorn/prefer-response-static-json -- intentional test pattern.
        JSON.stringify({
          events: [
            { tStartMs: 0, segs: [{ utf8: "Hello   world." }] },
            { tStartMs: 5000, segs: [{ utf8: "Second\nline." }] },
            { tStartMs: 35_000, segs: [{ utf8: "Later paragraph." }] },
          ],
        }),
        { status: 200 }
      );
    },
  });

  const code = await main(
    ["https://www.youtube.com/watch?v=jP9yjEDlc4k"],
    deps
  );

  assert.equal(code, 0);
  assert.equal(tempCalls.length, 0);

  return { fetchedCaptionUrl, markdown: out.join("") };
};

test("transcript track selection prefers English manual, then English asr, then first manual, then first track", async () => {
  // Prefers English manual over English asr and other manual
  const enManual = await runWithTracks([
    { baseUrl: "https://captions.example/fr", languageCode: "fr" },
    {
      baseUrl: "https://captions.example/en-asr",
      languageCode: "en",
      kind: "asr",
    },
    { baseUrl: "https://captions.example/en-man", languageCode: "en" },
  ]);

  assert.match(
    enManual.fetchedCaptionUrl,
    /^https:\/\/captions\.example\/en-man.*fmt=json3/u
  );
  assert.match(enManual.markdown, /## Transcript \(en\)/u);
  assert.match(enManual.markdown, /\[0:00\] Hello world\. Second line\./u);
  assert.match(enManual.markdown, /\[0:35\] Later paragraph\./u);

  // Prefers English asr over non-English manual
  const enAsr = await runWithTracks([
    { baseUrl: "https://captions.example/es", languageCode: "es" },
    {
      baseUrl: "https://captions.example/en-asr",
      languageCode: "en",
      kind: "asr",
    },
  ]);

  assert.match(
    enAsr.fetchedCaptionUrl,
    /^https:\/\/captions\.example\/en-asr.*fmt=json3/u
  );
  assert.match(enAsr.markdown, /## Transcript \(en, auto-generated\)/u);

  // Prefers first manual over non-English asr
  const otherManual = await runWithTracks([
    {
      baseUrl: "https://captions.example/de-asr",
      languageCode: "de",
      kind: "asr",
    },
    { baseUrl: "https://captions.example/ja", languageCode: "ja" },
  ]);

  assert.match(
    otherManual.fetchedCaptionUrl,
    /^https:\/\/captions\.example\/ja.*fmt=json3/u
  );
  assert.match(otherManual.markdown, /## Transcript \(ja\)/u);
});

test("long transcript over 60,000 bytes writes full Markdown via writeTemp and bounds stdout under 64 KB", async () => {
  const events = Array.from({ length: 800 }, (_, i) => ({
    tStartMs: i * 1000,
    segs: [
      {
        utf8: `Segment ${i} with enough repeated words to exceed sixty thousand bytes easily across the transcript.`,
      },
    ],
  }));

  const { deps, out, tempCalls } = makeDeps({
    fetch: async (input) => {
      await Promise.resolve();
      const url = requestUrl(input);

      if (url.includes("youtubei/v1/player")) {
        return new Response(
          // eslint-disable-next-line unicorn/prefer-response-static-json -- intentional test pattern.
          JSON.stringify(
            playerResponse({
              captions: {
                playerCaptionsTracklistRenderer: {
                  captionTracks: [
                    {
                      baseUrl: "https://captions.example/en",
                      languageCode: "en",
                      kind: "asr",
                    },
                  ],
                },
              },
            })
          ),
          { status: 200 }
        );
      }

      // eslint-disable-next-line unicorn/prefer-response-static-json -- intentional test pattern.
      return new Response(JSON.stringify({ events }), { status: 200 });
    },
  });

  const code = await main(["https://youtu.be/jP9yjEDlc4k"], deps);
  assert.equal(code, 0);
  assert.equal(tempCalls.length, 1);
  assert.equal(tempCalls[0]?.name, "link-reader-jP9yjEDlc4k.md");
  assert.ok(Buffer.byteLength(tempCalls[0].text, "utf-8") > 60_000);
  assert.match(tempCalls[0].text, /Segment 799/u);

  const stdoutText = out.join("");
  assert.ok(Buffer.byteLength(stdoutText, "utf-8") < 65_536);
  assert.match(stdoutText, /\/tmp\/link-reader-jP9yjEDlc4k\.md/u);
  assert.match(stdoutText, /Segment 0/u);
});

test("failure: empty caption body with unavailable yt-dlp prints metadata and unavailable note with exit 0", async () => {
  let ytDlpCalled = false;

  const { deps, out } = makeDeps({
    fetch: async (input) => {
      await Promise.resolve();
      const url = requestUrl(input);

      if (url.includes("youtubei/v1/player")) {
        return new Response(
          // eslint-disable-next-line unicorn/prefer-response-static-json -- intentional test pattern.
          JSON.stringify(
            playerResponse({
              captions: {
                playerCaptionsTracklistRenderer: {
                  captionTracks: [
                    {
                      baseUrl: "https://captions.example/en",
                      languageCode: "en",
                    },
                  ],
                },
              },
            })
          ),
          { status: 200 }
        );
      }

      return new Response("", { status: 200 });
    },
    runYtDlp: async () => {
      await Promise.resolve();
      ytDlpCalled = true;

      return null;
    },
  });

  const code = await main(["https://youtu.be/jP9yjEDlc4k"], deps);
  assert.equal(code, 0);
  assert.equal(ytDlpCalled, true);
  const markdown = out.join("");
  assert.match(markdown, /Opus just lost/u);
  assert.match(markdown, /Transcript unavailable:/iu);
});

test("failure fallback: when yt-dlp returns a json3 file, its transcript is rendered with fallback language label", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ytdlp-fixture-"));
  const json3Path = path.join(dir, "jP9yjEDlc4k.en.json3");
  fs.writeFileSync(
    json3Path,
    JSON.stringify({
      events: [{ tStartMs: 12_000, segs: [{ utf8: "Recovered via yt-dlp." }] }],
    }),
    "utf-8"
  );

  const { deps, out } = makeDeps({
    fetch: async (input) => {
      await Promise.resolve();
      const url = requestUrl(input);

      if (url.includes("youtubei/v1/player")) {
        return new Response(
          // eslint-disable-next-line unicorn/prefer-response-static-json -- intentional test pattern.
          JSON.stringify(
            playerResponse({
              captions: {
                playerCaptionsTracklistRenderer: {
                  captionTracks: [
                    {
                      baseUrl: "https://captions.example/ja",
                      languageCode: "ja",
                      kind: "asr",
                    },
                  ],
                },
              },
            })
          ),
          { status: 200 }
        );
      }

      return new Response("", { status: 200 });
    },
    runYtDlp: async () => {
      await Promise.resolve();

      return json3Path;
    },
  });

  const code = await main(["https://youtu.be/jP9yjEDlc4k"], deps);
  assert.equal(code, 0);
  const markdown = out.join("");
  assert.match(markdown, /## Transcript \(en\)/u);
  assert.doesNotMatch(markdown, /ja, auto-generated/u);
  assert.match(markdown, /\[0:12\] Recovered via yt-dlp\./u);
});

test("failure fallback: when yt-dlp returns an .asr.json3 file, its transcript is labeled auto-generated", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ytdlp-asr-fixture-"));
  const asrJson3Path = path.join(dir, "jP9yjEDlc4k.en.asr.json3");
  fs.writeFileSync(
    asrJson3Path,
    JSON.stringify({
      events: [
        { tStartMs: 5000, segs: [{ utf8: "Auto-generated via yt-dlp." }] },
      ],
    }),
    "utf-8"
  );

  const { deps, out } = makeDeps({
    fetch: async (input) => {
      await Promise.resolve();
      const url = requestUrl(input);

      if (url.includes("youtubei/v1/player")) {
        // eslint-disable-next-line unicorn/prefer-response-static-json -- intentional test pattern.
        return new Response(JSON.stringify(playerResponse()), { status: 200 });
      }

      return new Response("", { status: 200 });
    },
    runYtDlp: async () => {
      await Promise.resolve();

      return asrJson3Path;
    },
  });

  const code = await main(["https://youtu.be/jP9yjEDlc4k"], deps);
  assert.equal(code, 0);
  const markdown = out.join("");
  assert.match(markdown, /## Transcript \(en, auto-generated\)/u);
  assert.match(markdown, /\[0:05\] Auto-generated via yt-dlp\./u);
});

test("failure: caption body read rejection falls back cleanly and exits 0", async () => {
  let ytDlpCalled = false;

  const { deps, out } = makeDeps({
    fetch: async (input) => {
      await Promise.resolve();
      const url = requestUrl(input);

      if (url.includes("youtubei/v1/player")) {
        return new Response(
          // eslint-disable-next-line unicorn/prefer-response-static-json -- intentional test pattern.
          JSON.stringify(
            playerResponse({
              captions: {
                playerCaptionsTracklistRenderer: {
                  captionTracks: [
                    {
                      baseUrl: "https://captions.example/en",
                      languageCode: "en",
                    },
                  ],
                },
              },
            })
          ),
          { status: 200 }
        );
      }

      return Object.assign(new Response("", { status: 200 }), {
        text: async () => {
          await Promise.resolve();
          throw new Error("stream reset");
        },
      });
    },
    runYtDlp: async () => {
      await Promise.resolve();
      ytDlpCalled = true;

      return null;
    },
  });

  const code = await main(["https://youtu.be/jP9yjEDlc4k"], deps);
  assert.equal(code, 0);
  assert.equal(ytDlpCalled, true);
  const markdown = out.join("");
  assert.match(markdown, /Opus just lost/u);
  assert.match(markdown, /Transcript unavailable: stream reset/u);
});

test("failure: X 404 prints reason on stderr and exits 1", async () => {
  const { deps, out, err } = makeDeps({
    fetch: async () => {
      await Promise.resolve();

      return new Response(
        // eslint-disable-next-line unicorn/prefer-response-static-json -- intentional test pattern.
        JSON.stringify({
          code: 404,
          status: null,
          thread: null,
          message: "NOT_FOUND",
        }),
        { status: 404 }
      );
    },
  });

  const code = await main(["https://x.com/user/status/000"], deps);
  assert.equal(code, 1);
  assert.equal(out.join(""), "");
  assert.match(err.join(""), /cannot read X post 000: 404/u);
});

test("failure: missing or unsupported URL prints usage on stderr and exits 2", async () => {
  const missing = makeDeps();
  assert.equal(await main([], missing.deps), 2);
  assert.match(missing.err.join(""), /Usage:/u);

  const unsupported = makeDeps();
  assert.equal(
    await main(["https://example.com/article"], unsupported.deps),
    2
  );
  assert.match(unsupported.err.join(""), /Usage:/u);
});
