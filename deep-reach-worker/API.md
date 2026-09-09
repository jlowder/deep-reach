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

The service needs the LLM configuration from `utils/var.env` (`LLM_ENDPOINT`, `LLM_API_KEY`, `LLM_MODEL`, with `OPENAI_*` fallbacks) to actually run research. Check before posting topics:

```bash
curl -s localhost:8321/health
# {"service":"multi-agent-rag-researcher","running":false,"pending":0,"deep_configured":true}
```

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/research` | Start or queue a run → 202 with task id (queued as `pending` while one is running, 422 on invalid body) |
| GET | `/research` | List all tasks (summaries) |
| GET | `/research/{id}` | Full task record: status, current_step, step timeline, stats |
| DELETE | `/research/{id}` | Remove a queued/finished task → 200 {deleted, documents} (409 while running, 404 unknown) |
| GET | `/research/{id}/report` | Raw structured report JSON once completed |
| GET | `/health` | Service status, incl. whether the deep pipeline is configured |
| POST | `/documents` | Stage PDF files for the next research task → 201 {documents, rejected} (400 if all rejected) |
| GET | `/documents` | {staged, on_disk, indexed} |
| DELETE | `/documents` | Remove all staged documents → 200 {removed} |

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
  ]
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
  "stats": {"llm_calls": 5, "wall_s": 225.3, "sections": 1, "revisions": 1},
  "quality": {
    "citation_density": {"overall": 0.42, "per_section": {"<heading>": 0.5}},
    "verification": {
      "confidence": "medium",
      "coverage": "moderate",
      "gaps": [],
      "unresolvable_citations": ["D2"],
      "dropped_bare_citations": ["7"],
      "normalized_citations": {"bare_key_rewrites": 2, "adjacent_duplicates_collapsed": 5, "title_brackets_stripped": 3, "empty_brackets_removed": 1}
    },
    "sources_count": {"documents": 1, "web": 3},
    "total_words": 1834
  },
  "documents": ["alpha.pdf"]
}
```

`max_rounds` / `budget_doc` / `budget_web` are the requested budgets, stored on the record at creation (same defaults as the POST body: 3 / 10 / 5) so a finished run can be diagnosed against the parameters it ran with. `stats` is present only after the run produced a result; `quality` is present only for completed structured (json) runs — it is the `quality` object from the report envelope, computed at assembly, with: `citation_density` (`overall` 0–1 plus `per_section`), `verification` (`confidence`, `coverage`, `gaps`, `unresolvable_citations` — keys cited in the body but absent from the source registry, `dropped_bare_citations` — bare numbers removed, `normalized_citations` — deterministic, non-blocking counts of citation-mark fixes applied at assembly: bare registry keys resolved to titles in callout/note prose, adjacent identical bracket groups collapsed `[X][X]`→`[X]`, registered-title brackets stripped to bare mentions, empty bracket pairs removed), `sources_count` (`documents` / `web`), and `total_words`.

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

- 409, while pending, running, or failed: `{"status": "pending"}`, `{"status": "running"}` or `{"status": "failed"}`
- 404, unknown id: `{"error": "unknown task: <id>"}`

### GET /health

```json
{"service": "multi-agent-rag-researcher", "running": false, "pending": 0, "deep_configured": true}
```

`running` is true while any task is executing; `pending` is the count of queued (not yet started) tasks; `deep_configured` is true when the config has both an endpoint and an API key.

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

Poll `GET /research/{id}` (every ~10 s) and watch `current_step` advance through that sequence. A task with staged RAG documents records one extra first step — `documents: indexing N document(s)` (or `…indexing failed — continuing without local docs`) — before the pipeline's stage steps.

## Status lifecycle

```
pending ──▶ running ──▶ completed   pipeline returns; stats + report stored
   │          │         └──▶ failed  exception (error = "<ExceptionType>: <message>")
   │          │                         or watchdog timeout (error = "timed out after 2700s")
   └──────────┘ (the pump promotes the oldest pending task to running —
                 a newly promoted task also briefly shows current_step "queued")
```

- **pending** — the run was requested while another run was in progress; it waits in the FIFO queue with no thread, `current_step` `"queued"`.
- **running** — the pump (or an idle POST) started it; a worker thread + watchdog thread are live.
- **completed / failed** — terminal; the worker's exit triggers the pump, which starts the oldest pending task.

Queue advance semantics: the pump runs when a run has **truly stopped** (its run thread has returned and released the pipeline's process lock). Known limitation: Python threads cannot be killed. A run the watchdog has marked failed keeps executing in the background until the pipeline finishes on its own — and the queue advances only at that moment, not when the watchdog fired. Because a queued run can only start after the in-progress one has fully released, a long zombie run simply delays queued tasks; it cannot wedge them permanently.

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
