"""Unit tests for search recovery settings persistence in utils/settings.py.

Tests the layer that writes SEARCH_RECOVERY_* vars to var.env.
No real keyring, no real var.env: fully mocked.
"""

import importlib

s = importlib.import_module("utils.settings")
config_mod = importlib.import_module("utils.config")


class TestSearchRecoveryVarEnv:
    """Tests for search recovery vars in var.env layer."""

    def test_write_managed_vars_writes_recovery_fields(self, tmp_path):
        """write_managed_vars correctly writes SEARCH_RECOVERY_* fields."""
        p = tmp_path / "var.env"
        p.write_text("LLM_ENDPOINT=http://localhost:8080/v1\n")
        
        recovery_data = {
            "SEARCH_RECOVERY_RETRY_COUNT": "3",
            "SEARCH_RECOVERY_COOL_DOWN_SECONDS": "900",
            "SEARCH_RECOVERY_COMMAND": "docker restart searxng"
        }
        
        changed = s.write_managed_vars(recovery_data, p)
        assert changed is True
        
        content = s.read_var_env(p)
        assert content["SEARCH_RECOVERY_RETRY_COUNT"] == "3"
        assert content["SEARCH_RECOVERY_COOL_DOWN_SECONDS"] "900"
        assert content["SEARCH_RECOVERY_COMMAND"] == "docker restart searxng"

    def test_read_var_env_reads_recovery_fields(self, tmp_path):
        """read_var_env correctly parses SEARCH_RECOVERY_* fields."""
        p = tmp_path / "var.env"
        content = """# Config
LLM_ENDPOINT=http://localhost:8080/v1
SEARCH_RECOVERY_RETRY_COUNT=4
SEARCH_RECOVERY_COOL_DOWN_SECONDS=1200
SEARCH_RECOVERY_COMMAND=systemctl restart searxng
"""
        p.write_text(content)
        
        parsed = s.read_var_env(p)
        assert parsed["SEARCH_RECOVERY_RETRY_COUNT"] == "4"
        assert parsed["SEARCH_RECOVERY_COOL_DOWN_SECONDS"] == "1200"
        assert parsed["SEARCH_RECOVERY_COMMAND"] == "systemctl restart searxng"

    def test_effective_settings_includes_recovery(self, tmp_path):
        """effective_settings() includes SEARCH_RECOVERY_* fields."""
        p = tmp_path / "var.env"
        p.write_text("""LLM_ENDPOINT=http://localhost:8080/v1
SEARCH_RECOVERY_RETRY_COUNT=5
SEARCH_RECOVERY_COOL_DOWN_SECONDS=1800
SEARCH_RECOVERY_COMMAND=docker compose restart searxng
""")
        
        monkey = type("M", (), {})()
        import os
        monkey.setenv = lambda k, v: os.environ.setdefault(k, v)
        monkey.delenv = lambda k, **_: os.environ.pop(k, None)
        
        # Temporarily set env vars to match file
        import os
        original = {k: os.environ.get(k) for k in s.MANAGED_VARS}
        try:
            parsed = s.read_var_env(p)
            for k, v in parsed.items():
                os.environ[k] = v
            
            effective = s.effective_settings(p)
            assert effective["SEARCH_RECOVERY_RETRY_COUNT"] == "5"
            assert effective["SEARCH_RECOVERY_COOL_DOWN_SECONDS"] == "1800"
            assert effective["SEARCH_RECOVERY_COMMAND"] == "docker compose restart searxng"
        finally:
            # Restore original
            for k in s.MANAGED_VARS:
                if k in original and original[k]:
                    os.environ[k] = original[k]
                elif k in os.environ:
                    del os.environ[k]

    def test_reload_settings_pushes_recovery_to_env(self, tmp_path, monkeypatch):
        """reload_settings() pushes SEARCH_RECOVERY_* to os.environ."""
        import os
        p = tmp_path / "var.env"
        p.write_text("""LLM_ENDPOINT=http://localhost:8080/v1
SEARCH_RECOVERY_RETRY_COUNT=2
SEARCH_RECOVERY_COOL_DOWN_SECONDS=600
SEARCH_RECOVERY_COMMAND=test_command
""")
        
        monkeypatch.setattr(s, "VAR_ENV_PATH", p)
        
        # Clear from env
        for k in ["SEARCH_RECOVERY_RETRY_COUNT", "SEARCH_RECOVERY_COOL_DOWN_SECONDS", "SEARCH_RECOVERY_COMMAND"]:
            if k in os.environ:
                monkeypatch.delenv(k, raising=False)
        
        s.reload_settings(p)
        
        assert os.environ.get("SEARCH_RECOVERY_RETRY_COUNT") == "2"
        assert os.environ.get("SEARCH_RECOVERY_COOL_DOWN_SECONDS") == "600"
        assert os.environ.get("SEARCH_RECOVERY_COMMAND") == "test_command"

    def test_config_reset_on_reload(self, tmp_path, monkeypatch):
        """reload_settings() resets Config singleton so new values are read."""
        import os
        p = tmp_path / "var.env"
        
        # Initial state
        p.write_text("""LLM_ENDPOINT=http://localhost:8080/v1
SEARCH_RECOVERY_RETRY_COUNT=1
SEARCH_RECOVERY_COOL_DOWN_SECONDS=600
SEARCH_RECOVERY_COMMAND=
""")
        monkeypatch.setattr(s, "VAR_ENV_PATH", p)
        s.reload_settings(p)
        cfg1 = config_mod.get_config()
        assert cfg1.search_recovery_retry_count == 1
        
        # Update var.env
        p.write_text("""LLM_ENDPOINT=http://localhost:8080/v1
SEARCH_RECOVERY_RETRY_COUNT=5
SEARCH_RECOVERY_COOL_DOWN_SECONDS=1500
SEARCH_RECOVERY_COMMAND=new_command
""")
        s.reload_settings(p)
        cfg2 = config_mod.get_config()
        assert cfg2.search_recovery_retry_count == 5
        assert cfg2.search_recovery_cool_down_seconds == 1500
        assert cfg2.search_recovery_command == "new_command"


class TestSearchRecoveryInSettingsView:
    """Tests that settings_view() includes search_recovery section."""

    def test_settings_view_includes_recovery_section(self, tmp_path, monkeypatch):
        """settings_view() returns search_recovery with retry_count, cool_down_seconds, command."""
        import os
        p = tmp_path / "var.env"
        p.write_text("""LLM_ENDPOINT=http://localhost:8080/v1
SEARCH_RECOVERY_RETRY_COUNT=3
SEARCH_RECOVERY_COOL_DOWN_SECONDS=900
SEARCH_RECOVERY_COMMAND=docker restart searxng
""")
        
        monkeypatch.setattr(s, "VAR_ENV_PATH", p)
        monkeypatch.setattr(s, "_KEYRING", None)  # Fake keyring
        
        view = s.settings_view(p)
        
        assert "search_recovery" in view
        assert "retry_count" in view["search_recovery"]
        assert "cool_down_seconds" in view["search_recovery"]
        assert "command" in view["search_recovery"]
        
        assert view["search_recovery"]["retry_count"] == 3
        assert view["search_recovery"]["cool_down_seconds"] == 900
        assert view["search_recovery"]["command"] == "docker restart searxng"

    def test_settings_view_defaults_when_unset(self, tmp_path, monkeypatch):
        """settings_view() returns defaults when SEARCH_RECOVERY_* not in var.env."""
        import os
        p = tmp_path / "var.env"
        p.write_text("LLM_ENDPOINT=http://localhost:8080/v1\n")
        
        monkeypatch.setattr(s, "VAR_ENV_PATH", p)
        monkeypatch.setattr(s, "_KEYRING", None)
        
        view = s.settings_view(p)
        
        assert view["search_recovery"]["retry_count"] == 1
        assert view["search_recovery"]["cool_down_seconds"] == 600
        assert view["search_recovery"]["command"] == ""

    def test_settings_view_clamps_retry_count(self, tmp_path, monkeypatch):
        """settings_view() clamps retry_count to 0-5 range."""
        import os
        p = tmp_path / "var.env"
        p.write_text("""LLM_ENDPOINT=http://localhost:8080/v1
SEARCH_RECOVERY_RETRY_COUNT=10
""")
        
        monkeypatch.setattr(s, "VAR_ENV_PATH", p)
        monkeypatch.setattr(s, "_KEYRING", None)
        
        view = s.settings_view(p)
        assert view["search_recovery"]["retry_count"] == 5  # capped

    def test_settings_view_clamps_timeout(self, tmp_path, monkeypatch):
        """settings_view() clamps cool_down_seconds to 1-3600 range."""
        import os
        p = tmp_path / "var.env"
        p.write_text("""LLM_ENDPOINT=http://localhost:8080/v1
SEARCH_RECOVERY_COOL_DOWN_SECONDS=5000
""")
        
        monkeypatch.setattr(s, "VAR_ENV_PATH", p)
        monkeypatch.setattr(s, "_KEYRING", None)
        
        view = s.settings_view(p)
        assert view["search_recovery"]["cool_down_seconds"] == 3600  # capped

    def test_settings_view_handles_invalid_retry_count(self, tmp_path, monkeypatch):
        """settings_view() uses default for invalid retry_count."""
        import os
        p = tmp_path / "var.env"
        p.write_text("""LLM_ENDPOINT=http://localhost:8080/v1
SEARCH_RECOVERY_RETRY_COUNT=bad
""")
        
        monkeypatch.setattr(s, "VAR_ENV_PATH", p)
        monkeypatch.setattr(s, "_KEYRING", None)
        
        view = s.settings_view(p)
        assert view["search_recovery"]["retry_count"] == 1  # default

    def test_settings_view_handles_invalid_timeout(self, tmp_path, monkeypatch):
        """settings_view() uses default for invalid cool_down_seconds."""
        import os
        p = tmp_path / "var.env"
        p.write_text("""LLM_ENDPOINT=http://localhost:8080/v1
SEARCH_RECOVERY_COOL_DOWN_SECONDS=bad
""")
        
        monkeypatch.setattr(s, "VAR_ENV_PATH", p)
        monkeypatch.setattr(s, "_KEYRING", None)
        
        view = s.settings_view(p)
        assert view["search_recovery"]["cool_down_seconds"] == 600  # default
