import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pdf from "pdf-parse";
import {
  checkTitleInText,
  chromiumAvailable,
  normalizeForTextCheck,
  validatePdfBuffer,
  type PdfParseFn,
  type PdfResult,
} from "../src/pdf.js";
import { run } from "../src/pipeline.js";

// The exact shape captured from the 06bfd false-500: the 63-char title
// wraps at 22pt / 511pt content width, chromium breaks after the hyphen in
// "Real-", and pdf.js joins the lines with "\n".
const REAL_TITLE =
  "Assessing AI Capabilities in Open-Ended Real-World Contexts";
const REAL_EXTRACTED =
  "Assessing AI Capabilities in Open-Ended Real-\n" +
  "World Contexts\n" +
  "Research Assistant • September 8, 2026\n" +
  "Deep Research\n" +
  "The tyranny of tasks critiques the practice of assessing AI through isolated benchmarks.";

// ---------------------------------------------------------------------------
// (a) normalizeForTextCheck units
// ---------------------------------------------------------------------------

test("normalizeForTextCheck re-joins the captured hyphen line-break", () => {
  const wrapped =
    "Assessing AI Capabilities in Open-Ended Real-\n" + "World Contexts";
  assert.equal(normalizeForTextCheck(wrapped), REAL_TITLE);
  assert.equal(
    normalizeForTextCheck(REAL_EXTRACTED),
    REAL_TITLE +
      " Research Assistant • September 8, 2026 Deep Research " +
      "The tyranny of tasks critiques the practice of assessing AI through isolated benchmarks.",
  );
});

test("normalizeForTextCheck leaves unbroken hyphenated words intact", () => {
  assert.equal(normalizeForTextCheck("Open-Ended Real-World"), "Open-Ended Real-World");
});

test("normalizeForTextCheck is NFC-insensitive (composed vs decomposed)", () => {
  // "Café" composed (U+00E9) vs decomposed (e + U+0301 combining acute).
  assert.equal(
    normalizeForTextCheck("Caf\u00e9 Real-\nWorld"),
    normalizeForTextCheck("Caf\u0065\u0301 Real- World"),
  );
});

test("normalizeForTextCheck strips soft hyphens", () => {
  assert.equal(normalizeForTextCheck("A\u00adB C-\nD"), "AB C-D");
});

test("normalizeForTextCheck is idempotent", () => {
  const x = "X-\nY  Z-\u00adW \n Q";
  assert.equal(normalizeForTextCheck(normalizeForTextCheck(x)), normalizeForTextCheck(x));
});

// ---------------------------------------------------------------------------
// (b) the title check itself (injected extracted text, no chromium)
// ---------------------------------------------------------------------------

test("checkTitleInText: strict pass on the real wrapped shape", () => {
  const r = checkTitleInText(REAL_TITLE, REAL_EXTRACTED);
  assert.equal(r.ok, true);
  assert.equal(r.loose, false);
});

test("checkTitleInText: loose fallback passes and is flagged", () => {
  // Strict fails ("Real - World" ≠ "Real-World"); the squashed loose
  // comparison ("realworld" in "realworldcontexts") succeeds.
  const r = checkTitleInText("Real-World", "Real - World Contexts");
  assert.equal(r.ok, true);
  assert.equal(r.loose, true);
});

test("checkTitleInText: genuinely absent title fails with a diagnostic", () => {
  const r = checkTitleInText("ZZZ Absolutely Not Present ZZZ", REAL_EXTRACTED);
  assert.equal(r.ok, false);
  assert.equal(r.loose, false);
  assert.ok(r.diagnostic !== undefined, "diagnostic populated");
  assert.ok(
    r.diagnostic.startsWith(` (extracted begins: "${REAL_TITLE.slice(0, 30)}`),
    `diagnostic quotes the extracted start, got: ${r.diagnostic}`,
  );
});

test("checkTitleInText: whitespace-only expected title is a no-op pass (old behavior)", () => {
  assert.deepEqual(checkTitleInText("   \n ", "whatever"), { ok: true, loose: false });
});

// ---------------------------------------------------------------------------
// (b) validatePdfBuffer level: fake parser injects the extracted text
// ---------------------------------------------------------------------------

function bigBuffer(): Buffer {
  // >10 KB, %PDF header — everything the content checks need pre-parse.
  return Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(20_000, 0x78)]);
}

const parseText = (text: string): PdfParseFn =>
  async () => ({ numpages: 1, text } as unknown as PdfResult);

test("validatePdfBuffer: real title + real wrapped shape -> ok, no warning", async () => {
  const warnings: string[] = [];
  const res = await validatePdfBuffer(bigBuffer(), { expectedTitle: REAL_TITLE }, {
    parse: parseText(REAL_EXTRACTED),
    onWarning: (w) => warnings.push(w),
  });
  assert.deepEqual(res, { ok: true, pages: 1, attempts: 1 });
  assert.deepEqual(warnings, []);
});

test("validatePdfBuffer: loose-mode match -> ok with a surfaced warning", async () => {
  const warnings: string[] = [];
  const res = await validatePdfBuffer(bigBuffer(), { expectedTitle: "Real-World" }, {
    parse: parseText("Real - World Contexts and more prose"),
    onWarning: (w) => warnings.push(w),
  });
  assert.equal(res.ok, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /loose mode/);
});

test("validatePdfBuffer: absent title -> error carries the extracted-begins diagnostic", async () => {
  const res = await validatePdfBuffer(bigBuffer(), { expectedTitle: "ZZZ Absolutely Not Present ZZZ" }, {
    parse: parseText(REAL_EXTRACTED),
  });
  assert.equal(res.ok, false);
  if (res.ok) throw new Error("expected failure");
  assert.match(
    res.error,
    /^title "ZZZ Absolutely Not Present ZZZ" not found in extracted PDF text \(extracted begins: "/,
  );
  assert.ok(res.error.includes("Assessing AI Capabilities"), "diagnostic quotes the real text");
});

// ---------------------------------------------------------------------------
// (c) chromium-guarded e2e: a long hyphenated title that wraps past the
// content width (the server 200-equivalent is proven live in integration)
// ---------------------------------------------------------------------------

const hasChromium = chromiumAvailable();
const skipReason = hasChromium
  ? false
  : "chromium not installed (run: npx playwright install chromium)";

test("e2e: long hyphenated title wraps without failing validation", { skip: skipReason }, async () => {
  const title =
    "Assessing AI Capabilities in Open-Ended Real-World Contexts and Beyond";
  const dir = mkdtempSync(join(tmpdir(), "paperbot-title-"));
  const input = join(dir, "long-title.json");
  const prose =
    "The tyranny of tasks critiques the practice of assessing AI through isolated, narrow benchmarks. ";
  writeFileSync(
    input,
    JSON.stringify({
      report: {
        metadata: { title },
        sections: [
          {
            heading: "Scope",
            blocks: [{ type: "paragraph", spans: [{ text: prose.repeat(30) }] }],
          },
          {
            heading: "Method",
            blocks: [{ type: "paragraph", spans: [{ text: prose.repeat(30) }] }],
          },
        ],
        sources: [],
      },
    }),
  );
  const out = join(dir, "long-title.pdf");
  const result = await run(input, { outPath: out });
  assert.ok(result.ok, `pipeline should succeed: ${result.error}`);
  assert.equal(result.exitCode, 0);
  const text = (await pdf(new Uint8Array(readFileSync(out)))).text;
  assert.ok(
    normalizeForTextCheck(text).includes(title),
    "normalized extracted text contains the title",
  );
});
