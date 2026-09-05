import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { markdownToModel } from "../src/markdown.js";
import { renderHtml } from "../src/render/html.js";
import { prepare } from "../src/pipeline.js";
import { FIXTURES_DIR } from "./util.js";

const MD_FIXTURE = join(FIXTURES_DIR, "sample.md");
const md = () => readFileSync(MD_FIXTURE, "utf8");

test("markdown: title, executive summary, sections", () => {
  const model = markdownToModel(md(), {});

  assert.equal(model.metadata.title, "Sample Report");
  assert.deepEqual(model.executiveSummary, ["First finding.", "Second finding."]);
  assert.equal(model.sources.length, 0, "markdown carries no citations");

  const headings = model.sections.map((s) => s.heading);
  // "Overview" and "Final Section"; the pre-section lead paragraph sits in an
  // anonymous section with an empty heading.
  assert.ok(headings.includes("Overview"));
  assert.ok(headings.includes("Final Section"));
  assert.ok(headings.includes(""), "content before the first H2 goes to an anonymous section");

  const overview = model.sections.find((s) => s.heading === "Overview")!;
  const types = overview.blocks.map((b) => b.type);
  assert.deepEqual(types, [
    "paragraph",
    "heading",
    "paragraph",
    "unordered_list",
    "ordered_list",
    "comparison_table",
    "code_block",
    "callout",
    "page_break",
  ]);
});

test("markdown: lists, table, code, callout content", () => {
  const model = markdownToModel(md(), {});
  const overview = model.sections.find((s) => s.heading === "Overview")!;

  const ul = overview.blocks.find((b) => b.type === "unordered_list")!;
  assert.equal(ul.type, "unordered_list");
  assert.deepEqual(
    (ul as { items: { text: string }[] }).items.map((i) => i.text),
    ["bullet one", "bullet two", "bullet three"],
  );

  const ol = overview.blocks.find((b) => b.type === "ordered_list")!;
  assert.equal(ol.type, "ordered_list");
  assert.deepEqual(
    (ol as { items: { text: string }[] }).items.map((i) => i.text),
    ["first step", "second step"],
  );

  const table = overview.blocks.find((b) => b.type === "comparison_table")!;
  const tb = table as { columns: string[]; rows: { text: string }[][] };
  assert.deepEqual(tb.columns, ["Col A", "Col B"]);
  assert.deepEqual(
    tb.rows.map((r) => r.map((c) => c.text)),
    [
      ["a1", "b1"],
      ["a2", "b2"],
    ],
  );

  const code = overview.blocks.find((b) => b.type === "code_block")!;
  assert.equal((code as { language: string }).language, "js");
  assert.ok((code as { text: string }).text.includes("const x = 1;"));

  const callout = overview.blocks.find((b) => b.type === "callout")!;
  assert.equal((callout as { calloutType: string }).calloutType, "note");
  assert.ok((callout as unknown as { spans: { text: string }[] }).spans[0].text.includes("quoted note"));

  // Inline markdown is flattened to text.
  const p = overview.blocks[0] as { spans: { text: string }[] };
  assert.ok(p.spans[0].text.includes("bold"));
  assert.ok(p.spans[0].text.includes("italic"));
  assert.ok(!p.spans[0].text.includes("**"), "no raw markdown markers");
});

test("markdown: raw HTML fragments are dropped with a warning", () => {
  const { html, warnings } = prepare(join(FIXTURES_DIR, "raw-html.md"), {
    outPath: "out/unused.pdf",
  });
  assert.ok(!/<script/i.test(html), "no raw <script> may appear in the HTML");
  assert.ok(!html.includes("alert(1)"), "script content must not render");
  assert.ok(
    warnings.some((w) => /^dropped \d+ raw HTML fragment\(s\) from markdown$/.test(w)),
    `expected an aggregated raw-HTML warning, got: ${JSON.stringify(warnings)}`,
  );
});

test("markdown: title override and fallback", () => {
  assert.equal(markdownToModel("# T\n\nBody.", { title: "Override" }).metadata.title, "Override");
  assert.equal(markdownToModel("No heading here.", { fallbackTitle: "File Name" }).metadata.title, "File Name");
  assert.equal(markdownToModel("No heading here.", {}).metadata.title, "Untitled document");
});

test("markdown: full prepare() round-trip renders expected HTML", () => {
  const { model, html, warnings } = prepare(MD_FIXTURE, { outPath: "out/unused.pdf" });
  assert.equal(model.metadata.title, "Sample Report");
  assert.ok(html.includes("<title>Sample Report</title>"));
  assert.ok(html.includes("<h1>Sample Report</h1>"));
  assert.ok(html.includes("<h2>Overview</h2>"));
  assert.ok(html.includes("<h3>Deeper point</h3>"));
  assert.ok(html.includes("<ul>"));
  assert.ok(html.includes("<ol>"));
  assert.ok(html.includes("<table>"));
  assert.ok(/<pre[\s>]/.test(html), "code fence renders as <pre>");
  assert.ok(html.includes('class="callout note"'));
  assert.ok(html.includes('class="page-break"'));
  assert.ok(!html.includes("<h2>References</h2>"), "no references section for markdown input");
  assert.deepEqual(warnings, []);
});
