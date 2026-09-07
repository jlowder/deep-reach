"""
Web-search abstraction for the retriever agent.

The backend is selected at call time via the environment:

  SEARCH_TOOL=tavily|searxng    (default: "tavily"; anything else falls back
                                 to tavily with a logged warning)
  SEARXNG_URL=http://localhost:8081   (SearXNG base URL, no trailing slash
                                 normalization needed — handled here)
  TAVILY_API_KEY=...            (required only when SEARCH_TOOL=tavily)

All backends implement the same return contract and NEVER raise — on any
error (missing key, network failure, non-200, malformed JSON) they return
the query with an empty result list:

  {"query": str,
   "results": [{"title": str, "url": str, "content": str (<= 600 chars),
                "score": float, "published_date": str?}, ...]}
"""

import logging
import os
from abc import ABC, abstractmethod
from typing import Any, Dict, Optional

import requests

# Import utils.config first: its module-level code loads var.env via
# load_dotenv, so env reads below see the real configuration.
import utils.config  # noqa: F401

logger = logging.getLogger(__name__)

# Maximum characters to retain per result content. Tavily can return 3-15KB
# of raw HTML/Markdown per result; cap it so accumulated results across
# iterations stay within the context window.
WEB_RESULT_CONTENT_MAX_CHARS = 600


def _whitelist_result(r: Dict[str, Any], max_chars: int = WEB_RESULT_CONTENT_MAX_CHARS) -> Dict[str, Any]:
    """Keep only the citation-required fields; drop all backend extras.

    Keeps title/url/content (truncated to ``max_chars``)/score with safe
    defaults, plus ``published_date`` when the backend provided one (accepts
    either ``published_date`` or SearXNG's ``publishedDate``).
    """
    title = r.get("title")
    url = r.get("url")
    content = r.get("content")
    try:
        score = float(r.get("score"))
    except (TypeError, ValueError):
        score = 0.0
    kept: Dict[str, Any] = {
        "title": title if isinstance(title, str) else "",
        "url": url if isinstance(url, str) else "",
        "content": content[:max_chars] if isinstance(content, str) else "",
        "score": score,
    }
    published = r.get("published_date") or r.get("publishedDate")
    if isinstance(published, str) and published:
        kept["published_date"] = published
    return kept


class SearchTool(ABC):
    """A web-search backend.

    Implementations must NEVER raise: on any error return
    ``{"query": query, "results": []}``.
    """

    name: str = "search"

    @abstractmethod
    def search(self, query: str, num_results: int = 5) -> Dict[str, Any]:
        """Search the web for ``query``; returns the documented contract."""
        raise NotImplementedError


class TavilySearchTool(SearchTool):
    """The original Tavily-based backend.

    The TavilyClient is built lazily on first call — importing this module
    never touches the SDK and never raises when TAVILY_API_KEY is unset.
    """

    name = "tavily"

    def __init__(self) -> None:
        self._client: Optional[Any] = None
        self._client_built = False

    def _get_client(self) -> Optional[Any]:
        """Build the TavilyClient on first use; None when no API key is set."""
        if not self._client_built:
            self._client_built = True
            api_key = os.getenv("TAVILY_API_KEY")
            if not api_key:
                logger.warning(
                    "SEARCH_TOOL=tavily but TAVILY_API_KEY is not set; web "
                    "search will return no results. Set the key or switch to "
                    "SEARCH_TOOL=searxng."
                )
            else:
                # Local import: module import must not require the SDK.
                from tavily import TavilyClient

                self._client = TavilyClient(api_key=api_key)
        return self._client

    def search(self, query: str, num_results: int = 5) -> Dict[str, Any]:
        client = self._get_client()
        if client is None:
            return {"query": query, "results": []}
        try:
            result = client.search(
                query=query,
                search_depth="advanced",
                max_results=num_results,
                include_answer=False,
                include_raw_content=False,
                include_images=False,
            )
            results = result.get("results", [])
        except Exception as e:
            logger.warning("Tavily search failed for %r: %s", query, e)
            return {"query": query, "results": []}
        return {"query": query, "results": [_whitelist_result(r) for r in results]}


class SearxngSearchTool(SearchTool):
    """A local SearXNG meta-search backend (default: http://localhost:8081).

    SearXNG has no max_results parameter, so results are sliced client-side.
    Its raw per-engine ``score`` is incomparable across engines, so each
    result gets a synthetic rank-decay score (1.0, 0.9, 0.8, ...).

    Note: SearXNG must be configured to allow JSON output — in its
    ``settings.yml`` add ``- json`` under ``search: formats:``.
    """

    name = "searxng"

    def __init__(self, base_url: Optional[str] = None) -> None:
        self.base_url = (base_url or os.getenv("SEARXNG_URL", "http://localhost:8081")).rstrip("/")

    def search(self, query: str, num_results: int = 5) -> Dict[str, Any]:
        try:
            resp = requests.get(
                f"{self.base_url}/search",
                params={"q": query, "format": "json"},
                timeout=30,
            )
        except Exception as e:
            logger.warning("SearXNG request to %s failed: %s", self.base_url, e)
            return {"query": query, "results": []}

        if resp.status_code != 200:
            logger.warning(
                "SearXNG at %s returned HTTP %s — if the body says the json "
                "format is not enabled, add '- json' under 'search: formats:' "
                "in SearXNG's settings.yml.",
                self.base_url,
                resp.status_code,
            )
            return {"query": query, "results": []}

        try:
            data = resp.json()
        except Exception as e:
            logger.warning(
                "SearXNG at %s returned a non-JSON body (HTML?): %s — enable "
                "the json format in settings.yml (search: formats: [html, json]).",
                self.base_url,
                e,
            )
            return {"query": query, "results": []}

        raw = data.get("results", [])[:num_results] if isinstance(data, dict) else []
        results = []
        for i, r in enumerate(raw):
            if not isinstance(r, dict):
                continue
            r = dict(r)
            # Synthesize a rank-decay score; do NOT use SearXNG's raw
            # per-engine score (incomparable across engines).
            _whitelisted = _whitelist_result(r)
            _whitelisted["score"] = round(max(0.0, 1.0 - i * 0.1), 4)
            results.append(_whitelisted)
        return {"query": query, "results": results}


def get_search_tool() -> SearchTool:
    """Factory: pick the web-search backend from SEARCH_TOOL (default tavily)."""
    tool = os.getenv("SEARCH_TOOL", "tavily").strip().lower()
    if tool == "searxng":
        return SearxngSearchTool()
    if tool != "tavily":
        logger.warning(
            "Unknown SEARCH_TOOL %r (expected 'tavily' or 'searxng'); "
            "falling back to tavily.",
            tool,
        )
    return TavilySearchTool()


def web_search(query: str, num_results: int = 5) -> Dict[str, Any]:
    """Config-selected web search. Never raises; returns empty results on error."""
    return get_search_tool().search(query, num_results)
