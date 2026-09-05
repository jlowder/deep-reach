// Manual CORS mirroring deep-reach-backend (paperbot) exactly.
//
// Paperbot sets these in an unconditional fastify onSend hook and answers
// every OPTIONS in an onRequest hook (204, no body, no route or upstream
// touched). We replicate that: fixed "*" origin (no origin reflection, no
// Vary), fixed methods, fixed allow-headers, no credentials, no max-age.
//
// One deliberate addition: Access-Control-Expose-Headers on real (non-204)
// responses, so browsers can read content-disposition / x-paperbot-warnings
// on the streamed /download and /render byte responses. Paperbot exposes
// nothing (consumed same-origin), but this API hands those bytes to
// cross-origin browser clients.

export const ALLOW_ORIGIN = "*";
export const ALLOW_METHODS = "GET, POST, OPTIONS";
export const ALLOW_HEADERS = "content-type";
export const EXPOSE_HEADERS = "content-type, content-disposition, x-paperbot-warnings";

/** Paperbot's exact CORS header set (its onSend hook). */
function applyCors(headers: Headers): void {
  headers.set("access-control-allow-origin", ALLOW_ORIGIN);
  headers.set("access-control-allow-methods", ALLOW_METHODS);
  headers.set("access-control-allow-headers", ALLOW_HEADERS);
}

/** Preflight (any path): 204 + paperbot headers. Never contacts upstreams. */
export function preflight(): Response {
  const headers = new Headers();
  applyCors(headers);
  return new Response(null, { status: 204, headers });
}

/** Clone a response with paperbot's CORS headers plus expose-headers. */
export function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  applyCors(headers);
  headers.set("access-control-expose-headers", EXPOSE_HEADERS);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
