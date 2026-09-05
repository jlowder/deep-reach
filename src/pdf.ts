/**
 * PDF rendering (Playwright Chromium) + post-generation validation.
 *
 * Validation stage (required by pdfgen.md): the output file must exist, be
 * larger than 10 KB, start with %PDF, parse with pdf-parse into >= 1 page,
 * and contain the document title in its extracted text.
 */
import { readFileSync, statSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import pdf from "pdf-parse";
import type { PdfResult } from "pdf-parse";
import { EXIT_RENDER } from "./pipeline.js";

export const PAGE_FORMATS = ["letter", "a4", "legal", "a5", "tabloid"] as const;
export type PageFormat = (typeof PAGE_FORMATS)[number];

export interface PdfOptions {
  outputPath: string;
  format: PageFormat;
  /** Document title; required for the text-containment check. */
  expectedTitle: string;
  /** Skip the pdf-parse text check (CLI --no-validate). Page count is still checked. */
  skipTextCheck?: boolean;
}

export interface PdfOutput {
  ok: boolean;
  error?: string;
  pages?: number;
  sizeBytes?: number;
}

export class PaperbotError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
  ) {
    super(message);
    this.name = "PaperbotError";
  }
}

export const CHROMIUM_MISSING_MESSAGE =
  "Chromium is not installed. Run: npx playwright install chromium";

/**
 * Launch a reusable browser instance. Throws PaperbotError(exit 3) with a
 * clean, actionable message when the chromium build is not present.
 */
export async function launchChromium(): Promise<Browser> {
  let executable: string | undefined;
  try {
    executable = chromium.executablePath();
  } catch {
    /* fall through to launch attempt */
  }
  if (executable !== undefined) {
    try {
      statSync(executable);
    } catch {
      throw new PaperbotError(CHROMIUM_MISSING_MESSAGE, 3);
    }
  }
  try {
    return await chromium.launch();
  } catch {
    throw new PaperbotError(CHROMIUM_MISSING_MESSAGE, 3);
  }
}

/**
 * Probe for an installed chromium without launching. Used to skip e2e
 * tests cleanly when the browser is unavailable.
 */
export function chromiumAvailable(): boolean {
  try {
    const exe = chromium.executablePath();
    statSync(exe);
    return true;
  } catch {
    return false;
  }
}

/** Shared Chromium page.pdf layout options (file and buffer paths alike). */
function pdfPageOptions(format: PageFormat): NonNullable<Parameters<Page["pdf"]>[0]> {
  return {
    format,
    printBackground: true,
    displayHeaderFooter: true,
    preferCSSPageSize: false,
    margin: {
      top: "0.75in",
      right: "0.7in",
      bottom: "0.95in",
      left: "0.7in",
    },
    headerTemplate: "<span></span>",
    footerTemplate:
      '<div style="font-size:8px;color:#999;width:100%;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
  };
}

/**
 * Render `html` in a fresh page and return the PDF bytes. With
 * `outputPath`, writes via Playwright's `path` option and reads the file
 * back (identical to the previous file-writing behavior); without it,
 * Playwright returns the bytes directly (no file touched).
 */
async function renderPdfCore(
  browser: Browser,
  html: string,
  format: PageFormat,
  outputPath?: string,
): Promise<Buffer> {
  const page: Page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    if (outputPath !== undefined) {
      await page.pdf({ ...pdfPageOptions(format), path: outputPath });
      return readFileSync(outputPath);
    }
    return await page.pdf({ ...pdfPageOptions(format) });
  } finally {
    await page.close().catch(() => {});
  }
}

async function renderPdfWithBrowser(browser: Browser, html: string, opts: PdfOptions): Promise<void> {
  await renderPdfCore(browser, html, opts.format, opts.outputPath);
}

const normalizeWs = (s: string) => s.replace(/\s+/g, " ").trim();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * How we parse the generated PDF, and the defenses in play.
 *
 * pdf-parse 1.1.4 vendors pdf.js 1.10.100 (2018). Two interacting 2018-era
 * details combine into a deterministic failure for the input representation
 * this codebase originally passed (a Buffer straight from readFileSync):
 *
 *   1. In Node the worker is a LoopbackPort whose postMessage CLONES every
 *      payload via `new value.constructor(value.buffer, value.byteOffset,
 *      value.byteLength)` or `new value.constructor(value)`. For a Buffer
 *      input, `new Buffer(...)` allocates from Node's 64 KB buffer pool
 *      (files smaller than one pool slab), so the CLONE lands at a
 *      non-zero byteOffset inside a 65536-byte slab.
 *
 *   2. `Stream.makeSubStream` re-derives streams from
 *      `new Stream(this.bytes.buffer, ...)` — the WHOLE underlying
 *      ArrayBuffer — while start/pos stay view-relative. With a pooled
 *      backing, every byte is then read shifted by the clone's
 *      byteOffset: xref object numbers come back as whitespace/garbage
 *      ("bad XRef entry", "Command token too long", "Invalid number").
 *
 *   A plain (non-Buffer) Uint8Array input escapes both: the clone is
 *   `new Uint8Array(value)`, which by spec allocates a FRESH dedicated
 *   ArrayBuffer, so the clone's `.buffer` is exactly the document and
 *   sub-streams stay aligned — regardless of pool state, process history,
 *   or CJS/ESM entry. Proven differentially (same file, same process):
 *   pooled Buffer clone off=12400/65536 -> fails 3/3; dedicated plain
 *   Uint8Array -> parses 3/3. Files > 64 KB always worked because Buffer
 *   allocation falls back to dedicated slabs (byteOffset 0).
 *
 * Defense layers (in order):
 *   1. **Representation fix** — `toPdfParseInput()` hands the parser a
 *      dedicated, offset-0 plain Uint8Array. This is the root-cause fix.
 *   2. **Pre-warm prime** — one throwaway getDocument on a minimal
 *      in-memory PDF before the real parse (kept per review; its buffer is
 *      dedicated too). Insurance against first-call quirks of the 2018
 *      fake-worker on other platforms; result/errors swallowed.
 *   3. **Retry with re-read** — if a parse still throws, re-read the file
 *      and retry up to PDF_PARSE_MAX_ATTEMPTS times with a short backoff.
 */
const PDF_PARSE_MAX_ATTEMPTS = 5;
const PDF_PARSE_BACKOFF_MS = 50;

/**
 * Normalize parser input to a form the vendored pdf.js 1.10 can parse
 * deterministically: a plain Uint8Array backed by a dedicated, offset-0
 * ArrayBuffer (see the module comment). Zero-copy fast path when the input
 * already is one (including the prime); one file-sized copy otherwise.
 * Exported for unit tests of the representation contract.
 */
export function toPdfParseInput(data: Buffer | Uint8Array): Uint8Array {
  if (
    data instanceof Uint8Array &&
    !(data instanceof Buffer) &&
    data.byteOffset === 0 &&
    data.buffer.byteLength === data.byteLength
  ) {
    return data;
  }
  return new Uint8Array(data);
}

/**
 * A minimal valid 1-page PDF, hand-assembled (correct xref offsets, pure
 * ASCII) as a DEDICATED Uint8Array (byteOffset 0 — see the bug note above).
 * Used only as the pre-warm prime target; its contents are irrelevant —
 * the act of calling getDocument on it is what matters.
 */
function buildPrimePdf(): Uint8Array {
  const objects = [
    "<</Type /Catalog /Pages 2 0 R>>",
    "<</Type /Pages /Kids [3 0 R] /Count 1>>",
    "<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]>>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefPos = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<</Size ${objects.length + 1} /Root 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF\n`;
  // Dedicated copy: new Uint8Array(buffer) allocates a fresh ArrayBuffer at
  // offset 0, escaping the buffer-pool byteOffset bug in the vendored pdf.js.
  return new Uint8Array(Buffer.from(out, "latin1"));
}

const PRIME_PDF = buildPrimePdf();
let primeDone = false;

/**
 * The real parse: pre-warm prime (once per process) + representation-safe
 * input. The prime's result/errors are swallowed: even a failed prime
 * consumes a first-call window.
 */
async function realPdfParse(buf: Buffer): Promise<PdfResult> {
  if (!primeDone) {
    primeDone = true;
    try {
      await pdf(PRIME_PDF);
    } catch {
      /* swallowed on purpose */
    }
  }
  return pdf(toPdfParseInput(buf));
}

/**
 * Parser dependency for validatePdf. Tests inject a deterministic fake to
 * exercise the retry loop (exact attempt counts) without real pdf.js —
 * which is exactly what a fresh-process window would corrupt.
 */
export type PdfParseFn = (
  buf: Buffer,
) => Promise<PdfResult>;

export interface PdfValidateDeps {
  /** Override the parser (default: prime + vendored pdf-parse). */
  parse?: PdfParseFn;
}

export interface PdfValidationOk {
  ok: true;
  pages: number;
  /** How many parse attempts the validation used (1 on first-try success). */
  attempts: number;
}

export interface PdfValidationFail {
  ok: false;
  error: string;
  /** Parse attempts made before giving up (0 = failed a pre-parse check). */
  attempts: number;
}

/**
 * Validate raw PDF bytes (the content-based half of validatePdf).
 *
 * Same defenses as the file path: >10 KB, %PDF header, up to
 * PDF_PARSE_MAX_ATTEMPTS parses with backoff, >= 1 page, and title
 * containment in the extracted text unless skipTextCheck. The header check
 * stays inside the attempt loop (mirroring the file path's per-re-read
 * check) so a bad header reports attempts=1, exactly like before.
 */
export async function validatePdfBuffer(
  buffer: Buffer,
  opts: { expectedTitle: string; skipTextCheck?: boolean },
  deps: PdfValidateDeps = {},
): Promise<PdfValidationOk | PdfValidationFail> {
  const parse = deps.parse ?? realPdfParse;

  if (buffer.length < 10 * 1024) {
    return { ok: false, attempts: 0, error: `output suspiciously small (${buffer.length} bytes, expected > 10KB)` };
  }

  let parsed: PdfResult | undefined;
  let lastError: unknown;
  let attempts = 0;
  for (let attempt = 1; attempt <= PDF_PARSE_MAX_ATTEMPTS; attempt++) {
    attempts = attempt;
    const header = buffer.subarray(0, 5).toString("latin1");
    if (!header.startsWith("%PDF")) {
      return { ok: false, attempts, error: `output does not start with %PDF (got "${header}")` };
    }

    try {
      parsed = await parse(buffer);
      lastError = undefined;
      break;
    } catch (err) {
      lastError = err;
      if (attempt < PDF_PARSE_MAX_ATTEMPTS) {
        await sleep(PDF_PARSE_BACKOFF_MS);
      }
    }
  }
  if (lastError !== undefined || parsed === undefined) {
    const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown parse failure");
    return {
      ok: false,
      attempts,
      error: `pdf-parse failed on output after ${PDF_PARSE_MAX_ATTEMPTS} attempts: ${detail}`,
    };
  }

  if (parsed.numpages < 1) {
    return { ok: false, attempts, error: `pdf has ${parsed.numpages} pages (expected at least 1)` };
  }

  if (!opts.skipTextCheck) {
    const expected = normalizeWs(opts.expectedTitle);
    if (expected !== "" && !normalizeWs(parsed.text).includes(expected)) {
      return {
        ok: false,
        attempts,
        error: `title "${opts.expectedTitle}" not found in extracted PDF text`,
      };
    }
  }

  return { ok: true, pages: parsed.numpages, attempts };
}

/** Validate a generated PDF file. Returns the result; `ok: false` carries the error. */
export async function validatePdf(
  opts: PdfOptions,
  deps: PdfValidateDeps = {},
): Promise<PdfValidationOk | PdfValidationFail> {
  let size: number;
  try {
    const st = statSync(opts.outputPath);
    if (!st.isFile()) return { ok: false, attempts: 0, error: `output path is not a regular file: ${opts.outputPath}` };
    size = st.size;
  } catch {
    return { ok: false, attempts: 0, error: `output file missing: ${opts.outputPath}` };
  }

  if (size < 10 * 1024) {
    return { ok: false, attempts: 0, error: `output file suspiciously small (${size} bytes, expected > 10KB)` };
  }

  let buffer: Buffer;
  try {
    buffer = readFileSync(opts.outputPath);
  } catch (err) {
    return { ok: false, attempts: 0, error: `could not read output file: ${err instanceof Error ? err.message : String(err)}` };
  }

  return validatePdfBuffer(buffer, opts, deps);
}

/**
 * Render HTML to PDF in a fresh browser (opened and closed around the call)
 * and validate the result.
 */
export async function htmlToPdf(html: string, opts: PdfOptions): Promise<PdfOutput> {
  const browser = await launchChromium();
  try {
    await renderPdfWithBrowser(browser, html, opts);
  } finally {
    await browser.close().catch(() => {});
  }

  const validation = await validatePdf(opts);
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }
  const sizeBytes = statSync(opts.outputPath).size;
  return { ok: true, pages: validation.pages, sizeBytes };
}

export interface PdfBufferOptions {
  format: PageFormat;
  expectedTitle: string;
  skipTextCheck?: boolean;
}

/**
 * Render HTML to PDF bytes (NO file written) and validate them.
 *
 * Pass a caller-owned `browser` to amortize launch cost across many
 * conversions (e.g. an API server); when omitted, a browser is launched
 * and closed around the call. Throws PaperbotError(EXIT_RENDER) when the
 * bytes fail validation — callers wanting a result object should use
 * htmlToPdf (file-based) instead.
 */
export async function htmlToPdfBuffer(
  html: string,
  opts: PdfBufferOptions,
  browser?: Browser,
): Promise<Buffer> {
  const own = browser === undefined;
  const b = browser ?? (await launchChromium());
  try {
    const buffer = await renderPdfCore(b, html, opts.format);
    const validation = await validatePdfBuffer(buffer, opts);
    if (!validation.ok) {
      throw new PaperbotError(validation.error, EXIT_RENDER);
    }
    return buffer;
  } finally {
    if (own) await b.close().catch(() => {});
  }
}
