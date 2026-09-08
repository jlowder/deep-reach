"""
Unit tests for utils.search — the config-selectable web-search abstraction.

No network: requests.get, the Tavily SDK, and env vars are all monkeypatched,
so none of these tests touches the real environment or the outside world.
"""

import importlib
import sys
import types

import pytest

search = importlib.import_module("utils.search")
ra = importlib.import_module("worker_agents.retriever_agent")


# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------

class FakeResp:
    """Minimal stand-in for a requests.Response."""

    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


def fake_searxng_results(n=8):
    """SearXNG-shaped results (note the camelCase ``publishedDate``)."""
    return [
        {
            "title": f"Result {i}",
            "url": f"https://example.com/{i}",
            # every third snippet is long enough to exercise truncation
            "content": f"snippet {i} " + "x" * (800 if i % 3 == 0 else 10),
            # raw per-engine score: intentionally arbitrary, must be ignored
            "score": 0.5 + i * 0.01,
            "publishedDate": f"2024-01-{i + 1:02d}" if i % 2 == 0 else None,
        }
        for i in range(n)
    ]


def install_fake_get(monkeypatch, resp_factory):
    calls = []

    def fake_get(url, params=None, timeout=None):
        calls.append({"url": url, "params": params, "timeout": timeout})
        return resp_factory(url, params)

    monkeypatch.setattr(search.requests, "get", fake_get)
    return calls


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------

def test_factory_tavily(monkeypatch):
    monkeypatch.setenv("SEARCH_TOOL", "tavily")
    assert isinstance(search.get_search_tool(), search.TavilySearchTool)


def test_factory_searxng(monkeypatch):
    monkeypatch.setenv("SEARCH_TOOL", "searxng")
    assert isinstance(search.get_search_tool(), search.SearxngSearchTool)


def test_factory_case_and_whitespace_insensitive(monkeypatch):
    monkeypatch.setenv("SEARCH_TOOL", "  SeArXnG  ")
    assert isinstance(search.get_search_tool(), search.SearxngSearchTool)


def test_factory_defaults_to_tavily(monkeypatch):
    monkeypatch.delenv("SEARCH_TOOL", raising=False)
    assert isinstance(search.get_search_tool(), search.TavilySearchTool)


def test_factory_unknown_falls_back_to_tavily(monkeypatch):
    monkeypatch.setenv("SEARCH_TOOL", "bing")
    assert isinstance(search.get_search_tool(), search.TavilySearchTool)


# ---------------------------------------------------------------------------
# SearxngSearchTool
# ---------------------------------------------------------------------------

def test_searxng_base_url_from_env(monkeypatch):
    monkeypatch.setenv("SEARXNG_URL", "http://localhost:9999/")
    tool = search.SearxngSearchTool()
    assert tool.base_url == "http://localhost:9999"  # trailing slash stripped


def test_searxng_base_url_defaults_to_8081(monkeypatch):
    monkeypatch.delenv("SEARXNG_URL", raising=False)
    assert search.SearxngSearchTool().base_url == "http://localhost:8081"


def test_searxng_maps_slices_and_synth_scores(monkeypatch):
    install_fake_get(
        monkeypatch,
        lambda url, params: FakeResp(200, {"results": fake_searxng_results(8), "suggest": []}),
    )
    out = search.SearxngSearchTool(base_url="http://localhost:8081").search("quantum computing", num_results=3)

    assert out["query"] == "quantum computing"
    assert len(out["results"]) == 3  # sliced to num_results
    scores = [r["score"] for r in out["results"]]
    assert scores == [1.0, 0.9, 0.8]  # rank decay, strictly decreasing
    assert all(a > b for a, b in zip(scores, scores[1:]))
    assert out["results"][0]["title"] == "Result 0"
    assert out["results"][0]["url"] == "https://example.com/0"
    assert len(out["results"][0]["content"]) == 600  # long snippet truncated
    assert all(len(r["content"]) <= 600 for r in out["results"])
    # publishedDate (camelCase) mapped to published_date; omitted when falsy
    assert out["results"][0]["published_date"] == "2024-01-01"
    assert "published_date" not in out["results"][1]


def test_searxng_request_calls_expected_url_and_params(monkeypatch):
    calls = install_fake_get(
        monkeypatch,
        lambda url, params: FakeResp(200, {"results": []}),
    )
    search.SearxngSearchTool(base_url="http://localhost:8081").search("q1")
    assert calls == [
        {
            "url": "http://localhost:8081/search",
            "params": {"q": "q1", "format": "json"},
            "timeout": 30,
        }
    ]


def test_searxng_non_200_returns_empty_without_raising(monkeypatch):
    install_fake_get(
        monkeypatch,
        lambda url, params: FakeResp(403, {"error": "JSON format not enabled"}),
    )
    out = search.SearxngSearchTool(base_url="http://localhost:8081").search("q")
    assert out == {"query": "q", "results": []}


def test_searxng_request_exception_returns_empty_without_raising(monkeypatch):
    def boom(url, params=None, timeout=None):
        raise OSError("connection refused")

    monkeypatch.setattr(search.requests, "get", boom)
    out = search.SearxngSearchTool(base_url="http://localhost:8081").search("q")
    assert out == {"query": "q", "results": []}


def test_searxng_non_json_body_returns_empty_without_raising(monkeypatch):
    install_fake_get(
        monkeypatch,
        lambda url, params: FakeResp(200, ValueError("Expecting value: '<html>...'")),
    )
    out = search.SearxngSearchTool(base_url="http://localhost:8081").search("q")
    assert out == {"query": "q", "results": []}


def test_searxng_ignores_raw_per_engine_score(monkeypatch):
    install_fake_get(
        monkeypatch,
        lambda url, params: FakeResp(
            200, {"results": [{"title": "t", "url": "u", "content": "c", "score": 0.999}]}
        ),
    )
    out = search.SearxngSearchTool(base_url="http://localhost:8081").search("q", num_results=1)
    assert out["results"][0]["score"] == 1.0  # synthesized, not 0.999


# ---------------------------------------------------------------------------
# TavilySearchTool
# ---------------------------------------------------------------------------

def test_tavily_missing_key_returns_empty_without_raising(monkeypatch):
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    out = search.TavilySearchTool().search("q")
    assert out == {"query": "q", "results": []}


def test_importing_search_module_never_imports_sdk(monkeypatch):
    # Importing utils.search must not build a client nor import the tavily SDK
    # (the old code raised at import time when TAVILY_API_KEY was unset).
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    assert "tavily" not in sys.modules
    tool = search.TavilySearchTool()
    assert tool._client is None and tool._client_built is False
    assert tool.search("q") == {"query": "q", "results": []}
    assert "tavily" not in sys.modules  # still: no SDK pulled in


def test_tavily_maps_results_via_whitelist(monkeypatch):
    monkeypatch.setenv("TAVILY_API_KEY", "tvly-test")
    client = types.SimpleNamespace(
        search=lambda **kw: {
            "answer": "ignored",
            "results": [
                {
                    "title": "T",
                    "url": "U",
                    "content": "c" * 1000,
                    "score": "0.87",
                    "published_date": "2024-05-01",
                    "raw_content": "R" * 5000,
                }
            ],
        }
    )
    tool = search.TavilySearchTool()
    tool._client = client  # inject: no SDK, no network
    tool._client_built = True
    out = tool.search("q", num_results=5)
    r = out["results"][0]
    assert r == {
        "title": "T",
        "url": "U",
        "content": "c" * 600,
        "score": 0.87,
        "published_date": "2024-05-01",
    }  # raw_content and answer dropped


# ---------------------------------------------------------------------------
# Module-level entry point + retriever_agent global
# ---------------------------------------------------------------------------

def test_web_search_delegates_to_selected_tool(monkeypatch):
    calls = install_fake_get(
        monkeypatch,
        lambda url, params: FakeResp(200, {"results": fake_searxng_results(5)}),
    )
    monkeypatch.setenv("SEARCH_TOOL", "searxng")
    monkeypatch.setenv("SEARXNG_URL", "http://localhost:8081")
    out = search.web_search("quantum computing", 2)
    assert len(out["results"]) == 2
    assert calls[0]["url"] == "http://localhost:8081/search"


def test_retriever_agent_exposes_web_search_global():
    # Tests in the rest of the suite monkeypatch ra.web_search — it must stay
    # a module-level global of worker_agents.retriever_agent.
    assert hasattr(ra, "web_search")
    assert callable(ra.web_search)
    assert ra.web_search is search.web_search


def test_retriever_agent_imports_without_tavily_key(monkeypatch):
    # Regression: the old module-level TavilyClient() raised
    # MissingAPIKeyError at import time when the key was unset.
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    importlib.reload(ra)
    assert hasattr(ra, "web_search")
    assert "tavily" not in sys.modules


# ---------------------------------------------------------------------------
# Config-failure visibility: warn once per failure state, never raise
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _reset_warn_state():
    search._warned.clear()
    yield
    search._warned.clear()


def test_searxng_unreachable_warns_once_not_per_call(monkeypatch, caplog):
    import logging

    monkeypatch.setenv("SEARCH_TOOL", "searxng")

    def boom(url, params=None, timeout=None):
        raise ConnectionError("tunnel down")

    monkeypatch.setattr(search.requests, "get", boom)
    with caplog.at_level(logging.WARNING, logger="utils.search"):
        out1 = search.web_search("q1")
        out2 = search.web_search("q2")
        out3 = search.web_search("q3")
    assert out1 == {"query": "q1", "results": []}
    assert out3 == {"query": "q3", "results": []}
    warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert len(warnings) == 1  # one per failure state, not one per call


def test_searxng_failure_warns_again_after_recovery(monkeypatch, caplog):
    import logging

    monkeypatch.setenv("SEARCH_TOOL", "searxng")

    def boom(url, params=None, timeout=None):
        raise ConnectionError("tunnel down")

    monkeypatch.setattr(search.requests, "get", boom)
    search.web_search("q1")
    # Backend recovers: a non-empty answer clears the failure state.
    install_fake_get(
        monkeypatch,
        lambda url, params: FakeResp(200, {"results": fake_searxng_results(2)}),
    )
    out = search.web_search("q1")
    assert len(out["results"]) == 2
    caplog.clear()
    # Breaks again → warns afresh instead of going silent for the process.
    monkeypatch.setattr(search.requests, "get", boom)
    with caplog.at_level(logging.WARNING, logger="utils.search"):
        search.web_search("q1")
    warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert len(warnings) == 1


def test_tavily_missing_key_warns_once(monkeypatch, caplog):
    import logging

    monkeypatch.setenv("SEARCH_TOOL", "tavily")
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    with caplog.at_level(logging.WARNING, logger="utils.search"):
        out1 = search.web_search("q1")
        out2 = search.web_search("q2")
    assert out1 == {"query": "q1", "results": []}
    assert out2 == {"query": "q2", "results": []}
    warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert len(warnings) == 1
