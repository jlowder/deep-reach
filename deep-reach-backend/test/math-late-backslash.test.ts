import { test } from "node:test";
import assert from "node:assert/strict";
import { prepare } from "../src/pipeline.js";
import { restoreLateBackslash } from "../src/render/math.js";
import { renderMathText } from "../src/render/blocks.js";
import { tempFile } from "./util.js";

function docWith(blocks: Record<string, unknown> | Record<string, unknown>[]): string {
  const list = Array.isArray(blocks) ? blocks : [blocks];
  return JSON.stringify({
    schema_version: "1.0",
    report: {
      metadata: { title: "Late-Backslash Fixture" },
      sections: [{ heading: "Section", blocks: list }],
      sources: [],
    },
  });
}

const katexCount = (html: string) => (html.match(/class="katex"/g) ?? []).length;

// ---------------------------------------------------------------------------
// text-level rule (worker _restore_late_backslash mirror)
// ---------------------------------------------------------------------------

test("tab + times tail restores to backslash-times", () => {
  const r = restoreLateBackslash("volume at $8\times 8\times 8$ nm resolution");
  assert.equal(r.text, "volume at $8\\times 8\\times 8$ nm resolution");
  assert.equal(r.restored, 2);
});

test("control char before prose stays untouched (fail forward)", () => {
  const a = restoreLateBackslash("first sentence\nused to be longer");
  assert.equal(a.text, "first sentence\nused to be longer");
  assert.equal(a.restored, 0);
  const b = restoreLateBackslash("the\tvolume was measured");
  assert.equal(b.text, "the\tvolume was measured");
  assert.equal(b.restored, 0);
});

test("newline + standalone nu restores; tail-prefix of a word does not", () => {
  assert.equal(restoreLateBackslash("rate \nu = 0.5").text, "rate \\nu = 0.5");
  const r = restoreLateBackslash("each \nunit was imaged");
  assert.equal(r.text, "each \nunit was imaged");
  assert.equal(r.restored, 0);
});

test("ff/bs/vt escapes restore frac/bar/vee", () => {
  assert.equal(restoreLateBackslash("a \frac{1}{2} share").text, "a \\frac{1}{2} share");
  assert.equal(restoreLateBackslash("x \bar{y} conj").text, "x \\bar{y} conj");
  assert.equal(restoreLateBackslash("p \vee q disj").text, "p \\vee q disj");
});

test("idempotent: a restored text carries no control char to re-match", () => {
  const once = restoreLateBackslash("at $8\times 8\times 8$ nm, again \frac{a}{b} once");
  assert.equal(once.restored, 3);
  const twice = restoreLateBackslash(once.text);
  assert.equal(twice.text, once.text);
  assert.equal(twice.restored, 0);
});

test("a real backslash command is untouched (no double escape)", () => {
  const r = restoreLateBackslash("volume at $8\\times 8$ nm resolution");
  assert.equal(r.text, "volume at $8\\times 8$ nm resolution");
  assert.equal(r.restored, 0);
});

// ---------------------------------------------------------------------------
// render-level: ordering (restore before splitMath / gate / KaTeX)
// ---------------------------------------------------------------------------

test("corrupted $-region in prose restores before the math gate and typesets", () => {
  // The recovered sec3 span (task 10b502cf): two real TABs where the JSON
  // decode consumed \t from \times. Before the fix the tabs + a worker-
  // healed $ reached KaTeX as an italic `imes`; the mirror restores them,
  // splitMath then yields a well-formed region, and KaTeX typesets it.
  const spanText =
    "Building a neuron-level sparse recurrent model on the MaleCNS begins " +
    "with the connectivity graph: the fully proofread adult male CNS was " +
    "imaged with seven eFIB-SEM systems over thirteen months, producing a " +
    "160 teravoxel volume at $8\times 8\times 8$ nm isotropic resolution.";
  const warnings: string[] = [];
  const html = renderMathText(spanText, warnings);
  assert.ok(katexCount(html) >= 1, "restored region must be typeset by KaTeX");
  assert.ok(html.includes("\\times"), "the rendered markup must carry the restored command");
  // renderMathText is the raw text path: per-event markers land in the
  // array; the block renderer aggregates them (see the prepare() test).
  assert.deepEqual(
    warnings,
    [
      "math: restored a backslash a JSON decode consumed",
      "math: restored a backslash a JSON decode consumed",
    ],
    "one per-event marker per restored command",
  );
});

test("prepare(): a corrupted paragraph span yields one AGGREGATE restore warning and typeset math", () => {
  const f = tempFile(
    "late-bs-para.json",
    docWith([
      {
        type: "paragraph",
        spans: [
          {
            text:
              "the proofread adult male CNS was imaged over thirteen months, " +
              "producing a 160 teravoxel volume at $8\t\times 8\times 8$ nm " +
              "isotropic resolution.",
            citations: [],
          },
        ],
      },
    ]),
  );
  const { html, warnings } = prepare(f, { outPath: "out/unused.pdf" });
  assert.ok(katexCount(html) >= 1, "restored region must be typeset");
  assert.deepEqual(
    warnings.filter((w) => w.includes("backslash")),
    ["math: restored 2 backslash(es) a JSON decode consumed"],
    "per-block aggregation, one entry",
  );
});

test("an already-restored (worker-fixed) report renders with no restore warning", () => {
  const warnings: string[] = [];
  renderMathText("volume at $8\\times 8\\times 8$ nm isotropic resolution.", warnings);
  assert.deepEqual(warnings, []);
});

test("corrupted display equation block restores before delimiter strip / gate", () => {
  const f = tempFile(
    "late-bs-eq.json",
    // NOTE: every \\ below is a literal TeX backslash in the runtime value;
    // the ONE single-backslash \frac in the source parses (JS escape \f) to
    // FF + "rac" — exactly the corruption the mirror must repair.
    docWith([{ type: "equation", text: "$$\\mu \\in \\mathbb{R}^{3} + \frac{a}{b}$$" }]),
  );
  const { html, warnings } = prepare(f, { outPath: "out/unused.pdf" });
  assert.ok(katexCount(html) >= 1, "corrupted equation must still typeset");
  assert.ok(
    warnings.some((w) => w.includes("restored 1 backslash(es) a JSON decode consumed")),
    `expected aggregate restore warning, got: ${JSON.stringify(warnings)}`,
  );
});

test("corrupted latex code_block body restores before the verbatim typeset", () => {
  const f = tempFile(
    "late-bs-code.json",
    // \\vec is a clean TeX backslash; the single-backslash \frac parses to
    // FF + "rac" — the corruption the mirror repairs.
    docWith([{ type: "code_block", language: "latex", text: "\\vec{v} \frac{d}{dt}" }]),
  );
  const { html, warnings } = prepare(f, { outPath: "out/unused.pdf" });
  assert.ok(katexCount(html) >= 1, "corrupted latex code block must still typeset");
  assert.ok(
    warnings.some((w) => w.includes("restored 1 backslash(es)")),
    JSON.stringify(warnings),
  );
});

test("a plain (non-latex) code block never restores: a tab is literal", () => {
  const f = tempFile(
    "late-bs-code-plain.json",
    docWith([{ type: "code_block", language: "python", text: "x = 1\t# keep" }]),
  );
  const { html, warnings } = prepare(f, { outPath: "out/unused.pdf" });
  assert.ok(html.includes("x = 1\t"), "literal tab must survive in plain code");
  assert.deepEqual(warnings, []);
});
