import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import type { RawDocument } from "../src/document.js";
import { prepare } from "../src/pipeline.js";
import { DJ_EXAMPLE, GP_EXAMPLE } from "./util.js";

/** Load a real example file (paths contain spaces on purpose). */
function loadExample(path: string): RawDocument {
  assert.ok(existsSync(path), `example file must exist: ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as RawDocument;
}

function count(pattern: RegExp, s: string): number {
  const m = s.match(pattern);
  return m ? m.length : 0;
}

test(
  "DJ example (25 sources, spaces in filename) parses, validates, renders",
  {
    // examples/ was removed for the public release; skip gracefully when the
    // fixture is absent, run normally if it ever returns.
    skip: !existsSync(DJ_EXAMPLE)
      ? "example fixture absent (examples/ removed for public release)"
      : false,
  },
  () => {
  const raw = loadExample(DJ_EXAMPLE);
  assert.equal(raw.report.sources?.length, 25);

  const { model, html, warnings } = prepare(DJ_EXAMPLE, { outPath: "out/unused.pdf" });

  // Title + exec summary
  assert.ok(html.includes("Development Plan for DJ-Aware Lyrics Sync Player"));
  assert.equal(model.executiveSummary.length, 3);
  assert.ok(html.includes(model.executiveSummary[0].slice(0, 60)));

  // Every section heading renders (including the 4 empty scaffolding sections).
  for (const sec of raw.report.sections ?? []) {
    assert.ok(
      html.includes(sec.heading),
      `section heading missing from HTML: ${sec.heading}`,
    );
  }

  // The DJ comparison table: all 6 data rows, with their first-column text.
  const table = raw.report
    .sections?.flatMap((s) => s.blocks ?? [])
    .find((b) => b.type === "comparison_table");
  assert.ok(table, "DJ example must contain a comparison table");
  const rows = table.rows as { text: string }[][];
  assert.equal(rows.length, 6);
  for (const row of rows) {
    assert.ok(html.includes(row[0].text), `table row missing from HTML: ${row[0].text}`);
  }
  assert.equal(count(/<table>/g, html), 1);
  assert.equal(count(/<tbody>[\s\S]*?<\/tbody>/g, html), 1);

  // References: exactly one <li id="src-N"> per source, original order.
  assert.equal(count(/<li id="src-\d+">/g, html), raw.report.sources!.length);
  assert.ok(html.includes('id="src-1"'));
  assert.ok(html.includes(`id="src-${raw.report.sources!.length}"`));

  // No [W#]/[D#] markers survive anywhere in the body HTML.
  assert.equal(
    /\[(?:W|D)\d+\]/gi.test(html),
    false,
    "citation markers must not remain in the HTML",
  );

  // DJ file is citation-consistent: no warnings at all.
  assert.deepEqual(warnings, []);

  // Structural sanity: doctype, charset, embedded style, no external resources.
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes('<meta charset="utf-8">'));
  assert.ok(html.includes("<style>"));
  assert.ok(!html.includes("<link"), "no external <link> resources allowed");
  assert.ok(!/src="http/.test(html), "no external script/img resources allowed");
});

test(
  "GP example (18 sources, dirty citations) builds with the 36-ref warning",
  {
    skip: !existsSync(GP_EXAMPLE)
      ? "example fixture absent (examples/ removed for public release)"
      : false,
  },
  () => {
  const raw = loadExample(GP_EXAMPLE);
  assert.equal(raw.report.sources?.length, 18);

  const { model, html, warnings } = prepare(GP_EXAMPLE, { outPath: "out/unused.pdf" });

  assert.ok(html.includes("Comprehensive Report on Genetic Programming"));
  for (const sec of raw.report.sections ?? []) {
    assert.ok(html.includes(sec.heading), `section heading missing: ${sec.heading}`);
  }

  // Binding requirement: warnings must carry the 36 out-of-range ref count.
  assert.ok(
    warnings.some((w) => w.includes("36 unresolvable citation references")),
    `expected a warning counting the 36 out-of-range refs, got: ${JSON.stringify(warnings)}`,
  );

  // 18 reference entries; no markers left; callout survived normalization.
  assert.equal(count(/<li id="src-\d+">/g, html), 18);
  assert.equal(/\[(?:W|D)\d+\]/gi.test(html), false);
  assert.ok(html.includes('class="callout note"'));

  // Sources keep original order; positions are 1..N.
  assert.deepEqual(
    model.sources.map((s) => s.position),
    model.sources.map((_, i) => i + 1),
  );
});
