import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { CitationResolver } from "../src/citations.js";
import {
  applyTerminalPeriodRepairs,
  collapseRepeatedClauseCites,
  needsTerminalPeriod,
  renderBlock,
} from "../src/render/blocks.js";
import { prepareContent } from "../src/pipeline.js";
import type { Span } from "../src/document.js";

/**
 * Worker citation-format linter mirrors (3803fb3c luminous black-hole report:
 * 7 missing terminal periods, 10 redundant key groups, 6 repeated clause
 * cites). R1 resolves in normalizeDocument (citations.ts); R2 (period repair)
 * and R3 (clause-run collapse) run in renderBlock in the worker's assembly
 * order — R2 first, so a repaired span is terminal and cannot join a run.
 */

// SourceLike for CitationResolver: only citation_key/id are consulted.
const SOURCES = [
  { id: "s1", citation_key: "W2" },
  { id: "s2", citation_key: "W5" },
  { id: "s3", citation_key: "W17" },
  { id: "s4", citation_key: "W20" },
];

function span(text: string, sourcePositions: number[]): Span {
  return { text, sourcePositions };
}

// ---------------------------------------------------------------- R1

test("R1: multi-key group whose keys all resolve is stripped; positions union", () => {
  const res = new CitationResolver(SOURCES);
  const r = res.resolve("energy came from a mechanical wind [W2, W5, W17].", ["1", "2", "3"]);
  // the leading space is consumed with the group (the "word ." shape is the renderer's to fix)
  assert.equal(r.text, "energy came from a mechanical wind.");
  assert.deepEqual(r.sourcePositions, [1, 2, 3]);
  assert.equal(r.redundantKeyGroups, 1);
  assert.deepEqual(res.warnings(), [
    "citations: removed 1 redundant key group(s) (numbers already cited)",
  ]);
});

test("R1: multi-key group with an unresolvable key is KEPT (sole visible trace)", () => {
  const res = new CitationResolver(SOURCES);
  const r = res.resolve("energy came from a wind [W2, W19].", []);
  assert.equal(r.text, "energy came from a wind [W2, W19].");
  assert.equal(r.redundantKeyGroups, 0);
  assert.equal(r.unresolvedKeptKeys, 1);
  // the resolved key in the kept group still contributes its number
  assert.deepEqual(r.sourcePositions, [1]);
  assert.equal(res.warnings().length, 1);
  assert.match(res.warnings()[0], /1 citation key\(s\) in a multi-key group/);
});

test("R1: single-key groups are always stripped (legacy behavior unchanged)", () => {
  const res = new CitationResolver(SOURCES);
  const r = res.resolve("fusion [W20].", []);
  assert.equal(r.text, "fusion.");
  assert.deepEqual(r.sourcePositions, [4]);
  assert.equal(r.redundantKeyGroups, 0);
  assert.deepEqual(res.warnings(), []);
});

test("R1: resolved keys inside a kept group still contribute positions", () => {
  const res = new CitationResolver(SOURCES);
  const r = res.resolve("wind [W2, W19] and light [W5].", []);
  assert.equal(r.text, "wind [W2, W19] and light.");
  assert.deepEqual(r.sourcePositions, [1, 2]);
});

// ---------------------------------------------------------------- R2

test("R2: needsTerminalPeriod — ends in letter/digit + next starts a new sentence", () => {
  assert.equal(needsTerminalPeriod("…powered by gravity", "Gas falling in heats up."), true);
  // next starts a non-exception capital head
  assert.equal(needsTerminalPeriod("…in 2024", "New surveys show."), true);
  // already has terminal punctuation
  assert.equal(needsTerminalPeriod("…powered by gravity.", "Gas falling."), false);
  assert.equal(needsTerminalPeriod("…why?", "Gas falling."), false);
  // next continues lowercase
  assert.equal(needsTerminalPeriod("…powered by gravity", "and light."), false);
  // exception heads
  for (const next of [
    "Figure 2 shows",
    "TABLE 2 shows",
    "Fig. 2 shows",
    "Eq. 2 shows",
    "Section 3 follows",
    "Appendix A lists",
    "Vol. 2",
    "No 5 lists",
    "Dr Smith argues",
    "US policy",
    "NASA data",
    "e.g. LRDs",
    "i.e. roughly",
    "eg LRDs",
    "etc.",
    "min and max",
    "Ref Smith",
    "p 5",
  ]) {
    assert.equal(needsTerminalPeriod("…powered by gravity", next), false, `expected no period before "${next}"`);
  }
  // next starts with a digit (not an uppercase letter) — not a sentence start
  assert.equal(needsTerminalPeriod("…in 2024", "2025 surveys show."), false);
  // empty next content
  assert.equal(needsTerminalPeriod("…gravity", "  "), false);
});

test("R2: applyTerminalPeriodRepairs appends '.' only to cited sentence-final spans", () => {
  const warnings: string[] = [];
  const out = applyTerminalPeriodRepairs(
    [
      span("the object appears to be powered by gravity", [2]),
      span("Gas falling in heats up.", [2]),
      span("an uncited clause ends in a word", []),
      span("and continues it", []),
    ],
    warnings,
  );
  assert.equal(out[0].text, "the object appears to be powered by gravity.");
  // already terminal: untouched
  assert.equal(out[1].text, "Gas falling in heats up.");
  // uncited: untouched
  assert.equal(out[2].text, "an uncited clause ends in a word");
  assert.equal(out[3].text, "and continues it");
  assert.equal(warnings.length, 1);
});

test("R2: trailing kept key group (unresolvable) still gets the period", () => {
  const warnings: string[] = [];
  const out = applyTerminalPeriodRepairs(
    [
      span("the wind stops here [W19]", []), // ends in a kept group, no positions
      span("Gas keeps falling.", [1]),
    ],
    warnings,
  );
  assert.equal(out[0].text, "the wind stops here [W19].");
  assert.equal(warnings.length, 1);
});

test("R2: paragraph render — '…gravity [2]. Gas…' (the 3803fb3c S0 instance)", () => {
  const warnings: string[] = [];
  const html = renderBlock(
    {
      type: "paragraph",
      spans: [
        span("…object appears to be powered by gravity", [2]),
        span("Gas falling in heats up and releases energy.", [2]),
        span("The bright red color.", [2]),
      ],
    },
    { onWarning: (w) => warnings.push(w) },
  );
  assert.match(html, /gravity <span class="cite"><a href="#src-2">\[2\]<\/a><\/span>\. Gas/);
  // the "Gas" span already ends in a period and "The" is a sentence start: untouched
  assert.match(html, /energy <span class="cite"><a href="#src-2">\[2\]<\/a><\/span>\. The/);
  // one per-event mark -> one aggregated warning
  assert.deepEqual(warnings, ["citations: inserted 1 missing terminal period(s)"]);
});

// ---------------------------------------------------------------- R3

test("R3: 3 clause spans with identical cites -> one sup on the last", () => {
  const warnings: string[] = [];
  const html = renderBlock(
    {
      type: "paragraph",
      spans: [
        span("roughly 100 billion times the Suns luminosity", [1]),
        span("a few times the Suns total", [1]),
        span("all within 660 million years", [1]),
      ],
    },
    { onWarning: (w) => warnings.push(w) },
  );
  const sups = html.match(/\[1\]/g) || [];
  assert.equal(sups.length, 1);
  // no-punct text: the legacy rule glues the sup directly to the word
  assert.match(html, /years<span class="cite"><a href="#src-1">\[1\]<\/a><\/span><\/p>$/);
  assert.deepEqual(warnings, ["citations: suppressed 2 repeated clause citation(s)"]);
});

test("R3: 3 distinct sentences with the same cite keep all 3 sups", () => {
  const warnings: string[] = [];
  const html = renderBlock(
    {
      type: "paragraph",
      spans: [
        span("First fact stated.", [1]),
        span("Second fact stated.", [1]),
        span("Third fact stated.", [1]),
      ],
    },
    { onWarning: (w) => warnings.push(w) },
  );
  assert.equal((html.match(/\[1\]/g) || []).length, 3);
  assert.equal(warnings.length, 0);
});

test("R3: clause + sentence + clauses in one same-cite run clears the clause segments", () => {
  const { spans, suppressed } = collapseRepeatedClauseCites([
    span("classified as little red dots (LRDs)", [3]),
    span("detected with JWST.", [3]), // terminal: sentence keeps its cite
    span("reviewed in a journal", [3]),
    span("redshifted to 13.2", [3]),
  ]);
  assert.deepEqual(
    spans.map((s) => s.sourcePositions),
    [[], [3], [], [3]],
  );
  assert.equal(suppressed, 2);
});

test("R3: different citation sets never collapse", () => {
  const warnings: string[] = [];
  renderBlock(
    {
      type: "paragraph",
      spans: [span("alpha claims", [1]), span("while beta agrees", [2])],
    },
    { onWarning: (w) => warnings.push(w) },
  );
  assert.equal(warnings.length, 0);
});

test("R3: applies to quotes and callouts too", () => {
  const warnings: string[] = [];
  const q = renderBlock(
    {
      type: "quote",
      spans: [span("a quoted clause one", [2]), span("and a quoted clause two", [2])],
    },
    { onWarning: (w) => warnings.push(w) },
  );
  assert.equal((q.match(/\[2\]/g) || []).length, 1);
  const c = renderBlock(
    {
      type: "callout",
      calloutType: "note",
      calloutTitle: "T",
      spans: [span("a callout clause one", [2]), span("and a callout clause two", [2])],
    },
    { onWarning: (w) => warnings.push(w) },
  );
  assert.equal((c.match(/\[2\]/g) || []).length, 1);
  assert.deepEqual(warnings, [
    "citations: suppressed 1 repeated clause citation(s)",
    "citations: suppressed 1 repeated clause citation(s)",
  ]);
});

// ------------------------------------------------- legacy behavior (unchanged)

test("legacy: marker-only span keeps its terminal period; sup-before-punct ordering", () => {
  const warnings: string[] = [];
  const html = renderBlock(
    {
      type: "paragraph",
      spans: [
        span("A lone period", [7, 15]),
        span(".", []),
        span("Since its rise", [7, 15]),
      ],
    },
    { onWarning: (w) => warnings.push(w) },
  );
  // glue + established "word [4,5]." ordering
  assert.match(html, /<a href="#src-7">\[7,15\]<\/a><\/span>\. Since/);
  // "Since its rise" is the last span (no next) — no period repair
  assert.doesNotMatch(html, /Since its rise\./);
  assert.equal(warnings.length, 0);
});

// --------------------------------------------------- integration: real report

// The recovered 3803fb3c luminous black-hole report envelope. Absent in
// fresh clones: the test skips (same convention as document.test.ts's
// /tmp/dr-exaone end-to-end test).
const REAL_REPORT = "/tmp/dr-lint/report.json";

test("integration: real 3803fb3c report renders with zero key groups and repaired instances", () => {
  if (!existsSync(REAL_REPORT)) {
    console.log(`  (skipped: ${REAL_REPORT} not present)`);
    return;
  }
  const content = readFileSync(REAL_REPORT, "utf8");
  const { html, warnings } = prepareContent(content, "json", "dr-lint", {
    outPath: "/tmp/dr-lint/fixed.html",
  });

  // R1: no [W#]/[D#] key group survives in the HTML
  assert.equal((html.match(/\[(?:W|D)\d+/gi) || []).length, 0);

  // The user-reported S0 instance (R2): missing terminal period inserted
  // before the citation, period AFTER the sup.
  assert.ok(
    html.includes(
      "powered by gravity <span class=\"cite\"><a href=\"#src-2\">[2]</a></span>. Gas",
    ),
    "expected '…powered by gravity [2]. Gas…' in the rendered HTML",
  );

  // The user-reported synthesis instance (R1): key group stripped, display
  // numbers single-grouped, the sentence's period kept after the sup.
  assert.ok(
    html.includes(
      "mechanical wind <span class=\"cite\"><a href=\"#src-6\">[6,7,10]</a></span>.",
    ),
    "expected '…mechanical wind [6,7,10].' in the rendered HTML",
  );

  // Warning counts match the worker's own linter run on the same envelope:
  // 10 key groups (5 multi-key counted; 5 single-key = legacy silent strip),
  // 3 terminal periods, 6 repeated clause cites.
  const sum = (re: RegExp) =>
    warnings.reduce((acc, w) => {
      const m = w.match(re);
      return acc + (m ? Number(m[1]) : 0);
    }, 0);
  assert.equal(sum(/removed (\d+) redundant key group/), 5);
  assert.equal(sum(/inserted (\d+) missing terminal period/), 3);
  assert.equal(sum(/suppressed (\d+) repeated clause citation/), 6);
});
