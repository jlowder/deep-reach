// Manual zero-dependency router for the unified deep-reach API.
// Maps public routes onto the two upstreams (deep-reach-worker, paperbot) via
// the helpers in upstream.ts; every response carries CORS headers.

import {
  UpstreamName,
  jsonResponse,
  mapUpstreamError,
  rewriteLinks,
  toResponse,
  upstreamBytes,
  upstreamFetch,
  upstreamJson,
} from "./upstream.ts";
import { preflight } from "./cors.ts";

const VERSION = "0.1.0";
const HEALTH_TIMEOUT_MS = 5000;
const FORMATS = ["pdf", "html"] as const;
const PAGE_FORMATS = ["letter", "a4", "legal", "a5", "tabloid"] as const;

export async function app(req: Request): Promise<Response> {
  const url = new URL(req.url);
  let path = url.pathname.replace(/\/+$/, "");
  if (path === "") path = "/";
  const method = req.method.toUpperCase();

  if (method === "OPTIONS") return preflight();

  try {
    return await route(method, path, req);
  } catch (err) {
    return jsonResponse(
      { error: "internal error", detail: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}

async function route(method: string, path: string, req: Request): Promise<Response> {
  if (method === "GET" && path === "/") return getIndex();
  if (method === "GET" && path === "/health") return getHealth();
  if (method === "POST" && path === "/research") return postResearch(req);
  if (method === "GET" && path === "/research") return getResearchList();
  if (method === "POST" && path === "/render") return postRender(req);

  const segs = path.split("/").filter((s) => s.length > 0);
  if (method === "GET" && segs[0] === "research" && segs.length >= 2) {
    let id: string;
    try {
      id = decodeURIComponent(segs[1]);
    } catch {
      return jsonResponse({ error: "invalid task id" }, 400);
    }
    if (segs.length === 2) return getResearch(id);
    if (segs.length === 3 && segs[2] === "report") return getReport(id);
    if (segs.length === 3 && segs[2] === "download") return getDownload(req, id);
  }

  return jsonResponse({ error: "not found" }, 404);
}

// --- helpers ---------------------------------------------------------------

/** Run an upstream-backed handler; map any thrown error to a CORS'd JSON response. */
function guard(name: UpstreamName, fn: () => Promise<Response>): Promise<Response> {
  return fn().catch((err: unknown) => mapUpstreamError(err, name));
}

function asRecord(v: unknown): Record<string, any> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, any>) : null;
}

/** Worker task ids appear as task_id on create and id elsewhere. */
function taskId(v: any): string | undefined {
  const rec = asRecord(v);
  if (!rec) return undefined;
  if (typeof rec.task_id === "string") return rec.task_id;
  if (typeof rec.id === "string") return rec.id;
  return undefined;
}

function enc(id: string): string {
  return encodeURIComponent(id);
}

/** Non-ok upstream response → JSON passthrough with the upstream's status. */
async function passthroughJson(res: Response, name: UpstreamName): Promise<Response> {
  const text = await res.text();
  let data: unknown = { error: `${name} returned ${res.status} with an empty body` };
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text.slice(0, 500) };
    }
  }
  return jsonResponse(data, res.status);
}

// --- routes ----------------------------------------------------------------

function getIndex(): Response {
  return jsonResponse({
    service: "deep-reach-api",
    version: VERSION,
    endpoints: [
      "POST /research",
      "GET /research",
      "GET /research/{id}",
      "GET /research/{id}/report",
      "GET /research/{id}/download",
      "POST /render",
      "GET /health",
    ],
  });
}

async function healthProbe(name: UpstreamName): Promise<Record<string, unknown>> {
  try {
    const res = await upstreamFetch(name, "/health", {}, HEALTH_TIMEOUT_MS);
    const text = await res.text();
    const rec = safeParseRecord(text);
    if (res.ok) return rec ? { ...rec, ok: true } : { ok: true, body: text.slice(0, 200) };
    return rec
      ? { ...rec, ok: false, status: res.status }
      : { ok: false, status: res.status, error: text.slice(0, 500) || `${name} returned ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function safeParseRecord(text: string): Record<string, unknown> | null {
  if (text.length === 0) return null;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

async function getHealth(): Promise<Response> {
  const [worker, paperbot] = await Promise.allSettled([
    healthProbe("worker"),
    healthProbe("paperbot"),
  ]);
  const pick = (r: PromiseSettledResult<Record<string, unknown>>): Record<string, unknown> =>
    r.status === "fulfilled" ? r.value : { ok: false, error: String(r.reason) };
  return jsonResponse({ service: "deep-reach-api", worker: pick(worker), paperbot: pick(paperbot) });
}

async function postResearch(req: Request): Promise<Response> {
  return guard("worker", async () => {
    const ct = req.headers.get("content-type") ?? "application/json";
    const body = await req.text();
    const { status, data } = await upstreamJson("worker", "/research", {
      method: "POST",
      headers: { "content-type": ct },
      body,
    });
    if (status === 202) {
      const rec = asRecord(data);
      const id = rec ? taskId(rec) : undefined;
      if (rec && id) return jsonResponse(rewriteLinks("", { id }, rec), status);
    }
    return jsonResponse(data, status);
  });
}

async function getResearchList(): Promise<Response> {
  return guard("worker", async () => {
    const { status, data } = await upstreamJson("worker", "/research");
    const rec = asRecord(data);
    if (rec && Array.isArray(rec.tasks)) {
      rec.tasks = rec.tasks.map((t: any) => rewriteLinks("", { id: taskId(t) ?? "" }, t));
    }
    return jsonResponse(rec ?? data, status);
  });
}

async function getResearch(id: string): Promise<Response> {
  return guard("worker", async () => {
    const { status, data } = await upstreamJson("worker", `/research/${enc(id)}`);
    const rec = asRecord(data);
    if (rec && status === 200) {
      return jsonResponse(rewriteLinks("", { id: taskId(rec) ?? id }, rec), status);
    }
    return jsonResponse(data, status);
  });
}

async function getReport(id: string): Promise<Response> {
  return guard("worker", async () => {
    // Bytes passthrough preserves the upstream content-type on ok and its
    // error body (409/404) verbatim.
    return toResponse(await upstreamBytes("worker", `/research/${enc(id)}/report`));
  });
}

async function getDownload(req: Request, id: string): Promise<Response> {
  const url = new URL(req.url);
  const format = url.searchParams.get("format") ?? "pdf";
  const pageFormat = url.searchParams.get("page_format") ?? "letter";
  const title = url.searchParams.get("title");
  const validate = url.searchParams.get("validate");

  if (!FORMATS.includes(format as (typeof FORMATS)[number])) {
    return jsonResponse({ error: `format must be one of: ${FORMATS.join(", ")}` }, 400);
  }
  if (!PAGE_FORMATS.includes(pageFormat as (typeof PAGE_FORMATS)[number])) {
    return jsonResponse({ error: `page_format must be one of: ${PAGE_FORMATS.join(", ")}` }, 400);
  }

  try {
    // a) task must exist and be completed
    const { status, data } = await upstreamJson("worker", `/research/${enc(id)}`);
    if (status === 404) return jsonResponse({ error: "not found" }, 404);
    const st = asRecord(data)?.status;
    if (st === "running" || st === "queued") {
      return jsonResponse({ status: st, task_id: id }, 409);
    }
    if (st === "failed") {
      const rec = asRecord(data);
      return jsonResponse(
        { error: typeof rec?.error === "string" ? rec.error : "research task failed", task_id: id },
        502,
      );
    }
    if (st !== "completed") {
      return jsonResponse({ error: `task is not downloadable (status: ${String(st)})`, task_id: id }, 409);
    }

    // b) fetch the report envelope, then hand it to paperbot /render
    const reportRes = await upstreamFetch("worker", `/research/${enc(id)}/report`);
    if (!reportRes.ok) return passthroughJson(reportRes, "worker");
    const reportText = await reportRes.text();
    return renderViaPaperbot(reportText, format, pageFormat, title, validate);
  } catch (err) {
    return mapUpstreamError(err, "worker");
  }
}

/** POST the report envelope to paperbot /render; stream its output back. */
function renderViaPaperbot(
  body: string,
  format: string,
  pageFormat: string,
  title: string | null,
  validate: string | null,
): Promise<Response> {
  const qs = new URLSearchParams();
  qs.set("format", format);
  qs.set("page_format", pageFormat);
  if (title !== null) qs.set("title", title);
  if (validate !== null) qs.set("validate", validate);
  return guard("paperbot", async () => {
    const result = await upstreamBytes("paperbot", `/render?${qs.toString()}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    return toResponse(result);
  });
}

async function postRender(req: Request): Promise<Response> {
  return guard("paperbot", async () => {
    const qs = new URL(req.url).search; // verbatim, includes leading "?" when present
    const headers: Record<string, string> = {};
    const ct = req.headers.get("content-type");
    if (ct) headers["content-type"] = ct;
    const result = await upstreamBytes("paperbot", `/render${qs}`, {
      method: "POST",
      headers,
      body: req.body,
    });
    return toResponse(result);
  });
}
