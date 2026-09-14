"""One secret resolution for the pipeline and the settings layer.

Regression for the pause-merge settings work: the startup migration
blanked the API-key lines in ``utils/var.env`` after moving them to the
OS keyring, but the pipeline (``utils/config.py`` ``get_config()``) still
read the raw environment — a blank dotenv line is an *empty string*,
which is a truthy enough value to skip the client's "missing key" branch
and degrade to the ``dummy`` auth key that the LLM server rejects.
"Test LLM" in the dialog passed (it uses the keyring); every pipeline
call 401'd.

These tests pin the contract (patterns follow ``tests/test_settings.py``:
fake keyring, tmp var.env, loopback stubs, no real network):

- (a) a blanked var.env + a keychain key + a fake LLM HTTP endpoint that
  asserts the Authorization header of every request equals the keychain
  value; the full pipeline run must resolve the keychain key end-to-end.
- (b) no keyring entry + no env var -> the deep run refuses to start,
  naming the exact variable, and makes zero LLM calls (direct call and
  through the API layer: the record finalizes ``failed``).
- (c) a run whose section drafts all fail (the writer raises like a 401)
  assembles zero sections -> the run finalizes ``failed`` with the captured
  last LLM error, never ``completed``; GET /report stays 409.
- (d) zero sources with drafted sections -> still ``completed`` with the
  UNSOURCED disclosure (existing behavior, unchanged).

Run:  venv/bin/python -m pytest tests/test_secret_resolution.py -q
"""

from __future__ import annotations

import importlib
import json
import shutil
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient

import api_server
import deep_research_orchestrator as dpo
import utils.config as config_mod
import utils.settings as s
import worker_agents.model_runner as model_runner
# importlib (not `import ... as`): worker_agents/__init__.py re-exports the
# agent functions, shadowing the submodule attributes.
rmod = importlib.import_module("worker_agents.retriever_agent")
wmod = importlib.import_module("worker_agents.writer_agent")
import test_deep_pipeline as tdp
from test_deep_pipeline import (
    CRITIC_OK_JSON,
    PLAN_JSON,
    SUFFICIENT_JSON,
    _json_writer,
)
from test_settings import FAKE_FILE, FakeKeyring

ecache_mod = importlib.import_module("memory.evidence_cache")

# A key that exists ONLY in the (fake) keychain; the var.env line is blank.
KEYCHAIN_KEY = "omlx-keychain-secret-123"


@pytest.fixture(autouse=True)
def iso(tmp_path, monkeypatch):
    """Isolate every live surface the pipeline resolves through."""
    # 1. var.env in the POST-migration state: the three key lines are blank.
    var_env = tmp_path / "var.env"
    var_env.write_text(FAKE_FILE, encoding="utf-8")
    monkeypatch.setattr(s, "VAR_ENV_PATH", var_env)
    # 2. An empty fake keyring; individual tests opt in to entries.
    monkeypatch.setattr(s, "_KEYRING", FakeKeyring())
    # 3. The real file's dotenv residue: managed keys + legacy aliases +
    #    the per-agent/effort/cache vars that config reads off os.environ.
    for name in [
        *s.MANAGED_VARS,
        "OPENAI_API_KEY",
        "OPENAI_ENDPOINT",
        "OPENAI_MODEL",
        "DECOMPOSER_MODEL",
        "LLM_ENABLE_THINKING",
        "EVIDENCE_CACHE_ENABLED",
    ]:
        monkeypatch.delenv(name, raising=False)
    # 4. Evidence cache -> tmp DB; doc catalog -> empty (no qdrant touch).
    monkeypatch.setattr(ecache_mod, "EVIDENCE_CACHE_DB_PATH", tmp_path / "evidence_cache_test.db")
    monkeypatch.setattr(ecache_mod, "_purged_this_process", False)
    monkeypatch.setattr(dpo, "_read_doc_catalog", lambda: [])
    config_mod.reset_config()
    yield
    config_mod.reset_config()


@pytest.fixture(autouse=True)
def _cache_tmp_cleanup():
    # _install_stubs registers throwaway evidence-cache dirs in
    # test_deep_pipeline's registry; that module's cleanup fixture only
    # covers its own tests.
    yield
    for d in tdp._CACHE_TMP_DIRS:
        shutil.rmtree(d, ignore_errors=True)
    tdp._CACHE_TMP_DIRS.clear()


def _canned_response(text: str) -> dict:
    """A minimal-but-complete OpenAI /responses 200 body (the SDK parses
    this into a Response; mirrors tests/test_settings.py's canned dict)."""
    return {
        "id": "resp_1",
        "object": "response",
        "status": "completed",
        "model": "stub-model",
        "output": [
            {
                "type": "message",
                "status": "completed",
                "role": "assistant",
                "content": [
                    {"type": "output_text", "text": text, "annotations": []},
                ],
            },
        ],
        "usage": {
            "input_tokens": 1,
            "output_tokens": 1,
            "total_tokens": 2,
            "input_tokens_details": {"cached_tokens": 0},
            "output_tokens_details": {"reasoning_tokens": 0},
        },
    }


def _make_llm_stub(routes: list[tuple[str, str]]):
    """A loopback OpenAI-compatible /v1/responses stub. Records the
    Authorization header of every request and replies with a canned
    response whose text is selected by the first instructions marker
    that matches (robust to call order/count)."""

    seen_auth: list[str] = []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        timeout = 5

        def log_message(self, *args):
            pass

        def do_POST(self):
            length = int(self.headers.get("content-length") or 0)
            body = json.loads(self.rfile.read(length)) if length else {}
            seen_auth.append(self.headers.get("authorization"))
            instructions = str(body.get("instructions") or "")
            text = next(
                (t for marker, t in routes if marker in instructions),
                SUFFICIENT_JSON,
            )
            data = json.dumps(_canned_response(text)).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    return server, base, seen_auth


def _web_results(query: str) -> dict:
    return {
        "query": query,
        "results": [
            {"title": "Vector databases", "url": "https://ex.example/a",
             "content": "embeddings and ANN indexes for retrieval", "score": 0.9},
            {"title": "Similarity search", "url": "https://ex.example/b",
             "content": "cosine similarity over dense vectors", "score": 0.8},
        ],
    }


def _deep_run_fn(topic: str, **budgets) -> dict:
    """run_fn in the shape api_server.default_run_fn calls it with."""
    on_stage = budgets.pop("on_stage", None)
    on_section = budgets.pop("on_section", None)
    return dpo.deep_research(
        user_query=topic,
        verbose=False,
        max_rounds=int(budgets.get("max_rounds", 3)),
        budget_doc=int(budgets.get("budget_doc", 10)),
        budget_web=int(budgets.get("budget_web", 5)),
        on_stage=on_stage,
        on_section=on_section,
    )


def _wait(client: TestClient, tid: str, timeout: float = 10.0) -> dict:
    """Poll GET /research/{id} until the record is terminal."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        rec = client.get(f"/research/{tid}").json()
        if rec["status"] not in ("pending", "running"):
            return rec
        time.sleep(0.05)
    return rec


def _cited_section() -> str:
    """A valid 300+ word Section whose prose cites the registry keys [W1,
    W2], so the assembled report carries its sources (refs -> sources)."""
    return json.dumps(
        {
            "id": "section-body",
            "heading": "Section body",
            "blocks": [
                {
                    "type": "paragraph",
                    "spans": [
                        {
                            "text": "Dense vectors power retrieval. "
                            + " ".join(f"word{j} [W1]" for j in range(155)),
                            "citations": ["W1"],
                        },
                        {
                            "text": "Indexes keep recall high. "
                            + " ".join(f"tail{j} [W2]" for j in range(155)),
                            "citations": ["W2"],
                        },
                    ],
                }
            ],
        }
    )


def _synthesis_json() -> str:
    return _json_writer(9)  # a valid 300+ word Section stands in for the synthesis


class TestPipelineResolvesKeychainKey:
    def test_pipeline_uses_keychain_key_when_var_env_blanked(self, monkeypatch):
        """(a) THE regression: blanked var.env + keychain key + a fake LLM
        endpoint asserting the Authorization header equals the keychain
        value. The pipeline must resolve the keychain key end-to-end."""
        s._KEYRING.set_password("deep-reach", "llm-api-key", KEYCHAIN_KEY)
        routes = [
            ("decomposition worker", PLAN_JSON),
            ("sufficiency evaluator", SUFFICIENT_JSON),
            ("CRITIC", CRITIC_OK_JSON),
            ("FINAL SYNTHESIS", _synthesis_json()),
            # the writer call's instructions carry the substituted heading
            ("Section One", _cited_section()),
            ("Section Two", _cited_section()),
            ("ONE section", _cited_section()),
            ("executive summary", "Vector databases store dense embeddings.\n\nANN indexes retrieve them."),
        ]
        server, base, auths = _make_llm_stub(routes)
        try:
            monkeypatch.setenv("LLM_ENDPOINT", f"{base}/v1")
            monkeypatch.setenv("LLM_MODEL", "stub-model")
            monkeypatch.setattr(
                rmod, "retrieve_document",
                lambda query, **k: {"query": query, "chunks": []},
            )
            monkeypatch.setattr(rmod, "web_search", _web_results)

            # The asserting line (config level): the per-agent config the
            # pipeline builds must carry the keychain key, not "" / dummy.
            assert config_mod.get_config().get_agent_config("writer").api_key == KEYCHAIN_KEY

            result = dpo.deep_research(
                "Explain vector databases for retrieval",
                verbose=False,
                max_rounds=2,
                budget_doc=0,
                budget_web=2,
            )
        finally:
            server.shutdown()

        # The asserting line (wire level): EVERY request the pipeline made
        # carried the keychain key as the bearer token.
        assert auths, "the pipeline made no LLM requests at all"
        assert all(a == f"Bearer {KEYCHAIN_KEY}" for a in auths), auths

        report = json.loads(result["state"]["report_json"])
        assert len(report["report"]["sections"]) == 2
        assert len(report["report"]["sources"]) == 2
        assert result["stats"]["llm_calls"] == len(auths)


class TestUnresolvableKeyFailsFast:
    def test_no_keyring_no_env_fails_fast(self, monkeypatch):
        """(b) no keyring entry and no env var -> the deep run refuses to
        start, naming the exact variable, and makes zero LLM calls."""
        result = dpo.deep_research(
            "topic", verbose=False, max_rounds=1, budget_doc=0, budget_web=1
        )
        err = result["state"]["final_error"]
        assert err == (
            "LLM_API_KEY not set — store it in the OS keychain or set the "
            "environment variable LLM_API_KEY"
        )
        assert result["stats"]["llm_calls"] == 0  # no doomed calls

    def test_no_keyring_no_env_finalizes_failed_via_api(self):
        """(b, API level) the record ends ``failed`` with the same message —
        never ``completed`` with an empty report."""
        client = TestClient(api_server.create_app(run_fn=_deep_run_fn))
        r = client.post(
            "/research",
            json={"topic": "t", "max_rounds": 1, "budget_doc": 0, "budget_web": 0},
        )
        assert r.status_code == 202
        tid = r.json()["task_id"]
        rec = _wait(client, tid)
        assert rec["status"] == "failed"
        assert "LLM_API_KEY" in rec["error"]
        assert rec["stats"]["llm_calls"] == 0
        assert client.get(f"/research/{tid}/report").status_code == 409


class TestZeroSectionsFails:
    def test_all_writers_failed_finalizes_failed_with_captured_error(
        self, monkeypatch, pin_keyring
    ):
        """(c) the production failure mode: the key is resolvable so the run
        starts, but every section draft 401s (writer raises) -> zero
        sections assembled -> the run finalizes ``failed`` with the captured
        last LLM error, never ``completed``; GET /report stays 409. Sources
        exist, so the guard fires regardless of sourcing."""
        pin_keyring(llm=KEYCHAIN_KEY)
        tdp._install_stubs(monkeypatch, tdp._basic_env())

        def raising_writer(*a, **k):
            # Like a 401 from the LLM server: run_model raises and records
            # the failure in its process-global capture.
            model_runner.last_llm_error = (
                'AuthenticationError: Error code: 401 - {"error": '
                '{"message": "rejected api key", "type": "authentication_error"}}'
            )
            raise RuntimeError(
                'Error code: 401 - {"error": {"message": "rejected api key"}}'
            )

        monkeypatch.setattr(wmod, "run_model", raising_writer)

        client = TestClient(api_server.create_app(run_fn=_deep_run_fn))
        tid = client.post(
            "/research",
            json={"topic": "t", "max_rounds": 1, "budget_doc": 0, "budget_web": 1},
        ).json()["task_id"]
        rec = _wait(client, tid)
        assert rec["status"] == "failed", rec.get("error")
        assert rec["error"].startswith("run produced no sections")
        assert "rejected api key" in rec["error"]  # the captured real cause
        assert "rejected api key" in rec["stats"]["last_llm_error"]
        assert client.get(f"/research/{tid}/report").status_code == 409

    def test_zero_sections_with_sources_via_direct_call(self, monkeypatch, pin_keyring):
        """(c, direct) the same guard outside the API layer: the result dict
        carries final_error, no report_json, and the captured error."""
        pin_keyring(llm=KEYCHAIN_KEY)
        tdp._install_stubs(monkeypatch, tdp._basic_env())

        def failing_writer(*a, **k):
            model_runner.last_llm_error = "RateLimitError: 429 too many requests"
            raise RuntimeError("Error code: 429 - rate limited")

        monkeypatch.setattr(wmod, "run_model", failing_writer)
        result = dpo.deep_research(
            "topic", verbose=False, max_rounds=1, budget_doc=0, budget_web=1
        )
        assert result["state"].get("report_json") is None
        assert "no sections" in result["state"]["final_error"]
        assert result["stats"]["sections"] == 0
        assert result["stats"]["last_llm_error"] == "RateLimitError: 429 too many requests"


class TestUnsourcedStillCompletes:
    def test_zero_sources_with_sections_completes_unsourced(self, monkeypatch, pin_keyring):
        """(d) the existing behavior, unchanged: drafted sections but zero
        retrieved sources -> still ``completed`` + UNSOURCED disclosure (a
        real report with no backing evidence), not failed."""
        pin_keyring(llm=KEYCHAIN_KEY)
        env = tdp._basic_env()
        env["web_results"] = lambda query: []  # no web hits at all
        tdp._install_stubs(monkeypatch, env)

        stages: list[tuple[int, str]] = []
        result = _deep_run_fn(
            "t",
            max_rounds=1,
            budget_doc=0,
            budget_web=1,
            on_stage=lambda n, d: stages.append((n, d)),
            on_section=lambda *a: None,
        )
        assert result["state"]["report_json"] is not None
        report = json.loads(result["state"]["report_json"])
        assert len(report["report"]["sections"]) == 2  # writers succeeded
        assert len(report["report"]["sources"]) == 0
        # the unsourced disclosure lands in the terminal assembly step
        assert any("UNSOURCED" in d for _n, d in stages)
        assert result["state"].get("final_error") is None

        # API level: the same run finalizes completed (not failed) with a
        # fetchable report whose quality reflects the missing sources.
        client = TestClient(api_server.create_app(run_fn=_deep_run_fn))
        tid = client.post(
            "/research",
            json={"topic": "t", "max_rounds": 1, "budget_doc": 0, "budget_web": 1},
        ).json()["task_id"]
        rec = _wait(client, tid)
        assert rec["status"] == "completed", rec.get("error")
        rep = client.get(f"/research/{tid}/report")
        assert rep.status_code == 200
        assert json.loads(rep.text)["report"]["sources"] == []
