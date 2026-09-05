import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { runCli, tempFile, DJ_EXAMPLE, FIXTURES_DIR } from "./util.js";
import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { chromiumAvailable } from "../src/pdf.js";

function rm(p: string) {
  rmSync(p, { force: true });
}

test("nonexistent input file -> exit 1 with actionable message", async () => {
  const res = await runCli([join(FIXTURES_DIR, "does-not-exist.json")]);
  assert.equal(res.code, 1);
  assert.match(res.err, /input file not found/);
  assert.match(res.err, /✗/);
  assert.equal(res.out, "");
  assert.ok(!/Trace|at .+\(.*\)/.test(res.err), "no stack traces on input errors");
});

test("malformed JSON -> exit 1 with line/column, no stack", async () => {
  const bad = tempFile("bad.json", '{\n  "report": { "metadata": }\n}\n');
  const res = await runCli([bad]);
  assert.equal(res.code, 1);
  assert.match(res.err, /invalid JSON/);
  assert.match(res.err, /line \d+, column \d+/);
  assert.ok(!/at .*\(.*\)\s*\n/.test(res.err), "no stack trace");
});

test("JSON missing metadata.title -> exit 1 naming the JSON path", async () => {
  const noTitle = tempFile(
    "no-title.json",
    JSON.stringify({
      schema_version: "1.0",
      report: {
        metadata: { author: "x" }, // no title
        sections: [{ heading: "S", blocks: [] }],
      },
    }),
  );
  const res = await runCli([noTitle]);
  assert.equal(res.code, 1);
  assert.match(res.err, /validation failed/);
  assert.match(res.err, /report\.metadata\.title/);
});

test("JSON with sections missing -> exit 1 naming the path", async () => {
  const noSections = tempFile(
    "no-sections.json",
    JSON.stringify({
      schema_version: "1.0",
      report: { metadata: { title: "T" } }, // no sections
    }),
  );
  const res = await runCli([noSections]);
  assert.equal(res.code, 1);
  assert.match(res.err, /report\.sections/);
});

test("invalid --format -> exit 2 usage error", async () => {
  const res = await runCli([DJ_EXAMPLE, "--format", "ledger"]);
  assert.equal(res.code, 2);
  assert.match(res.err, /invalid --format "ledger"/);
  assert.match(res.err, /letter or a4 or legal or a5 or tabloid/);
  assert.match(res.err, /--help/);
});

test("all five page formats are accepted", async () => {
  // Each must pass argument validation (exit 2 would mean the parser rejected it);
  // without chromium the pipeline then fails at render (3) or succeeds (0).
  const small = join(FIXTURES_DIR, "sample.md");
  for (const fmt of ["letter", "a4", "legal", "a5", "tabloid"]) {
    const res = await runCli([small, "--format", fmt, "--quiet", "--no-validate"]);
    assert.notEqual(res.code, 2, `--format ${fmt} must be accepted`);
  }
});

test("missing input -> exit 2; --help alone -> exit 0 with usage", async () => {
  const noInput = await runCli([]);
  assert.equal(noInput.code, 2);
  assert.match(noInput.err, /missing <input>/);

  const help = await runCli(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.out, /Usage:/);
  assert.match(help.out, /--keep-html/);
});

test("two positional inputs -> exit 2 naming the extra argument", async () => {
  const res = await runCli([DJ_EXAMPLE, "b.json"]);
  assert.equal(res.code, 2);
  assert.match(res.err, /unexpected extra argument 'b\.json' \(expected exactly one input file\)/);
  assert.match(res.err, /--help/);
});

test("--keep-html space form consumes the next non-flag argument", async () => {
  const htmlPath = join(tmpdir(), `paperbot-keephtml-${process.pid}.html`);
  const res = await runCli([join(FIXTURES_DIR, "sample.md"), "--keep-html", htmlPath, "--quiet"]);
  if (chromiumAvailable()) {
    assert.equal(res.code, 0, `expected exit 0: ${res.err}`);
    assert.ok(existsSync(htmlPath), `HTML must be written to the space-form path (${htmlPath})`);
  } else {
    // Without chromium the render fails (3), but argument parsing must have
    // succeeded (no usage error).
    assert.equal(res.code, 3);
    assert.match(res.err, /Chromium/);
  }
  rm(htmlPath);
});

test("--help wins over unknown flags (exit 0, usage on stdout, nothing on stderr)", async () => {
  const res = await runCli([DJ_EXAMPLE, "--frobnicate", "--help"]);
  assert.equal(res.code, 0);
  assert.match(res.out, /Usage:/);
  assert.equal(res.err, "", "no usage errors may be reported when --help is present");
});

test("unknown option -> exit 2", async () => {
  const res = await runCli([DJ_EXAMPLE, "--frobnicate"]);
  assert.equal(res.code, 2);
  assert.match(res.err, /unknown option/);
});

test("convert subcommand is a no-op alias", async () => {
  // "convert" must be consumed as a subcommand, not treated as the input file:
  // the error must name the real input, and it must be an input error (1),
  // not a usage error (2).
  const res = await runCli(["convert", "no-such-file.json"]);
  assert.equal(res.code, 1);
  assert.match(res.err, /no-such-file\.json/);
  assert.ok(!res.err.includes('"convert"'), '"convert" must not be named in the error');
});
