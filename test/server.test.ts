import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { createServer } from "../src/server.js";
import { chromiumAvailable } from "../src/pdf.js";

const here = dirname(fileURLToPath(import.meta.url));

const TINY_DOC = JSON.parse(readFileSync(join(here, "fixtures", "tiny.json"), "utf8")) as Record<string, unknown>;
const UNICODE_DOC = JSON.parse(readFileSync(join(here, "fixtures", "unicode.json"), "utf8")) as Record<string, unknown>;

// ---------------------------------------------------------------------------
// Suite A: no chromium (pdf: false) — all injectable, no browser needed.
// ---------------------------------------------------------------------------
describe("API server (pdf disabled)", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await createServer({ pdf: false, logger: false });
  });
  afterEach(async () => {
    await app.close();
  });

  test("GET /health reports service + pdf_ready false", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.service, "paperbot");
    assert.equal(body.pdf_ready, false);
    assert.equal(typeof body.chromium_available, "boolean");
    assert.equal(typeof body.version, "string");
  });

  test("GET / lists endpoints", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.endpoints.includes("POST /render"));
    assert.equal(body.docs, "API.md");
  });

  test("OPTIONS preflight -> 204 with CORS allow headers", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/health",
      headers: { origin: "http://x", "access-control-request-method": "GET" },
    });
    assert.equal(res.statusCode, 204);
    assert.equal(res.headers["access-control-allow-origin"], "*");
    assert.equal(res.headers["access-control-allow-methods"], "GET, POST, OPTIONS");
    assert.equal(res.headers["access-control-allow-headers"], "content-type");
  });

  test("GET /health response carries access-control-allow-origin", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["access-control-allow-origin"], "*");
    assert.equal(res.headers["access-control-allow-methods"], "GET, POST, OPTIONS");
  });

  test("GET /openapi.json serves a parseable spec with /render", async () => {
    const res = await app.inject({ method: "GET", url: "/openapi.json" });
    assert.equal(res.statusCode, 200);
    const spec = JSON.parse(res.body);
    assert.equal(spec.info.title, "Paperbot API");
    assert.ok(spec.paths["/render"].post);
  });

  test("POST /render wrapped document -> html bytes", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/render",
      payload: { document: TINY_DOC, format: "html" },
    });
    assert.equal(res.statusCode, 200, res.body.slice(0, 200));
    assert.match(res.headers["content-type"] ?? "", /text\/html/);
    assert.ok(res.body.includes("Tiny"), "title rendered");
    assert.equal(res.headers["x-paperbot-warnings"], "0");
  });

  test("POST /render markdown via text/markdown content type", async () => {
    const res = await app.inject({
      method: "POST",
      // markdown bodies default to format "pdf"; ask for html here (suite A
      // has no browser) to exercise the query fallback.
      url: "/render?format=html",
      headers: { "content-type": "text/markdown" },
      payload: "# Hello Markdown\n\nSome body text.",
    });
    assert.equal(res.statusCode, 200, res.body.slice(0, 200));
    assert.match(res.headers["content-type"] ?? "", /text\/html/);
    assert.ok(res.body.includes("Hello Markdown"));
  });

  test("neither document nor markdown -> 400", async () => {
    const res = await app.inject({ method: "POST", url: "/render", payload: {} });
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /exactly one/);
  });

  test("both document and markdown -> 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/render",
      payload: { document: TINY_DOC, markdown: "x" },
    });
    assert.equal(res.statusCode, 400);
  });

  test("invalid document (missing sections) -> 400 mentioning the issue", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/render",
      payload: { document: { report: { metadata: { title: "Bad" } } }, format: "html" },
    });
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /sections/);
  });

  test("invalid page_format -> 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/render",
      payload: { document: TINY_DOC, format: "html", page_format: "folio" },
    });
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /page_format/);
  });

  test("raw (unwrapped) document body with ?format=html", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/render?format=html",
      payload: TINY_DOC,
    });
    assert.equal(res.statusCode, 200, res.body.slice(0, 200));
    assert.match(res.headers["content-type"] ?? "", /text\/html/);
    assert.ok(res.body.includes("Tiny"));
  });
});

// ---------------------------------------------------------------------------
// Suite B: real chromium (gated like test/pdf.e2e.test.ts).
// ---------------------------------------------------------------------------
const hasChromium = chromiumAvailable();
const skipReason = hasChromium ? false : "chromium not installed (run: npx playwright install chromium)";

describe("API server (real chromium)", { skip: skipReason }, () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await createServer({ logger: false });
  });
  afterEach(async () => {
    await app.close();
  });

  test("POST /render document -> PDF bytes with metadata headers", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/render",
      payload: { document: UNICODE_DOC, format: "pdf" },
    });
    assert.equal(res.statusCode, 200, res.body.slice(0, 200));
    assert.equal(res.headers["content-type"], "application/pdf");
    assert.match(res.headers["content-disposition"] ?? "", /unicode_injection_fixtures\.pdf/);
    assert.equal(typeof res.headers["x-paperbot-warnings"], "string");
    const raw = res.rawPayload;
    assert.ok(raw.length > 10 * 1024, `expected > 10 KB, got ${raw.length}`);
    assert.ok(raw.subarray(0, 5).toString("latin1").startsWith("%PDF"));
  });
});
