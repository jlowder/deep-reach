import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromiumAvailable } from "../src/pdf.js";

/**
 * Fresh-process regression: pdf-parse 1.1.4 vendors pdf.js 1.10.100 (2018),
 * whose first getDocument call in a fresh ESM process fails deterministically
 * ("bad XRef entry") on SMALL byte-valid PDFs. Measured on this machine:
 * the 11.5 KB / 1-page PDF produced from this fixture failed 6/6 fresh
 * processes pre-fix, while a 66 KB / 1-page PDF passed 6/6 — the window is
 * size-dependent, so the fixture is deliberately tiny (title "Tiny", one
 * word) to reproduce the failing class. Fix under test: pre-warm prime +
 * 5x retry in src/pdf.ts.
 *
 * Gated: skips cleanly when dist/cli.js is absent (fresh clone pre-build) or
 * when chromium is unavailable (for the render legs).
 */
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const DIST_CLI = join(ROOT, "dist", "cli.js");
const TINY_FIXTURE = join(here, "fixtures", "tiny.json");
const SMALL_PDF = join(here, "fixtures", "small.pdf");
const VALIDATE_CHILD = join(here, "helpers", "validate-child.mjs");

const hasDist = existsSync(DIST_CLI);
const hasChromium = chromiumAvailable();

const noDist = "dist/cli.js missing (run `npm run build` first)";
const noChromium = "chromium not installed (run: npx playwright install chromium)";

function runNode(
  script: string,
  args: string[],
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolveP, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: ROOT });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.stdin.on("error", () => {});
    child.stdin.end();
    child.on("error", reject);
    child.on("close", (code) =>
      resolveP({
        code: code ?? -1,
        out: Buffer.concat(out).toString("utf8"),
        err: Buffer.concat(err).toString("utf8"),
      }),
    );
  });
}

function runCli(
  args: string[],
  stdin?: string,
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolveP, reject) => {
    const child = spawn(process.execPath, [DIST_CLI, ...args], { cwd: ROOT });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.stdin.on("error", () => {}); // EPIPE is fine; we always end()
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
    child.on("error", reject);
    child.on("close", (code) =>
      resolveP({
        code: code ?? -1,
        out: Buffer.concat(out).toString("utf8"),
        err: Buffer.concat(err).toString("utf8"),
      }),
    );
  });
}

test(
  "fresh CLI process: 1-page doc passes validation (pdf-parse cold-start regression)",
  { skip: !hasDist ? noDist : !hasChromium ? noChromium : false },
  async () => {
    const outDir = mkdtempSync(join(tmpdir(), "paperbot-fresh-"));
    const out = join(outDir, "tiny.pdf");
    const res = await runCli(["convert", TINY_FIXTURE, "--out", out]);
    assert.equal(res.code, 0, `CLI should exit 0, got ${res.code}\nstdout: ${res.out}\nstderr: ${res.err}`);
    assert.ok(existsSync(out), "output PDF must exist");
    const buf = readFileSync(out);
    assert.ok(buf.subarray(0, 5).toString("latin1").startsWith("%PDF"), "valid header");
    // Title check via pdf-parse in THIS (test) process. Note the dedicated
    // copy: the raw Buffer is a buffer-pool view (non-zero byteOffset) which
    // the vendored pdf.js 1.10 mis-reads — the same root cause this suite
    // exists to guard against. `new Uint8Array(buf)` is the known-good form.
    const { default: pdf } = await import("pdf-parse");
    const parsed = await pdf(new Uint8Array(buf));
    assert.ok(parsed.text.includes("Tiny"), `title must be in extracted text, got: ${JSON.stringify(parsed.text.slice(0, 120))}`);
  },
);

test(
  "fresh CLI process: empty stdin pipe -> exit 1 'no data on stdin' (not 'invalid JSON')",
  { skip: !hasDist ? noDist : false },
  async () => {
    const outDir = mkdtempSync(join(tmpdir(), "paperbot-fresh-"));
    const res = await runCli(["-", "--out", join(outDir, "x.pdf")], "");
    assert.equal(res.code, 1, `expected exit 1, got ${res.code}\nstdout: ${res.out}\nstderr: ${res.err}`);
    assert.match(res.err, /no data on stdin/);
    assert.doesNotMatch(res.err, /invalid JSON/);
  },
);

test(
  "fresh child process: validatePdf() parses the 11 KB pool-class fixture (byteOffset regression)",
  { skip: !hasDist ? noDist : false },
  async () => {
    // No chromium needed: validatePdf only parses the committed fixture.
    //
    // Why this test exists: pdf.js 1.10.100 (vendored by pdf-parse 1.1.4)
    // mis-reads Buffers with a non-zero byteOffset (Node buffer-pool views;
    // files under ~64 KB). Pre-fix, a fresh process that imported the built
    // pdf.js and validated this 11.4 KB fixture failed 10/10 with
    // "bad XRef entry"; with the dedicated-copy fix it passes deterministically.
    // The CLI path is masked by playwright's allocation history, so this
    // minimal child is the only reliable reproduction.
    for (let i = 0; i < 3; i++) {
      const res = await runNode(VALIDATE_CHILD, [SMALL_PDF, "Tiny"]);
      assert.equal(res.code, 0, `run ${i + 1}: expected ok, got code ${res.code}\nstdout: ${res.out}\nstderr: ${res.err}`);
      const parsed = JSON.parse(res.out);
      assert.equal(parsed.ok, true, `run ${i + 1}: ${JSON.stringify(parsed)}`);
      assert.equal(parsed.pages, 1);
    }
  },
);

test(
  "fresh CLI process: markdown on stdin -> exit 0",
  { skip: !hasDist ? noDist : !hasChromium ? noChromium : false },
  async () => {
    const outDir = mkdtempSync(join(tmpdir(), "paperbot-fresh-"));
    const out = join(outDir, "stdin.pdf");
    const res = await runCli(["-", "--out", out], "# Piped Title\n\nPiped body text.\n");
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout: ${res.out}\nstderr: ${res.err}`);
    assert.ok(existsSync(out), "output PDF must exist");
  },
);
