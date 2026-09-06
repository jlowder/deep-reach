// Manual zero-dependency router for the unified deep-reach API.
// Maps public routes onto the two upstreams (deep-reach-worker, paperbot) via
// the helpers in upstream.ts; every response carries CORS headers.

import {
  UpstreamName,
  jsonResponse,
  mapUpstreamError,
  readText,
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
  let method = req.method.toUpperCase();
  if (method === "HEAD") method = "GET"; // routes below; Bun omits the body for HEAD

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
  if (method === "GET" && path === "/health") return getHealth(clientSignal(req));
  if (method === "POST" && path === "/research") return postResearch(req);
  if (method === "GET" && path === "/research") return getResearchList(clientSignal(req));
  if (method === "POST" && path === "/render") return postRender(req);
  if (path === "/documents") {
    if (method === "GET") return getDocuments(clientSignal(req));
    if (method === "POST") return postDocuments(req);
    if (method === "DELETE") return deleteDocuments(clientSignal(req));
  }

  const segs = path.split("/").filter((s) => s.length > 0);
  if ((method === "GET" || method === "DELETE") && segs[0] === "research" && segs.length >= 2) {
    let id: string;
    try {
      id = decodeURIComponent(segs[1]);
    } catch {
      return jsonResponse({ error: "invalid task id" }, 400);
    }
    if (method === "GET") {
      if (segs.length === 2) return getResearch(id, clientSignal(req));
      if (segs.length === 3 && segs[2] === "report") return getReport(id, clientSignal(req));
      if (segs.length === 3 && segs[2] === "download") return getDownload(req, id);
    }
    if (method === "DELETE" && segs.length === 2) return deleteResearch(id, clientSignal(req));
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

/**
 * The client's abort signal (Bun exposes one on the serve Request). Thread it
 * into upstream calls so an abandoned client releases the upstream socket.
 */
function clientSignal(req: Request): AbortSignal | undefined {
  return (req as { signal?: AbortSignal }).signal ?? undefined;
}

/** Non-ok upstream response → JSON passthrough with the upstream's status. */
async function passthroughJson(res: Response, name: UpstreamName, signal?: AbortSignal | null): Promise<Response> {
  const text = await readText(res, signal);
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
      "DELETE /research/{id}",
      "POST /render",
      "GET /documents",
      "POST /documents",
      "DELETE /documents",
      "GET /health",
    ],
  });
}

async function healthProbe(name: UpstreamName, signal: AbortSignal | undefined): Promise<Record<string, unknown>> {
  try {
    const res = await upstreamFetch(name, "/health", { signal }, HEALTH_TIMEOUT_MS);
    const text = await readText(res, signal);
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

async function getHealth(signal: AbortSignal | undefined): Promise<Response> {
  const [worker, paperbot] = await Promise.allSettled([
    healthProbe("worker", signal),
    healthProbe("paperbot", signal),
  ]);
  const pick = (r: PromiseSettledResult<Record<string, unknown>>): Record<string, unknown> =>
    r.status === "fulfilled" ? r.value : { ok: false, error: String(r.reason) };
  return jsonResponse({ service: "deep-reach-api", worker: pick(worker), paperbot: pick(paperbot) });
}

async function postResearch(req: Request): Promise<Response> {
  return guard("worker", async () => {
    const ct = req.headers.get("content-type") ?? "application/json";
    // Stream the request body byte-faithfully (req.text() would corrupt
    // non-UTF-8 payloads); forward content-type and the client abort signal.
    const { status, data } = await upstreamJson("worker", "/research", {
      method: "POST",
      headers: { "content-type": ct },
      body: req.body,
      signal: clientSignal(req),
    });
    if (status === 202) {
      const rec = asRecord(data);
      const id = rec ? taskId(rec) : undefined;
      if (rec && id) return jsonResponse(rewriteLinks("", { id }, rec), status);
    }
    return jsonResponse(data, status);
  });
}

async function getResearchList(signal: AbortSignal | undefined): Promise<Response> {
  return guard("worker", async () => {
    const { status, data } = await upstreamJson("worker", "/research", { signal });
    const rec = asRecord(data);
    if (rec && Array.isArray(rec.tasks)) {
      rec.tasks = rec.tasks.map((t: any) => {
        const id = taskId(t);
        return id ? rewriteLinks("", { id }, t) : t; // no id -> no links
      });
    }
    return jsonResponse(rec ?? data, status);
  });
}

async function getResearch(id: string, signal: AbortSignal | undefined): Promise<Response> {
  return guard("worker", async () => {
    const { status, data } = await upstreamJson("worker", `/research/${enc(id)}`, { signal });
    const rec = asRecord(data);
    if (rec && status === 200) {
      return jsonResponse(rewriteLinks("", { id: taskId(rec) ?? id }, rec), status);
    }
    return jsonResponse(data, status);
  });
}

async function deleteResearch(id: string, signal: AbortSignal | undefined): Promise<Response> {
  return guard("worker", async () => {
    // Status + JSON body passthrough (200 removed / 409 running / 404 unknown
    // on the worker; every non-2xx body passes through verbatim).
    const { status, data } = await upstreamJson("worker", `/research/${enc(id)}`, {
      method: "DELETE",
      signal,
    });
    return jsonResponse(data, status);
  });
}

async function getReport(id: string, signal: AbortSignal | undefined): Promise<Response> {
  return guard("worker", async () => {
    // Bytes passthrough preserves the upstream content-type on ok and its
    // error body (409/404) verbatim.
    return toResponse(await upstreamBytes("worker", `/research/${enc(id)}/report`, { signal }), signal);
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
  if (validate !== null && validate !== "true" && validate !== "false") {
    return jsonResponse({ error: `validate must be "true" or "false"` }, 400);
  }

  const signal = clientSignal(req);
  try {
    // a) task must exist and be completed
    const { status, data } = await upstreamJson("worker", `/research/${enc(id)}`, { signal });
    if (status === 404) return jsonResponse({ error: "not found" }, 404);
    if (status < 200 || status >= 300) return jsonResponse(data, status); // transient upstream error: passthrough
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
    const reportRes = await upstreamFetch("worker", `/research/${enc(id)}/report`, { signal });
    if (!reportRes.ok) return passthroughJson(reportRes, "worker", signal);
    const reportText = await readText(reportRes, signal);
    if (signal?.aborted) return new Response(null, { status: 204 }); // client gone; release done via cancel
    return renderViaPaperbot(reportText, format, pageFormat, title, validate, signal);
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
  signal: AbortSignal | undefined,
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
      signal,
    });
    return toResponse(result, signal);
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
      signal: clientSignal(req),
    });
    return toResponse(result, clientSignal(req));
  });
}

// --- /documents (RAG staging, proxied to the worker) -----------------------
//
// GET/DELETE are JSON passthroughs; POST is a raw byte passthrough (multipart
// upload) mirroring postRender — the client abort signal is threaded in, so an
// abandoned upload releases the upstream socket mid-body.

async function getDocuments(signal: AbortSignal | undefined): Promise<Response> {
  return guard("worker", async () => {
    // {staged, on_disk, indexed} — best-effort on the worker, never a 5xx.
    const { status, data } = await upstreamJson("worker", "/documents", { signal });
    return jsonResponse(data, status);
  });
}

async function postDocuments(req: Request): Promise<Response> {
  return guard("worker", async () => {
    const qs = new URL(req.url).search; // verbatim, includes leading "?" when present
    const headers: Record<string, string> = {};
    const ct = req.headers.get("content-type");
    if (ct) headers["content-type"] = ct;
    const result = await upstreamBytes("worker", `/documents${qs}`, {
      method: "POST",
      headers,
      body: req.body,
      signal: clientSignal(req),
    });
    return toResponse(result, clientSignal(req));
  });
}

async function deleteDocuments(signal: AbortSignal | undefined): Promise<Response> {
  return guard("worker", async () => {
    const { status, data } = await upstreamJson("worker", "/documents", {
      method: "DELETE",
      signal,
    });
    return jsonResponse(data, status);
  });
}
