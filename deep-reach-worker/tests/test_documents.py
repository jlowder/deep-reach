"""
Tests for RAG document staging (api_server.py /documents + task attachment).

Every vector-store and LLM surface is stubbed: the docs dir is a tmp dir
(monkeypatched) and api_server.ingest_documents / reconcile_corpus /
get_indexed_document_catalog are patched where used, so nothing touches
Qdrant, the repo's docs/, or the network.
"""

import json

import pytest
from fastapi.testclient import TestClient

import api_server
from test_api_server import _wait


# Minimal file with the %PDF magic bytes (ingest/cleanup are patched in
# every test, so deeper PDF validity does not matter).
TINY_PDF = (
    b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"
    b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"
    b"3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n"
    b"4 0 obj\n<< /Length 28 >>\nstream\nBT (hello) Tj ET\n"
    b"endstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n"
)
NOT_PDF = b"definitely not a pdf"


def _result(topic: str) -> dict:
    # Carries a report artifact: a run that returns without one is now
    # finalized "failed" (see api_server._worker), and these tests assert
    # "completed".
    return {
        "final_answer": f"done {topic}",
        "state": {
            "report_json": json.dumps(
                {"schema_version": "1.0", "report": {"sections": []}, "quality": None}
            )
        },
        "stats": {"llm_calls": 1},
    }


def _ok_run_fn(topic, **kwargs):
    return _result(topic)


@pytest.fixture()
def env(monkeypatch, tmp_path):
    """Hermetic docs environment: tmp docs dir + recording stubs for the
    vector-store seams (patched where used, i.e. in api_server's module
    namespace)."""
    docs_dir = tmp_path / "docs"
    ingest_calls: list = []
    reconcile_calls: list = []

    def fake_ingest(pdf_dir):
        ingest_calls.append(pdf_dir)
        return {"num_pdfs": 0, "num_chunks": 0}

    def fake_reconcile(pdf_dir=None):
        reconcile_calls.append(pdf_dir)
        return []

    monkeypatch.setattr(api_server, "DEFAULT_DOCS_DIR", docs_dir)
    monkeypatch.setattr(api_server, "ingest_documents", fake_ingest)
    monkeypatch.setattr(api_server, "reconcile_corpus", fake_reconcile)
    monkeypatch.setattr(api_server, "get_indexed_document_catalog", lambda: [])
    return {
        "docs_dir": docs_dir,
        "ingest": ingest_calls,
        "reconcile": reconcile_calls,
    }


def _client(run_fn=_ok_run_fn) -> TestClient:
    return TestClient(api_server.create_app(run_fn=run_fn, max_run_seconds=10))


def _upload(client: TestClient, *pairs) -> "TestClient":
    """POST /documents with the given (filename, bytes) pairs."""
    return client.post(
        "/documents",
        files=[("files", (name, data, "application/pdf")) for name, data in pairs],
    )


# ---------------------------------------------------------------------------
# POST /documents
# ---------------------------------------------------------------------------


def test_upload_pdf_accepted_201(env):
    client = _client()
    resp = _upload(client, ("alpha.pdf", TINY_PDF))
    assert resp.status_code == 201
    assert resp.json() == {"documents": ["alpha.pdf"], "rejected": {}}
    assert (env["docs_dir"] / "alpha.pdf").read_bytes() == TINY_PDF
    body = client.get("/documents").json()
    assert body["staged"] == ["alpha.pdf"]
    assert body["on_disk"] == ["alpha.pdf"]
    assert body["indexed"] == []


def test_upload_non_pdf_rejected(env):
    client = _client()
    # Mixed upload: one rejected, one accepted -> 201 with both reported.
    resp = _upload(client, ("notes.txt", NOT_PDF), ("beta.pdf", TINY_PDF))
    assert resp.status_code == 201
    body = resp.json()
    assert body["documents"] == ["beta.pdf"]
    assert "not a PDF" in body["rejected"]["notes.txt"]
    assert not (env["docs_dir"] / "notes.txt").exists()
    # All rejected -> 400.
    resp = _upload(client, ("notes.txt", NOT_PDF))
    assert resp.status_code == 400
    assert resp.json()["documents"] == []
    assert "not a PDF" in resp.json()["rejected"]["notes.txt"]


def test_upload_name_sanitized(env):
    client = _client()
    resp = _upload(client, ("My Report (1)!.pdf", TINY_PDF))
    assert resp.json()["documents"] == ["My_Report__1.pdf"]
    # A name with no usable characters falls back to document.pdf.
    resp = _upload(client, ("???.pdf", TINY_PDF))
    assert resp.json()["documents"] == ["document.pdf"]


def test_upload_dedupes_with_suffix(env):
    client = _client()
    first = _upload(client, ("alpha.pdf", TINY_PDF)).json()
    assert first["documents"] == ["alpha.pdf"]
    # 'alpha.pdf' collides (case-insensitive) with the staged file -> -2;
    # the uppercase variant keeps its case but collides twice -> ALPHA-3.pdf
    # (a case-differing duplicate would overwrite on a case-insensitive FS).
    second = _upload(client, ("alpha.pdf", TINY_PDF), ("ALPHA.PDF", TINY_PDF)).json()
    assert second["documents"] == ["alpha-2.pdf", "ALPHA-3.pdf"]
    assert sorted(p.name.lower() for p in env["docs_dir"].glob("*.pdf")) == [
        "alpha-2.pdf",
        "alpha-3.pdf",
        "alpha.pdf",
    ]
    assert client.get("/documents").json()["staged"] == [
        "alpha.pdf",
        "alpha-2.pdf",
        "ALPHA-3.pdf",
    ]


def test_get_documents_empty_shape(env):
    client = _client()
    assert client.get("/documents").json() == {
        "staged": [],
        "on_disk": [],
        "indexed": [],
    }


def test_delete_documents_clears_staged(env):
    client = _client()
    _upload(client, ("alpha.pdf", TINY_PDF), ("beta.pdf", TINY_PDF))
    resp = client.delete("/documents")
    assert resp.status_code == 200
    assert resp.json()["removed"] == ["alpha.pdf", "beta.pdf"]
    assert list(env["docs_dir"].glob("*.pdf")) == []
    assert client.get("/documents").json() == {
        "staged": [],
        "on_disk": [],
        "indexed": [],
    }
    assert env["reconcile"] == [env["docs_dir"]]


# ---------------------------------------------------------------------------
# Attachment at task creation + ingest at start + cleanup on exit
# ---------------------------------------------------------------------------


def test_research_attaches_staged_documents(env):
    client = _client()
    _upload(client, ("alpha.pdf", TINY_PDF), ("beta.pdf", TINY_PDF))
    body = client.post("/research", json={"topic": "t"}).json()
    assert body["documents"] == ["alpha.pdf", "beta.pdf"]
    # The staging area is consumed by exactly one task.
    assert client.get("/documents").json()["staged"] == []
    last = _wait(client, body["task_id"])
    assert last["documents"] == ["alpha.pdf", "beta.pdf"]
    listed = client.get("/research").json()["tasks"][0]
    assert listed["documents"] == ["alpha.pdf", "beta.pdf"]


def test_task_without_docs_skips_ingest(env):
    client = _client()
    body = client.post("/research", json={"topic": "t"}).json()
    assert body["documents"] == []
    _wait(client, body["task_id"])
    assert env["ingest"] == []
    assert env["reconcile"] == []


def test_ingest_at_start_and_cleanup_on_exit(env):
    state = {}

    def run_fn(topic, **kwargs):
        # Snapshot the seam call counts while the pipeline is mid-run.
        state["ingest_at_fn"] = len(env["ingest"])
        state["reconcile_at_fn"] = len(env["reconcile"])
        return _result(topic)

    client = _client(run_fn=run_fn)
    _upload(client, ("alpha.pdf", TINY_PDF))
    body = client.post("/research", json={"topic": "t"}).json()
    last = _wait(client, body["task_id"])
    assert last["status"] == "completed"
    # Indexed exactly once, with the docs dir, BEFORE the pipeline ran...
    assert state["ingest_at_fn"] == 1
    assert state["reconcile_at_fn"] == 1
    assert env["ingest"] == [env["docs_dir"]]
    # ...and the file is gone with a final reconcile after the run.
    assert not (env["docs_dir"] / "alpha.pdf").exists()
    assert env["reconcile"] == [env["docs_dir"], env["docs_dir"]]
    # The documents step is the first recorded step (the stub fn records
    # no pipeline stages of its own).
    assert last["steps"][0]["stage"] == "documents"
    assert "indexing 1 document" in last["steps"][0]["detail"]


def test_docs_ingest_failure_does_not_kill_task(env, monkeypatch):
    def boom(pdf_dir):
        raise RuntimeError("qdrant on fire")

    monkeypatch.setattr(api_server, "ingest_documents", boom)
    client = _client()
    _upload(client, ("alpha.pdf", TINY_PDF))
    body = client.post("/research", json={"topic": "t"}).json()
    last = _wait(client, body["task_id"])
    assert last["status"] == "completed"
    assert any(
        s["stage"] == "documents" and "indexing failed" in s["detail"]
        for s in last["steps"]
    )
    # Cleanup still ran.
    assert not (env["docs_dir"] / "alpha.pdf").exists()


def test_failed_task_cleans_up_docs(env):
    def run_fn(topic, **kwargs):
        raise RuntimeError("boom")

    client = _client(run_fn=run_fn)
    _upload(client, ("alpha.pdf", TINY_PDF))
    body = client.post("/research", json={"topic": "t"}).json()
    last = _wait(client, body["task_id"])
    assert last["status"] == "failed"
    assert "boom" in last["error"]
    assert not (env["docs_dir"] / "alpha.pdf").exists()
    assert env["reconcile"] == [env["docs_dir"], env["docs_dir"]]
