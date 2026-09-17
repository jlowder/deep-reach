# API Server

A FastAPI service exposing the 5-stage deep-research pipeline over HTTP. POST a topic to get a task id, poll status and current step, then GET the finished report as the structured JSON envelope (`{schema_version, report, quality}`) that paperbot consumes for PDF/HTML rendering.

## Overview

- Same pipeline as the Gradio UI's deep mode (`deep_research` in `deep_research_orchestrator.py`) — just the HTTP layer, no UI.
- In-memory task store: single process; tasks do not survive a restart.
- One run at a time, FIFO queue: `deep_research` holds a process lock, so at most one run executes at a time. A POST accepted while a run is in progress is **queued** (status `pending`, `current_step` `"queued"`, no thread) and a pump starts the oldest queued task as soon as the pipeline is free — the API never returns 409 for a busy pipeline.
- A per-task watchdog (45 min by default) marks a run that exceeds the deadline as failed. Threads cannot be killed, so a watchdog-killed run keeps executing in the background until it finishes; the queue only advances when the run has **truly** stopped (the pipeline lock is released).
- RAG documents: `POST /documents` stages PDFs for the next created research task (magic-checked, name-sanitized, deduped); they are ingested at task start and removed from disk on task exit (see Documents below).
- The finished report is the canonical `ResearchReport` JSON (the same structured document deep mode saves under `reports/`), which is exactly what paperbot's `POST /render` accepts.

## Quick start

Dependencies are pinned in `utils/requirements.txt` (`fastapi`, `uvicorn`):

```bash
pip3 install -r utils/requirements.txt
venv/bin/python api_server.py   # PORT env (default 8321), HOST env (default 0.0.0.0)
```

The service needs the LLM configuration from `utils/var.env` (`LLM_ENDPOINT`, `LLM_API_KEY`, `LLM_MODEL`, with `OPENAI_*` fallbacks) to actually run research. Optional tuning: `DECOMPOSER_MODEL` overrides the model for the decomposition stage only; `DECOMPOSER_MAX_OUTPUT_TOKENS` (default 8000) caps its output — it must fit reasoning tokens **and** the plan JSON, because thinking tokens share the completion budget; `DECOMPOSER_THINKING_BUDGET` (default 1024, `0` = use the global `LLM_ENABLE_THINKING` default) caps reasoning tokens per decompose call on servers that honor `thinking_budget` (the local omlx/MLX server does — it only enforces the budget when the prompt ends with an open think tag, which this setting forces for those calls). Check before posting topics:

```bash
curl -s localhost:8321/health
# {"service":"multi-agent-rag-researcher","running":false,"pending":0,"queue":{"paused":false,"pending":0},"deep_configured":true}
```

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/research` | Start or queue a run → 202 with task id (queued as `pending` while one is running — or while the queue is paused — 422 on invalid body) |
| GET | `/research` | List all tasks (summaries) + queue state |
| GET | `/research/{id}` | Full task record: status, current_step, step timeline, stats |
| DELETE | `/research/{id}` | Remove a queued/finished task → 200 {deleted, documents} (409 while running, 404 unknown) |
| GET | `/research/{id}/report` | Raw structured report JSON once completed |
| GET | `/queue` | Queue state → {paused, pending, running} (in-memory; resets on restart) |
| PUT | `/queue` | Pause / resume the queue → 200 queue shape (400 on non-boolean `paused`) |
| GET | `/health` | Service status, incl. whether the deep pipeline is configured |
| POST | `/documents` | Stage PDF files for the next research task → 201 {documents, rejected} (400 if all rejected) |
| GET | `/documents` | {staged, on_disk, indexed} |
| DELETE | `/documents` | Remove all staged documents → 200 {removed} |
| GET | `/settings` | Dialog state — secrets as presence+source, never key values |
| PUT | `/settings` | Save settings; hot-applies to the next run (embeddings need a restart) |
| POST | `/settings/test` | One-shot live check of the llm / search / embedding configuration |

### POST /research

Body:

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `topic` | string | — | Research query. Required, must be non-empty. |
| `max_rounds` | int | 3 | Max investigation rounds per sub-question. |
| `budget_doc` | int | 10 | Max doc chunks kept per sub-question. |
| `budget_web` | int | 5 | Max web results kept per sub-question. |

202 Accepted — the run starts immediately when the pipeline is free, or is queued (FIFO) when a run is in progress:

```json
{
  "task_id": "4bd2c028651a4d8091088b48aa14186d",
  "status": "running",
  "current_step": "queued",
  "max_rounds": 3,
  "budget_doc": 10,
  "budget_web": 5,
  "documents": ["alpha.pdf"],
  "links": {
    "status": "/research/4bd2c028651a4d8091088b48aa14186d",
    "report": "/research/4bd2c028651a4d8091088b48aa14186d/report"
  }
}
```

`status` is `"running"` when the task starts immediately, or `"pending"` when it is queued behind an in-progress run (the body shape is otherwise identical; `current_step` stays `"queued"` until the pump promotes the task, and — as for any new run — until the pipeline's first stage callback updates it). `documents` lists the RAG documents the staging area handed to this task (empty when nothing was staged; always present). Queued tasks are started oldest-first (FIFO) as the pipeline frees up, with no further client action.

Other responses:

- 422, invalid body (e.g. empty `topic`)

### GET /research

```json
{
  "tasks": [
    {
      "id": "4bd2c0…",
      "topic": "What is a vector field",
      "status": "running",
      "current_step": "draft: drafting 1 section(s)",
      "max_rounds": 3,
      "budget_doc": 10,
      "budget_web": 5,
      "step_count": 5,
      "started_at": 1788272018.03,
      "finished_at": null,
      "error": null
    }
  ],
  "queue": {"paused": false, "pending": 1}
}
```

### GET /research/{id}

200 — the full record (`error` present only on failure; `stats` present only after the run produced a result):

```json
{
  "id": "4bd2c0…",
  "topic": "What is a vector field",
  "status": "completed",
  "current_step": "assemble: complete (structured): 1 section(s), 3 source(s)",
  "steps": [
    {"stage": "documents", "detail": "indexing 1 document(s)", "ts": 1788272018.0}
  ],
  "started_at": 1788272018.03,
  "finished_at": 1788272243.33,
  "max_rounds": 3,
  "budget_doc": 10,
  "budget_web": 5,
  "stats": {"llm_calls": 5, "wall_s": 225.3, "sections": 1, "revisions": 1, "last_llm_error": null, "llm_call_log": [{"stage": "decomposer", "model": "Ornith-1.5-35B-A3B-MLX-8bit", "tokens_in": 1100, "tokens_out": 1953, "reasoning_out": 1034, "finish_reason": null, "ms": 21520, "capped": false}]},
  "quality": {
    "citation_density": {"overall": 0.42, "per_section": {"<heading>": 0.5}},
    "verification": {
      "confidence": "medium",
      "coverage": "moderate",
      "gaps": [],
      "unresolvable_citations": ["D2"],
      "dropped_bare_citations": ["7"],
      "normalized_citations": {"bare_key_rewrites": 2, "adjacent_duplicates_collapsed": 5, "title_brackets_stripped": 3, "empty_brackets_removed": 1, "key_groups_removed": 1, "terminal_periods_inserted": 2, "repeated_cites_collapsed": 3},
      "decoded_unicode_escapes": 6
    },
    "sources_count": {"documents": 1, "web": 3},
    "total_words": 1834
  },
  "documents": ["alpha.pdf"]
}
```

`max_rounds` / `budget_doc` / `budget_web` are the requested budgets, stored on the record at creation (same defaults as the POST body: 3 / 10 / 5) so a finished run can be diagnosed against the parameters it ran with. `stats` is present only after the run produced a result: `llm_calls` (total LLM calls, the budget counter), `wall_s`, `sections`, `revisions`, `last_llm_error` (the last LLM error captured this run, `null` when none — the failure-surface for zero-section runs), and `llm_call_log` — one entry per LLM call of THIS run (`stage` = `decomposer` / `sufficiency/retriever` / `writer` / `critic` / `synthesis`), each `model`, `tokens_in`, `tokens_out`, `reasoning_out` (omlx's reasoning tokens), `finish_reason` (the server's per-item reason when set, otherwise derived — `"length"` when the completion consumed the full `max_output_tokens` budget, the only reliable truncation signal on a server that reports `status=completed` for a cap-hit stream), `ms`, and `capped` (`tokens_out >= max_output_tokens`). Values the server or SDK omits are `null`; the list is bounded (drop-oldest) and is run-local. `quality` is present only for completed structured (json) runs — it is the `quality` object from the report envelope, computed at assembly, with: `citation_density` (`overall` 0–1 plus `per_section`), `verification` (`confidence`, `coverage`, `gaps`, `unresolvable_citations` — keys cited in the body but absent from the source registry, `dropped_bare_citations` — bare numbers removed, `normalized_citations` — deterministic, non-blocking counts of citation-mark fixes applied at assembly: bare registry keys resolved to titles in callout/note prose, adjacent identical bracket groups collapsed `[X][X]`→`[X]`, registered-title brackets stripped to bare mentions, empty bracket pairs removed, `key_groups_removed` — `[W#]`/`[D#]` key groups whose entire content is a registered-key list, removed when the span also carries a non-empty citations array (the renderer would otherwise print the numbers AND the keys; groups containing an unregistered key are left as the only trace of the reference), `terminal_periods_inserted` — a terminal `.` appended to a cited sentence-final span missing one (only when the next span in the same paragraph starts an uppercase, non-exception first word — never across paragraph boundaries), `repeated_cites_collapsed` — consecutive clause spans repeating an identical non-empty citation set collapsed to the last span (real sentence boundaries keep both); `decoded_unicode_escapes` — count of JSON-style `\uXXXX` escapes (exactly 4 hex digits, case-insensitive, not followed by another hex digit) decoded at assembly: `\u2014`→`—` etc.; a math region that is a single such escape unwraps its `$…$`/`$$…$$` delimiters since the decoded char is prose, not math (a model thinking in JSON escapes would otherwise reach KaTeX, where `\u` is the breve accent — the bowl-on-2014 artifact); control-char escapes decode to nothing; code blocks never touched, so a `\uXXXX` in a code sample stays literal), `sources_count` (`documents` / `web`), and `total_words`.

404, unknown id: `{"error": "unknown task: <id>"}`

### DELETE /research/{id}

Removes a task record from the in-memory store (and cleans up its
documents — below). There is no other way to free a finished task's
record; a worker restart also clears all of them.

| Status | When |
| ------ | ---- |
| 200    | `pending` or terminal (`completed`/`failed`) task: the record is popped. Body: `{"deleted": "<id>", "documents": [names cleaned, or []]}` |
| 409    | `running` task: `{"error": "cannot delete a running task", "task_id": "<id>"}` — Python threads cannot be killed, so the run is left to finish on its own (its exit-cleanup still runs, and the task becomes deletable once terminal) |
| 404    | Unknown id: `{"error": "unknown task: <id>"}` |

Document cleanup on delete: a deleted record carrying documents has its
files removed from the docs dir and the vector store reconciled against
what remains — the same idempotent cleanup (unlink `missing_ok` +
reconcile) the run exit performs. For a `pending` task this matters most:
its attached files were never ingested (the task never started), and
removing them plus purging any of their points keeps the next run's corpus
clean. The staging registry is not re-populated (the files belonged to the
deleted task).

Watchdog/zombie interaction: a run the watchdog has marked `failed` may
keep executing in the background (a zombie holding the pipeline lock). Its
record is no longer "running", so deleting it is allowed immediately; the
zombie thread keeps going until the pipeline finishes on its own, and its
own exit-cleanup (idempotent) still runs. Deleting never affects the queue
pump — the queue advances only when the zombie truly stops.

### GET /research/{id}/report

- 200, when completed — the raw report JSON (`Content-Type: application/json`):

```json
{
  "schema_version": "1.0",
  "report": {
    "metadata": {"title": "Vector Field Overview"},
    "executive_summary": ["…"],
    "sections": [{"id": "sq1", "heading": "Definition of vector field", "blocks": ["…"]}],
    "sources": ["…"]
  },
  "quality": {"citation_density": {"…": "…"}, "verification": {"…": "…"}, "sources_count": {"…": "…"}, "total_words": 265}
}
```

- 409, while pending, running, or failed: `{"status": "<status>"}` (plus `"error"` when the record has one — e.g. the orchestrator's failure message or the watchdog timeout)
- 409, when completed **but the run produced no report** (a pipeline exit that never assembled one): `{"error": "no report artifact — the run produced no report", "status": "completed"}` — this endpoint never serves a bare `null` 200
- 404, unknown id: `{"error": "unknown task: <id>"}`

### Queue pause — GET /queue, PUT /queue

Runs are serialized on a single pipeline: at most one task runs at a time, the rest wait as `pending` (FIFO). The queue can be **paused** — `PUT /queue {"paused": true}` — with these semantics:

- **New runs stay `pending` even when the pipeline is idle.** Pausing gates *promotion*, not posting: `POST /research` still returns the usual 202, but nothing starts.
- **Already-running tasks are unaffected.** The flag is consulted only when the pump promotes a pending task, so an in-flight run runs to completion (or failure) exactly as unpaused.
- **Completion while paused does not start the next run.** The after-completion pump fires but is gated, so the backlog waits until resume.
- **Resume** (`{"paused": false}`) pumps immediately: the oldest queued task starts as the pipeline frees, the rest drain FIFO in POST order.

The flag is **in-memory only** and resets to active on worker restart (the task store is in-memory, so the pending backlog is lost on restart regardless).

```bash
curl -s localhost:8321/queue
# {"paused": false, "pending": 2, "running": true}

curl -s -X PUT localhost:8321/queue -H 'content-type: application/json' -d '{"paused": true}'
# {"paused": true, "pending": 2, "running": true}
```

`PUT /queue` requires `{"paused": <boolean>}`; anything else (missing key, string, number, non-object body) → `400 {"error": "invalid queue payload", "details": ["paused must be a boolean"]}`. The `queue` object (without `running`, in the list body: `{paused, pending}`) also appears in `GET /research` and nested in `/health` beside its existing top-level counts.

### GET /health

```json
{"service": "multi-agent-rag-researcher", "running": false, "pending": 0,
 "queue": {"paused": false, "pending": 0},
 "deep_configured": true,
 "settings": {"keyring_available": true, "llm_key_present": true, "search_tool": "searxng"}}
```

`running` is true while any task is executing; `pending` is the count of queued (not yet started) tasks; `queue` nests the pause state beside those counts (`{paused, pending}`); `deep_configured` is true when the config has both an endpoint and an API key; `settings` is the cheap dialog summary (keyring backend availability, LLM key presence, active search tool).

## Settings (dialog backend)

The web settings dialog talks to this service through the unified API glue. Non-secret settings live in `utils/var.env`; API keys live in the **OS keyring** under service `deep-reach` (entries `llm-api-key`, `tavily-api-key`, `embedding-api-key`) with the environment variable as fallback. There is no plaintext-file fallback: a key that is neither in the keyring nor the environment is simply *unresolved*, and any run/test that needs it fails fast naming the exact variable.

**Secret resolution chain:** OS keyring → environment variable (incl. `var.env` values) → refuse. At worker startup the service idempotently migrates live plaintext keys still sitting in `var.env` into the keyring and blanks those lines (with no keyring backend the file is left alone — the env path keeps working).

**Pipeline parity:** the research pipeline resolves the same three keys through the same chain (`get_config()` → `utils.settings.get_secret`), so the dialog, the Test button, and a live run always use the same key; a run whose LLM key is unresolvable is refused at start with `LLM_API_KEY not set — store it in the OS keychain or set the environment variable LLM_API_KEY`.

**Hot-apply:** saved non-embedding settings apply to the **next** run without a restart (the config singleton is invalidated; OpenAI clients re-cache per endpoint:key). Embedding configuration is frozen at import in the vector store, so any change to `EMBEDDING_*` is reported via `requires_restart` and needs a worker restart.

### GET /settings

```json
{
  "llm": {"endpoint": "http://localhost:8080/v1", "model": "Ornith-1.5-35B-A3B-MLX-8bit",
          "thinking": true, "key": {"present": true, "source": "keyring"}},
  "search": {"tool": "searxng", "searxng_url": "http://localhost:8081", "throttle_ms": 1000,
             "tavily_key": {"present": false, "source": null}},
  "embeddings": {"endpoint": "http://localhost:8080/v1", "model": "nomicai-modernbert-embed-base-bf16",
                 "key": {"present": true, "source": "keyring"}},
  "keyring": {"available": true, "backend": "macOS Keyring"},
  "requires_restart": []
}
```

`source` is `"keyring"`, `"env"`, or `null` (unresolved). Key VALUES are never included. `requires_restart` lists `"embeddings"` when the effective embedding config differs from the running (import-frozen) one.

### PUT /settings

```json
{
  "llm": {"endpoint": "http://localhost:8080/v1", "model": "Some-Other-Model", "thinking": false},
  "search": {"tool": "searxng", "searxng_url": "http://localhost:8081", "throttle_ms": 1000},
  "embeddings": {"endpoint": "http://localhost:8080/v1", "model": "nomicai-modernbert-embed-base-bf16"},
  "keys": {"llm": "new-or-empty-string", "tavily": "", "embedding": "keep-current"}
}
```

Rules: any field/section absent = keep current; a key `""` = **delete** the key (keyring + var.env line); validation — `tool` ∈ {tavily, searxng}, `throttle_ms` int 0..5000, endpoints must be http(s) URLs, models non-empty, `thinking` boolean. A key that must be stored with no keyring backend available → 503 naming the environment variable. 200 response = the GET shape + `{"applied": true, "errors": []}`; `requires_restart` reflects the post-save state (embeddings changes surface here).

### POST /settings/test

```json
{"target": "llm", "llm": {"endpoint": "http://localhost:8080/v1", "model": "...", "key": "optional-override"}}
```

`target` is `llm` | `search` | `embedding`; the `llm` / `search` / `embedding` form object (when present) overrides the saved values field-for-field — the dialog uses this to validate before saving. One minimal live call per target (16-token completion / one query through the resolved search tool / one embedding, 30 s timeout each; the search test paces itself per `SEARCH_THROTTLE_MS`):

```json
{"ok": true, "latency_ms": 412, "snippet": "pong"}          // llm
{"ok": true, "latency_ms": 87, "result_count": 5}           // search
{"ok": true, "latency_ms": 63, "dim": 768}                  // embedding
{"ok": false, "error": "LLM_API_KEY not set — store it in the OS keyring or set the environment variable"}
```

Business failures (missing key, unreachable endpoint, throttled engine) return 200 with `ok: false`; malformed bodies return 400.

## Step tracking

`current_step` (and every `steps[]` entry) is populated by the pipeline's `on_stage` / `on_section` progress callbacks. Stage numbers map to `decompose` (1), `investigate` (2), `draft` (3), `critique` (4), `assemble` (5); each drafted section adds a `section i/n` step. A real run of "What is a vector field" (1 round, 1 section) recorded:

```
queued
decompose: decomposing query: What is a vector field
investigate: investigating 1 sub-question(s)
investigate: investigating sub-question 1/1: What is a vector field Definition
draft: drafting 1 section(s)
section 1/1: Definition of vector field
critique: critic pass: checking every drafted section
assemble: assembling final report
assemble: complete (structured): 1 section(s), 3 source(s)
```

Poll `GET /research/{id}` (every ~10 s) and watch `current_step` advance through that sequence. A task with staged RAG documents records one extra first step — `documents: indexing N document(s)` (or `…indexing failed — continuing without local docs`) — before the pipeline's stage steps. Decompose failure handling records extra `decompose` steps naming what happened: `model returned an {empty plan|unusable plan|truncated plan} — re-prompting` (before the single retry — the re-ask appends a trailing no-prose line only), `plan truncated at N tokens — salvaged M complete sub-question(s)` (or `…mid-JSON…` when the server did not report budget exhaustion — recorded INSTEAD of the retry: the completed sub-questions from a cut-off plan are used directly), `re-prompt returned a complete plan — using M sub-questions`, and `re-prompt still returned a {truncated|empty} plan — using single-sub-question fallback`. A truncated plan is one whose JSON brackets are unbalanced (a string-aware scan) or whose completion consumed the output budget; a truncated plan that still yielded at least one complete sub-question is salvaged deterministically (no LLM) and runs as a narrowed plan rather than degenerating to the raw-query fallback.

## Status lifecycle

```
pending ──▶ running ──▶ completed   pipeline returns a report; stats + report stored
   │          │         └──▶ failed  exception (error = "<ExceptionType>: <message>")
   │          │                     or watchdog timeout (error = "timed out after 2700s")
   │          │                     or a pipeline that returned without a report
   │          │                       (error = the orchestrator's failure message, or
   │          │                        "run produced no report")
   └──────────┘ (the pump promotes the oldest pending task to running —
                 a newly promoted task also briefly shows current_step "queued")
```

- **pending** — the run was requested while another run was in progress; it waits in the FIFO queue with no thread, `current_step` `"queued"`.
- **running** — the pump (or an idle POST) started it; a worker thread + watchdog thread are live.
- **completed / failed** — terminal; the worker's exit triggers the pump, which starts the oldest pending task.

A run that drafted **zero sections** (every section-draft call failed — e.g. a rejected API key: each 401 is caught per section and the run used to "complete" empty) finalizes **failed** with `run produced no sections — last LLM error: <captured error>`; zero *sources* with at least one section still completes, flagged `UNSOURCED` in the terminal step.

Queue advance semantics: the pump runs when a run has **truly stopped** (its run thread has returned and released the pipeline's process lock). Known limitation: Python threads cannot be killed. A run the watchdog has marked failed keeps executing in the background until the pipeline finishes on its own — and the queue advances only at that moment, not when the watchdog fired. Because a queued run can only start after the in-progress one has fully released, a long zombie run simply delays queued tasks; it cannot wedge them permanently.

**Pause** (`PUT /queue {"paused": true}`) gates the promotion itself: while paused the `pending → running` arrow is disabled — even when nothing is running — so new runs accumulate as `pending` and a finishing run does not start the next one. In-flight runs are never affected (the flag is consulted only by the pump), and resume re-arms the pump, draining the backlog FIFO. The flag is in-memory only and resets to active on worker restart.

## Documents (RAG staging)

PDFs a research run should retrieve against are staged via `POST /documents`, attached to the **next created** research task, ingested into the vector store at task start, and removed from disk again when the task exits.

### POST /documents

Multipart form, field `files` (repeatable). For each upload:

- the bytes must start with the `%PDF` magic, otherwise the file is rejected with a reason;
- the basename is sanitized to `[A-Za-z0-9._-]` (case preserved, `.pdf` extension forced lowercase) and deduped with `-2`/`-3` suffixes against what is already on disk / staged (case-insensitive, so case-variant duplicates cannot overwrite each other);
- the file is saved into the docs dir and added to the staging registry.

```bash
curl -s -X POST localhost:8321/documents -F 'files=@alpha.pdf' -F 'files=@notes.txt'
# 201 {"documents":["alpha.pdf"],"rejected":{"notes.txt":"not a PDF (missing %PDF magic bytes)"}}
# 400 when every upload is rejected
```

No ingestion happens here: ingesting rebuilds the vector collection from the docs dir (embedding cost grows with the corpus), so it runs once per task start instead.

### Attachment at task creation

`POST /research` attaches the entire staging area to the created task — the `documents` field appears in the 202 body and in both `GET /research` payloads, always (empty list when nothing was staged) — and then clears it. Staged documents therefore belong to exactly one task: upload, then create the task that should use them, or clear the staging area with `DELETE /documents`.

### Ingest at task start / cleanup on exit

Inside the task thread, before the pipeline runs, the docs dir is reconciled and re-ingested (a `documents` step is recorded). A failure never kills the task: the run continues in web-only mode and the step reads `indexing failed — continuing without local docs`. After the run — both `completed` and `failed` — the task's files are deleted from the docs dir and the collection is reconciled again, so a task's documents cannot pollute later runs.

### GET /documents

```json
{"staged": ["alpha.pdf"], "on_disk": ["alpha.pdf", "old.pdf"], "indexed": ["old.pdf"]}
```

`staged` = the staging registry, `on_disk` = `*.pdf` in the docs dir, `indexed` = names in the saved document catalog. All best-effort: any error yields an empty list, never a 5xx.

### DELETE /documents

Removes all staged files from disk, clears the registry, and reconciles the collection (so the removed files' chunks are purged): `200 {"removed": ["alpha.pdf"]}`.

## Integration with paperbot

The report endpoint returns exactly what paperbot consumes — the structured `{schema_version, report, quality}` envelope that paperbot's `POST /render` takes, so a finished run pipes straight into PDF/HTML rendering. Verified end-to-end: topic "What is a vector field" (`max_rounds=1, budget_doc=2, budget_web=1`) → 225 s run → 1 section / 3 sources → 211 KB, 2-page PDF rendered in 0.25 s.

```bash
# 1. Start a run
curl -s -X POST localhost:8321/research -H 'content-type: application/json' \
  -d '{"topic":"What is a vector field","max_rounds":1,"budget_doc":2,"budget_web":1}'
# → {"task_id":"4bd2c0…","status":"running","current_step":"queued","links":{…}}

# 2. Poll until status becomes "completed"
curl -s localhost:8321/research/4bd2c0…

# 3. Fetch the structured report
curl -s localhost:8321/research/4bd2c0…/report -o report.json

# 4. Render with paperbot
curl -s -X POST -H 'content-type: application/json' -d @report.json \
  'http://paperbot-host:3000/render?format=pdf' -o report.pdf
```

`?format=html` renders the same envelope to HTML.

## Notes

- Web search pacing: `SEARCH_THROTTLE_MS` (default `1000`; `0` disables) spaces web queries so engine rate limits stay out of effect. The policy is pace, never retry — a throttled engine is paced, not retried.
- No authentication: bind to localhost or put the service behind an authenticating proxy.
- Permissive CORS is enabled (Access-Control-Allow-Origin: *, all methods/headers) so browser-based clients (e.g. HTML API testers, web front-ends) work out of the box; it is permissive on purpose — put the service behind a proxy/restrict origins if exposed to untrusted networks.
- Tests: `venv/bin/python -m pytest tests/ -q`. `tests/test_api_server.py` covers the full task lifecycle with a fake run function (fully offline) plus one end-to-end test that runs the real pipeline with every LLM/retrieval surface stubbed.
