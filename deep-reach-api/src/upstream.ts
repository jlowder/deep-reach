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
  | { kind: "bytes"; status: number; headers: Headers; body: UpstreamBody }
  | { kind: "error"; status: number; data: unknown };

const baseFor = (name: UpstreamName): string =>
  name === "worker" ? config.workerUrl : config.paperbotUrl;

function absoluteUrl(name: UpstreamName, path: string): string {
  const base = baseFor(name).replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Fetch an upstream with a timeout. Resolves with the raw Response (caller
 * inspects .status); throws UpstreamError 504 on timeout, 502 on network
 * failure.
 */
export async function upstreamFetch(
  name: UpstreamName,
  path: string,
  init: RequestInit = {},
  timeoutMs: number = config.upstreamTimeoutMs,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(absoluteUrl(name, path), { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
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
 * Fetch + JSON-decode an upstream response. Both ok and error bodies pass
 * through with the upstream's status.
 */
export async function upstreamJson(
  name: UpstreamName,
  path: string,
  init?: RequestInit,
): Promise<UpstreamJsonResult> {
  const res = await upstreamFetch(name, path, init);
  const text = await res.text();
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
  extraHeaders?: Record<string, string>,
): Promise<UpstreamBytesResult> {
  const headers = new Headers(init?.headers);
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
  }
  const res = await upstreamFetch(name, path, { ...init, headers });
  if (!res.ok) {
    const text = await res.text();
    return { kind: "error", status: res.status, data: errorData(name, res.status, text) };
  }
  const body: UpstreamBody = res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() });
  return { kind: "bytes", status: res.status, headers: res.headers, body };
}

/** Serialize an upstreamBytes result: stream bytes (headers preserved) or JSON the error. */
export function toResponse(result: UpstreamBytesResult): Response {
  if (result.kind === "bytes") {
    return withCors(new Response(result.body, { status: result.status, headers: result.headers }));
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
export function jsonResponse(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return withCors(new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } }));
}

/** Map any error raised during an upstream call to a client Response. */
export function mapUpstreamError(err: unknown, name: UpstreamName): Response {
  if (err instanceof UpstreamError) {
    return jsonResponse(
      { error: err.status === 504 ? `${name} timed out` : `${name} unreachable`, detail: err.detail },
      err.status,
    );
  }
  return jsonResponse(
    { error: "internal error", detail: err instanceof Error ? err.message : String(err) },
    500,
  );
}
