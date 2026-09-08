import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { renderReferences } from "../src/render/blocks.js";
import { createServer } from "../src/server.js";
import type { Source } from "../src/document.js";

// Real task 0992eb851fde4b9e8136af0f269082d9: the "Sources" callout (a
// citation_note block) says "keyed to the report source W1", but the
// References section printed only positional [1]..[5] + title + URL — the
// citation keys (W1..W5) were never rendered, so the prose label resolved
// to nothing. renderReferences now prints the key beside the position.

function src(over: Partial<Source>): Source {
  return {
    position: 0,
    id: "",
    type: "webpage",
    title: "",
    author: "",
    issued: "",
    url: "",
    publisher: "",
    doi: "",
    citationKey: "",
    accessed: "",
    ...over,
  };
}

const REAL_REPORT = "/tmp/dr-src/report.json";

test("(a) keys W1/W2 print beside positions; empty key prints nothing; positions/titles/urls unchanged", () => {
  const html = renderReferences([
    src({ position: 1, id: "source-w1", title: "First Title", url: "https://a.example", citationKey: "W1" }),
    src({ position: 2, id: "source-w2", title: "Second Title", url: "https://b.example", citationKey: "W2" }),
    src({ position: 3, id: "source-w3", title: "Third Title", url: "https://c.example", citationKey: "" }),
  ]);

  assert.ok(html.includes('<span class="ref-num">[1]</span><span class="ref-key">W1</span>'), "W1 beside [1]");
  assert.ok(html.includes('<span class="ref-num">[2]</span><span class="ref-key">W2</span>'), "W2 beside [2]");
  // Empty key: position goes straight to the title — no key element in that entry.
  const third = html.match(/<li id="src-3">[\s\S]*?<\/li>/)![0];
  assert.ok(third.includes('<span class="ref-num">[3]</span><span class="ref-title">Third Title</span>'));
  assert.ok(!third.includes("ref-key"), "no key element for the empty-key source");

  const counts = (html.match(/ref-key/g) ?? []).length;
  assert.equal(counts, 2, "exactly two key elements");

  // The unchanged parts stay byte-identical.
  assert.ok(html.includes('<span class="ref-title">First Title</span>'));
  assert.ok(html.includes('<a href="https://a.example">https://a.example</a>'));
  assert.ok(html.includes('<li id="src-1">'));
  assert.ok(html.includes("<h2>References</h2>"));
});

test("(b) real 0992eb85 report: all five keys print in position order; callout prose untouched", async () => {
  if (!existsSync(REAL_REPORT)) {
    console.log(`skipped: recovered artifact ${REAL_REPORT} not present`);
    return;
  }
  const payload = JSON.parse(readFileSync(REAL_REPORT, "utf8"));
  const app = await createServer({ pdf: false, logger: false });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/render?format=html",
      payload,
    });
    assert.equal(res.statusCode, 200);

    const m = res.body.match(/<section class="doc-section references">[\s\S]*?<\/section>/);
    assert.ok(m, "the references section exists");
    const refs = m![0];

    // The sources array order is W1, W2, W4, W3, W5 (ids w1/w2/w4/w3/w5) —
    // keys must appear exactly in that positional order.
    const keys = [...refs.matchAll(/ref-key">([^<]+)</g)].map((x) => x[1]);
    assert.deepEqual(keys, ["W1", "W2", "W4", "W3", "W5"]);

    // Positions and titles unchanged alongside the keys.
    assert.ok(refs.includes("[1]</span><span class=\"ref-key\">W1</span><span class=\"ref-title\">Effective field theory - Wikipedia</span>"));
    assert.ok(refs.includes("[5]</span><span class=\"ref-key\">W5</span><span class=\"ref-title\">SESSION CVIII"));

    // The citation_note callout prose is verbatim (paperbot never rewrites
    // prose) — and the key it names now has a definition in-document.
    assert.ok(res.body.includes("keyed to the report source W1"), "callout prose untouched");
    assert.ok(refs.includes("ref-key\">W1"), "W1 is defined in the References section");
  } finally {
    await app.close();
  }
});
