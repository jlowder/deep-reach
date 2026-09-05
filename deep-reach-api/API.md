# Unified Deep-Reach API

A Bun + TypeScript glue service (zero runtime deps) that puts one base URL in
front of the two deep-reach upstreams:

- **deep-reach-worker** (`WORKER_URL`, default `http://localhost:8321`) — the
  async 5-stage deep-research pipeline; owns the in-memory task store
  ([its API](../deep-reach-worker/API.md)).
- **deep-reach-backend** / **paperbot** (`PAPERBOT_URL`, default
  `http://localhost:8322`) — renders a structured document to PDF or HTML
  ([its API](../deep-reach-backend/API.md)).

The service is a pure aggregator: it adds no state, no auth, and no pipeline
logic of its own. Its value is a single public surface for the whole flow —
start a run, poll it, download the rendered PDF/HTML — plus CORS on every
response and a `/health` that probes both upstreams.

## Running

```bash
bun install      # dev deps only (typescript, @types/bun); no runtime deps
bun run dev      # watch mode (or: bun start)
```

Bun auto-loads `.env` from the working directory (see `.env.example`).
Invalid values fail fast at startup with a descriptive error.

| Variable             | Default                 | Meaning                                                                                   |
| -------------------- | ----------------------- | ----------------------------------------------------------------------------------------- |
| `PORT`               | `8320`                  | Port this service listens on                                                              |
| `HOST`               | `0.0.0.0`               | Bind address                                                                              |
| `WORKER_URL`         | `http://localhost:8321` | Base URL of deep-reach-worker                                                             |
| `PAPERBOT_URL`       | `http://localhost:8322` | Base URL of deep-reach-backend (paperbot)                                                 |
| `UPSTREAM_TIMEOUT_MS`| `300000`                | Timeout per upstream call, in ms (5 min). Does not apply to the `/health` probes (fixed 5 s) |

Validation: `PORT` must be an integer 1–65535; `HOST` must be an IP address
or `"localhost"` (blank/empty falls back to the default, anything else is a
startup error); `WORKER_URL`/`PAPERBOT_URL` must be base URLs **without a path
or query** (blank/empty falls back to the default). Invalid values exit before
the server binds, with a message naming the variable.

## Endpoints

| Method | Path                     | Purpose                                                          |
| ------ | ------------------------ | ---------------------------------------------------------------- |
| POST   | `/research`              | Start a research run (proxied to worker) → 202 with task id       |
| GET    | `/research`              | List all tasks (worker), each augmented with `links`              |
| GET    | `/research/{id}`         | Full task record (worker) + `links`                               |
| GET    | `/research/{id}/report`  | Structured report JSON (worker)                                   |
| GET    | `/research/{id}/download`| Completed run → rendered PDF/HTML bytes (worker report → paperbot) |
| POST   | `/render`                | Raw passthrough to paperbot's `/render`                           |
| GET    | `/health`                | Probe both upstreams in parallel; always 200                     |
| GET    | `/`                      | Service index                                                     |

All responses carry the same CORS headers as deep-reach-backend (paperbot):
`Access-Control-Allow-Origin: *` (fixed — no origin reflection, no `Vary`),
`Access-Control-Allow-Methods: GET, POST, OPTIONS`,
`Access-Control-Allow-Headers: content-type`. Non-preflight responses add one
thing paperbot does not: `Access-Control-Expose-Headers: content-type,
content-disposition, x-paperbot-warnings`, so browsers can read the metadata
of streamed download/render bytes. `OPTIONS` preflights (any path, including
unknown routes) are answered **204** with those headers, no body, and no
upstream contact. Trailing slashes are normalized (`/research/` routes to
`/research`).

## GET /

```json
{
  "service": "deep-reach-api",
  "version": "0.1.0",
  "endpoints": [
    "POST /research",
    "GET /research",
    "GET /research/{id}",
    "GET /research/{id}/report",
    "GET /research/{id}/download",
    "POST /render",
    "GET /health"
  ]
}
```

## GET /health

Always **200**. Probes `GET /health` on both upstreams in parallel, with a
fixed 5 s timeout each. Each upstream's JSON payload is spread into the
result, with `ok` added:

- upstream responded 2xx → `{…upstream payload, "ok": true}`
- upstream responded non-2xx → `{…upstream payload, "ok": false, "status": <n>}`
  (non-JSON bodies are truncated to 500 chars into `error`)
- network failure or timeout → `{ "ok": false, "error": "<name> unreachable" }`
  / `{ "ok": false, "error": "<name> timed out" }`

Typical response with both upstreams healthy:

```json
{
  "service": "deep-reach-api",
  "worker":   { "service": "multi-agent-rag-researcher", "running": false, "deep_configured": true, "ok": true },
  "paperbot": { "service": "paperbot", "version": "0.1.0", "pdf_ready": true, "chromium_available": true, "ok": true }
}
```

`worker.running` is true while the worker has a task in progress; check it
before posting a new topic.

## POST /research

Proxies the request body **byte-for-byte** (including non-UTF-8 payloads —
it is streamed, not re-encoded) and the `content-type` header (default
`application/json`) to the worker's `POST /research`. Body fields (the
worker's contract):

| Field        | Type | Default | Meaning                                              |
| ------------ | ---- | ------- | ---------------------------------------------------- |
| `topic`      | string | —    | Research query. Required, must be non-empty.         |
| `max_rounds` | int  | `3`     | Max investigation rounds per sub-question.           |
| `budget_doc` | int  | `10`    | Max doc chunks kept per sub-question.                |
| `budget_web` | int  | `5`     | Max web results kept per sub-question.               |

**202** — the worker's create response, with `links` rewritten to point at
*this* service (the three canonical keys are always added or overridden; any
extra link keys the worker provided are kept):

```json
{
  "task_id": "4bd2c028651a4d8091088b48aa14186d",
  "status": "running",
  "current_step": "queued",
  "links": {
    "status": "/research/4bd2c028651a4d8091088b48aa14186d",
    "report": "/research/4bd2c028651a4d8091088b48aa14186d/report",
    "download": "/research/4bd2c028651a4d8091088b48aa14186d/download"
  }
}
```

Link paths are root-relative to this service.

**Other statuses** — the worker's error body and status pass through
verbatim:

| Status | When                                                                  |
| ------ | ---------------------------------------------------------------------- |
| 409    | A run is already in progress: `{"error": "a research run is already in progress", "running_task_id": "<id>"}` |
| 422    | Invalid body (e.g. missing or empty `topic`)                          |

## GET /research

Worker's task list, with `links` (`status` / `report` / `download`) added to
every item:

```json
{
  "tasks": [
    {
      "id": "4bd2c0…",
      "topic": "What is a vector field",
      "status": "running",
      "current_step": "draft: drafting 1 section(s)",
      "step_count": 5,
      "started_at": 1788272018.03,
      "finished_at": null,
      "error": null,
      "links": { "status": "/research/4bd2c0…", "report": "/research/4bd2c0…/report", "download": "/research/4bd2c0…/download" }
    }
  ]
}
```

## GET /research/{id}

**200** — the worker's full task record + `links`:

```json
{
  "id": "4bd2c0…",
  "topic": "What is a vector field",
  "status": "completed",
  "current_step": "assemble: complete (structured): 1 section(s), 3 source(s)",
  "steps": [
    { "stage": "decompose", "detail": "decomposing query: What is a vector field", "ts": 1788272018.1 }
  ],
  "started_at": 1788272018.03,
  "finished_at": 1788272243.33,
  "stats": { "llm_calls": 5, "wall_s": 225.3, "sections": 1, "revisions": 1 },
  "links": { "status": "/research/4bd2c0…", "report": "/research/4bd2c0…/report", "download": "/research/4bd2c0…/download" }
}
```

`status` is `running`, `completed`, or `failed`; `error` is present only on
failure and `stats` only once the run produced a result (worker semantics).

| Status | When                                                        |
| ------ | ----------------------------------------------------------- |
| 400    | Malformed percent-encoding in the id: `{"error": "invalid task id"}` |
| 404    | Unknown id — worker's body passes through: `{"error": "unknown task: <id>"}` |

## GET /research/{id}/report

Streams the worker's finished report byte-for-byte
(`Content-Type: application/json`) — the same `{schema_version, report,
quality}` envelope paperbot consumes:

```json
{
  "schema_version": "1.0",
  "report": {
    "metadata": { "title": "Vector Field Overview" },
    "executive_summary": ["…"],
    "sections": [ { "id": "sq1", "heading": "Definition of vector field", "blocks": ["…"] } ],
    "sources": ["…"]
  },
  "quality": { "total_words": 265 }
}
```

| Status | When                                                        |
| ------ | ----------------------------------------------------------- |
| 409    | While running or failed — worker's body passes through: `{"status": "running"}` / `{"status": "failed"}` |
| 404    | Unknown id: `{"error": "unknown task: <id>"}`               |

## GET /research/{id}/download

The one-stop deliverable: gates on the task's state, fetches the worker's
report, renders it via paperbot, and streams the file back.

Query parameters:

| Name          | Values                                           | Default    |
| ------------- | ------------------------------------------------ | ---------- |
| `format`      | `pdf` \| `html`                                  | `pdf`      |
| `page_format` | `letter` \| `a4` \| `legal` \| `a5` \| `tabloid` | `letter`   |
| `title`       | free text (paperbot title override)              | — (report's own title) |
| `validate`    | `true` \| `false`                                | — (paperbot's default, `true`) |

Behavior, in order:

1. **Enum validation** (checked first, even for unknown ids):
   - `400 {"error": "format must be one of: pdf, html"}`
   - `400 {"error": "page_format must be one of: letter, a4, legal, a5, tabloid"}`
   - `400 {"error": "validate must be \"true\" or \"false\""}` (for any other value)
2. **Task-state gating** (from the worker's task record):
   | Status | Response                                                              |
   | ------ | ---------------------------------------------------------------------- |
   | 404    | Unknown task: `{"error": "not found"}`                                |
   | worker's 5xx/4xx | The task-record probe is not 2xx/404 (e.g. a transient worker error): the worker's status and body pass through unchanged |
   | 409    | `running`/`queued` task: `{"status": "running" \| "queued", "task_id": "<id>"}`; any other non-completed status: `{"error": "task is not downloadable (status: <s>)", "task_id": "<id>"}` |
   | 502    | `failed` task: `{"error": "<worker's error, else 'research task failed'>", "task_id": "<id>"}` |
3. **Render** (completed tasks): the worker report is posted to paperbot's
   `POST /render` with the same options and the result is streamed back
   byte-for-byte, headers preserved:
   - `format=pdf` → `Content-Type: application/pdf`,
     `Content-Disposition: attachment; filename="<slug>.pdf"` (slug from the
     title), `X-Paperbot-warnings: <n>`
   - `format=html` → `Content-Type: text/html; charset=utf-8`,
     `X-Paperbot-warnings: <n>`
   - paperbot errors (400/413/500/503) pass through as its JSON `{"error": …}`

## POST /render

Raw passthrough to paperbot: the body, the `content-type` header (when
present), and the query string are forwarded verbatim, and paperbot's
response is returned byte-for-byte (200 file bytes or its JSON error body and
status). All of paperbot's request shapes work unchanged — wrapped
`{document|markdown, …}`, raw document JSON, or `text/plain` markdown — and
its query options (`format`, `page_format`, `title`, `validate`); see
[paperbot's docs](../deep-reach-backend/API.md) for the full contract, body
limit (10 MB), and error/warning tables. This endpoint is the escape hatch
for rendering arbitrary documents that did not come out of `/research`.

## Everything else

- `OPTIONS` (any path) → **204**, no body, CORS headers; upstreams are never
  contacted for preflights.
- `HEAD` is handled as `GET` (status + headers only; the body is not sent).
- Any other method/path → **404** `{"error": "not found"}`.

## Error semantics

Upstream error responses (non-2xx) pass through with the upstream's status
and body — JSON stays JSON, non-JSON bodies are truncated to 500 chars.
Transport-level failures are synthesized by this service:

| Trigger                                                        | Status | Body                                                                      |
| -------------------------------------------------------------- | ------ | ------------------------------------------------------------------------- |
| Upstream unreachable (DNS failure, connection refused, …)       | 502    | `{"error": "<name> unreachable", "detail": "<cause>"}`                    |
| Upstream slower than `UPSTREAM_TIMEOUT_MS`                      | 504    | `{"error": "<name> timed out", "detail": "no response from <url> within <N>ms"}` |
| An ok response whose body is not JSON, on a JSON-expected route | 502    | `{"error": "<name> returned invalid JSON", "detail": "<first 500 chars of body>"}`  |
| Any other internal error                                        | 500    | `{"error": "internal error", "detail": "<message>"}`                      |

`<name>` is `worker` or `paperbot`. The `/health` probes are the exception:
transport failures there are reported inside the 200 body (`ok: false`)
instead of as 5xx.

## Typical user flow

1. `POST /research` with `{topic, max_rounds?, budget_doc?, budget_web?}` → 202 with `task_id`.
2. Poll `GET /research/{id}` (≈ every 10 s) until `status` becomes `completed`; watch `current_step` advance through `decompose → investigate → draft → critique → assemble`.
3. `GET /research/{id}/download?format=pdf` → the rendered PDF (`?format=html` for a web view).

```bash
# 1. Start a run
curl -s -X POST localhost:8320/research -H 'content-type: application/json' \
  -d '{"topic":"What is a vector field","max_rounds":1,"budget_doc":2,"budget_web":1}'
# → {"task_id":"4bd2c0…","status":"running","current_step":"queued","links":{…}}

# 2. Poll until status becomes "completed"
curl -s localhost:8320/research/4bd2c0…

# 3. Download the rendered PDF
curl -s 'localhost:8320/research/4bd2c0…/download?format=pdf' -o report.pdf
```

Inherited from the worker: **one research run at a time** — `POST /research`
answers 409 while a run is in progress — and a **45-minute watchdog** that
marks overlong runs `failed` (a watchdog-failed run keeps 409-ing new posts
until it finishes on its own).

## Notes

- No authentication: bind to localhost or put the service (and both
  upstreams) behind an authenticating proxy.
- CORS mirrors paperbot's deliberately permissive setup (`*` origin, fixed
  method/header allow-lists, no credentials) so browser front-ends work out
  of the box; restrict origins at a proxy if exposed to untrusted networks.
- Stateless single process: the only state that exists is the worker's
  in-memory task store — a worker restart loses its tasks.
- Implementation is five small files: `src/config.ts` (env load +
  validation), `src/app.ts` (router), `src/cors.ts` (paperbot-compatible
  CORS), `src/upstream.ts` (transport: timeout, error mapping, body
  passthrough, link rewriting), and `src/index.ts` (entry). Run with
  [Bun](https://bun.sh); `bun run typecheck` for types.
