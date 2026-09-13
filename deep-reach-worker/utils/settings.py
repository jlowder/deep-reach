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
from pathlib import Path
from typing import Dict, Optional

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
