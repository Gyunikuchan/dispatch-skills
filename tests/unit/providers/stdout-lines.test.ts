import assert from "node:assert/strict";
import { test } from "node:test";

import { stdoutLines } from "../../../skills/dispatch/scripts/providers/node-process.ts";

test("stdout lines span chunks, normalize CRLF and flush final carry", () => {
  const lines: string[] = [];
  // eslint-disable-next-line typescript/strict-void-return -- mock callback intentionally returns void through a wrapper.
  const feed = stdoutLines((line) => lines.push(line));
  feed.write(Buffer.from("one\r"));
  feed.write(Buffer.from("\ntw"));
  feed.write(Buffer.from("o\nlast"));
  feed.end();
  assert.deepEqual(lines, ["one", "two", "last"]);
});

test("over-long partial lines are delivered within the carry bound", () => {
  const lines: string[] = [];
  // eslint-disable-next-line typescript/strict-void-return -- mock callback intentionally returns void through a wrapper.
  const feed = stdoutLines((line) => lines.push(line));
  feed.write(Buffer.from("x".repeat(65_537)));
  feed.end();
  assert.equal(lines.join(""), "x".repeat(65_537));
  assert.ok(lines.every((line) => Buffer.byteLength(line) <= 65_536));
});

test("every fragment of an over-long line is marked, including a parseable tail", () => {
  const lines: [string, boolean | undefined][] = [];
  // eslint-disable-next-line typescript/strict-void-return -- mock callback intentionally returns void through a wrapper.
  const feed = stdoutLines((line, fragment) => lines.push([line, fragment]));
  feed.write(
    Buffer.from(`${"x".repeat(65_536)}{"type":"step_finish"}\nnext\n`)
  );
  feed.end();
  assert.deepEqual(lines, [
    ["x".repeat(65_536), true],
    ['{"type":"step_finish"}', true],
    ["next", false],
  ]);
});
