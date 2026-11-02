// S7 read-only supply-chain guard for the disposable Composer PHAR.
// Does not execute PHP, the PHAR, Composer scripts, or any project mutations.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
const file = "/tmp/questboard-s7-composer-2.11.0.phar";
const expectedSha256 = "9674f12a2a181100d889ebfd0b4510805b3e94cea57869b14b383753d602599b";
if (!existsSync(file)) throw new Error("Pinned Composer 2.11.0 PHAR has not been downloaded");
const stat = statSync(file);
if (!stat.isFile() || stat.size < 300_000 || stat.size > 10_000_000) {
  throw new Error("Unexpected Composer PHAR file shape or size");
}
const digest = createHash("sha256");
for await (const chunk of createReadStream(file, { highWaterMark: 128 * 1024 })) {
  digest.update(chunk);
}
const matches = digest.digest("hex") === expectedSha256;
console.log(JSON.stringify({file, version:"2.11.0", officialSha256Verified:matches, bytes:stat.size}));
if (!matches) process.exitCode = 2;
