import { test } from "node:test";
import assert from "node:assert/strict";
import { prepare } from "../src/pipeline.js";
import { decodeUnicodeEscapes, renderMath } from "../src/render/math.js";
import { tempFile } from "./util.js";

/**
 * The bowl-on-2014 artifact: a model thinking in JSON emits a literal
 * \u2014 (backslash-u-2-0-1-4) inside a $...$ region meaning the em dash;
 * KaTeX natively defines \u as the breve accent, so it typesets as
 * "2"+bowl+"014" (U+02D8) — the user-visible defect in the recovered
 * Langlands report (task acf41000, PDF page 11).
 *
 * Defense: renderMath decodes \u + exactly 4 hex (case-insensitive, not
 * followed by another hex digit) BEFORE the well-formedness gate and KaTeX;
 * a region that is a single such escape is prose, not math, and returns the
 * decoded char as plain text. \u{...} / \u x accent uses never match.
 */

const EM = "\u2014"; // real em dash
const BOWL = "\u02d8"; // modifier breve — the artifact glyph

function docWith(blocks: Record<string, unknown> | Record<string, unknown>[]): string {
  const list = Array.isArray(blocks) ? blocks : [blocks];
  return JSON.stringify({
    schema_version: "1.0",
    report: {
      metadata: { title: "Escape Fixture" },
      sections: [{ heading: "Section", blocks: list }],
      sources: [],
    },
  });
}

// ---------------------------------------------------------------------------
// decodeUnicodeEscapes
// ---------------------------------------------------------------------------

test("decodeUnicodeEscapes: em dash, accent (case-insensitive hex), arrow", () => {
  const a = decodeUnicodeEscapes("a \\u2014 b");
  assert.equal(a.text, `a ${EM} b`);
  assert.equal(a.count, 1);

  const b = decodeUnicodeEscapes("caf\\u00e9 and \\u00C9");
  assert.equal(b.text, "café and É");
  assert.equal(b.count, 2);

  const c = decodeUnicodeEscapes("x \\u2194 y");
  assert.equal(c.text, "x ↔ y");
  assert.equal(c.count, 1);
});

test("decodeUnicodeEscapes: 5+-hex runs and accent forms never match", () => {
  assert.equal(decodeUnicodeEscapes("run \\u20149 done").text, "run \\u20149 done");
  assert.equal(decodeUnicodeEscapes("run \\u20142014 done").count, 0);
  assert.equal(decodeUnicodeEscapes("accent \\u{x} stays").text, "accent \\u{x} stays");
  assert.equal(decodeUnicodeEscapes("accent \\u x stays").text, "accent \\u x stays");
});

test("decodeUnicodeEscapes: control chars decode to nothing without doubling spaces", () => {
  assert.equal(decodeUnicodeEscapes("ctrl \\u0000 here").text, "ctrl here");
  assert.equal(decodeUnicodeEscapes("ab\\u0001x").text, "abx");
  assert.equal(decodeUnicodeEscapes("x \\u0001\\u0002 y").text, "x y");
});

test("decodeUnicodeEscapes: supplementary code points decode to a surrogate pair", () => {
  const r = decodeUnicodeEscapes("smile \\ud83d\\ude00 ok");
  assert.equal(r.text, "smile 😀 ok");
  assert.equal(r.count, 2);
});

test("decodeUnicodeEscapes: no-escape input is byte-identical; idempotent", () => {
  const tex = `E = mc^2 and ${EM} real dash`;
  const r = decodeUnicodeEscapes(tex);
  assert.equal(r.text, tex);
  assert.equal(r.count, 0);

  const first = decodeUnicodeEscapes("a \\u2014 b \\u20149");
  const second = decodeUnicodeEscapes(first.text);
  assert.equal(second.text, first.text);
  assert.equal(second.count, 0);
});

// ---------------------------------------------------------------------------
// renderMath: the gate-time decode
// ---------------------------------------------------------------------------

test("renderMath: lone escape returns the decoded char as plain text, no katex, with warning", () => {
  const w: string[] = [];
  const out = renderMath("\\u2014", false, w, "inline");
  assert.equal(out, EM);
  assert.ok(!out.includes("katex"), "no katex span for a lone escape");
  assert.ok(!out.includes("math-fallback"), "no fallback span for a lone escape");
  assert.equal(w.length, 1);
  assert.match(w[0], /lone \\u2014 unicode escape is not math; rendered as plain text/);
});

test("renderMath: lone display escape (kind=equation) likewise plain text", () => {
  const w: string[] = [];
  const out = renderMath("\\u2014", true, w, "equation");
  assert.equal(out, EM);
  assert.equal(w.length, 1);
  assert.match(w[0], /^equation: lone \\u2014/);
});

test("renderMath: mixed math decodes the escape and still typesets via KaTeX", () => {
  const w: string[] = [];
  const out = renderMath("a \\u2014 b and $x$", false, w, "inline");
  // the interior $ makes the gate reject AFTER decoding → fallback shows the
  // decoded text; the point: no \u2014 literal and no breve survive
  assert.ok(!out.includes("\\u2014"));
  assert.ok(!out.includes(BOWL));
  assert.equal(w.length, 1);
  assert.match(w[0], /decoded 1 \\uXXXX unicode escape/);

  const w2: string[] = [];
  const out2 = renderMath("a \\u2014 b", false, w2, "inline");
  assert.ok(out2.includes('class="katex"'), "well-formed decoded math typesets");
  assert.ok(!out2.includes("\\u2014"));
  assert.ok(!out2.includes(BOWL), "the breve artifact must not appear");
  assert.equal(w2.length, 1);
});

test("renderMath: real \\u accent uses are untouched (no decode warning)", () => {
  const w: string[] = [];
  const out = renderMath("\\u{x}", false, w, "inline");
  assert.ok(out.includes('class="katex"'));
  assert.equal(w.length, 0);
});

test("renderMath: escape-free math is untouched (no warning, no rewrite)", () => {
  const w: string[] = [];
  const before = "\\int_0^1 x\\,dx";
  const out = renderMath(before, false, w, "inline");
  assert.ok(out.includes('class="katex"'));
  assert.equal(w.length, 0);
});

// ---------------------------------------------------------------------------
// full pipeline: the recovered artifact through prepare()
// ---------------------------------------------------------------------------

test("prepare: inline $\\u2014$ renders as a real em dash; no bowl; warning surfaced", () => {
  const f = tempFile(
    "escape-inline.json",
    docWith({
      type: "paragraph",
      spans: [
        {
          text: `shortcut between domains that look unrelated $\\u2014$ two mouths joined by a throat`,
          citations: [],
        },
      ],
    }),
  );
  const { html, warnings } = prepare(f, { outPath: "out/unused.pdf" });
  assert.ok(html.includes("unrelated — two mouths joined"), "the dash must be a real em dash in prose");
  assert.ok(!html.includes("\\u2014"), "no literal escape in the output");
  assert.ok(!html.includes(BOWL), "no breve artifact glyph");
  assert.ok(
    warnings.some((x) => x.includes("lone \\u2014 unicode escape")),
    `warning surfaced via x-paperbot-warnings: ${JSON.stringify(warnings)}`,
  );
});

test("prepare: display equation block that is a lone escape ships as plain text", () => {
  const f = tempFile("escape-display.json", docWith({ type: "equation", text: "$$\\u2014$$" }));
  const { html, warnings } = prepare(f, { outPath: "out/unused.pdf" });
  assert.ok(html.includes(EM));
  assert.ok(!html.includes(BOWL));
  assert.ok(!html.includes('class="katex"'), "a lone escape is prose, not math");
  assert.ok(warnings.some((x) => x.includes("lone \\u2014 unicode escape")));
});

test("prepare: six-escape synthesis paragraph (the recovered report shape) decodes clean", () => {
  const f = tempFile(
    "escape-synthesis.json",
    docWith({
      type: "paragraph",
      spans: [
        {
          text:
            `pair bridge language $\\u2014$ functoriality $\\u2014$ that works; ` +
            `payoffs $\\u2014$ Fermat's theorem and $\\u2014$ Satake $\\u2014$ isomorphism ` +
            `as $\\u2014$ the program's spine`,
          citations: [],
        },
      ],
    }),
  );
  const { html, warnings } = prepare(f, { outPath: "out/unused.pdf" });
  assert.equal((html.match(/—/g) ?? []).length, 6, "all six decode to real em dashes");
  assert.ok(!html.includes("\\u2014"));
  assert.ok(!html.includes(BOWL));
  const lone = warnings.filter((x) => x.includes("lone \\u2014"));
  assert.equal(lone.length, 6, `six lone-escape warnings: ${JSON.stringify(warnings)}`);
});
