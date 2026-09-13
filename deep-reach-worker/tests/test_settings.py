"""
Tests for the settings store (utils/settings.py) and the /settings API
surface in api_server.py.

No real keychain, no real var.env, no external network: the keyring module,
the var.env path, and the managed environment variables are all monkeypatched
per test (autouse fixture), so nothing here touches the user's live var.env,
OS keyring, or environment. The only "network" is a loopback stub HTTP
server for the /settings/test endpoint.
"""

import importlib
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

s = importlib.import_module("utils.settings")
config_mod = importlib.import_module("utils.config")
import api_server  # noqa: E402  (heavy: pulls the pipeline; needed for the app)
from qdrant_vector_database import vector_store  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures + doubles
# ---------------------------------------------------------------------------

FAKE_FILE = """\
# Multi-Agent RAG Researcher Configuration
LLM_ENDPOINT=http://localhost:8080/v1
LLM_API_KEY=
LLM_MODEL=Ornith-1.5-35B-A3B-MLX-8bit
DECOMPOSER_MODEL=Ornith-1.5-35B-A3B-MLX-8bit
RETRIEVER_REASONING_EFFORT=low
WRITER_REASONING_EFFORT=low
VERIFIER_REASONING_EFFORT=low
ORCHESTRATOR_REASONING_EFFORT=low
OPENAI_ENDPOINT=https://api.openai.com/v1
OPENAI_API_KEY=your_openai_api_key_here
OPENAI_MODEL=gpt-5.4
TAVILY_API_KEY=
SEARCH_TOOL=searxng
SEARXNG_URL=http://localhost:8081
SEARCH_THROTTLE_MS=0
EMBEDDING_ENDPOINT=http://localhost:8080/v1
EMBEDDING_MODEL=nomicai-modernbert-embed-base-bf16
EMBEDDING_API_KEY=
LLM_ENABLE_THINKING=true
"""

# Pre-migration state: plaintext keys still in the file (what startup migration consumes).
FAKE_FILE_LIVE = (
    FAKE_FILE.replace("LLM_API_KEY=\n", "LLM_API_KEY=omlx-fake-llm-key\n")
    .replace("TAVILY_API_KEY=\n", "TAVILY_API_KEY=tvly-fake-tavily-key\n")
    .replace("EMBEDDING_API_KEY=\n", "EMBEDDING_API_KEY=omlx-fake-emb-key\n")
)


class FakeKeyring:
    """In-memory stand-in for the keyring module (what utils.settings uses)."""

    def __init__(self, backend_name="Fake Keyring", viable=True, raise_on_probe=False, entries=None):
        self._entries = dict(entries or {})
        self._backend_name = backend_name
        self._viable = viable
        self._raise = raise_on_probe

    def get_keyring(self):
        if self._raise:
            raise RuntimeError("keyring probe failed")
        return _FakeBackend(self._backend_name, self._viable)

    def get_password(self, service, entry):
        return self._entries.get((service, entry))

    def set_password(self, service, entry, value):
        self._entries[(service, entry)] = value

    def delete_password(self, service, entry):
        if (service, entry) not in self._entries:
            raise KeyError(entry)
        del self._entries[(service, entry)]

    def has(self, service, entry):
        return (service, entry) in self._entries


def _FakeBackend(name, viable):
    return type("B", (), {"name": name, "viable": viable})()


@pytest.fixture(autouse=True)
def iso(tmp_path, monkeypatch):
    """Isolate every mutable global the settings code touches."""
    var_env = tmp_path / "var.env"
    var_env.write_text(FAKE_FILE, encoding="utf-8")  # post-migration: key lines blank
    monkeypatch.setattr(s, "VAR_ENV_PATH", var_env)
    # LLM key already in the keyring (as after startup migration); the others unset.
    monkeypatch.setattr(s, "_KEYRING", FakeKeyring(
        entries={("deep-reach", "llm-api-key"): "omlx-fake-llm-key"}
    ))
    # Deterministic environment: the managed vars hold the user's REAL keys
    # (dotenv-loaded at import); clear them and let monkeypatch restore.
    for k in s.MANAGED_VARS:
        if k in os.environ:
            monkeypatch.delenv(k, raising=False)
        else:
            monkeypatch.setenv(k, "")  # registers "absent" as the prior state
    # Keep the import-frozen embedding constants in sync with the fake file
    # so requires_restart comparisons are deterministic.
    monkeypatch.setattr(vector_store, "EMBEDDING_ENDPOINT", "http://localhost:8080/v1")
    monkeypatch.setattr(vector_store, "EMBEDDING_MODEL_NAME", "nomicai-modernbert-embed-base-bf16")
    monkeypatch.setattr(vector_store, "EMBEDDING_API_KEY", None)  # matches the blank file line
    config_mod.reset_config()
    yield
    config_mod.reset_config()


def make_app() -> TestClient:
    return TestClient(
        api_server.create_app(run_fn=lambda **k: {"final_answer": "x", "state": {}, "stats": {}})
    )


def make_stub(routes: dict):
    """Loopback HTTP server answering canned JSON per exact path."""

    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        timeout = 5  # idle keep-alive reads return so serve_forever can exit

        def log_message(self, *a):
            pass

        def _reply(self):
            length = int(self.headers.get("content-length") or 0)
            if length:  # drain the request body or the pooled socket wedges
                self.rfile.read(length)
            body = routes.get(self.path.split("?")[0])  # ignore query strings
            if body is None:
                status, data = 404, b'{"error":"no such route"}'
            else:
                status, data = 200, json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))  # keep-alive safe
            self.end_headers()
            self.wfile.write(data)

        do_GET = do_POST = _reply

    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


# ---------------------------------------------------------------------------
# Layer 1: var.env surgery
# ---------------------------------------------------------------------------


class TestVarEnvSurgery:
    def test_read_parses_defined_keys_only(self, tmp_path):
        p = tmp_path / "v.env"
        p.write_text("# comment\nA=1\n\n# B=2\nB = 3 \nC\n")
        assert s.read_var_env(p) == {"A": "1", "B": "3"}  # commented/line-no-equals skipped

    def test_read_missing_file(self, tmp_path):
        assert s.read_var_env(tmp_path / "nope.env") == {}

    def test_is_unset(self):
        assert s.is_unset(None) and s.is_unset("") and s.is_unset("  ")
        assert s.is_unset("your_openai_api_key_here") and s.is_unset("YOUR_key")
        assert s.is_unset("n/a") and s.is_unset("null")
        assert not s.is_unset("omlx-om5hh4rsln2h3f8w") and not s.is_unset("lm-studio")

    def test_update_in_place_preserves_everything_else(self, tmp_path):
        p = tmp_path / "v.env"
        original = "# head\nLLM_ENDPOINT=http://a:1/v1\n# note\nOPENAI_MODEL=gpt-5.4\n\nLLM_MODEL=Old\n"
        p.write_text(original)
        assert s.write_managed_vars({"LLM_ENDPOINT": "http://b:2/v1"}, p)
        lines = p.read_text().splitlines()
        assert lines[0] == "# head" and lines[1] == "LLM_ENDPOINT=http://b:2/v1"
        assert lines[2] == "# note" and lines[3] == "OPENAI_MODEL=gpt-5.4" and lines[4] == ""
        assert s.read_var_env(p)["LLM_MODEL"] == "Old"  # untouched key

    def test_create_missing_keys_with_marker(self, tmp_path):
        p = tmp_path / "v.env"
        p.write_text("LLM_ENDPOINT=http://a\n")
        s.write_managed_vars({"SEARCH_THROTTLE_MS": "250"}, p)
        text = p.read_text()
        assert "# settings dialog" in text
        assert "SEARCH_THROTTLE_MS=250" in text
        assert s.read_var_env(p) == {"LLM_ENDPOINT": "http://a", "SEARCH_THROTTLE_MS": "250"}

    def test_write_is_idempotent(self, tmp_path):
        p = tmp_path / "v.env"
        p.write_text("LLM_ENDPOINT=http://a\n")
        assert s.write_managed_vars({"LLM_ENDPOINT": "http://b"}, p)
        before = p.read_text()
        assert not s.write_managed_vars({"LLM_ENDPOINT": "http://b"}, p)
        assert p.read_text() == before

    def test_commented_line_is_not_a_definition(self, tmp_path):
        p = tmp_path / "v.env"
        p.write_text("# LLM_MODEL=Qwen3\nLLM_ENDPOINT=http://a\n")
        s.write_managed_vars({"LLM_MODEL": "New"}, p)
        text = p.read_text()
        assert "# LLM_MODEL=Qwen3" in text  # the comment survives
        assert "LLM_MODEL=New" in text  # ...and the real key was created

    def test_blank_value_retires_line_in_place(self, tmp_path):
        p = tmp_path / "v.env"
        p.write_text("LLM_API_KEY=live-secret\nLLM_MODEL=m\n")
        s.write_managed_vars({"LLM_API_KEY": ""}, p)
        lines = p.read_text().splitlines()
        assert lines[0] == "LLM_API_KEY=" and lines[1] == "LLM_MODEL=m"


# ---------------------------------------------------------------------------
# Layer 2: keyring resolution chain
# ---------------------------------------------------------------------------


class TestKeyringChain:
    def test_keyring_wins_over_env(self, monkeypatch):
        kr = FakeKeyring(entries={("deep-reach", "llm-api-key"): "from-keyring"})
        monkeypatch.setattr(s, "_KEYRING", kr)
        monkeypatch.setenv("LLM_API_KEY", "from-env")
        assert s.get_secret("llm-api-key") == ("from-keyring", "keyring")

    def test_env_fallback_when_keyring_empty(self, monkeypatch):
        monkeypatch.setattr(s, "_KEYRING", FakeKeyring())
        monkeypatch.setenv("LLM_API_KEY", "from-env")
        assert s.get_secret("llm-api-key") == ("from-env", "env")

    def test_placeholder_env_counts_as_unset(self, monkeypatch):
        monkeypatch.setattr(s, "_KEYRING", FakeKeyring())
        monkeypatch.setenv("LLM_API_KEY", "your_openai_api_key_here")
        assert s.get_secret("llm-api-key") == (None, None)

    def test_both_missing_refuses(self, monkeypatch):
        monkeypatch.setattr(s, "_KEYRING", FakeKeyring())
        assert s.get_secret("tavily-api-key") == (None, None)

    def test_set_stores_into_keyring(self, monkeypatch):
        kr = FakeKeyring()
        monkeypatch.setattr(s, "_KEYRING", kr)
        s.set_secret("llm-api-key", "k1")
        assert kr.has("deep-reach", "llm-api-key")
        assert s.get_secret("llm-api-key") == ("k1", "keyring")

    def test_set_refuses_without_keyring_naming_env_var(self, monkeypatch):
        for kr in (FakeKeyring(backend_name=None, viable=False),
                   FakeKeyring(backend_name="No keyring"),
                   FakeKeyring(raise_on_probe=True)):
            monkeypatch.setattr(s, "_KEYRING", kr)
            assert s.keyring_available() == (False, None)
            with pytest.raises(s.SettingsError) as ei:
                s.set_secret("llm-api-key", "k1")
            assert "LLM_API_KEY" in str(ei.value)

    def test_delete_removes_and_missing_delete_is_noop(self, monkeypatch):
        kr = FakeKeyring(entries={("deep-reach", "llm-api-key"): "k1"})
        monkeypatch.setattr(s, "_KEYRING", kr)
        s.set_secret("llm-api-key", "")
        assert not kr.has("deep-reach", "llm-api-key")
        s.set_secret("llm-api-key", "")  # idempotent
        assert s.get_secret("llm-api-key") == (None, None)

    def test_unknown_secret_raises(self, monkeypatch):
        monkeypatch.setattr(s, "_KEYRING", FakeKeyring())
        with pytest.raises(s.SettingsError):
            s.get_secret("nope-api-key")
        with pytest.raises(s.SettingsError):
            s.set_secret("nope-api-key", "x")

    def test_backend_name_mapping(self, monkeypatch):
        monkeypatch.setattr(s, "_KEYRING", FakeKeyring(backend_name="macOS Keyring"))
        assert s.keyring_available() == (True, "macOS Keyring")
        monkeypatch.setattr(s, "_KEYRING", FakeKeyring(backend_name=None, viable=False))
        assert s.keyring_available() == (False, None)


# ---------------------------------------------------------------------------
# Layer 3: migration + hot reload
# ---------------------------------------------------------------------------


class TestMigration:
    def _go_live(self, monkeypatch):
        """Restore the pre-migration state: plaintext keys back in the file."""
        s.VAR_ENV_PATH.write_text(FAKE_FILE_LIVE, encoding="utf-8")
        s._KEYRING._entries.clear()

    def test_moves_live_plaintext_and_blanks_file(self, monkeypatch):
        self._go_live(monkeypatch)
        moved = s.migrate_plaintext_secrets()
        kr = s._KEYRING
        assert sorted(moved) == ["embedding-api-key", "llm-api-key", "tavily-api-key"]
        assert kr.get_password("deep-reach", "llm-api-key") == "omlx-fake-llm-key"
        file = s.read_var_env()
        assert file["LLM_API_KEY"] == "" and file["TAVILY_API_KEY"] == ""
        assert file["EMBEDDING_API_KEY"] == ""  # var.env keeps no plaintext
        assert file["LLM_MODEL"] == "Ornith-1.5-35B-A3B-MLX-8bit"  # non-secrets intact

    def test_idempotent_second_run(self, monkeypatch):
        self._go_live(monkeypatch)
        assert s.migrate_plaintext_secrets()
        before = s.VAR_ENV_PATH.read_text()
        assert s.migrate_plaintext_secrets() == []  # nothing left to move
        assert s.VAR_ENV_PATH.read_text() == before
        assert s._KEYRING.get_password("deep-reach", "llm-api-key") == "omlx-fake-llm-key"

    def test_never_overwrites_existing_keyring_entry(self, monkeypatch):
        kr = FakeKeyring(entries={("deep-reach", "llm-api-key"): "user-changed-key"})
        monkeypatch.setattr(s, "_KEYRING", kr)
        s.VAR_ENV_PATH.write_text(FAKE_FILE_LIVE, encoding="utf-8")
        s.migrate_plaintext_secrets()
        assert kr.get_password("deep-reach", "llm-api-key") == "user-changed-key"
        assert s.read_var_env()["LLM_API_KEY"] == ""  # file still retired

    def test_no_keyring_leaves_file_untouched(self, monkeypatch):
        self._go_live(monkeypatch)
        monkeypatch.setattr(s, "_KEYRING", FakeKeyring(backend_name=None, viable=False))
        before = s.VAR_ENV_PATH.read_text()
        assert s.migrate_plaintext_secrets() == []
        assert s.VAR_ENV_PATH.read_text() == before  # env path keeps working


class TestHotReload:
    def test_reload_updates_env_and_config_singleton(self, monkeypatch):
        monkeypatch.setenv("LLM_ENDPOINT", "http://stale:1/v1")
        monkeypatch.setenv("LLM_API_KEY", "stale-key")
        kr = FakeKeyring(entries={("deep-reach", "llm-api-key"): "fresh-key"})
        monkeypatch.setattr(s, "_KEYRING", kr)
        s.VAR_ENV_PATH.write_text(s.VAR_ENV_PATH.read_text().replace(
            "LLM_ENDPOINT=http://localhost:8080/v1", "LLM_ENDPOINT=http://fresh:2/v1"
        ).replace("LLM_MODEL=Ornith-1.5-35B-A3B-MLX-8bit", "LLM_MODEL=Fresh-Model"))

        s.reload_settings()

        assert os.environ["LLM_ENDPOINT"] == "http://fresh:2/v1"
        assert os.environ["LLM_API_KEY"] == "fresh-key"  # keyring resolved into env
        cfg = config_mod.get_config()
        assert cfg.default_endpoint == "http://fresh:2/v1"
        assert cfg.default_model == "Fresh-Model"
        assert cfg.default_api_key == "fresh-key"

    def test_client_cache_recaches_on_change(self, monkeypatch):
        kr = FakeKeyring(entries={("deep-reach", "llm-api-key"): "k1"})
        monkeypatch.setattr(s, "_KEYRING", kr)
        s.reload_settings()
        old_cfg = config_mod.get_config()
        assert old_cfg.default_api_key == "k1"  # keyring leg resolved
        config_mod.get_client_for_endpoint(old_cfg.default_endpoint, old_cfg.default_api_key)
        assert len(old_cfg._clients) == 1

        # New endpoint + rotated key -> reload -> fresh cache with only the new pair.
        text = s.VAR_ENV_PATH.read_text().replace(
            "LLM_ENDPOINT=http://localhost:8080/v1", "LLM_ENDPOINT=http://new:2/v1"
        )
        s.VAR_ENV_PATH.write_text(text, encoding="utf-8")
        kr._entries[("deep-reach", "llm-api-key")] = "k2"
        s.reload_settings()

        new_cfg = config_mod.get_config()
        config_mod.get_client_for_endpoint(new_cfg.default_endpoint, new_cfg.default_api_key)
        assert any("new:2" in k for k in new_cfg._clients)
        assert not any("old:1" in k or "localhost:8080" in k for k in new_cfg._clients)


# ---------------------------------------------------------------------------
# API surface: GET/PUT /settings, /settings/test, /health, lifespan
# ---------------------------------------------------------------------------


class TestGetSettings:
    def test_shape_and_never_echoes_key_material(self, monkeypatch):
        s._KEYRING.set_password("deep-reach", "llm-api-key", "omlx-fake-llm-key")
        c = make_app()
        body = c.get("/settings")
        assert body.status_code == 200
        raw = body.text
        assert "omlx-fake-llm-key" not in raw and "tvly-fake-tavily-key" not in raw \
            and "omlx-fake-emb-key" not in raw
        data = body.json()
        assert data["llm"] == {"endpoint": "http://localhost:8080/v1",
                               "model": "Ornith-1.5-35B-A3B-MLX-8bit",
                               "thinking": True,
                               "key": {"present": True, "source": "keyring"}}
        assert data["search"]["tool"] == "searxng"
        assert data["search"]["searxng_url"] == "http://localhost:8081"
        assert data["search"]["throttle_ms"] == 0
        assert data["search"]["tavily_key"] == {"present": False, "source": None}
        assert data["embeddings"]["key"] == {"present": False, "source": None}  # env cleared by fixture
        assert data["keyring"] == {"available": True, "backend": "Fake Keyring"}
        assert data["requires_restart"] == []

    def test_env_source_when_keyring_empty(self, monkeypatch):
        s._KEYRING._entries.clear()
        monkeypatch.setenv("LLM_API_KEY", "omlx-fake-llm-key")
        c = make_app()
        data = c.get("/settings").json()
        assert data["llm"]["key"] == {"present": True, "source": "env"}  # var.env dotenv leg

    def test_health_settings_summary(self, monkeypatch):
        s._KEYRING._entries.clear()
        monkeypatch.setenv("LLM_API_KEY", "omlx-fake-llm-key")
        c = make_app()
        h = c.get("/health").json()
        assert h["settings"] == {"keyring_available": True, "llm_key_present": True,
                                 "search_tool": "searxng"}
        assert "deep_configured" in h  # old shape intact


class TestPutSettings:
    def test_saves_and_hot_applies(self):
        c = make_app()
        before = config_mod.get_config()
        r = c.put("/settings", json={
            "llm": {"endpoint": "http://newhost:1234/v1", "model": "New-Model"},
            "search": {"tool": "tavily", "throttle_ms": 250},
            "keys": {"llm": "brand-new-key"},
        })
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["applied"] is True and data["errors"] == []
        assert data["llm"]["endpoint"] == "http://newhost:1234/v1"
        assert data["llm"]["model"] == "New-Model"
        assert data["llm"]["key"] == {"present": True, "source": "keyring"}
        assert data["search"]["tool"] == "tavily" and data["search"]["throttle_ms"] == 250

        # Hot-apply: the singleton now serves the new values to all call sites.
        after = config_mod.get_config()
        assert after.default_endpoint == "http://newhost:1234/v1"
        assert after.default_model == "New-Model"
        assert after.default_api_key == "brand-new-key"
        assert before is not after

        # File: non-secrets written, key line retired, unmanaged keys preserved.
        file = s.read_var_env()
        assert file["LLM_MODEL"] == "New-Model" and file["SEARCH_TOOL"] == "tavily"
        assert file["SEARCH_THROTTLE_MS"] == "250"
        assert file["LLM_API_KEY"] == ""  # retired from the file
        assert file["DECOMPOSER_MODEL"] == "Ornith-1.5-35B-A3B-MLX-8bit"  # unmanaged, intact

    def test_requires_restart_for_embedding_change(self):
        c = make_app()
        r = c.put("/settings", json={"embeddings": {"model": "other-embed-model"}})
        assert r.status_code == 200
        assert r.json()["requires_restart"] == ["embeddings"]

    @pytest.mark.parametrize("body", [
        {"llm": {"endpoint": "notaurl"}},
        {"llm": {"endpoint": "ftp://x/v1"}},
        {"llm": {"model": "   "}},
        {"llm": {"thinking": "yes"}},
        {"search": {"tool": "bogus"}},
        {"search": {"throttle_ms": 5001}},
        {"search": {"throttle_ms": -1}},
        {"search": {"throttle_ms": "fast"}},
        {"embeddings": {"endpoint": ""}},
        {"llm": []},
        {"keys": {"llm": 42}},
        {"keys": {"unknown": "x"}},
        {},
    ])
    def test_validation_rejects(self, body):
        c = make_app()
        r = c.put("/settings", json=body)
        assert r.status_code == 400, (body, r.status_code)
        assert r.json()["error"] == "invalid settings"
        assert r.json()["details"]

    def test_empty_body_is_400_and_absent_fields_keep(self):
        c = make_app()
        assert c.put("/settings", json={"llm": {}}).status_code == 400
        model_before = s.read_var_env()["LLM_MODEL"]
        r = c.put("/settings", json={"llm": {"thinking": False}})
        assert r.status_code == 200
        assert s.read_var_env()["LLM_MODEL"] == model_before  # absent = keep
        assert s.read_var_env()["LLM_ENABLE_THINKING"] == "false"  # written

    def test_delete_key(self):
        s._KEYRING.set_password("deep-reach", "llm-api-key", "omlx-fake-llm-key")
        c = make_app()
        r = c.put("/settings", json={"keys": {"llm": ""}})
        assert r.status_code == 200
        assert not s._KEYRING.has("deep-reach", "llm-api-key")
        assert r.json()["llm"]["key"] == {"present": False, "source": None}

    def test_key_store_without_keyring_is_503_naming_env_var(self, monkeypatch):
        monkeypatch.setattr(s, "_KEYRING", FakeKeyring(backend_name=None, viable=False))
        c = make_app()
        r = c.put("/settings", json={"keys": {"llm": "some-key"}})
        assert r.status_code == 503
        assert "LLM_API_KEY" in r.json()["error"]

    def test_non_json_body_is_400(self):
        c = make_app()
        r = c.put("/settings", content=b"not json", headers={"content-type": "application/json"})
        assert r.status_code == 400


class TestSettingsTestEndpoint:
    def _c(self):
        c = make_app()
        return c

    def test_bad_target(self):
        r = self._c().post("/settings/test", json={"target": "nope"})
        assert r.status_code == 400

    def test_llm_missing_key_refuses_with_explanation(self):
        s._KEYRING._entries.clear()  # no keyring entry; env is cleared by the fixture
        r = self._c().post("/settings/test", json={"target": "llm"})
        assert r.status_code == 200
        assert r.json() == {"ok": False,
                            "error": "LLM_API_KEY not set — store it in the OS keyring or set the environment variable"}

    def test_llm_success_against_stub(self):
        srv, base = make_stub({"/v1/chat/completions": {"choices": [{"message": {"content": "pong"}}]}})
        try:
            r = self._c().post("/settings/test", json={
                "target": "llm",
                "llm": {"endpoint": f"{base}/v1", "model": "stub-model", "key": "stub-key"},
            })
        finally:
            srv.shutdown()
        data = r.json()
        assert data["ok"] is True and data["snippet"] == "pong"
        assert data["latency_ms"] >= 0

    def test_llm_responses_fallback_when_chat_404(self):
        # No /v1/chat/completions route (-> 404): the endpoint retries via /v1/responses.
        full_response = {"id": "resp_1", "object": "response", "status": "completed", "model": "stub-model",
                         "output": [{"type": "message", "status": "completed", "role": "assistant",
                                    "content": [{"type": "output_text", "text": "pong", "annotations": []}]}],
                         "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2,
                                   "input_tokens_details": {"cached_tokens": 0},
                                   "output_tokens_details": {"reasoning_tokens": 0}}}
        srv, base = make_stub({"/v1/responses": full_response})
        try:
            r = self._c().post("/settings/test", json={
                "target": "llm",
                "llm": {"endpoint": f"{base}/v1", "model": "stub-model", "key": "stub-key"},
            })
        finally:
            srv.shutdown()
        assert r.json()["ok"] is True and r.json()["snippet"] == "pong"

    def test_llm_stub_down_reports_error(self):
        srv, base = make_stub({})
        port = srv.server_address[1]
        srv.shutdown()  # closed socket
        r = self._c().post("/settings/test", json={
            "target": "llm",
            "llm": {"endpoint": f"http://127.0.0.1:{port}/v1", "model": "m", "key": "k"},
        })
        data = r.json()
        assert data["ok"] is False and "error" in data and data["latency_ms"] >= 0

    def test_search_searxng_against_stub(self, monkeypatch):
        monkeypatch.setenv("SEARCH_THROTTLE_MS", "0")  # no pacing in tests
        results = [{"title": f"t{i}", "url": f"http://x/{i}"} for i in range(3)]
        srv, base = make_stub({"/healthz": {"status": "ok"},
                               "/search": {"results": results}})
        try:
            r = self._c().post("/settings/test", json={
                "target": "search",
                "search": {"tool": "searxng", "searxng_url": base},
            })
        finally:
            srv.shutdown()
        data = r.json()
        assert data["ok"] is True and data["result_count"] == 3

    def test_search_searxng_unreachable(self, monkeypatch):
        monkeypatch.setenv("SEARCH_THROTTLE_MS", "0")
        srv, base = make_stub({})
        port = srv.server_address[1]
        srv.shutdown()  # closed socket
        data = self._c().post("/settings/test", json={
            "target": "search", "search": {"tool": "searxng", "searxng_url": f"http://127.0.0.1:{port}"},
        }).json()
        assert data["ok"] is False and data["error"]

    def test_search_tavily_missing_key(self):
        s._KEYRING._entries.clear()
        r = self._c().post("/settings/test", json={
            "target": "search", "search": {"tool": "tavily"},
        })
        assert r.json() == {"ok": False,
                            "error": "TAVILY_API_KEY not set — store it in the OS keyring or set the environment variable"}

    def test_embedding_against_stub(self):
        srv, base = make_stub({"/v1/embeddings": {"data": [{"embedding": [0.1] * 8}]}})
        try:
            r = self._c().post("/settings/test", json={
                "target": "embedding",
                "embedding": {"endpoint": f"{base}/v1", "model": "stub-embed", "key": "stub-key"},
            })
        finally:
            srv.shutdown()
        data = r.json()
        assert data["ok"] is True and data["dim"] == 8 and data["latency_ms"] >= 0

    def test_embedding_missing_key(self):
        s._KEYRING._entries.clear()
        r = self._c().post("/settings/test", json={"target": "embedding"})
        assert r.json() == {"ok": False,
                            "error": "EMBEDDING_API_KEY not set — store it in the OS keyring or set the environment variable"}


class TestLifespanMigration:
    def test_startup_migrates_and_blanks(self):
        with TestClient(
            api_server.create_app(run_fn=lambda **k: {"final_answer": "x", "state": {}, "stats": {}})
        ):
            pass  # lifespan start/stop runs around the context
        file = s.read_var_env()
        assert file["LLM_API_KEY"] == "" and file["TAVILY_API_KEY"] == ""
        assert s._KEYRING.get_password("deep-reach", "llm-api-key") == "omlx-fake-llm-key"

    def test_harmless_when_keyring_unavailable(self, monkeypatch):
        monkeypatch.setattr(s, "_KEYRING", FakeKeyring(backend_name=None, viable=False))
        before = s.VAR_ENV_PATH.read_text()
        with TestClient(
            api_server.create_app(run_fn=lambda **k: {"final_answer": "x", "state": {}, "stats": {}})
        ):
            pass
        assert s.VAR_ENV_PATH.read_text() == before
