/**
 * formatDate (src/render/html.ts) — the header date must be the LOCAL
 * calendar date of the instant, never the UTC one (the 8 PM local creation
 * -> next-day UTC off-by-one that produced "September 14, 2026" headers).
 *
 * Note: test/title-check.test.ts's captured "September 8, 2026" strings are
 * static literals exercised by normalizeForTextCheck (pure string joining,
 * no Date parsing) and its e2e input has no generated_at — that suite is
 * TZ-independent and needs no pinning.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDate } from "../src/render/html.js";
import { prepareContent } from "../src/pipeline.js";

const INSTANT = "2026-09-13T20:00:00Z";

test("(a) explicit zones discriminate UTC vs local on any machine", () =>
  {
    // 20:00 UTC is still Sept 13 in Los Angeles (same day)…
    assert.equal(
      formatDate(INSTANT, "America/Los_Angeles"),
      "September 13, 2026",
    );
    // …but UTC+13 has already rolled over to Sept 14 — a getUTC* formatter
    // cannot produce the LA result for a next-day-UTC instant either.
    assert.equal(formatDate(INSTANT, "Pacific/Kiritimati"), "September 14, 2026");
    // The user's actual case: an early-UTC instant created the prior US
    // evening reads as the evening's day in Denver.
    assert.equal(
      formatDate("2026-09-14T04:00:00Z", "America/Denver"),
      "September 13, 2026",
    );
  });

test("(c) unparseable / missing values keep the existing fallback: ''", () => {
  assert.equal(formatDate("not a date"), "");
  assert.equal(formatDate(""), "");
  assert.equal(formatDate("   "), "");
});

test("(b) rendered header uses the local date, not the UTC calendar date", () => {
  const content = JSON.stringify({
    report: {
      metadata: {
        title: "Planetary Shrinkage",
        author: "Research Assistant",
        report_type: "deep_research",
        generated_at: INSTANT,
      },
      sections: [
        { heading: "Findings", blocks: [{ type: "paragraph", spans: [{ text: "Body." }] }] },
      ],
      sources: [],
    },
  });
  const { html } = prepareContent(content, "json", "planetary.json", {});
  const local = new Intl.DateTimeFormat("en", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(INSTANT));
  const utc = new Intl.DateTimeFormat("en", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(INSTANT));
  assert.ok(html.includes(local), `header should read the local date (${local})`);
  assert.ok(html.includes('<p class="meta-line">'), "header meta line present");
  if (local !== utc) {
    // On a UTC machine the two coincide and the check is weaker (the
    // explicit-zone units above still discriminate); elsewhere the old
    // buggy UTC date must be gone from the header.
    assert.ok(!html.includes(utc), `header must not show the UTC date (${utc})`);
  }
});

test("renderHtml omits the date span entirely when generated_at is empty", () => {
  const content = JSON.stringify({
    report: {
      metadata: { title: "No Date" },
      sections: [],
      sources: [],
    },
  });
  const { html } = prepareContent(content, "json", "nodoc.json", {});
  // Match the element tag, not the class name: REPORT_CSS inside <style>
  // also mentions .meta-line.
  assert.ok(!html.includes('<p class="meta-line">'), "no meta line without a date/author");
});
