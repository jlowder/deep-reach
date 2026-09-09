"""
FastAPI service exposing the 5-stage deep-research pipeline.

deep_research() is synchronous and process-serialized (internal lock: one
deep run at a time), so the service runs each research job on a daemon
thread, tracks its lifecycle (pending -> running -> completed / failed) in
an in-memory task store, records per-stage / per-section progress from the
pipeline's on_stage / on_section callbacks, and enforces a wall-clock
deadline via a per-task watchdog thread.

Runs are serialized: at most one task executes at a time. A POST accepted
while a run is in progress is queued (status "pending") and a FIFO pump
starts the oldest pending task when the pipeline becomes free.

Routes:
    POST /research               start or queue a run -> 202 {task_id, links}
                                 (status "running" when the pipeline is
                                 free, "pending" when busy; FIFO queue)
    GET  /research               -> 200 {tasks: [summaries]}
    GET  /research/{id}          -> 200 full record / 404 unknown task
    DELETE /research/{id}        -> 200 {deleted, documents} / 409 running /
                                    404 unknown task (removes the record +
                                    cleans up its documents)
    GET  /research/{id}/report   -> raw canonical ResearchReport JSON
                                 (200 only when completed; 409 otherwise)
    POST /documents              stage PDF files for the next research
                                 task -> 201 {documents, rejected}
                                 (400 when everything is rejected)
    GET  /documents              -> 200 {staged, on_disk, indexed}
    DELETE /documents            -> 200 {removed} (clears the staging area)
    GET  /health                 -> {service, running, pending,
                                     deep_configured}

Staged documents (POST /documents) are attached to the next created
research task, ingested into the vector store at task start, and removed
from disk again when the task exits — or when the task is deleted.

Run with:  python api_server.py
Environment:  PORT (default 8321), HOST (default 0.0.0.0)
"""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

import deep_research_orchestrator
from qdrant_vector_database.vector_store import (
    DEFAULT_DOCS_DIR,
    get_indexed_document_catalog,
    ingest_documents,
    reconcile_corpus,
)
from utils.config import get_config

SERVICE_NAME = "multi-agent-rag-researcher"

# deep_research on_stage numbers (1-5) -> human-readable stage names.
STAGE_NAMES = {
    1: "decompose",
    2: "investigate",
    3: "draft",
    4: "critique",
    5: "assemble",
}


def stage_name(stage: int) -> str:
    """Human-readable name for a pipeline stage number (unknown -> "stage N")."""
    return STAGE_NAMES.get(stage, f"stage {stage}")


def _sanitize_pdf_name(filename: Optional[str]) -> str:
    """Upload filename -> safe staged name: basename, every character
    outside [A-Za-z0-9._-] replaced with '_', case preserved, and a
    lowercase .pdf extension appended (ingest globs *.pdf). Names that
    sanitize to nothing become 'document.pdf'."""
    base = os.path.basename(filename or "")
    stem, _ext = os.path.splitext(base)
    stem = "".join(c if (c.isascii() and c.isalnum() or c in "._-") else "_" for c in stem)
    stem = stem.strip("._") or "document"
    return f"{stem}.pdf"


@dataclass
class TaskRecord:
    """One research run: lifecycle, step timeline, final artifacts."""

    id: str
    topic: str
    status: str = "running"  # "pending" | "running" | "completed" | "failed"
    current_step: str = "queued"
    steps: list = field(default_factory=list)  # [{stage: str, detail: str, ts: float}]
    started_at: float = field(default_factory=time.time)
    finished_at: Optional[float] = None
    error: Optional[str] = None
    stats: Optional[dict] = None
    quality: Optional[dict] = None
    report_json: Optional[str] = None
    # Requested budgets, kept on the record so the queue pump can rebuild
    # the run args when it promotes this record to "running".
    max_rounds: int = 3
    budget_doc: int = 10
    budget_web: int = 5
    # Staged RAG documents attached at creation time; ingested at task
    # start, removed from disk on task exit (see the /documents routes).
    documents: list = field(default_factory=list)


def promote_next_pending(
    tasks: dict[str, TaskRecord], lock: threading.Lock
) -> Optional[TaskRecord]:
    """Queue pump: atomically promote the oldest pending task to running.

    FIFO by creation order (the tasks dict is insertion-ordered). Returns
    the promoted record — the caller spawns its worker/watchdog threads —
    or None if any task is still running or nothing is pending. The
    running-check and the promotion happen together under `lock`, so
    however many pumps race, a given task can be promoted at most once.
    """
    with lock:
        if any(t.status == "running" for t in tasks.values()):
            return None
        record = next((t for t in tasks.values() if t.status == "pending"), None)
        if record is None:
            return None
        record.status = "running"
        record.current_step = "queued"
        record.started_at = time.time()
        return record


class ResearchRequest(BaseModel):
    """POST /research body. `topic` is required and must be non-empty."""

    topic: str = Field(..., min_length=1)
    max_rounds: int = Field(3, ge=1)
    budget_doc: int = Field(10, ge=0)
    budget_web: int = Field(5, ge=0)


def default_run_fn(topic: str, **budgets: Any) -> dict:
    """The default run seam: the real deep_research pipeline (json mode).

    Progress callbacks (on_stage / on_section) arrive as kwargs from
    create_app and are forwarded so the task record sees stage / section
    progress. Returns {"final_answer", "state" (carrying report_json),
    "stats"}.
    """
    on_stage = budgets.pop("on_stage", None)
    on_section = budgets.pop("on_section", None)
    return deep_research_orchestrator.deep_research(
        user_query=topic,
        verbose=False,
        max_rounds=int(budgets.get("max_rounds", 3)),
        budget_doc=int(budgets.get("budget_doc", 10)),
        budget_web=int(budgets.get("budget_web", 5)),
        on_stage=on_stage,
        on_section=on_section,
    )


def create_app(
    run_fn: Optional[Callable[..., dict]] = None,
    max_run_seconds: float = 120 * 60,
) -> FastAPI:
    """Build the API app.

    run_fn(topic, **budgets) -> {"final_answer", "state", "stats"} is the
    injectable test seam: pass a fake to exercise the whole task lifecycle
    without LLMs. The app additionally passes on_stage / on_section kwargs
    to run_fn so a run can drive step recording. With run_fn=None the real
    deep_research pipeline is used. max_run_seconds bounds each run via a
    per-task watchdog thread (exceeded runs are marked failed).
    """
    app = FastAPI(title=f"{SERVICE_NAME} API")

    # Permissive CORS so browser-based clients (HTML API testers, web
    # front-ends) work out of the box. CORSMiddleware answers OPTIONS
    # preflights itself, so no explicit OPTIONS routes are needed.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["*"],
    )

    tasks: dict[str, TaskRecord] = {}
    lock = threading.Lock()
    fn = run_fn if run_fn is not None else default_run_fn
    # Staged RAG documents (filename -> None, ordered by upload) awaiting
    # attachment to the next created research task. Guarded by `lock`.
    staged_documents: dict[str, None] = {}

    def record_step(record: TaskRecord, stage: str, detail: str) -> None:
        """Append a step and advance current_step. Exception-guarded: a bad
        callback must never kill the run."""
        try:
            with lock:
                record.steps.append(
                    {"stage": stage, "detail": detail, "ts": time.time()}
                )
                record.current_step = f"{stage}: {detail}"
        except Exception:
            pass

    def _finalize(record: TaskRecord, status: str, error: Optional[str] = None) -> bool:
        """Move a still-running task to a terminal status. No-op (returns
        False) if the watchdog (or an earlier finish) got there first."""
        with lock:
            if record.status != "running":
                return False
            record.status = status
            record.finished_at = time.time()
            if error is not None:
                record.error = error
            return True

    def _index_documents(record: TaskRecord) -> None:
        """Ingest the task's staged documents (runs in the task thread, so
        the cost counts against the run's wall-clock budget). The collection
        is rebuilt from the docs dir — cost grows with corpus size, which is
        why this runs once per task start, not per request. A failure never
        kills the task: the pipeline tolerates an empty collection
        (web-only mode), so just record it and continue."""
        record_step(
            record, "documents", f"indexing {len(record.documents)} document(s)"
        )
        try:
            reconcile_corpus(DEFAULT_DOCS_DIR)
            ingest_documents(DEFAULT_DOCS_DIR)
        except Exception:
            record_step(
                record, "documents", "indexing failed — continuing without local docs"
            )

    def _cleanup_documents(record: TaskRecord) -> None:
        """Remove the task's documents from disk and reconcile the
        collection against what remains. Called from the worker on task
        exit (both terminal states; a watchdog zombie thread also reaches
        it eventually) and from DELETE /research/{id} for a deleted record
        (a pending task's staged files were never ingested — removing them
        plus purging their points keeps the next run's corpus clean).
        Idempotent (unlink missing_ok + reconcile); a failure only records
        a step."""
        try:
            for name in record.documents:
                (DEFAULT_DOCS_DIR / name).unlink(missing_ok=True)
            reconcile_corpus(DEFAULT_DOCS_DIR)
        except Exception:
            record_step(record, "documents", "cleanup failed — stale docs may remain")

    def _worker(
        record: TaskRecord, fn: Callable[..., dict], topic: str, budgets: dict
    ) -> None:
        """Daemon-thread body: index the task's documents, run fn, store
        artifacts, finalize the record, clean the documents up, then pump
        the queue (the run_fn thread has returned, so the pipeline's
        process lock is free again)."""
        if record.documents:
            _index_documents(record)
        error: Optional[str] = None
        result: Any = None
        try:
            result = fn(topic, **budgets)
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__
        try:
            if result is not None:
                if not isinstance(result, dict):
                    error = f"run_fn returned {type(result).__name__}, expected dict"
                else:
                    state = result.get("state") or {}
                    report_json = state.get("report_json")
                    with lock:
                        record.stats = result.get("stats")
                        if isinstance(report_json, str):
                            record.report_json = report_json
                            try:
                                q = json.loads(report_json).get("quality")
                                if isinstance(q, dict):
                                    record.quality = q
                            except Exception:
                                pass  # quality stays None; the artifact is kept
                        elif error is None:
                            # The pipeline returned normally but produced no
                            # report artifact (e.g. the decomposer gave up):
                            # finalize FAILED, not completed — a "completed"
                            # record with a null report reads as success to
                            # every downstream consumer (glue/paperbot/web).
                            error = (
                                state.get("final_error")
                                or "run produced no report"
                            )
        except Exception as exc:
            # Artifact storage must never wedge the task/queue: record the
            # failure instead of leaving the record stuck "running".
            if error is None:
                error = (
                    f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__
                )
        if error is None:
            _finalize(record, "completed")
        else:
            _finalize(record, "failed", error=error)
        if record.documents:
            _cleanup_documents(record)
        # The run has truly stopped — whether we won the race against the
        # watchdog or we are a zombie it already marked failed — so the
        # pipeline lock is released and the queue may advance: start the
        # oldest pending task (no-op when none is waiting).
        _pump()

    def _watchdog(record: TaskRecord) -> None:
        time.sleep(max_run_seconds)
        # Marks the run failed but does NOT pump: the run_fn thread may still
        # be executing (a zombie holding the pipeline lock). The pump runs
        # from _worker, i.e. when the run has truly stopped.
        _finalize(record, "failed", error=f"timed out after {max_run_seconds:g}s")

    def _budgets(record: TaskRecord) -> dict:
        """Run args for a record: its requested budgets plus the progress
        callbacks bound to it. (record_step appends to steps + advances
        current_step, exception-guarded; raw pipeline detail strings are
        kept verbatim.)"""
        return {
            "max_rounds": record.max_rounds,
            "budget_doc": record.budget_doc,
            "budget_web": record.budget_web,
            "on_stage": lambda n, d: record_step(record, stage_name(n), d),
            "on_section": lambda i, t, h, s, p: record_step(
                record, f"section {i}/{t}", h
            ),
        }

    def _start_task(
        record: TaskRecord, run: Callable[..., dict], topic: str, budgets: dict
    ) -> None:
        """Spawn the worker + watchdog threads for a record that is
        "running". Caller must not hold `lock`; the record's status and
        started_at are set beforehand (under lock) by the caller. Used by
        POST (pipeline free) and by the queue pump."""
        threading.Thread(
            target=_worker, args=(record, run, topic, budgets), daemon=True
        ).start()
        threading.Thread(target=_watchdog, args=(record,), daemon=True).start()

    def _pump() -> None:
        """Start the oldest pending task now that a run has stopped.

        Idempotent: promote_next_pending re-checks for a running task and
        promotes under the lock, so racing pumps never double-start. The
        threads are spawned after the lock is released.
        """
        record = promote_next_pending(tasks, lock)
        if record is not None:
            _start_task(record, fn, record.topic, _budgets(record))

    def _summary(t: TaskRecord) -> dict:
        return {
            "id": t.id,
            "topic": t.topic,
            "status": t.status,
            "current_step": t.current_step,
            "max_rounds": t.max_rounds,
            "budget_doc": t.budget_doc,
            "budget_web": t.budget_web,
            "step_count": len(t.steps),
            "started_at": t.started_at,
            "finished_at": t.finished_at,
            "error": t.error,
            "documents": t.documents,
        }

    @app.post("/documents")
    def upload_documents(files: list[UploadFile] = File(...)):
        """Stage PDF files (multipart field `files`, multiple allowed) for
        the next research task. Each upload must start with the %PDF magic
        bytes; the basename is sanitized and deduped (-2/-3 suffix, case
        insensitive) against what is already on disk / staged, then the
        file is saved into the docs dir. Ingestion into the vector store
        happens at TASK START (it rebuilds the collection from the docs
        dir — cost grows with the corpus), not here. 201 when anything is
        accepted, 400 when everything is rejected."""
        accepted: list[str] = []
        rejected: dict[str, str] = {}
        DEFAULT_DOCS_DIR.mkdir(parents=True, exist_ok=True)
        for upload in files:
            display = os.path.basename(upload.filename or "") or "upload"
            try:
                contents = upload.file.read()
            except Exception:
                rejected[display] = "could not read upload"
                continue
            if contents[:4] != b"%PDF":
                rejected[display] = "not a PDF (missing %PDF magic bytes)"
                continue
            with lock:
                taken = {
                    n.lower() for n in staged_documents
                } | {p.name.lower() for p in DEFAULT_DOCS_DIR.glob("*.pdf")}
                base = _sanitize_pdf_name(upload.filename)
                stem = base[: -len(".pdf")]
                name = base
                counter = 2
                while name.lower() in taken:
                    name = f"{stem}-{counter}.pdf"
                    counter += 1
                (DEFAULT_DOCS_DIR / name).write_bytes(contents)
                staged_documents[name] = None
                accepted.append(name)
        return JSONResponse(
            status_code=201 if accepted else 400,
            content={"documents": accepted, "rejected": rejected},
        )

    @app.get("/documents")
    def list_documents():
        """Staged / on-disk / indexed documents. All best-effort: any error
        yields an empty list, never a 5xx."""
        with lock:
            staged = list(staged_documents)
        try:
            on_disk = (
                sorted(p.name for p in DEFAULT_DOCS_DIR.glob("*.pdf"))
                if DEFAULT_DOCS_DIR.exists()
                else []
            )
        except OSError:
            on_disk = []
        try:
            indexed = [
                d.get("document_name")
                for d in get_indexed_document_catalog()
                if d.get("document_name")
            ]
        except Exception:
            indexed = []
        return {"staged": staged, "on_disk": on_disk, "indexed": indexed}

    @app.delete("/documents")
    def clear_documents():
        """Remove every staged document: files off disk, registry cleared,
        and the vector store reconciled (purges the vanished files' chunks
        so they cannot pollute later retrieval). Best-effort: errors are
        swallowed, never a 5xx."""
        with lock:
            names = list(staged_documents)
            staged_documents.clear()
        removed = []
        for name in names:
            try:
                (DEFAULT_DOCS_DIR / name).unlink(missing_ok=True)
            except OSError:
                continue
            removed.append(name)
        try:
            reconcile_corpus(DEFAULT_DOCS_DIR)
        except Exception:
            pass
        return {"removed": removed}

    @app.post("/research", status_code=202)
    def start_research(req: ResearchRequest):
        with lock:
            busy = any(t.status == "running" for t in tasks.values())
            record = TaskRecord(
                id=uuid.uuid4().hex,
                topic=req.topic,
                max_rounds=req.max_rounds,
                budget_doc=req.budget_doc,
                budget_web=req.budget_web,
            )
            if busy:
                # Queue it (FIFO): no thread yet. The pump promotes it to
                # "running" when the pipeline becomes free.
                record.status = "pending"
            # Attach whatever is staged to this task (and only this task),
            # then clear the staging area for the next request.
            if staged_documents:
                record.documents = list(staged_documents)
                staged_documents.clear()
            # Pipeline free: keep the "running" default; start below.
            tasks[record.id] = record
        if not busy:
            _start_task(record, fn, req.topic, _budgets(record))

        return {
            "task_id": record.id,
            "status": record.status,
            "current_step": record.current_step,
            "max_rounds": record.max_rounds,
            "budget_doc": record.budget_doc,
            "budget_web": record.budget_web,
            "documents": record.documents,
            "links": {
                "status": f"/research/{record.id}",
                "report": f"/research/{record.id}/report",
            },
        }

    @app.get("/research")
    def list_research():
        with lock:
            return {"tasks": [_summary(t) for t in tasks.values()]}

    @app.get("/research/{task_id}")
    def get_research(task_id: str):
        with lock:
            t = tasks.get(task_id)
            if t is None:
                return JSONResponse(
                    status_code=404, content={"error": f"unknown task: {task_id}"}
                )
            body = {
                "id": t.id,
                "topic": t.topic,
                "status": t.status,
                "current_step": t.current_step,
                "steps": list(t.steps),
                "max_rounds": t.max_rounds,
                "budget_doc": t.budget_doc,
                "budget_web": t.budget_web,
                "started_at": t.started_at,
                "finished_at": t.finished_at,
                "documents": list(t.documents),
            }
            if t.error is not None:
                body["error"] = t.error
            if t.stats is not None:
                body["stats"] = t.stats
            if t.quality is not None:
                body["quality"] = t.quality
        return body

    @app.delete("/research/{task_id}")
    def delete_research(task_id: str):
        """Remove a task record from the in-memory store. A running task
        cannot be deleted (409): Python threads cannot be killed, so its
        worker is left to finish — its exit-cleanup then runs as usual.
        Pending and terminal records are popped (200); a deleted record's
        documents are cleaned up (files off disk + reconcile, idempotent)
        so a deleted pending task's staged files cannot leak into later
        runs."""
        with lock:
            record = tasks.get(task_id)
            if record is None:
                return JSONResponse(
                    status_code=404, content={"error": f"unknown task: {task_id}"}
                )
            if record.status == "running":
                return JSONResponse(
                    status_code=409,
                    content={
                        "error": "cannot delete a running task",
                        "task_id": task_id,
                    },
                )
            del tasks[task_id]
            docs = list(record.documents)
        if docs:
            _cleanup_documents(record)
        return {"deleted": task_id, "documents": docs}

    @app.get("/research/{task_id}/report")
    def get_report(task_id: str):
        with lock:
            t = tasks.get(task_id)
            if t is None:
                return JSONResponse(
                    status_code=404, content={"error": f"unknown task: {task_id}"}
                )
            if t.status != "completed":
                body = {"status": t.status}
                if t.error is not None:
                    body["error"] = t.error
                return JSONResponse(status_code=409, content=body)
            if t.report_json is None:
                # Never serve a bare `null` 200: a record without a report
                # artifact has nothing to render downstream (paperbot would
                # 400 on it).
                return JSONResponse(
                    status_code=409,
                    content={
                        "error": "no report artifact — the run produced no report",
                        "status": t.status,
                    },
                )
            body = t.report_json
        return Response(content=body, media_type="application/json")

    @app.get("/health")
    def health():
        with lock:
            running = any(t.status == "running" for t in tasks.values())
            pending = sum(1 for t in tasks.values() if t.status == "pending")
        try:
            cfg = get_config()
            deep_configured = bool(
                getattr(cfg, "default_endpoint", None)
                and getattr(cfg, "default_api_key", None)
            )
        except Exception:
            deep_configured = False
        return {
            "service": SERVICE_NAME,
            "running": running,
            "pending": pending,
            "deep_configured": deep_configured,
        }

    return app


def main() -> None:
    """Run the service with uvicorn (PORT env, default 8321; HOST default 0.0.0.0)."""
    import uvicorn

    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8321"))
    uvicorn.run(app, host=host, port=port)


# Module-level app for `uvicorn api_server:app` / plain CLI runs.
app = create_app()

if __name__ == "__main__":
    main()
