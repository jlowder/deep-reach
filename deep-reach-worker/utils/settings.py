"""
Settings store for the settings dialog (web -> glue -> worker).

Layer 1 (this module, part 1): line-based surgery on utils/var.env.

The dialog manages a fixed set of var.env keys (MANAGED_VARS). Everything
else in the file — OPENAI_* legacy vars, per-agent overrides, comments,
blank lines — is preserved byte-for-byte by write_managed_vars().

Secrets (LLM_API_KEY / TAVILY_API_KEY / EMBEDDING_API_KEY) are NEVER
persisted in var.env by the dialog: they resolve keyring -> env (see
part 2 of this module) and the file line is blanked, never written.
"""

import logging
import os
from pathlib import Path
from typing import Dict, Optional, Tuple

from utils.config import reset_config

logger = logging.getLogger(__name__)

UTILS_DIR = Path(__file__).resolve().parent
VAR_ENV_PATH = UTILS_DIR / "var.env"

# Non-secret settings managed by the dialog (live in var.env).
NON_SECRET_VARS = (
    "LLM_ENDPOINT",
    "LLM_MODEL",
    "LLM_ENABLE_THINKING",
    "SEARCH_TOOL",
    "SEARXNG_URL",
    "SEARCH_THROTTLE_MS",
    "EMBEDDING_ENDPOINT",
    "EMBEDDING_MODEL",
)

# OS keyring service name for deep-reach entries.
SERVICE = "deep-reach"

# keyring entry name -> env var that is its fallback source.
SECRETS = {
    "llm-api-key": "LLM_API_KEY",
    "tavily-api-key": "TAVILY_API_KEY",
    "embedding-api-key": "EMBEDDING_API_KEY",
}
SECRET_VARS = tuple(SECRETS.values())

MANAGED_VARS = NON_SECRET_VARS + SECRET_VARS

# Marker comment used when a managed key has to be CREATED (it was absent
# from var.env, e.g. a fresh checkout): makes dialog-managed appends auditable.
CREATED_MARKER = "# settings dialog"


class SettingsError(Exception):
    """A settings operation failed with a user-actionable explanation."""


def _env_path(path: Optional[Path] = None) -> Path:
    return Path(path) if path else VAR_ENV_PATH


def is_unset(value: Optional[str]) -> bool:
    """A blank value, or a placeholder (``your_...`` / n/a / none / null),
    counts as UNSET."""
    v = (value or "").strip()
    if not v:
        return True
    low = v.lower()
    return low.startswith("your") or low in ("n/a", "none", "null")


def read_var_env(path: Optional[Path] = None) -> Dict[str, str]:
    """Parse var.env into {KEY: raw value}.

    Line-based (KEY=VALUE at the first ``=``); comment and blank lines are
    skipped, so a commented-out key is NOT defined. Values are stripped;
    placeholder values are kept raw (callers decide unset via is_unset).
    A missing file yields an empty dict.
    """
    p = _env_path(path)
    if not p.exists():
        return {}
    out: Dict[str, str] = {}
    for line in p.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        key, _, value = s.partition("=")
        out[key.strip()] = value.strip()
    return out


def write_managed_vars(values: Dict[str, str], path: Optional[Path] = None) -> bool:
    """Update managed keys in var.env with minimal, order-preserving surgery.

    - A key already defined (non-comment line ``KEY=...``) is replaced IN
      PLACE — its line position is kept, everything else is untouched.
    - A managed key absent from the file is appended at the end under a
      ``# settings dialog`` marker.
    - Keys not present in ``values`` are left exactly as-is.
    - ``""`` writes a blank value (the documented way to mark a key unset;
      the dialog does this to retire a secret from the file).

    Returns True when the file content changed.
    """
    p = _env_path(path)
    lines = p.read_text(encoding="utf-8").splitlines() if p.exists() else []

    updated = set()
    new_lines = []
    for line in lines:
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            key = stripped.partition("=")[0].strip()
            if key in values and key not in updated:
                updated.add(key)
                new_lines.append(f"{key}={values[key]}")
                continue
        new_lines.append(line)

    missing = [k for k in values if k not in updated]
    if missing:
        if new_lines and new_lines[-1].strip():
            new_lines.append("")
        # Re-use an existing trailing dialog block instead of stacking markers.
        if not (new_lines and new_lines[-1].strip() == CREATED_MARKER):
            new_lines.append(CREATED_MARKER)
        for key in missing:
            new_lines.append(f"{key}={values[key]}")

    content = "\n".join(new_lines) + "\n"
    old = p.read_text(encoding="utf-8") if p.exists() else ""
    if content == old:
        return False
    p.write_text(content, encoding="utf-8")
    logger.info("settings: updated var.env (%d key(s) written)", len(values))
    return True


# ---------------------------------------------------------------------------
# Layer 2: OS keyring secret store + keyring -> env resolution chain
# ---------------------------------------------------------------------------

# The imported keyring module; None until first use, sentinel when the
# dependency is absent. Module attribute so tests can monkeypatch it.
_KEYRING = None
_KEYRING_UNAVAILABLE = object()


def _kr():
    global _KEYRING
    if _KEYRING is None:
        try:
            import keyring as _mod  # noqa: F401
            _KEYRING = _mod
        except ImportError:  # pragma: no cover - venv always has it
            logger.warning("settings: keyring package not installed")
            _KEYRING = _KEYRING_UNAVAILABLE
    return _KEYRING


def _is_real_keyring(mod) -> bool:
    return mod is not None and mod is not _KEYRING_UNAVAILABLE


def keyring_available() -> Tuple[bool, Optional[str]]:
    """(available, human backend name). Handles headless hosts: a null /
    non-viable backend (or any probe error) counts as unavailable rather
    than raising."""
    kr = _kr()
    if not _is_real_keyring(kr):
        return False, None
    try:
        backend = kr.get_keyring()
    except Exception as e:
        logger.info("settings: keyring probe failed: %s", e)
        return False, None
    if getattr(backend, "viable", True) is False:
        return False, None
    name = getattr(backend, "name", None) or getattr(backend, "keyring_name", None)
    if name is None or str(name).strip() in ("", "No keyring"):
        return False, None
    return True, str(name)


def get_secret(secret: str) -> Tuple[Optional[str], Optional[str]]:
    """Resolve a managed secret: OS keyring -> environment -> None.

    Returns ``(value, source)`` with source ``"keyring"`` | ``"env"`` |
    None. The env leg sees var.env values too (utils.config load_dotenvs
    them at import); after startup migration blanks the file lines, a
    fresh process's env leg is empty and the chain correctly refuses.
    """
    if secret not in SECRETS:
        raise SettingsError(f"unknown secret {secret!r} (expected one of {sorted(SECRETS)})")
    kr = _kr()
    if _is_real_keyring(kr):
        try:
            value = kr.get_password(SERVICE, secret)
        except Exception:
            value = None
        if value:
            return value, "keyring"
    env_value = os.environ.get(SECRETS[secret], "")
    if not is_unset(env_value):
        return env_value, "env"
    return None, None


def set_secret(secret: str, value: str) -> None:
    """Store (value) or delete (value == "") a secret in the OS keyring.

    Raises SettingsError when a value must be stored but no keyring
    backend exists — the documented fallback is the environment variable.
    """
    if secret not in SECRETS:
        raise SettingsError(f"unknown secret {secret!r} (expected one of {sorted(SECRETS)})")
    kr = _kr()
    if value:
        if not _is_real_keyring(kr) or not keyring_available()[0]:
            raise SettingsError(
                f"no OS keyring backend is available; set {SECRETS[secret]} in the environment instead"
            )
        kr.set_password(SERVICE, secret, value)
    else:
        if _is_real_keyring(kr):
            try:
                kr.delete_password(SERVICE, secret)
            except Exception:  # deleting a missing entry is a no-op
                pass


# ---------------------------------------------------------------------------
# Layer 3: effective settings, hot reload, startup migration
# ---------------------------------------------------------------------------


def _secret_for_env(env_name: str) -> str:
    for secret, name in SECRETS.items():
        if name == env_name:
            return secret
    raise SettingsError(f"no keyring entry for env var {env_name!r}")


def effective_settings(path: Optional[Path] = None) -> Dict[str, Optional[str]]:
    """Resolved value for every managed var: non-secrets freshly read from
    var.env, secrets via the keyring -> env chain (None when unresolved)."""
    file = read_var_env(path)
    out: Dict[str, Optional[str]] = {}
    for name in NON_SECRET_VARS:
        raw = file.get(name, "")
        out[name] = None if is_unset(raw) else raw
    for env_name in SECRET_VARS:
        out[env_name], _ = get_secret(_secret_for_env(env_name))
    return out


def reload_settings(path: Optional[Path] = None) -> None:
    """Hot-apply: push resolved settings into os.environ and invalidate the
    Config singleton so the next get_config() — all 24 call sites — picks
    up the new values. The OpenAI client cache is keyed endpoint:api_key,
    so changed values naturally mint fresh clients; no restart needed for
    LLM/search. (Embeddings are frozen at import in vector_store.py and
    still require a restart.)"""
    eff = effective_settings(path)
    for name, value in eff.items():
        if value is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = value
    reset_config()


def migrate_plaintext_secrets(path: Optional[Path] = None) -> list:
    """Startup migration: move live plaintext secrets out of var.env into
    the OS keyring, then blank their file lines. Idempotent: a keyring
    entry already present is kept (never overwritten), and an already-
    blank line is left alone. With no keyring backend the file is
    untouched — the environment path keeps working. Returns the names of
    secrets actually MOVED (first time only)."""
    if not keyring_available()[0]:
        logger.info(
            "settings: no OS keyring backend; leaving var.env secrets for the environment path"
        )
        return []
    kr = _kr()
    file = read_var_env(path)
    blanks: Dict[str, str] = {}
    moved: list = []
    for secret, env_name in SECRETS.items():
        raw = file.get(env_name)
        if raw is None or is_unset(raw):
            continue
        try:
            existing = kr.get_password(SERVICE, secret)
        except Exception:
            existing = None
        if existing:
            logger.info("settings: %s already in keyring; blanking var.env copy", env_name)
        else:
            kr.set_password(SERVICE, secret, raw)
            moved.append(secret)
            logger.info("settings: moved %s from var.env into the keyring", env_name)
        blanks[env_name] = ""
    if blanks:
        write_managed_vars(blanks, path=path)
    return moved


def settings_view(path: Optional[Path] = None) -> dict:
    """GET /settings payload — key material NEVER included (presence +
    source only), plus which parts require a worker restart."""
    eff = effective_settings(path)
    avail, backend = keyring_available()

    def key_info(secret: str) -> dict:
        value, source = get_secret(secret)
        return {"present": value is not None, "source": source}

    thinking_raw = (eff.get("LLM_ENABLE_THINKING") or "").strip().lower()
    throttle_raw = eff.get("SEARCH_THROTTLE_MS") or ""
    try:
        throttle = int(throttle_raw)
    except ValueError:
        throttle = 1000

    return {
        "llm": {
            "endpoint": eff.get("LLM_ENDPOINT"),
            "model": eff.get("LLM_MODEL"),
            "thinking": thinking_raw in ("1", "true", "yes", "on"),
            "key": key_info("llm-api-key"),
        },
        "search": {
            "tool": eff.get("SEARCH_TOOL") or "tavily",
            "searxng_url": eff.get("SEARXNG_URL"),
            "throttle_ms": throttle,
            "tavily_key": key_info("tavily-api-key"),
        },
        "embeddings": {
            "endpoint": eff.get("EMBEDDING_ENDPOINT"),
            "model": eff.get("EMBEDDING_MODEL"),
            "key": key_info("embedding-api-key"),
        },
        "keyring": {"available": avail, "backend": backend},
        "requires_restart": _requires_restart(eff),
    }


def _requires_restart(eff: Dict[str, Optional[str]]) -> list:
    """vector_store freezes EMBEDDING_* at import; any effective diff
    against the running process means a restart is needed to take effect."""
    try:
        from qdrant_vector_database import vector_store as vs
    except Exception:
        return []
    running = {
        "EMBEDDING_ENDPOINT": vs.EMBEDDING_ENDPOINT,
        "EMBEDDING_MODEL": vs.EMBEDDING_MODEL_NAME,
        "EMBEDDING_API_KEY": vs.EMBEDDING_API_KEY,
    }

    def norm(v: Optional[str]) -> str:
        v = v or ""
        return "" if is_unset(v) or v.strip().lower() == "dummy" else v.rstrip("/")

    if any(norm(eff.get(k)) != norm(running[k]) for k in running):
        return ["embeddings"]
    return []
