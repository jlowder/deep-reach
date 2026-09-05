import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import pdf from "pdf-parse";
import { chromiumAvailable } from "../src/pdf.js";
import { run, type PipelineOptions } from "../src/pipeline.js";
import { DJ_EXAMPLE, GP_EXAMPLE, FIXTURES_DIR, ROOT } from "./util.js";

const hasChromium = chromiumAvailable();
const skipReason = hasChromium ? false : "chromium not installed (run: npx playwright install chromium)";

async function extractText(file: string): Promise<string> {
  // Dedicated copy: pdf.js 1.10.100 (vendored by pdf-parse) mis-reads
  // buffer-pool views with a non-zero byteOffset (files under ~64 KB).
  // Current fixtures are all > 64 KB (dedicated buffers, safe), but the copy
  // keeps this correct if that ever changes.
  return (await pdf(new Uint8Array(readFileSync(file)))).text;
}

test("unicode fixture full pipeline", { skip: skipReason }, async () => {
  const input = join(FIXTURES_DIR, "unicode.json");
  const out = join(ROOT, "out", "e2e-unicode.pdf");
  const opts: PipelineOptions = { outPath: out };

  const result = await run(input, opts);

  assert.ok(result.ok, `pipeline should succeed: ${result.error}`);
  assert.equal(result.exitCode, 0);
  assert.ok(existsSync(out), "output file must exist");
  assert.ok(statSync(out).size > 10 * 1024);
  assert.ok(readFileSync(out).subarray(0, 5).toString("latin1").startsWith("%PDF"));
  assert.ok((result.pages ?? 0) >= 1);

  const text = (await extractText(out)).replace(/\s+/g, " ");
  assert.ok(text.includes("Unicode & Injection Fixtures"), "title in extracted text");
  assert.ok(text.includes("東京"), "CJK in extracted text");
  assert.ok(text.includes("“Quoted text”"), "curly quotes in extracted text");
  assert.ok(!text.includes("東京TOOL"), "sanity: no injected code ran");
  // The escaped markup renders back as the literal visible text.
  assert.ok(text.includes("<script>alert(1)</script>"), "escaped tag renders as visible text");
});

test("real examples: full pipeline on both JSON files", {
  // skipReason is the chromium check (false when installed); add the
  // fixture-absence check so the public-release state skips, not fails.
  skip:
    skipReason ||
    (!existsSync(DJ_EXAMPLE) || !existsSync(GP_EXAMPLE)
      ? "example fixtures absent (examples/ removed for public release)"
      : false),
}, async () => {
  const cases: Array<[string, string, string]> = [
    [DJ_EXAMPLE, join(ROOT, "out", "e2e-dj.pdf"), "Development Plan for DJ-Aware Lyrics Sync Player"],
    [GP_EXAMPLE, join(ROOT, "out", "e2e-genetic-programming.pdf"), "Comprehensive Report on Genetic Programming"],
  ];

  for (const [input, out, title] of cases) {
    const result = await run(input, { outPath: out });
    assert.ok(result.ok, `${input} should succeed: ${result.error}`);
    assert.ok(existsSync(out));
    const text = (await extractText(out)).replace(/\s+/g, " ");
    assert.ok(text.includes(title), `title missing from ${out}`);
    console.log(
      `  e2e ${input.split("/").pop()!.slice(0, 28)}… -> ${out} ` +
        `(${result.pages} pages, ${result.sizeBytes} bytes, ${result.warnings.length} warnings)`,
    );
  }
});
