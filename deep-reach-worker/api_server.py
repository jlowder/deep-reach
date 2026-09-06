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
    GET  /research/{id}/report   -> raw canonical ResearchReport JSON
                                 (200 only when completed; 409 otherwise)
    GET  /health                 -> {service, running, pending,
                                     deep_configured}

Run with:  python api_server.py
Environment:  PORT (default 8321), HOST (default 0.0.0.0)
"""

from __future__ import annotations

import os
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

import deep_research_orchestrator
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
    report_json: Optional[str] = None
    # Requested budgets, kept on the record so the queue pump can rebuild
    # the run args when it promotes this record to "running".
    max_rounds: int = 3
    budget_doc: int = 10
    budget_web: int = 5


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
    max_run_seconds: float = 45 * 60,
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

    def _worker(
        record: TaskRecord, fn: Callable[..., dict], topic: str, budgets: dict
    ) -> None:
        """Daemon-thread body: run fn, store artifacts, finalize the record,
        then pump the queue (the run_fn thread has returned, so the
        pipeline's process lock is free again)."""
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
            "step_count": len(t.steps),
            "started_at": t.started_at,
            "finished_at": t.finished_at,
            "error": t.error,
        }

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
            # Pipeline free: keep the "running" default; start below.
            tasks[record.id] = record
        if not busy:
            _start_task(record, fn, req.topic, _budgets(record))

        return {
            "task_id": record.id,
            "status": record.status,
            "current_step": record.current_step,
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
                "started_at": t.started_at,
                "finished_at": t.finished_at,
            }
            if t.error is not None:
                body["error"] = t.error
            if t.stats is not None:
                body["stats"] = t.stats
        return body

    @app.get("/research/{task_id}/report")
    def get_report(task_id: str):
        with lock:
            t = tasks.get(task_id)
            if t is None:
                return JSONResponse(
                    status_code=404, content={"error": f"unknown task: {task_id}"}
                )
            if t.status != "completed":
                return JSONResponse(status_code=409, content={"status": t.status})
            body = t.report_json if t.report_json is not None else "null"
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
