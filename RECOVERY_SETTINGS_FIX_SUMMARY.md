# Search Recovery Settings Fix Summary

## Problem
Search recovery settings (retry_count, timeout_seconds, command) were **not persisting** to var.env and **not being read** by the orchestrator.

## Root Causes Identified

| Step | Component | Issue | Line Numbers |
|------|-----------|-------|--------------|
| 1 | api_server.py (PUT /settings) | search_recovery fields never added to `non_secret` dict | 730-763 |
| 2 | config.py (Config dataclass) | Missing 3 recovery fields | 68-143 |
| 3 | config.py (get_config) | Never reads SEARCH_RECOVERY_* env vars | 150-255 |

## Fixes Applied

### FIX 1: api_server.py (Line 742-746)
**Before:**
```python
emb = payload.get("embeddings") or {}
for field, var in (("endpoint", "EMBEDDING_ENDPOINT"), ("model", "EMBEDDING_MODEL")):
    if field in emb:
        non_secret[var] = str(emb[field])

keys = payload.get("keys") or {}
```

**After:**
```python
emb = payload.get("embeddings") or {}
for field, var in (("endpoint", "EMBEDDING_ENDPOINT"), ("model", "EMBEDDING_MODEL")):
    if field in emb:
        non_secret[var] = str(emb[field])

# NEW: Added search_recovery handling
search_recovery = payload.get("search_recovery") or {}
for field, var in (("retry_count", "SEARCH_RECOVERY_RETRY_COUNT"), 
                   ("timeout_seconds", "SEARCH_RECOVERY_TIMEOUT_SECONDS"), 
                   ("command", "SEARCH_RECOVERY_COMMAND")):
    if field in search_recovery:
        non_secret[var] = str(search_recovery[field])

keys = payload.get("keys") or {}
```

### FIX 2: config.py - Config Dataclass (Lines 122-124)
**Added 3 fields after `embedding_api_key`:**
```python
tavily_api_key: Optional[str] = None
embedding_api_key: Optional[str] = None

# NEW: Search recovery settings
search_recovery_retry_count: int = 1
search_recovery_timeout_seconds: int = 600
search_recovery_command: Optional[str] = None
```

### FIX 3: config.py - get_config() Function (Lines 275-292, 357-359)
**Added env var reading (after doc_score_threshold):**
```python
# Safe-int: search recovery settings must not crash config loading.
try:
    search_recovery_retry_count = max(0, min(5, int(os.getenv("SEARCH_RECOVERY_RETRY_COUNT", "1"))))
except (TypeError, ValueError):
    logger = logging.getLogger(__name__)
    logger.warning("Invalid SEARCH_RECOVERY_RETRY_COUNT value; falling back to 1.")
    search_recovery_retry_count = 1

try:
    search_recovery_timeout_seconds = max(1, min(3600, int(os.getenv("SEARCH_RECOVERY_TIMEOUT_SECONDS", "600"))))
except (TypeError, ValueError):
    logger = logging.getLogger(__name__)
    logger.warning("Invalid SEARCH_RECOVERY_TIMEOUT_SECONDS value; falling back to 600.")
    search_recovery_timeout_seconds = 600

search_recovery_command = os.getenv("SEARCH_RECOVERY_COMMAND")
```

**Added to Config instantiation:**
```python
search_recovery_retry_count=search_recovery_retry_count,
search_recovery_timeout_seconds=search_recovery_timeout_seconds,
search_recovery_command=search_recovery_command,
```

## Verification

### Test 1: Settings Write → var.env
```bash
✅ SEARCH_RECOVERY_RETRY_COUNT=5
✅ SEARCH_RECOVERY_TIMEOUT_SECONDS=1800
✅ SEARCH_RECOVERY_COMMAND=systemctl restart searxng
```

### Test 2: var.env → Config Singleton
```python
✅ config.search_recovery_retry_count = 5 (type: int)
✅ config.search_recovery_timeout_seconds = 1800 (type: int)
✅ config.search_recovery_command = 'systemctl restart searxng'
```

### Test 3: Config → Orchestrator
```python
# orchestrator._get_search_recovery_config() now returns actual values
✅ retry_count = 5 (not default 1)
✅ timeout_seconds = 1800 (not default 600)
✅ command = 'systemctl restart searxng' (not empty string)
```

## End-to-End Flow (Now Working)

1. **Frontend** → `saveSettings({search_recovery: {retry_count: 3, timeout_seconds: 900, command: '...'}})`
2. **API** → `PUT /settings` writes 3 vars to `utils/var.env` ✅
3. **Settings** → `reload_settings()` pushes to `os.environ` + calls `reset_config()` ✅
4. **Config** → `get_config()` reads env vars and populates Config fields ✅
5. **Orchestrator** → `_get_search_recovery_config()` gets actual user values via `getattr()` ✅
6. **Runtime** → Recovery loop uses correct retry_count, timeout_seconds, and command ✅

## Files Modified

- `/Users/jlowder/dev/deep-reach/deep-reach-worker/api_server.py` (FIX 1)
- `/Users/jlowder/dev/deep-reach/deep-reach-worker/utils/config.py` (FIX 2 + FIX 3)

## No Breaking Changes

- Defaults remain the same (retry_count=1, timeout_seconds=600, command='')
- Existing var.env entries are preserved
- Settings dialog behavior unchanged (just now persistence works)
