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

Run:  venv/bin/python -m pytest tests/test_secret_resolution.py -q
"""

from __future__ import annotations

import importlib
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient

import api_server
import deep_research_orchestrator as dpo
import utils.config as config_mod
import utils.settings as s
# importlib (not `import ... as`): worker_agents/__init__.py re-exports the
# agent functions, shadowing the submodule attributes.
rmod = importlib.import_module("worker_agents.retriever_agent")
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
        deadline = time.time() + 10
        while time.time() < deadline:
            rec = client.get(f"/research/{tid}").json()
            if rec["status"] not in ("pending", "running"):
                break
            time.sleep(0.05)
        assert rec["status"] == "failed"
        assert "LLM_API_KEY" in rec["error"]
        assert rec["stats"]["llm_calls"] == 0
        assert client.get(f"/research/{tid}/report").status_code == 409
