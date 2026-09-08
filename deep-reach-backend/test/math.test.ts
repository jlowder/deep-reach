import { test } from "node:test";
import assert from "node:assert/strict";
import { prepare } from "../src/pipeline.js";
import { _isWellFormedMath, renderMath, _stripDollarDelimiters } from "../src/render/math.js";
import { renderMathText } from "../src/render/blocks.js";
import { tempFile } from "./util.js";

function docWith(blocks: Record<string, unknown> | Record<string, unknown>[]): string {
  const list = Array.isArray(blocks) ? blocks : [blocks];
  return JSON.stringify({
    schema_version: "1.0",
    report: {
      metadata: { title: "Math Fixture" },
      sections: [{ heading: "Section", blocks: list }],
      sources: [],
    },
  });
}

/** Count exact `class="katex"` (inline+display) and `class="katex-display"` occurrences. */
const katexCount = (html: string) => (html.match(/class="katex"/g) ?? []).length;
const displayCount = (html: string) => (html.match(/class="katex-display"/g) ?? []).length;

test("display equation block renders .katex-display with inlined fonts, no delimiters", () => {
  const f = tempFile("eq-delimited.json", docWith({ type: "equation", text: "$$E = mc^2$$" }));
  const { html, warnings } = prepare(f, { outPath: "out/unused.pdf" });
  assert.ok(html.includes('class="katex-display"'), "delimited equation must be typeset (display)");
  assert.ok(!html.includes("$$E = mc^2$$"), "delimiters must be stripped");
  assert.ok(html.includes("data:font/woff2;base64,"), "KaTeX fonts must be inlined as data URIs");
  assert.ok(html.includes(".math-fallback"), "math-fallback CSS must be embedded");
  assert.ok(html.includes(".equation .katex-display"), "equation display margin rule must be embedded");
  assert.deepEqual(warnings, []);
});

test("equation with language latex typesets; undelimited without language stays plain", () => {
  const f = tempFile(
    "eq-lang.json",
    docWith([
      { type: "equation", text: "\\int_0^1 x^2\\,dx", language: "latex" },
      { type: "equation", text: "a plain undelimited line" },
    ]),
  );
  const { html, warnings } = prepare(f, { outPath: "out/unused.pdf" });
  assert.equal(displayCount(html), 1, "only the language:latex equation typesets");
  assert.ok(html.includes("a plain undelimited line"), "undelimited equation stays a plain div");
  assert.deepEqual(warnings, []);
});

test("span with $x^2 + y$ renders .katex inline; surrounding text escaped", () => {
  const f = tempFile(
    "inline-span.json",
    docWith({
      type: "paragraph",
      text: "",
      spans: [{ text: "Velocity $x^2 + y$ is <odd>." }],
    }),
  );
  const { html, warnings } = prepare(f, { outPath: "out/unused.pdf" });
  assert.equal(katexCount(html), 1, "one inline katex group");
  assert.equal(displayCount(html), 0, "single-$ math must be inline, not display");
  assert.ok(html.includes("Velocity <span class=\"katex\">"), "math glues into the text");
  assert.ok(html.includes("is &lt;odd&gt;."), "text segments must be escaped");
  assert.ok(!html.includes("<odd>"), "raw < must not leak");
  assert.ok(!html.includes('class="math-fallback"'), "valid tex must not fall back");
  assert.deepEqual(warnings, []);
});

test("costs $5 and $10 total stays plain text (pandoc digit rule)", () => {
  const f = tempFile(
    "dollar-prices.json",
    docWith({
      type: "paragraph",
      text: "",
      spans: [{ text: "It costs $5 and $10 total." }],
    }),
  );
  const { html, warnings } = prepare(f, { outPath: "out/unused.pdf" });
  assert.equal(katexCount(html), 0, "no math for $5 / $10 price pairs");
  assert.ok(html.includes("It costs $5 and $10 total."), "text must be untouched");
  assert.deepEqual(warnings, []);
});

test("whitespace around $ and unpaired $ stay text; \\( \\) and \\$ behave", () => {
  const f = tempFile(
    "pandoc-rules.json",
    docWith([
      { type: "paragraph", text: "", spans: [{ text: "For $ n $ we get $ 2 + 2$ and $50 saved" }] },
      {
        type: "paragraph",
        text: "",
        spans: [{ text: "price is \\$5 and \\(a+b\\) here" }],
      },
    ]),
  );
  const { html, warnings } = prepare(f, { outPath: "out/unused.pdf" });
  assert.equal(displayCount(html), 0);
  assert.equal(katexCount(html), 1, "only the \\(a+b\\) group typesets");
  assert.ok(html.includes("For $ n $ we get $ 2 + 2$ and $50 saved"), "pandoc-rejected $ stay literal");
  assert.ok(html.includes("price is $5 and "), "\\$ renders a literal dollar");
  assert.ok(!html.includes('class="math-fallback"'));
  assert.deepEqual(warnings, []);
});

test("malformed tex in a span (unbalanced brace) -> fallback span, NO scary warning (gate)", () => {
  const f = tempFile(
    "bad-tex.json",
    docWith({
      type: "paragraph",
      text: "",
      spans: [{ text: "Watch $\\frac{1$ closely" }],
    }),
  );
  const { html, warnings } = prepare(f, { outPath: "out/unused.pdf" });
  assert.deepEqual(warnings, [], "structurally malformed tex must degrade silently");
  assert.ok(html.includes('class="math-fallback"'), "fallback span must be emitted");
  assert.ok(html.includes("\\frac{1"), "the bad tex must be visible in the fallback");
  assert.equal(katexCount(html), 0, "no katex output for malformed tex");
});

test("standalone math spans get a leading space from joinSpans; commas still glue", () => {
  // Mirrors the producer's real output: each inline formula is its own span
  // and the inter-word spaces sit at the (trimmed-away) span edges.
  const f = tempFile(
    "standalone-math.json",
    docWith({
      type: "paragraph",
      text: "",
      spans: [
        { text: "…in the compact vector form " },
        { text: "$\\dot{x} = f(x, t)$" },
        { text: ", where the state " },
        { text: "$x$" },
        { text: " summarizes…" },
      ],
    }),
  );
  const { html, warnings } = prepare(f, { outPath: "out/unused.pdf" });
  assert.ok(
    html.includes('vector form <span class="katex">'),
    "a space must separate the word from a standalone math span",
  );
  assert.ok(
    html.includes("</span>, where the state"),
    "no space between a math span and the following comma",
  );
  assert.ok(
    html.includes("</span> summarizes…"),
    "a space must separate a standalone math span from the following word",
  );
  assert.deepEqual(warnings, []);
});

test("gate: _isWellFormedMath structural checks (no delimiter balance)", () => {
  assert.equal(_isWellFormedMath("a$b"), false, "interior $ is malformed");
  assert.equal(_isWellFormedMath("\\sum_{j} V_{"), false, "unbalanced braces are malformed");
  assert.equal(_isWellFormedMath("|\\psi\\rangle"), true, "ket is asymmetric but valid");
  assert.equal(_isWellFormedMath("|x\\rvert"), true, "norm is asymmetric but valid");
  assert.equal(_isWellFormedMath("\\langle\\phi|"), true, "bra is asymmetric but valid");
  assert.equal(_isWellFormedMath("\\sum_{j=0}^{3} V_{j}"), true, "balanced equation is well-formed");
  assert.equal(_isWellFormedMath("\\left( a \\right)"), true, "matched delimiters are well-formed");
});

test("gate: renderMath on malformed region -> fallback span, no warning", () => {
  const w: string[] = [];
  for (const tex of ["̲S_A$ = -$\\sum_n p_n\\log p_n", "\\frac{1"]) {
    const out = renderMath(tex, false, w);
    assert.ok(out.startsWith('<span class="math-fallback">'), `must be the fallback span for ${tex}`);
  }
  assert.deepEqual(w, [], "no scary warning may be emitted for malformed regions");
});

test("gate: well-formed tex still goes through KaTeX; well-formed-but-rejected still warns", () => {
  const w: string[] = [];
  for (const tex of ["\\sum_{j} V_{ij}", "|\\psi\\rangle", "|x\\rvert", "\\left( a \\right)"]) {
    const out = renderMath(tex, false, w);
    assert.ok(out.includes('class="katex"'), `KaTeX output expected for ${tex}`);
    assert.ok(!out.includes("math-fallback"), `must NOT fall back for ${tex}`);
  }
  assert.deepEqual(w, [], "well-formed tex must not warn");
  const w2: string[] = [];
  const out2 = renderMath("\\foobar{1}", false, w2);
  assert.ok(out2.includes('class="math-fallback"'), "KaTeX-rejected region falls back");
  assert.equal(w2.length, 1, "the rare well-formed-but-rejected case still warns");
  assert.ok(w2[0].startsWith("math:"), `expected a math warning, got: ${JSON.stringify(w2)}`);
});

test("executive_summary (flat strings) renders inline math: $H^A$⊗$H^B$ typesets, no literal $", () => {
  const json = {
    schema_version: "1.0",
    report: {
      metadata: { title: "Exec" },
      executive_summary:
        ["Tensors help: $H^A$⊗$H^B$ acts on the joint space, and $S_A = S_B$ for pure pairs."],
      sections: [{ heading: "Section", blocks: [] }],
      sources: [],
    },
  };
  const f = tempFile("exec-math2.json", JSON.stringify(json));
  const { html, warnings } = prepare(f, { outPath: "out/unused.pdf" });
  assert.equal(katexCount(html), 3, "all three $…$ groups typeset");
  assert.ok(!html.includes("$H^A$"), "no literal $ in output");
  assert.ok(html.includes("⊗"), "the ⊗ between the groups stays prose text");
  assert.ok(html.includes("Tensors help:"), "prose stays");
  assert.deepEqual(warnings, [], "no warnings for well-formed exec math");
});

test("executive_summary without math is unchanged escaped text", () => {
  const json = {
    schema_version: "1.0",
    report: {
      metadata: { title: "Exec" },
      executive_summary: ["No formulas here — just <prose> & more."],
      sections: [{ heading: "Section", blocks: [] }],
      sources: [],
    },
  };
  const f = tempFile("exec-plain.json", JSON.stringify(json));
  const { html, warnings } = prepare(f, { outPath: "out/unused.pdf" });
  assert.ok(html.includes("No formulas here — just &lt;prose&gt; &amp; more."), "plain text escaped unchanged");
  assert.equal(katexCount(html), 0);
  assert.deepEqual(warnings, []);
});

test("executive_summary with a malformed segment -> plain text, no scary warning", () => {
  const json = {
    schema_version: "1.0",
    report: {
      metadata: { title: "Exec" },
      executive_summary: ["Watch $\\frac{1$ closely in the summary."],
      sections: [{ heading: "Section", blocks: [] }],
      sources: [],
    },
  };
  const f = tempFile("exec-bad.json", JSON.stringify(json));
  const { html, warnings } = prepare(f, { outPath: "out/unused.pdf" });
  assert.ok(html.includes('class="math-fallback"'), "malformed segment degrades to the fallback span");
  assert.ok(html.includes("\\frac{1"), "raw tex visible in the fallback");
  assert.deepEqual(warnings, [], "no scary warning for a structurally malformed segment");
});

test("renderMathText: interior-$ region -> fallback, no warning; clean text byte-identical", () => {
  const w: string[] = [];
  const out = renderMathText("x $$a$ y$$ z", w);
  assert.ok(out.includes('class="math-fallback"'), "mis-split region becomes the fallback span");
  assert.ok(out.includes("a$ y"), "the raw mis-split region is visible");
  assert.deepEqual(w, [], "no warning");
  const out2 = renderMathText("plain & <safe>", w);
  assert.equal(out2, "plain &amp; &lt;safe&gt;", "math-free text is byte-identical to escapeHtml");
  assert.deepEqual(w, []);
});

test("_stripDollarDelimiters: inline $ removed, $$ removed, escaped \\\$ preserved", () => {
  assert.equal(
    _stripDollarDelimiters("F($\\psi, \\rho$) = $\\operatorname{Tr}$[\\psi \\rho$]"),
    "F(\\psi, \\rho) = \\operatorname{Tr}[\\psi \\rho]",
    "all unescaped $ gone",
  );
  assert.equal(_stripDollarDelimiters("$$E=mc^2$$"), "E=mc^2", "$$ pair removed");
  assert.equal(_stripDollarDelimiters("cost = \\$5"), "cost = \\$5", "escaped \\\$ preserved");
});

test("equation block with inline $ (undelimited) -> display math, no literal $", () => {
  const f = tempFile(
    "eq-inner-dollar.json",
    docWith({ type: "equation", text: "[$\\hat{x},\\hat{p}$] = i\\hbar" }),
  );
  const { html, warnings } = prepare(f, { outPath: "out/unused.pdf" });
  assert.ok(html.includes('class="katex-display"'), "typeset as a display equation");
  assert.ok(!html.includes("$"), "no literal $ in the output");
  assert.deepEqual(warnings, [], "clean equation must not warn");
});

test("equation block still malformed after $-strip -> plain-text fallback, surfaced warning (not a KaTeX parse error)", () => {
  const f = tempFile(
    "eq-still-bad.json",
    docWith({ type: "equation", text: "$\\sum_{j} V_{" }),
  );
  const { html, warnings } = prepare(f, { outPath: "out/unused.pdf" });
  assert.ok(html.includes('class="math-fallback"'), "gate degrades the malformed equation to plain text");
  assert.ok(html.includes("\\sum_{j} V_{"), "raw tex visible in the fallback");
  assert.equal(katexCount(html), 0, "no KaTeX output");
  assert.deepEqual(
    warnings,
    ["math fallback: unbalanced braces in equation — showing raw LaTeX"],
    "the equation gate fallback is surfaced as a plain diagnostic, never a KaTeX parse error",
  );
});

test("code_block language latex typesets as display; malformed falls back with surfaced warning; other langs unchanged", () => {
  const f = tempFile(
    "latex-code.json",
    docWith([
      { type: "code_block", language: "latex", text: "E = mc^2" },
      { type: "code_block", language: "latex", text: "E = \\frac{" },
      { type: "code_block", language: "python", text: "print(1)" },
    ]),
  );
  const { html, warnings } = prepare(f, { outPath: "out/unused.pdf" });
  assert.equal(displayCount(html), 1, "valid latex block typesets as a display equation");
  assert.ok(html.includes('class="equation"'), "latex block renders in the equation container");
  assert.equal((html.match(/class="math-fallback"/g) ?? []).length, 1, "malformed latex block falls back");
  assert.deepEqual(
    warnings,
    ["math fallback: unbalanced braces in equation — showing raw LaTeX"],
    "the malformed latex block (typeset as a display equation) surfaces the gate fallback",
  );
  assert.ok(
    html.includes('<pre class="language-python"><code>print(1)</code></pre>'),
    "non-latex code blocks must be unchanged",
  );
});
