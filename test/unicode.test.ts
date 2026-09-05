import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import type { RawDocument } from "../src/document.js";
import { prepare } from "../src/pipeline.js";
import { DJ_EXAMPLE, FIXTURES_DIR } from "./util.js";
import { join } from "node:path";

const UNICODE_FIXTURE = join(FIXTURES_DIR, "unicode.json");

/**
 * The unicode fixture mirrors the pdfgen.md test string (curly quotes, em
 * dash, NBSP, Greek/math symbols, CJK, Arabic, Devanagari, emoji) and adds
 * an HTML-injection attempt.
 */
const fixture = (): RawDocument => JSON.parse(readFileSync(UNICODE_FIXTURE, "utf8")) as RawDocument;

test("unicode fixture: every test string survives into the HTML", () => {
  const { html } = prepare(UNICODE_FIXTURE, { outPath: "out/unused.pdf" });

  const expected = [
    "“Quoted text”",
    "— café, naïve, coöperate",
    "α β γ",
    "∑ ∫ ≤ ≥ ≠",
    `word\u00a0word`, // NBSP between the words
    "東京",
    "العربية",
    "हिन्दी",
    "✅",
    "🔥",
  ];
  for (const s of expected) {
    assert.ok(html.includes(s), `expected "${s}" in output HTML`);
  }
});

test("unicode fixture: HTML injection is escaped, never raw", () => {
  const { html } = prepare(UNICODE_FIXTURE, { outPath: "out/unused.pdf" });

  // The injection attempt renders as escaped text...
  assert.ok(
    html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"),
    "injection must appear as escaped entities",
  );
  // ...and no executable script element exists anywhere in the document.
  assert.ok(!/<script/i.test(html), "no raw <script> tag may appear");
  // No generated tag may carry inline event handlers (escaped text mentions are fine).
  assert.ok(!/<[a-z][^>]*\son(?:error|mouseover|click)\s*=/i.test(html), "no inline event handlers in any tag");

  // Attribute-context escaping: the source URL with & and quotes.
  assert.ok(html.includes("https://example.com/a?b=1&amp;c=2"), "URL & must be entity-escaped in text");
});

test(
  "examples never leak executable content either",
  {
    skip: !existsSync(DJ_EXAMPLE)
      ? "example fixture absent (examples/ removed for public release)"
      : false,
  },
  () => {
  for (const f of [DJ_EXAMPLE]) {
    const { html } = prepare(f, { outPath: "out/unused.pdf" });
    assert.ok(!/<script/i.test(html));
    assert.ok(!/onclick=|onerror=|javascript:/i.test(html));
  }
});
