import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePdf, toPdfParseInput, type PdfParseFn, type PdfResult } from "../src/pdf.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Retry-loop unit tests. Fully ungated (no chromium, no real pdf.js): the
 * parser is dependency-injected, so these exercise the exact attempt count,
 * backoff, and error shaping of the retry in src/pdf.ts — including the
 * behavior a fresh-process "bad XRef entry" window would trigger.
 */

function fakeResult(numpages: number, text: string): PdfResult {
  return { numpages, numrender: numpages, info: {}, metadata: null, text, version: "" };
}

function makeFile(dir: string, sizeBytes = 12_000, header = "%PDF-1.4\n"): string {
  const p = join(dir, "x.pdf");
  const body = Buffer.alloc(Math.max(0, sizeBytes - header.length), 0x41);
  writeFileSync(p, Buffer.concat([Buffer.from(header, "latin1"), body]));
  return p;
}

function optsFor(outputPath: string) {
  return { outputPath, format: "letter" as const, expectedTitle: "Tiny" };
}

test("parser failing on every attempt -> 5 attempts, exit-3-shaped message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "paperbot-validate-"));
  const file = makeFile(dir);
  let calls = 0;
  const parse: PdfParseFn = async () => {
    calls++;
    throw new Error("Invalid PDF structure");
  };
  const res = await validatePdf(optsFor(file), { parse });
  assert.equal(calls, 5, "must try exactly PDF_PARSE_MAX_ATTEMPTS times");
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.attempts, 5);
    assert.equal(res.error, "pdf-parse failed on output after 5 attempts: Invalid PDF structure");
  }
});

test("parser failing first 2 attempts -> recovery on attempt 3", async () => {
  const dir = mkdtempSync(join(tmpdir(), "paperbot-validate-"));
  const file = makeFile(dir);
  let calls = 0;
  const parse: PdfParseFn = async () => {
    calls++;
    if (calls <= 2) throw new Error("bad XRef entry");
    return fakeResult(1, "Tiny");
  };
  const res = await validatePdf(optsFor(file), { parse });
  assert.equal(calls, 3);
  assert.ok(res.ok, `expected recovery, got: ${res.ok ? "" : res.error}`);
  if (res.ok) {
    assert.equal(res.attempts, 3);
    assert.equal(res.pages, 1);
  }
});

test("parser failing first 4 attempts -> recovery on the 5th (boundary)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "paperbot-validate-"));
  const file = makeFile(dir);
  let calls = 0;
  const parse: PdfParseFn = async () => {
    calls++;
    if (calls <= 4) throw new Error("bad XRef entry");
    return fakeResult(1, "Tiny");
  };
  const res = await validatePdf(optsFor(file), { parse });
  assert.equal(calls, 5);
  assert.ok(res.ok, `expected recovery, got: ${res.ok ? "" : res.error}`);
  if (res.ok) assert.equal(res.attempts, 5);
});

test("healthy parser -> exactly 1 attempt (no unnecessary retries)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "paperbot-validate-"));
  const file = makeFile(dir);
  let calls = 0;
  const parse: PdfParseFn = async () => {
    calls++;
    return fakeResult(2, "Tiny document");
  };
  const res = await validatePdf(optsFor(file), { parse });
  assert.equal(calls, 1);
  assert.ok(res.ok);
  if (res.ok) {
    assert.equal(res.attempts, 1);
    assert.equal(res.pages, 2);
  }
});

test("pre-parse failures report 0 attempts with their own messages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "paperbot-validate-"));
  const never: PdfParseFn = async () => {
    throw new Error("parser must not be called before pre-parse checks");
  };

  const missing = await validatePdf(optsFor(join(dir, "nope.pdf")), { parse: never });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.attempts, 0);
    assert.match(missing.error, /output file missing/);
  }

  const small = join(dir, "small.pdf");
  writeFileSync(small, Buffer.from("%PDF-1.4\nshort"));
  const smallRes = await validatePdf(optsFor(small), { parse: never });
  assert.equal(smallRes.ok, false);
  if (!smallRes.ok) {
    assert.equal(smallRes.attempts, 0);
    assert.match(smallRes.error, /suspiciously small/);
  }

  const badHeader = join(dir, "badhdr.pdf");
  writeFileSync(badHeader, Buffer.alloc(12_000, 0x58));
  const badRes = await validatePdf(optsFor(badHeader), { parse: never });
  assert.equal(badRes.ok, false);
  if (!badRes.ok) {
    // The header check runs inside the attempt loop (it re-validates on every
    // re-read), so it reports 1 attempt. The parse fn must still never have
    // been called: if it had, the error would be the after-N-attempts shape.
    assert.equal(badRes.attempts, 1);
    assert.match(badRes.error, /does not start with %PDF/);
  }
});

test("title text check runs on the (last) successful parse", async () => {
  const dir = mkdtempSync(join(tmpdir(), "paperbot-validate-"));
  const file = makeFile(dir);
  const parse: PdfParseFn = async () => fakeResult(1, "some other text");
  const res = await validatePdf(optsFor(file), { parse });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.attempts, 1);
    assert.match(res.error, /not found in extracted PDF text/);
  }
});

// ---------------------------------------------------------------------------
// Representation contract for the vendored pdf.js 1.10 (see the module
// comment in src/pdf.ts). These use the REAL parser but no chromium.
// ---------------------------------------------------------------------------

test("toPdfParseInput: Buffers and pooled views become dedicated offset-0 plain Uint8Arrays", () => {
  const file = readFileSync(join(here, "fixtures", "small.pdf"));

  // Buffer (readFileSync output): pooled, non-zero offset in a fresh process.
  const fromBuffer = toPdfParseInput(file);
  assert.ok(!(fromBuffer instanceof Buffer), "must be a plain Uint8Array, not a Buffer");
  assert.equal(fromBuffer.byteOffset, 0);
  assert.equal(fromBuffer.buffer.byteLength, fromBuffer.byteLength, "backing must be dedicated, not a pool slab");
  assert.deepEqual(Array.from(fromBuffer), Array.from(file), "content preserved");

  // A pooled VIEW (non-zero offset) of a larger ArrayBuffer.
  const slab = new Uint8Array(8192);
  slab.set(file.subarray(0, 2048), 300);
  const view = slab.subarray(300, 300 + 2048);
  const fromView = toPdfParseInput(view);
  assert.equal(fromView.byteOffset, 0);
  assert.equal(fromView.buffer.byteLength, fromView.byteLength);
  assert.deepEqual(Array.from(fromView), Array.from(view));

  // Zero-copy fast path: already a dedicated plain Uint8Array.
  const dedicated = new Uint8Array(16).fill(7);
  assert.equal(toPdfParseInput(dedicated), dedicated, "no copy for already-safe input");
});

test("real parser: normalized input parses a pool-class PDF under a poisoned pool (regression)", async () => {
  // Deterministically poison Node's buffer pool: occupy offset 0 so that the
  // worker-side clone of a Buffer payload (`new Buffer(value)`) lands at a
  // non-zero byteOffset inside a 64 KB slab — the exact condition under
  // which pdf.js 1.10's makeSubStream shift breaks parsing. Without the
  // toPdfParseInput normalization in validatePdf/realPdfParse, this 11.4 KB
  // file failed 3/3 with shifted-stream errors ("bad XRef entry" / "Invalid
  // number" / "Command token too long"); with it, the parser receives a
  // dedicated buffer and must succeed.
  const { default: pdf } = await import("pdf-parse");
  void Buffer.alloc(100); // the poison: shifts every subsequent pooled alloc
  const file = readFileSync(join(here, "fixtures", "small.pdf"));

  // Document the trap (upstream property; logged, not asserted, so an
  // upstream fix in a future pdf.js doesn't break the suite).
  try {
    await pdf(file);
    console.log("  [info] raw Buffer input parsed (upstream trap not triggered in this process layout)");
  } catch (err) {
    console.log(`  [info] raw Buffer input failed as documented: ${err instanceof Error ? err.message : String(err)}`);
  }

  const parsed = await pdf(toPdfParseInput(file));
  assert.equal(parsed.numpages, 1);
  assert.ok(parsed.text.includes("Tiny"), "title present in normalized-input parse");
});
