"""Shared test fixtures: hermetic secret resolution.

``utils.settings.get_secret`` resolves the managed API keys through
OS keyring -> environment -> None. A developer's real keychain (or its
absence on a CI runner) must never change test outcomes, so every test
runs against a fake keyring and a fresh config singleton:

- ``_hermetic_keyring`` (autouse) pins an EMPTY fake keyring around every
  test. Where a test previously saw "no key" via the raw environment it
  sees the same now; the developer's real keychain is never consulted.
- ``pin_keyring`` pins explicit entries (for tests that exercise the real
  pipeline, which fails fast when no LLM key resolves) and resets the
  config singleton so ``get_config()`` sees exactly those values.

``tests/test_settings.py`` pins its own per-test keyring state on top of
the autouse one (module fixtures apply after conftest fixtures).
"""

import pytest

import utils.config as config_mod
import utils.settings as s
from test_settings import FakeKeyring


@pytest.fixture(autouse=True)
def _hermetic_keyring(monkeypatch):
    monkeypatch.setattr(s, "_KEYRING", FakeKeyring())
    config_mod.reset_config()
    yield
    config_mod.reset_config()


@pytest.fixture
def pin_keyring(monkeypatch):
    """Pin the fake keyring with explicit entries and reset the config
    singleton; returns the FakeKeyring for further manipulation."""

    def _pin(llm: str | None = None, tavily: str | None = None, embedding: str | None = None):
        entries = {}
        if llm is not None:
            entries[("deep-reach", "llm-api-key")] = llm
        if tavily is not None:
            entries[("deep-reach", "tavily-api-key")] = tavily
        if embedding is not None:
            entries[("deep-reach", "embedding-api-key")] = embedding
        kr = FakeKeyring(entries=entries)
        monkeypatch.setattr(s, "_KEYRING", kr)
        config_mod.reset_config()
        return kr

    return _pin
