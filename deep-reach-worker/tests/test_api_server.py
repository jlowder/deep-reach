"""
Tests for the FastAPI research service (api_server.py).

Unit tests drive the app with a fake run_fn (the create_app seam) — no LLM,
no network. One integration test reuses test_deep_pipeline._install_stubs
to run the REAL deep_research through the API with every LLM / retrieval
surface stubbed.
"""

import json
import shutil
import threading
import time

import pytest
from fastapi.testclient import TestClient

import api_server
import test_deep_pipeline as tdp


# ---------------------------------------------------------------------------
# Fakes + helpers
# ---------------------------------------------------------------------------


def _fake_report_json(topic: str) -> str:
    """Plausible canonical ResearchReport JSON for the fake run_fn."""
    return json.dumps(
        {
            "schema_version": "1.0",
            "report": {
                "metadata": {"topic": topic},
                "executive_summary": ["fake executive summary"],
                "sections": [
                    {
                        "id": "s1",
                        "heading": "One",
                        "blocks": [
                            {
                                "type": "paragraph",
                                "spans": [
                                    {"text": "fake section body", "citations": []}
                                ],
                            }
                        ],
                    }
                ],
                "sources": [],
            },
            "quality": {"confidence_level": "high"},
        }
    )


def _make_fake_run_fn():
    """Fast fake run_fn: sleeps ~0.05s per stage via the app-provided
    on_stage (exercising step recording) and returns a canned
    deep_research-shaped result. Records calls on .calls."""

    def run_fn(topic, **kwargs):
        on_stage = kwargs.get("on_stage")
        run_fn.calls.append(
            {
                "topic": topic,
                "budgets": {
                    k: v
                    for k, v in kwargs.items()
                    if k not in ("on_stage", "on_section")
                },
            }
        )
        for n, detail in (
            (1, "decomposing query"),
            (2, "investigating 2 sub-question(s)"),
            (3, "drafting 2 section(s)"),
            (4, "critic pass: checking every drafted section"),
            (5, "assembling final report"),
        ):
            time.sleep(0.05)
            if on_stage is not None:
                on_stage(n, detail)
        return {
            "final_answer": f"fake answer for {topic}",
            "state": {"report_json": _fake_report_json(topic)},
            "stats": {"llm_calls": 7, "wall_s": 0.3, "sections": 2},
        }

    run_fn.calls = []
    return run_fn


@pytest.fixture()
def client():
    return TestClient(api_server.create_app(run_fn=_make_fake_run_fn()))


TERMINAL = {"completed", "failed"}


def _wait(client: TestClient, task_id: str, timeout: float = 10.0) -> dict:
    """Poll GET /research/{id} until the task reaches a terminal state
    (completed/failed). Also covers "pending" queue tasks, which the pump
    auto-starts when the pipeline frees up."""
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = client.get(f"/research/{task_id}").json()
        if last["status"] in TERMINAL:
            return last
        time.sleep(0.05)
    stuck = last["status"] if last else "?"
    raise AssertionError(f"task {task_id} still {stuck} after {timeout}s")


def _wait_for(predicate, timeout: float = 5.0) -> None:
    """Poll until a condition holds — worker threads are async, so tests
    must not race against them (e.g. the first run_fn call landing)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError("condition not met in time")


# ---------------------------------------------------------------------------
# POST /research + lifecycle
# ---------------------------------------------------------------------------


def test_post_returns_202_and_lists_task(client):
    resp = client.post("/research", json={"topic": "tiny topic"})
    assert resp.status_code == 202
    body = resp.json()
    assert body["status"] == "running"
    assert body["task_id"]
    assert body["current_step"]
    assert body["links"] == {
        "status": f"/research/{body['task_id']}",
        "report": f"/research/{body['task_id']}/report",
    }
    listed = client.get("/research").json()["tasks"]
    assert [t["id"] for t in listed] == [body["task_id"]]
    assert listed[0]["topic"] == "tiny topic"


def test_run_completes_and_steps_track_all_stages(client):
    task_id = client.post("/research", json={"topic": "tiny topic"}).json()["task_id"]
    last = _wait(client, task_id)
    assert last["status"] == "completed"
    assert "error" not in last  # omitted when the run did not fail
    assert last["finished_at"] is not None
    stages = [s["stage"] for s in last["steps"]]
    assert stages == ["decompose", "investigate", "draft", "critique", "assemble"]
    assert all(s["detail"] and s["ts"] > 0 for s in last["steps"])
    assert last["current_step"].startswith("assemble:")
    assert last["stats"] == {"llm_calls": 7, "wall_s": 0.3, "sections": 2}


def test_budgets_forwarded_to_run_fn():
    fn = _make_fake_run_fn()
    client = TestClient(api_server.create_app(run_fn=fn))
    task_id = client.post(
        "/research",
        json={"topic": "t", "max_rounds": 2, "budget_doc": 3, "budget_web": 1},
    ).json()["task_id"]
    _wait(client, task_id)
    assert fn.calls[0]["budgets"] == {
        "max_rounds": 2,
        "budget_doc": 3,
        "budget_web": 1,
    }


def test_post_echoes_requested_budgets(client):
    body = client.post(
        "/research",
        json={"topic": "t", "max_rounds": 2, "budget_doc": 3, "budget_web": 1},
    ).json()
    assert {
        "max_rounds": body["max_rounds"],
        "budget_doc": body["budget_doc"],
        "budget_web": body["budget_web"],
    } == {"max_rounds": 2, "budget_doc": 3, "budget_web": 1}


def test_get_and_list_carry_budgets(client):
    client.post(
        "/research",
        json={"topic": "t", "max_rounds": 2, "budget_doc": 3, "budget_web": 1},
    )
    task_id = client.get("/research").json()["tasks"][0]["id"]
    last = _wait(client, task_id)
    assert (last["max_rounds"], last["budget_doc"], last["budget_web"]) == (
        2, 3, 1
    )
    summary = client.get("/research").json()["tasks"][0]
    assert (summary["max_rounds"], summary["budget_doc"], summary["budget_web"]) == (
        2, 3, 1
    )


def test_defaults_when_budgets_omitted(client):
    task_id = client.post("/research", json={"topic": "t"}).json()["task_id"]
    last = _wait(client, task_id)
    assert (last["max_rounds"], last["budget_doc"], last["budget_web"]) == (
        3, 10, 5
    )


def _make_zero_run_fn():
    """Fake run_fn shaped like a zero-evidence run: the report has zero
    sources and its quality object reflects that (the shape assembly
    computes for an unsourced run)."""

    def run_fn(topic, **kwargs):
        on_stage = kwargs.get("on_stage")
        for n, detail in (
            (1, "decomposing query"),
            (2, "investigating 1 sub-question(s)"),
            (3, "drafting 1 section(s)"),
            (4, "critic pass"),
            (5, "assembling final report"),
        ):
            if on_stage is not None:
                on_stage(n, detail)
        return {
            "final_answer": f"fake answer for {topic}",
            "state": {
                "report_json": json.dumps(
                    {
                        "schema_version": "1.0",
                        "report": {"sources": [], "sections": []},
                        "quality": {
                            "citation_density": {"overall": 0.0, "per_section": {}},
                            "verification": {
                                "confidence": "medium",
                                "coverage": "moderate",
                                "gaps": [],
                                "unresolvable_citations": ["D2", "W1"],
                                "dropped_bare_citations": [],
                            },
                            "sources_count": {"documents": 0, "web": 0},
                            "total_words": 900,
                        },
                    }
                )
            },
            "stats": {"llm_calls": 9, "wall_s": 1.0, "sections": 1},
        }

    run_fn.calls = []
    return run_fn


def test_get_body_includes_quality():
    client = TestClient(api_server.create_app(run_fn=_make_zero_run_fn()))
    task_id = client.post("/research", json={"topic": "unsourced"}).json()[
        "task_id"
    ]
    last = _wait(client, task_id)
    q = last["quality"]
    assert q["citation_density"]["overall"] == 0.0
    assert q["sources_count"] == {"documents": 0, "web": 0}
    assert q["verification"]["unresolvable_citations"] == ["D2", "W1"]
    assert q["total_words"] == 900


def test_quality_absent_when_run_fails():
    def failing(topic, **kwargs):
        raise RuntimeError("boom")

    client = TestClient(api_server.create_app(run_fn=failing))
    task_id = client.post("/research", json={"topic": "t"}).json()["task_id"]
    last = _wait(client, task_id)
    assert last["status"] == "failed"
    assert "quality" not in last


def test_second_post_while_running_is_queued_pending():
    """New contract (was: 409 while busy): a POST accepted while a run is
    in progress is queued with 202 as status "pending", starts no second
    run_fn, lists as pending, 409s on /report, and is auto-started by the
    pump when the first run completes."""
    release = threading.Event()

    def run_fn(topic, **kwargs):
        run_fn.calls.append(topic)
        release.wait(timeout=10)
        return {
            "final_answer": f"done {topic}",
            "state": {"report_json": _fake_report_json(topic)},
            "stats": {"llm_calls": 1},
        }

    run_fn.calls = []
    client = TestClient(api_server.create_app(run_fn=run_fn))
    first = client.post("/research", json={"topic": "one"}).json()["task_id"]
    resp = client.post("/research", json={"topic": "two"})
    assert resp.status_code == 202
    body = resp.json()
    second = body["task_id"]
    assert body["status"] == "pending"
    assert body["current_step"] == "queued"
    assert body["links"] == {
        "status": f"/research/{second}",
        "report": f"/research/{second}/report",
    }
    listed = client.get("/research").json()["tasks"]
    assert [t["id"] for t in listed] == [first, second]
    assert [t["status"] for t in listed] == ["running", "pending"]
    # The queued task has started no run_fn yet.
    _wait_for(lambda: run_fn.calls == ["one"])
    assert run_fn.calls == ["one"]
    assert client.get(f"/research/{second}/report").json() == {"status": "pending"}
    release.set()
    _wait(client, first)
    # Completion pump: the queued task auto-starts, no new POST needed.
    _wait(client, second)
    assert run_fn.calls == ["one", "two"]
    # The queue has drained; once free, a fresh run is accepted again
    # (always 202, never 409) and runs to completion.
    listed = {t["status"] for t in client.get("/research").json()["tasks"]}
    assert listed == {"completed"}
    assert client.get("/health").json()["pending"] == 0
    fresh = client.post("/research", json={"topic": "three"})
    assert fresh.status_code == 202
    _wait(client, fresh.json()["task_id"])
    assert run_fn.calls == ["one", "two", "three"]


def test_run_failure_is_recorded():
    def run_fn(topic, **kwargs):
        raise RuntimeError("boom: simulated failure")

    client = TestClient(api_server.create_app(run_fn=run_fn))
    task_id = client.post("/research", json={"topic": "tiny topic"}).json()["task_id"]
    last = _wait(client, task_id)
    assert last["status"] == "failed"
    assert "boom: simulated failure" in last["error"]
    assert "stats" not in last
    assert client.get(f"/research/{task_id}/report").status_code == 409


# ---------------------------------------------------------------------------
# Pending queue (FIFO pump)
# ---------------------------------------------------------------------------


def _quick_run_fn(result_for=None):
    """run_fn that sleeps 0.2 s then returns (or raises for a given topic)."""

    def run_fn(topic, **kwargs):
        time.sleep(0.2)
        if result_for is not None and topic in result_for:
            raise RuntimeError(result_for[topic])
        return {
            "final_answer": f"done {topic}",
            "state": {"report_json": _fake_report_json(topic)},
            "stats": {"llm_calls": 1},
        }

    return run_fn


def test_pump_auto_starts_pending_on_completion():
    """On completion the pump starts the oldest pending task without any
    further POST; the queued task reaches completed on its own."""
    client = TestClient(
        api_server.create_app(run_fn=_quick_run_fn(), max_run_seconds=5)
    )
    a = client.post("/research", json={"topic": "a"}).json()["task_id"]
    time.sleep(0.1)  # let a's run start so b queues behind it
    b = client.post("/research", json={"topic": "b"})
    assert b.status_code == 202
    assert b.json()["status"] == "pending"
    b_id = b.json()["task_id"]
    _wait(client, a)
    last_b = _wait(client, b_id)  # no second POST
    assert last_b["status"] == "completed"
    listed = {t["topic"]: t["status"] for t in client.get("/research").json()["tasks"]}
    assert listed == {"a": "completed", "b": "completed"}
    assert client.get("/health").json()["pending"] == 0


def test_queue_is_fifo():
    """Three queued tasks start strictly in POST (oldest-first) order."""
    started = []
    started_lock = threading.Lock()

    def run_fn(topic, **kwargs):
        with started_lock:
            started.append(topic)
        time.sleep(0.15)
        return {
            "final_answer": f"done {topic}",
            "state": {"report_json": _fake_report_json(topic)},
            "stats": {"llm_calls": 1},
        }

    client = TestClient(api_server.create_app(run_fn=run_fn, max_run_seconds=5))
    first = client.post("/research", json={"topic": "first"}).json()["task_id"]
    time.sleep(0.05)
    second = client.post("/research", json={"topic": "second"})
    third = client.post("/research", json={"topic": "third"})
    assert second.json()["status"] == "pending"
    assert third.json()["status"] == "pending"
    _wait(client, first)
    _wait(client, second.json()["task_id"])
    _wait(client, third.json()["task_id"])
    assert started == ["first", "second", "third"]


def test_failed_run_pumps_next_pending():
    """A failed run (run_fn raised) frees the pipeline just like a
    completed one: the pump starts the next queued task."""
    client = TestClient(
        api_server.create_app(
            run_fn=_quick_run_fn(result_for={"boom": "kaboom"}),
            max_run_seconds=5,
        )
    )
    a = client.post("/research", json={"topic": "boom"}).json()["task_id"]
    time.sleep(0.1)
    b = client.post("/research", json={"topic": "ok"})
    assert b.json()["status"] == "pending"
    b_id = b.json()["task_id"]
    last_a = _wait(client, a)
    assert last_a["status"] == "failed"
    assert "kaboom" in last_a["error"]
    last_b = _wait(client, b_id)
    assert last_b["status"] == "completed"


def test_watchdog_killed_zombie_releases_queue_only_when_it_stops():
    """Zombie: the watchdog fails a run whose run_fn is still executing
    (in the real pipeline it keeps holding the process lock). The pump
    must NOT advance when the watchdog fires — only when the zombie's
    run_fn has truly returned and the pipeline is free."""
    started = {}

    def run_fn(topic, **kwargs):
        started[topic] = time.time()
        # "a" is the zombie (1 s, over the 0.3 s watchdog); "b" is short so
        # its OWN watchdog does not fire once the pump starts it.
        time.sleep(1.0 if topic == "a" else 0.1)
        return {
            "final_answer": f"done {topic}",
            "state": {"report_json": _fake_report_json(topic)},
            "stats": {"llm_calls": 1},
        }

    client = TestClient(api_server.create_app(run_fn=run_fn, max_run_seconds=0.3))
    a = client.post("/research", json={"topic": "a"}).json()["task_id"]
    time.sleep(0.05)
    b = client.post("/research", json={"topic": "b"}).json()
    assert b["status"] == "pending"
    b_id = b["task_id"]
    # t ≈ 0.45: the watchdog has marked a failed, but its run_fn (the
    # zombie) is still executing — the queue must not have advanced yet.
    time.sleep(0.4)
    assert client.get(f"/research/{a}").json()["status"] == "failed"
    assert client.get(f"/research/{b_id}").json()["status"] == "pending"
    # t ≈ 1.0: the zombie's run_fn returns; only now does the pump start b.
    last_b = _wait(client, b_id, timeout=5)
    assert last_b["status"] == "completed"
    assert started["b"] - started["a"] >= 0.5


def test_health_reports_pending_count():
    release = threading.Event()

    def run_fn(topic, **kwargs):
        release.wait(timeout=10)
        return {
            "final_answer": f"done {topic}",
            "state": {"report_json": _fake_report_json(topic)},
            "stats": {"llm_calls": 1},
        }

    client = TestClient(api_server.create_app(run_fn=run_fn))
    assert client.get("/health").json()["pending"] == 0
    ids = [
        client.post("/research", json={"topic": t}).json()["task_id"]
        for t in ("one", "two", "three")
    ]
    body = client.get("/health").json()
    assert body["running"] is True
    assert body["pending"] == 2
    release.set()
    for task_id in ids:
        _wait(client, task_id)
    body = client.get("/health").json()
    assert body["running"] is False
    assert body["pending"] == 0


def test_promote_next_pending_is_fifo_and_idempotent():
    """Unit test of the pump: while anything is running it promotes
    nothing; racing concurrent pumps promote the oldest pending record
    exactly once (a task can never be started twice)."""
    lock = threading.Lock()
    a = api_server.TaskRecord(id="a", topic="a")  # running
    p1 = api_server.TaskRecord(id="p1", topic="p1", status="pending")
    p2 = api_server.TaskRecord(id="p2", topic="p2", status="pending")
    tasks = {"a": a, "p1": p1, "p2": p2}
    assert api_server.promote_next_pending(tasks, lock) is None
    a.status = "completed"
    results = []
    barrier = threading.Barrier(4)

    def pump():
        barrier.wait()
        results.append(api_server.promote_next_pending(tasks, lock))

    threads = [threading.Thread(target=pump) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    winners = [r for r in results if r is not None]
    assert len(winners) == 1
    assert winners[0].id == "p1"  # FIFO: oldest pending first
    assert p1.status == "running"
    assert p2.status == "pending"
    assert api_server.promote_next_pending(tasks, lock) is None  # p1 running


# ---------------------------------------------------------------------------
# GET /research/{id} + report endpoint
# ---------------------------------------------------------------------------


def test_report_after_completed(client):
    task_id = client.post("/research", json={"topic": "tiny topic"}).json()["task_id"]
    _wait(client, task_id)
    resp = client.get(f"/research/{task_id}/report")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/json")
    data = json.loads(resp.text)
    assert data["report"]["sections"]
    assert data["report"]["sections"][0]["heading"] == "One"


def test_report_while_running_is_409():
    release = threading.Event()

    def run_fn(topic, **kwargs):
        on_stage = kwargs.get("on_stage")
        if on_stage is not None:
            on_stage(1, "decomposing query")
        release.wait(timeout=10)
        return {
            "final_answer": f"done {topic}",
            "state": {"report_json": _fake_report_json(topic)},
            "stats": {"llm_calls": 1},
        }

    client = TestClient(api_server.create_app(run_fn=run_fn))
    task_id = client.post("/research", json={"topic": "tiny topic"}).json()["task_id"]
    resp = client.get(f"/research/{task_id}/report")
    assert resp.status_code == 409
    assert resp.json() == {"status": "running"}
    release.set()
    _wait(client, task_id)
    assert client.get(f"/research/{task_id}/report").status_code == 200


def test_unknown_task_is_404(client):
    assert client.get("/research/deadbeef").status_code == 404
    assert client.get("/research/deadbeef/report").status_code == 404


def test_empty_topic_is_422(client):
    assert client.post("/research", json={"topic": ""}).status_code == 422


def test_health(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["service"] == "multi-agent-rag-researcher"
    assert body["running"] is False
    assert isinstance(body["deep_configured"], bool)


# ---------------------------------------------------------------------------
# DELETE /research/{id}
# ---------------------------------------------------------------------------


def _stub_docs_env(monkeypatch, tmp_path, calls):
    """Hermetic docs dir + recording stubs for the vector-store seams."""
    docs_dir = tmp_path / "docs"
    docs_dir.mkdir()
    monkeypatch.setattr(api_server, "DEFAULT_DOCS_DIR", docs_dir)
    monkeypatch.setattr(
        api_server,
        "ingest_documents",
        lambda d: calls.append(("ingest", d)) or {"num_pdfs": 0, "num_chunks": 0},
    )
    monkeypatch.setattr(
        api_server, "reconcile_corpus", lambda d=None: calls.append(("reconcile", d))
    )
    return docs_dir


def _upload(client: TestClient, *names: str) -> None:
    files = [("files", (n, b"%PDF-1.4 fake", "application/pdf")) for n in names]
    client.post("/documents", files=files)


def test_delete_running_is_409():
    """A running task cannot be deleted: Python threads cannot be killed,
    so the run is left to finish; once terminal, the same delete succeeds."""
    release = threading.Event()

    def run_fn(topic, **kwargs):
        release.wait(timeout=10)
        return {
            "final_answer": f"done {topic}",
            "state": {"report_json": _fake_report_json(topic)},
            "stats": {"llm_calls": 1},
        }

    client = TestClient(api_server.create_app(run_fn=run_fn))
    task_id = client.post("/research", json={"topic": "t"}).json()["task_id"]
    resp = client.delete(f"/research/{task_id}")
    assert resp.status_code == 409
    assert resp.json() == {"error": "cannot delete a running task", "task_id": task_id}
    assert client.get(f"/research/{task_id}").status_code == 200  # still there
    release.set()
    _wait(client, task_id)
    assert client.delete(f"/research/{task_id}").status_code == 200


def test_delete_unknown_is_404(client):
    resp = client.delete("/research/deadbeef")
    assert resp.status_code == 404
    assert resp.json()["error"] == "unknown task: deadbeef"


def test_delete_completed_removes_from_store(client):
    task_id = client.post("/research", json={"topic": "tiny topic"}).json()["task_id"]
    _wait(client, task_id)
    resp = client.delete(f"/research/{task_id}")
    assert resp.status_code == 200
    assert resp.json() == {"deleted": task_id, "documents": []}
    assert client.get(f"/research/{task_id}").status_code == 404
    assert client.get(f"/research/{task_id}/report").status_code == 404
    assert client.get("/research").json()["tasks"] == []
    health = client.get("/health").json()
    assert health["running"] is False and health["pending"] == 0


def test_delete_pending_head_and_pump_promotes_next():
    """Deleting the head of the pending queue: the record is gone from the
    list, and the completion pump then promotes the NEXT surviving pending
    task (FIFO intact after the deletion)."""
    release = threading.Event()

    def run_fn(topic, **kwargs):
        run_fn.calls.append(topic)
        release.wait(timeout=10)
        return {
            "final_answer": f"done {topic}",
            "state": {"report_json": _fake_report_json(topic)},
            "stats": {"llm_calls": 1},
        }

    run_fn.calls = []
    client = TestClient(api_server.create_app(run_fn=run_fn))
    first = client.post("/research", json={"topic": "one"}).json()["task_id"]
    second = client.post("/research", json={"topic": "two"}).json()["task_id"]
    third = client.post("/research", json={"topic": "three"}).json()["task_id"]
    resp = client.delete(f"/research/{second}")
    assert resp.status_code == 200
    assert resp.json() == {"deleted": second, "documents": []}
    assert client.get(f"/research/{second}").status_code == 404
    listed = {t["id"]: t["status"] for t in client.get("/research").json()["tasks"]}
    assert listed == {first: "running", third: "pending"}
    release.set()
    _wait(client, first)
    # the pump started the survivor, never the deleted task
    _wait_for(lambda: run_fn.calls == ["one", "three"])
    _wait(client, third)


def test_delete_pending_task_cleans_its_documents(monkeypatch, tmp_path):
    """A deleted PENDING task never started, so its attached files were
    never ingested and still sit in the docs dir: the delete removes them
    and reconciles, so the next run's corpus is clean. The running task's
    documents are untouched."""
    calls = []
    docs_dir = _stub_docs_env(monkeypatch, tmp_path, calls)
    release = threading.Event()

    def run_fn(topic, **kwargs):
        run_fn.calls.append(topic)
        release.wait(timeout=10)
        return {"final_answer": "x", "state": {}, "stats": {}}

    run_fn.calls = []
    client = TestClient(api_server.create_app(run_fn=run_fn))
    _upload(client, "alpha.pdf", "beta.pdf")
    first = client.post("/research", json={"topic": "one"}).json()
    assert first["documents"] == ["alpha.pdf", "beta.pdf"]
    # first's worker: index-at-start (reconcile + ingest) then waits in fn
    _wait_for(lambda: run_fn.calls == ["one"])
    _upload(client, "gamma.pdf", "delta.pdf")
    second = client.post("/research", json={"topic": "two"}).json()
    assert second["status"] == "pending"
    assert second["documents"] == ["gamma.pdf", "delta.pdf"]
    calls.clear()  # deterministic baseline after first's index-at-start
    resp = client.delete(f"/research/{second['task_id']}")
    assert resp.status_code == 200
    assert resp.json() == {
        "deleted": second["task_id"],
        "documents": ["gamma.pdf", "delta.pdf"],
    }
    assert not (docs_dir / "gamma.pdf").exists()
    assert not (docs_dir / "delta.pdf").exists()
    assert (docs_dir / "alpha.pdf").exists() and (docs_dir / "beta.pdf").exists()
    # one reconcile from the delete; the pending task was never ingested
    assert calls == [("reconcile", docs_dir)]
    release.set()
    _wait(client, first["task_id"])
    # first's own exit-cleanup still ran afterwards (idempotent re-cleanup)
    assert not (docs_dir / "alpha.pdf").exists()
    assert calls.count(("reconcile", docs_dir)) == 2
    assert ("ingest", docs_dir) not in calls


def test_delete_completed_task_reruns_cleanup_idempotently(monkeypatch, tmp_path):
    """A completed task's documents were already cleaned up at exit; the
    delete re-runs the same cleanup (unlink missing_ok + reconcile) without
    error and reports the record's document list."""
    calls = []
    docs_dir = _stub_docs_env(monkeypatch, tmp_path, calls)

    def run_fn(topic, **kwargs):
        return {"final_answer": "x", "state": {}, "stats": {}}

    client = TestClient(api_server.create_app(run_fn=run_fn))
    _upload(client, "alpha.pdf")
    body = client.post("/research", json={"topic": "t"}).json()
    _wait(client, body["task_id"])
    # worker exit: the file is already gone, start + exit reconciled
    assert not (docs_dir / "alpha.pdf").exists()
    assert calls.count(("reconcile", docs_dir)) == 2
    calls.clear()
    resp = client.delete(f"/research/{body['task_id']}")
    assert resp.status_code == 200
    assert resp.json() == {"deleted": body["task_id"], "documents": ["alpha.pdf"]}
    assert calls == [("reconcile", docs_dir)]  # idempotent re-run
    assert client.get("/research").json()["tasks"] == []


# ---------------------------------------------------------------------------
# CORS (browser-based clients)
# ---------------------------------------------------------------------------

ORIGIN = {"Origin": "http://localhost:1234"}


def test_health_has_cors_headers_with_origin(client):
    resp = client.get("/health", headers=ORIGIN)
    assert resp.status_code == 200
    assert resp.headers["access-control-allow-origin"] == "*"


def test_options_preflight_allows_post_json(client):
    resp = client.options(
        "/research",
        headers={
            **ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Content-Type": "application/json",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert resp.status_code in (200, 204)
    assert resp.headers["access-control-allow-origin"] == "*"
    assert "POST" in resp.headers["access-control-allow-methods"]
    assert "content-type" in resp.headers["access-control-allow-headers"]


def test_post_research_has_cors_headers_with_origin(client):
    resp = client.post("/research", json={"topic": "tiny topic"}, headers=ORIGIN)
    assert resp.status_code == 202
    assert resp.headers["access-control-allow-origin"] == "*"


# ---------------------------------------------------------------------------
# Integration: REAL deep_research through the API (all LLM surfaces stubbed)
# ---------------------------------------------------------------------------


def test_real_deep_research_through_api(monkeypatch):
    tdp._install_stubs(monkeypatch, tdp._basic_env())
    # test_deep_pipeline's autouse temp-dir cleanup does not apply here;
    # collect the temp cache DB dir(s) this test created for manual cleanup.
    created = list(tdp._CACHE_TMP_DIRS)
    client = TestClient(api_server.create_app())  # default run_fn = real deep_research
    try:
        task_id = client.post(
            "/research",
            json={
                "topic": "what is a small thing",
                "max_rounds": 1,
                "budget_doc": 1,
                "budget_web": 1,
            },
        ).json()["task_id"]
        last = _wait(client, task_id, timeout=60)
        assert last["status"] == "completed", last.get("error")
        assert last["stats"]["sections"] >= 1
        rep = client.get(f"/research/{task_id}/report")
        assert rep.status_code == 200
        data = json.loads(rep.text)
        assert {"schema_version", "report", "quality"} <= set(data)
        assert data["schema_version"] == "1.0"
        assert data["report"]["sections"]
    finally:
        for d in created:
            shutil.rmtree(d, ignore_errors=True)
        tdp._CACHE_TMP_DIRS[:] = [p for p in tdp._CACHE_TMP_DIRS if p not in created]


# ---------------------------------------------------------------------------
# Hollow runs: the pipeline returns without a report (regression for task
# 9deb0f48 — an empty ResearchPlan early-finished the run, the record was
# finalized "completed" with a null report, /report served 200 "null", and
# paperbot 400'd on it). A run without a report artifact must end "failed"
# with a named error, and /report must 409, never 200 "null".
# ---------------------------------------------------------------------------


def _hollow_run_fn(with_reason: bool):
    """A run_fn that finishes the pipeline normally but without a report —
    the 9deb shape. state carries the orchestrator's final_error message
    only when with_reason is True."""

    def run_fn(topic, **kwargs):
        on_stage = kwargs.get("on_stage")
        if on_stage is not None:
            on_stage(1, "decomposing query")
            on_stage(1, "model returned an empty plan — retrying with fallback")
        state: dict = {}
        if with_reason:
            state["final_error"] = (
                "Deep research failed: the query could not be decomposed into "
                "sub-questions (the decomposer returned an empty plan)."
            )
        return {
            "final_answer": "Deep research failed: ...",
            "state": state,
            "stats": {"llm_calls": 1, "wall_s": 20.5, "sections": 0},
        }

    return run_fn


def test_hollow_run_finalizes_failed_with_reason():
    client = TestClient(api_server.create_app(run_fn=_hollow_run_fn(True)))
    task_id = client.post("/research", json={"topic": "t"}).json()["task_id"]
    last = _wait(client, task_id)
    # Not "completed" (the 9deb bug): no report artifact -> failed.
    assert last["status"] == "failed"
    assert last["error"].startswith("Deep research failed")
    assert "quality" not in last
    # The decompose retry is visible in the step log.
    assert any(
        s["stage"] == "decompose" and "empty plan" in s["detail"]
        for s in last["steps"]
    )
    # /report never serves a bare null: 409 naming the failure.
    resp = client.get(f"/research/{task_id}/report")
    assert resp.status_code == 409
    body = resp.json()
    assert body["status"] == "failed"
    assert body["error"].startswith("Deep research failed")


def test_hollow_run_without_reason_gets_default_error():
    client = TestClient(api_server.create_app(run_fn=_hollow_run_fn(False)))
    task_id = client.post("/research", json={"topic": "t"}).json()["task_id"]
    last = _wait(client, task_id)
    assert last["status"] == "failed"
    assert last["error"] == "run produced no report"


def _app_tasks(app) -> dict:
    """The per-app task store: a closure local of the report route."""
    route = next(
        r for r in app.router.routes
        if getattr(r, "path", "") == "/research/{task_id}/report"
    )
    for name, cell in zip(route.endpoint.__code__.co_freevars, route.endpoint.__closure__):
        if name == "tasks":
            return cell.cell_contents
    raise AssertionError("'tasks' not among the report route's free variables")


def test_report_409_when_completed_without_artifact():
    # Defensive branch: a record that reached "completed" without a report
    # (injected directly — the new _worker logic normally fails such runs
    # before they finalize completed) must 409, never 200 "null".
    app = api_server.create_app(
        run_fn=lambda topic, **kw: {"final_answer": "x", "state": {}, "stats": {}}
    )
    client = TestClient(app)
    rec = api_server.TaskRecord(id="hollow", topic="t", status="completed")
    rec.finished_at = time.time()
    _app_tasks(app)[rec.id] = rec
    resp = client.get("/research/hollow/report")
    assert resp.status_code == 409
    body = resp.json()
    assert body["error"] == "no report artifact — the run produced no report"
    assert body["status"] == "completed"
