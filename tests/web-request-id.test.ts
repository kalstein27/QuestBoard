import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("Web request IDs work when crypto.randomUUID is unavailable", async () => {
  const source = await readFile(resolve("web/app.js"), "utf8");
  const start = source.indexOf("function createWebRequestId()");
  const end = source.indexOf("\nfunction showBoardLoading", start);

  assert.notEqual(start, -1, "createWebRequestId helper should exist");
  assert.notEqual(end, -1, "createWebRequestId helper should remain independently testable");

  const helperSource = source.slice(start, end);
  const loadHelper = new Function("globalThis", `${helperSource}; return createWebRequestId;`) as (
    globalObject: unknown,
  ) => () => string;

  const createWithGetRandomValues = loadHelper({
    crypto: {
      getRandomValues(bytes: Uint8Array) {
        bytes.fill(0xab);
        return bytes;
      },
    },
  });

  assert.equal(createWithGetRandomValues(), `web:${"ab".repeat(16)}`);

  const createWithoutCrypto = loadHelper({});
  assert.match(createWithoutCrypto(), /^web:[0-9a-z]+:[0-9a-z]+$/);
});
