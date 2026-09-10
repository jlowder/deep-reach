import { test } from "node:test";
import assert from "node:assert/strict";
import { renderBlock } from "../src/render/blocks.js";
import type { Block, Span } from "../src/document.js";

const span = (text: string, cites: number[] = []): Span => ({
  text,
  sourcePositions: cites,
});

const paragraphs = (html: string): string[] =>
  [...html.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1]);

test("callout joins mid-sentence spans into the previous <p>", () => {
  // Real producer pattern: a sentence split across spans, the continuation
  // span starting lowercase, each carrying its own citations.
  const block: Block = {
    type: "callout",
    calloutType: "info",
    calloutTitle: "",
    spans: [
      span(
        "Across these directions, a single through-line emerges: continuous-time models can be made trustworthy, but only if the problems are solved together.",
      ),
      span("Recent reviews already flag the area with novel open problems", [41]),
      span(
        "and call for co-evolving robustness metrics, layered human oversight, and harmonized audit standards.",
        [43],
      ),
    ],
  };
  const html = renderBlock(block);
  const ps = paragraphs(html);
  assert.equal(ps.length, 2, `expected exactly 2 <p>, got ${ps.length}:\n${html}`);
  assert.ok(ps[0].endsWith("solved together."), "first sentence stays its own paragraph");
  // The continuation lands in the SAME <p>: a space separates the citation
  // label from "and call for" (the marker sup is glued to its own word by
  // the established span rule).
  assert.match(ps[1], /problems.*\[41\].* and call for/);
  assert.match(ps[1], /\[41\]<\/a><\/span> and call for/);
  assert.match(ps[1], /standards <span class="cite"><a href="#src-43">\[43\]<\/a><\/span>\.$/);
});

test("callout with capital-initial spans keeps one <p> per span", () => {
  const block: Block = {
    type: "callout",
    calloutType: "note",
    calloutTitle: "Note",
    spans: [span("First idea."), span("Second idea.")],
  };
  const html = renderBlock(block);
  assert.equal(paragraphs(html).length, 2, html);
  assert.ok(html.includes('<span class="callout-title">Note</span>'), "title unchanged");
});

test("callout marker-only span glues without a space", () => {
  const block: Block = {
    type: "callout",
    calloutType: "tip",
    calloutTitle: "",
    spans: [span("Use adjoint training."), span("[W4]")],
  };
  const html = renderBlock(block);
  assert.equal(paragraphs(html).length, 1, html);
  assert.match(html, /adjoint training\.\[W4\]/);
});

// ---------------------------------------------------------------------------
// Empty / zero-width input in the shared renderCitedText path (cells,
// list items, spans): splitMath("") yields zero segments, which used to
// crash on the trailing-segment index. Empty input must render empty.
// ---------------------------------------------------------------------------

test("table cell with empty text renders as an empty cell, no throw", () => {
  const block: Block = {
    type: "comparison_table",
    caption: "",
    columns: ["Stage", "Classical unit"],
    rows: [
      [{ text: "Describe", sourcePositions: [] }, { text: "", sourcePositions: [] }],
      [
        { text: "", sourcePositions: [] },
        { text: "Builds the gate list.", sourcePositions: [8] },
      ],
    ],
  };
  const html = renderBlock(block);
  assert.ok(html.includes("<tr><td>Describe</td><td></td></tr>"), html);
  assert.ok(
    html.includes(
      "<tr><td></td><td>Builds the gate list <span class=\"cite\"><a href=\"#src-8\">[8]</a></span>.</td></tr>",
    ),
    html,
  );
});

test("table cell with whitespace-only text renders as an empty cell, no throw", () => {
  const block: Block = {
    type: "comparison_table",
    caption: "",
    columns: ["A"],
    rows: [[{ text: "  \t  ", sourcePositions: [] }]],
  };
  assert.equal(
    renderBlock(block),
    '<table><thead><tr><th>A</th></tr></thead><tbody><tr><td></td></tr></tbody></table>',
  );
});

test("paragraph span with only whitespace renders, no throw", () => {
  const block: Block = {
    type: "paragraph",
    spans: [span("Hello world."), span("   ")],
  };
  const html = renderBlock(block);
  assert.equal(paragraphs(html)[0], "Hello world.");
});

test("list item with whitespace-only text renders, no throw", () => {
  const block: Block = {
    type: "unordered_list",
    items: [{ text: "   ", sourcePositions: [] }],
  };
  assert.equal(renderBlock(block), "<ul><li></li></ul>");
});

test("a normal table still renders byte-identical", () => {
  const block: Block = {
    type: "comparison_table",
    caption: "",
    columns: ["Stage", "Unit"],
    rows: [
      [{ text: "Describe", sourcePositions: [] }, { text: "Parser", sourcePositions: [] }],
      [{ text: "Execute", sourcePositions: [] }, { text: "Runner", sourcePositions: [] }],
    ],
  };
  assert.equal(
    renderBlock(block),
    '<table><thead><tr><th>Stage</th><th>Unit</th></tr></thead><tbody>' +
      '<tr><td>Describe</td><td>Parser</td></tr>' +
      '<tr><td>Execute</td><td>Runner</td></tr>' +
      '</tbody></table>',
  );
});

// ---------------------------------------------------------------------------
// Column headers run through the same math pipeline as body cells (the
// pre-fix gap: bare escapeHtml printed $-TeX verbatim in the PDF — task
// 3614b2d6 page 9, 4 raw dollars).
// ---------------------------------------------------------------------------

test("table header with inline math typesets via KaTeX; no raw $ anywhere", () => {
  // The real columns from the recovered Langlands report (task 3614b2d6).
  const block: Block = {
    type: "comparison_table",
    caption: "The two sides of the geometric Langlands equivalence",
    columns: [
      "Left: geometry over $\\mathrm{Bun}_G$",
      "Right: $G^\\vee$-local systems",
    ],
    rows: [
      [
        { text: "The moduli stack $\\mathrm{Bun}_G$", sourcePositions: [3] },
        { text: "Local systems for $G^\\vee$", sourcePositions: [3] },
      ],
    ],
  };
  const warnings: string[] = [];
  const html = renderBlock(block, { onWarning: (w) => warnings.push(w) });
  const ths = [...html.matchAll(/<th>([\s\S]*?)<\/th>/g)].map((m) => m[1]!);
  assert.equal(ths.length, 2, html);
  assert.ok(ths[0]!.startsWith("Left: geometry over <span class=\"katex\">"), ths[0]);
  assert.ok(ths[1]!.startsWith("Right: <span class=\"katex\">"), ths[1]);
  assert.ok(!html.includes("$"), `no raw $ may survive anywhere: ${html}`);
  assert.equal(warnings.length, 0, warnings.join(" | "));
  // The same math in a body cell still typesets too.
  assert.ok(html.includes("<td>The moduli stack <span class=\"katex\">"), html);
});

test("table header with broken math degrades to the fallback span, no $, warning surfaced", () => {
  const block: Block = {
    type: "comparison_table",
    caption: "",
    columns: ["Right: $\\MATHRBUN)_G$-local systems"],
    rows: [[{ text: "plain cell", sourcePositions: [] }]],
  };
  const warnings: string[] = [];
  const html = renderBlock(block, { onWarning: (w) => warnings.push(w) });
  assert.ok(html.includes('class="math-fallback"'), html);
  assert.ok(!html.includes("$"), html);
  assert.ok(warnings.length > 0, "the failure must surface via onWarning");
});
