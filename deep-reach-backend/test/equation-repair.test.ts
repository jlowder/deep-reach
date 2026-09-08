import { test } from "node:test";
import assert from "node:assert/strict";
import { prepare } from "../src/pipeline.js";
import { balanceBraces, renderMath } from "../src/render/math.js";
import { createServer } from "../src/server.js";
import { tempFile } from "./util.js";

// The exact equation block body shipped by real task 427f039f (recovered
// report): 2 open vs 3 close braces — a stray trailing `}`.
const REAL_UNBALANCED = "Q^* = \\dfrac{F}{p - c} - c}";
const REAL_BALANCED = "Q^* = \\dfrac{F}{p - c} - c";
const GATE_WARNING = "math fallback: unbalanced braces in equation — showing raw LaTeX";

function docWith(blocks: Record<string, unknown> | Record<string, unknown>[]): string {
  const list = Array.isArray(blocks) ? blocks : [blocks];
  return JSON.stringify({
    schema_version: "1.0",
    report: {
      metadata: { title: "Equation Repair Fixture" },
      sections: [{ heading: "Section", blocks: list }],
      sources: [],
    },
  });
}

/**
 * Assert the HTML typeset the equation as KaTeX: the raw `\dfrac` command
 * may appear ONLY inside KaTeX's a11y MathML annotation (the balanced
 * source for screen readers) — never in visible markup or a fallback span.
 */
function assertTypesetNotRaw(html: string, marker: string): void {
  assert.ok(!html.includes('class="math-fallback"'), "no fallback span in the HTML");
  const visible = html.replace(/<annotation[\s\S]*?<\/annotation>/g, "");
  assert.ok(!visible.includes(marker), `raw tex command ${marker} must not appear in visible markup`);
  assert.ok(html.includes(marker), "the a11y annotation must carry the source");
}

// ---------------------------------------------------------------------------
// (1) balanceBraces helper
// ---------------------------------------------------------------------------

test("balanceBraces: real 427f body loses the stray trailing brace", () => {
  assert.equal(balanceBraces(REAL_UNBALANCED), REAL_BALANCED);
});

test("balanceBraces: balanced input round-trips exactly", () => {
  for (const tex of [
    REAL_BALANCED,
    "\\dfrac{F}{p - c}",
    "\\sum_{j=0}^{3} V_{j}",
    "\\left( \\int a \\,dx \\right)",
    "|\\psi\\rangle",
    "a + b",
  ]) {
    assert.equal(balanceBraces(tex), tex, `must be byte-identical for ${tex}`);
  }
});

test("balanceBraces: unmatched opener is never guessed at", () => {
  assert.equal(balanceBraces("\\dfrac{F"), "\\dfrac{F");
  assert.equal(balanceBraces("\\sum_{j=1}^{n"), "\\sum_{j=1}^{n");
});

test("balanceBraces: escaped braces are literals; multiple stray closers drop", () => {
  assert.equal(balanceBraces("a \\} b"), "a \\} b", "\\} is not a structural closer");
  assert.equal(balanceBraces("x} y}}"), "x y");
  assert.equal(balanceBraces("}}}{{{"), "{{{");
});

// ---------------------------------------------------------------------------
// (2)+(3) repair + surfaced diagnostics through the render pipeline
// ---------------------------------------------------------------------------

test("(a) real 427f equation body -> typesets, no math-fallback, no warnings", () => {
  const f = tempFile(
    "eq-427f-repaired.json",
    docWith({ type: "equation", text: REAL_UNBALANCED, language: "latex" }),
  );
  const { html, warnings } = prepare(f, { outPath: "out/unused.pdf" });
  assert.ok(html.includes('class="katex-display"'), "the repaired body must be typeset (display)");
  assertTypesetNotRaw(html, "\\dfrac");
  assert.deepEqual(warnings, [], "the repaired body is well-formed — zero warnings");
});

test("(b) balanced equation body untouched end-to-end; still typesets", () => {
  const f = tempFile(
    "eq-balanced-roundtrip.json",
    docWith({ type: "equation", text: REAL_BALANCED, language: "latex" }),
  );
  const { html, warnings } = prepare(f, { outPath: "out/unused.pdf" });
  assert.ok(html.includes('class="katex-display"'), "balanced body typesets");
  assert.ok(!html.includes('class="math-fallback"'), "balanced body must not fall back");
  assert.deepEqual(warnings, []);
});

test("(c) unmatched opener \\dfrac{F -> math-fallback AND the warnings array carries the new entry", () => {
  const f = tempFile(
    "eq-opener.json",
    docWith({ type: "equation", text: "\\dfrac{F", language: "latex" }),
  );
  const { html, warnings } = prepare(f, { outPath: "out/unused.pdf" });
  assert.ok(html.includes('class="math-fallback"'), "unrepairable body keeps the literal fallback");
  assert.ok(html.includes("\\dfrac{F"), "the raw tex is visible in the fallback");
  assert.ok(!html.includes('class="katex"'), "no KaTeX output for the unbalanced body");
  assert.deepEqual(warnings, [GATE_WARNING], "the gate fallback must be surfaced in warnings");
});

test("(c) direct renderMath: kind=equation surfaces the gate warning; kind=inline stays silent", () => {
  const wEq: string[] = [];
  const outEq = renderMath("\\dfrac{F", true, wEq, "equation");
  assert.ok(outEq.startsWith('<span class="math-fallback">'), "equation kind falls back");
  assert.deepEqual(wEq, [GATE_WARNING]);

  const wIn: string[] = [];
  const outIn = renderMath("\\dfrac{F", true, wIn, "inline");
  assert.ok(outIn.startsWith('<span class="math-fallback">'), "inline kind falls back too");
  assert.deepEqual(wIn, [], "prose math keeps the documented silent degradation");
});

// ---------------------------------------------------------------------------
// (d) full /render of a minimal document containing the real equation
// ---------------------------------------------------------------------------

test("(d) POST /render with the real equation -> katex markup, no fallback span, x-paperbot-warnings 0", async () => {
  const app = await createServer({ pdf: false, logger: false });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/render?format=html",
      payload: JSON.parse(docWith({ type: "equation", text: REAL_UNBALANCED, language: "latex" })),
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('class="katex-display"'), "the equation renders as KaTeX markup");
    assertTypesetNotRaw(res.body, "\\dfrac");
    assert.equal(res.headers["x-paperbot-warnings"], "0", "repaired body emits zero warnings");
  } finally {
    await app.close();
  }
});

test("(d) POST /render with an unrepairable opener -> x-paperbot-warnings 1 + fallback in HTML", async () => {
  const app = await createServer({ pdf: false, logger: false });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/render?format=html",
      payload: JSON.parse(docWith({ type: "equation", text: "\\dfrac{F", language: "latex" })),
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('class="math-fallback"'), "unrepairable body shows the literal");
    assert.equal(res.headers["x-paperbot-warnings"], "1", "the diagnostics path is surfaced");
  } finally {
    await app.close();
  }
});
