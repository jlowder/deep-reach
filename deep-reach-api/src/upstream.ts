// HTTP proxy helpers for the two upstreams (deep-reach-worker, paperbot).
// Pure transport plumbing: timeout, error mapping, body passthrough, link
// rewriting, CORS. Route files call into this; no routing logic lives here.

import { config } from "./config.ts";
import { withCors } from "./cors.ts";

export type UpstreamName = "worker" | "paperbot";

/** Transport-level failure talking to an upstream (network error or timeout). */
export class UpstreamError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

/** Non-null response body stream type. */
export type UpstreamBody = NonNullable<Response["body"]>;

export interface UpstreamJsonResult {
  status: number;
  data: unknown;
}

export type UpstreamBytesResult =
  | {
      kind: "bytes";
      status: number;
      headers: Headers;
      body: UpstreamBody;
      /** Abort the upstream fetch (releases the upstream socket for a gone client). */
      release: () => void;
    }
  | { kind: "error"; status: number; data: unknown };

/**
 * Controllers of live upstream fetches, keyed by their Response. In Bun,
 * aborting the fetch's own signal is what tears down the upstream socket for
 * a body that is already streaming (calling body.cancel() on the Response's
 * stream does not propagate to the fetch).
 */
const controllers = new WeakMap<Response, AbortController>();

/** Abort the upstream fetch that produced `res`; no-op for foreign responses. */
export function releaseUpstream(res: Response): void {
  try {
    controllers.get(res)?.abort();
  } catch {
    /* already settled */
  }
}

const baseFor = (name: UpstreamName): string =>
  name === "worker" ? config.workerUrl : config.paperbotUrl;

function absoluteUrl(name: UpstreamName, path: string): string {
  const base = baseFor(name).replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Fetch an upstream with a deadline timeout. Resolves with the raw Response
 * (caller inspects .status); throws UpstreamError 504 on timeout, 502 on
 * network failure. A client signal in init is threaded in for the response's
 * whole lifetime: if the client goes away (mid-flight or mid-body), the
 * upstream request is aborted so the upstream socket is released. Release the
 * Response with releaseUpstream() if the client abandons a streamed body.
 */
export async function upstreamFetch(
  name: UpstreamName,
  path: string,
  init: RequestInit = {},
  timeoutMs: number = config.upstreamTimeoutMs,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const clientSignal = init.signal ?? null;
  const onClientAbort = () => controller.abort();
  if (clientSignal) {
    if (clientSignal.aborted) controller.abort();
    else clientSignal.addEventListener("abort", onClientAbort, { once: true });
  }
  try {
    const res = await fetch(absoluteUrl(name, path), { ...init, signal: controller.signal });
    controllers.set(res, controller);
    return res;
  } catch (err) {
    if (controller.signal.aborted) {
      if (clientSignal?.aborted) {
        // Client went away; rethrow the fetch abort so the route bails out
        // without manufacturing a spurious 504 for a dead client.
        throw err;
      }
      throw new UpstreamError(
        504,
        `${name} timed out`,
        `no response from ${baseFor(name)} within ${timeoutMs}ms`,
      );
    }
    throw new UpstreamError(
      502,
      `${name} unreachable`,
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    clearTimeout(timer);
    // Note: the client-abort listener is intentionally kept until the signal
    // (i.e. the client request) is released, so it also covers mid-body.
  }
}

/** Upstream error body passthrough: parsed JSON verbatim, else raw text (truncated). */
function errorData(name: UpstreamName, status: number, text: string): unknown {
  if (text.length > 0) {
    try {
      return JSON.parse(text);
    } catch {
      return { error: text.slice(0, 500) };
    }
  }
  return { error: `${name} returned ${status} with an empty body` };
}

/**
 * Read a response body as text, releasing the upstream if the client aborts
 * first (Bun does not cancel a fetch body from the reader side). Rejects if
 * the release wins the race; callers treat that as a dead client.
 */
export async function readText(res: Response, signal?: AbortSignal | null): Promise<string> {
  let onAbort: (() => void) | undefined;
  if (signal) {
    onAbort = () => {
      releaseUpstream(res);
      res.body?.cancel().catch(() => {});
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    return await res.text();
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Fetch + JSON-decode an upstream response. Both ok and error bodies pass
 * through with the upstream's status.
 */
export async function upstreamJson(
  name: UpstreamName,
  path: string,
  init?: RequestInit,
): Promise<UpstreamJsonResult> {
  const res = await upstreamFetch(name, path, init);
  const text = await readText(res, init?.signal);
  if (!res.ok) return { status: res.status, data: errorData(name, res.status, text) };
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    throw new UpstreamError(502, `${name} returned invalid JSON`, text.slice(0, 500));
  }
}

/**
 * Fetch an upstream whose body must stream byte-for-byte (e.g. render output).
 * Non-ok responses come back as the error variant carrying the upstream error
 * body; use toResponse to serialize either variant.
 */
export async function upstreamBytes(
  name: UpstreamName,
  path: string,
  init?: RequestInit,
): Promise<UpstreamBytesResult> {
  const headers = new Headers(init?.headers);
  const res = await upstreamFetch(name, path, { ...init, headers });
  if (!res.ok) {
    const text = await readText(res, init?.signal);
    return { kind: "error", status: res.status, data: errorData(name, res.status, text) };
  }
  const body: UpstreamBody = res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() });
  return { kind: "bytes", status: res.status, headers: res.headers, body, release: () => releaseUpstream(res) };
}

/**
 * Serialize an upstreamBytes result: stream bytes (headers preserved) or JSON
 * the error. With the client's abort signal, releases the upstream fetch when
 * the client goes away mid-stream so the upstream socket is closed.
 */
export function toResponse(result: UpstreamBytesResult, clientSignal?: AbortSignal | null): Response {
  if (result.kind === "bytes") {
    const res = withCors(new Response(result.body, { status: result.status, headers: result.headers }));
    if (clientSignal) {
      const release = () => {
        result.release();
        result.body.cancel().catch(() => {});
      };
      if (clientSignal.aborted) release();
      else clientSignal.addEventListener("abort", release, { once: true });
    }
    return res;
  }
  return jsonResponse(result.data, result.status);
}

/**
 * Rewrite/ensure public `links` on a worker research task record. Keeps any
 * upstream-provided link keys; adds (or overrides) the three canonical paths.
 */
export function rewriteLinks(base: string, task: { id: string }, json: any): any {
  if (typeof json !== "object" || json === null) return json;
  const prefix = base.replace(/\/+$/, "");
  const existing = typeof json.links === "object" && json.links !== null ? json.links : {};
  return {
    ...json,
    links: {
      ...existing,
      status: `${prefix}/research/${task.id}`,
      report: `${prefix}/research/${task.id}/report`,
      download: `${prefix}/research/${task.id}/download`,
    },
  };
}

/** JSON response with CORS applied. */
export function jsonResponse(data: unknown, status = 200): Response {
  return withCors(
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
  );
}

/** Map any error raised during an upstream call to a client Response. */
export function mapUpstreamError(err: unknown, name: UpstreamName): Response {
  if (err instanceof UpstreamError) {
    // err.message is client-safe and specific ("worker unreachable", "worker
    // timed out", "worker returned invalid JSON"); detail adds context.
    return jsonResponse({ error: err.message, detail: err.detail }, err.status);
  }
  return jsonResponse(
    { error: "internal error", detail: err instanceof Error ? err.message : String(err) },
    500,
  );
}
