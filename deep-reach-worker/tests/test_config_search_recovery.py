"""Unit tests for the SEARCH_RECOVERY_* env var resolution in utils/config.py.

No live LLM calls: only config resolution is exercised.
Always resets the global config so no stale state leaks into other tests.
"""

import utils.config as config_mod
from utils.config import get_config


class TestSearchRecoveryConfig:
    """Tests for search_recovery_* fields in Config dataclass."""

    def setup_method(self):
        """Reset config before each test."""
        config_mod.reset_config()

    def teardown_method(self):
        """Reset config after each test."""
        config_mod.reset_config()

    def test_default_values_when_env_unset(self, monkeypatch):
        """Returns defaults when no SEARCH_RECOVERY_* env vars are set."""
        # Ensure these env vars are not set
        monkeypatch.delenv("SEARCH_RECOVERY_RETRY_COUNT", raising=False)
        monkeypatch.delenv("SEARCH_RECOVERY_TIMEOUT_SECONDS", raising=False)
        monkeypatch.delenv("SEARCH_RECOVERY_COMMAND", raising=False)
        
        cfg = get_config()
        assert cfg.search_recovery_retry_count == 1
        assert cfg.search_recovery_timeout_seconds == 600
        assert cfg.search_recovery_command is None

    def test_reads_env_vars_correctly(self, monkeypatch):
        """Config reads SEARCH_RECOVERY_* env vars and converts types properly."""
        monkeypatch.setenv("SEARCH_RECOVERY_RETRY_COUNT", "4")
        monkeypatch.setenv("SEARCH_RECOVERY_TIMEOUT_SECONDS", "1500")
        monkeypatch.setenv("SEARCH_RECOVERY_COMMAND", "docker restart searxng")
        
        cfg = get_config()
        assert cfg.search_recovery_retry_count == 4
        assert isinstance(cfg.search_recovery_retry_count, int)
        
        assert cfg.search_recovery_timeout_seconds == 1500
        assert isinstance(cfg.search_recovery_timeout_seconds, int)
        
        assert cfg.search_recovery_command == "docker restart searxng"
        assert isinstance(cfg.search_recovery_command, str)

    def test_retry_count_clamped_to_range(self, monkeypatch):
        """retry_count is clamped to 0-5 range."""
        monkeypatch.setenv("SEARCH_RECOVERY_RETRY_COUNT", "10")
        monkeypatch.setenv("SEARCH_RECOVERY_TIMEOUT_SECONDS", "600")
        
        cfg = get_config()
        assert cfg.search_recovery_retry_count == 5  # capped at max

        monkeypatch.setenv("SEARCH_RECOVERY_RETRY_COUNT", "-2")
        config_mod.reset_config()
        cfg = get_config()
        assert cfg.search_recovery_retry_count == 0  # floor at min

    def test_timeout_seconds_clamped_to_range(self, monkeypatch):
        """timeout_seconds is clamped to 1-3600 range."""
        monkeypatch.setenv("SEARCH_RECOVERY_RETRY_COUNT", "1")
        monkeypatch.setenv("SEARCH_RECOVERY_TIMEOUT_SECONDS", "5000")
        
        cfg = get_config()
        assert cfg.search_recovery_timeout_seconds == 3600  # capped at max

        monkeypatch.setenv("SEARCH_RECOVERY_TIMEOUT_SECONDS", "0")
        config_mod.reset_config()
        cfg = get_config()
        assert cfg.search_recovery_timeout_seconds == 1  # floor at min

    def test_invalid_retry_count_uses_default(self, monkeypatch):
        """Invalid retry_count value falls back to default with warning."""
        monkeypatch.setenv("SEARCH_RECOVERY_RETRY_COUNT", "not_a_number")
        monkeypatch.setenv("SEARCH_RECOVERY_TIMEOUT_SECONDS", "600")
        
        cfg = get_config()
        assert cfg.search_recovery_retry_count == 1  # default

    def test_invalid_timeout_seconds_uses_default(self, monkeypatch):
        """Invalid timeout_seconds value falls back to default with warning."""
        monkeypatch.setenv("SEARCH_RECOVERY_RETRY_COUNT", "3")
        monkeypatch.setenv("SEARCH_RECOVERY_TIMEOUT_SECONDS", "bad_value")
        
        cfg = get_config()
        assert cfg.search_recovery_timeout_seconds == 600  # default

    def test_command_is_optional(self, monkeypatch):
        """search_recovery_command can be None (optional)."""
        monkeypatch.setenv("SEARCH_RECOVERY_RETRY_COUNT", "2")
        monkeypatch.setenv("SEARCH_RECOVERY_TIMEOUT_SECONDS", "900")
        monkeypatch.delenv("SEARCH_RECOVERY_COMMAND", raising=False)
        
        cfg = get_config()
        assert cfg.search_recovery_retry_count == 2
        assert cfg.search_recovery_timeout_seconds == 900
        assert cfg.search_recovery_command is None

    def test_command_with_empty_string(self, monkeypatch):
        """Empty string command is kept as empty string (not None)."""
        monkeypatch.setenv("SEARCH_RECOVERY_RETRY_COUNT", "2")
        monkeypatch.setenv("SEARCH_RECOVERY_TIMEOUT_SECONDS", "900")
        monkeypatch.setenv("SEARCH_RECOVERY_COMMAND", "")
        
        cfg = get_config()
        assert cfg.search_recovery_command == ""

    def test_command_with_special_characters(self, monkeypatch):
        """Command can contain special characters (shell commands)."""
        cmd = "docker compose -f searxng.yml restart searxng-service"
        monkeypatch.setenv("SEARCH_RECOVERY_COMMAND", cmd)
        
        cfg = get_config()
        assert cfg.search_recovery_command == cmd

    def test_command_with_chained_commands(self, monkeypatch):
        """Command can contain shell chaining (&&, ;, etc.)."""
        cmd = "systemctl stop searxng && systemctl start searxng"
        monkeypatch.setenv("SEARCH_RECOVERY_COMMAND", cmd)
        
        cfg = get_config()
        assert cfg.search_recovery_command == cmd

    def test_field_types_correct(self, monkeypatch):
        """All three fields have correct Python types."""
        monkeypatch.setenv("SEARCH_RECOVERY_RETRY_COUNT", "3")
        monkeypatch.setenv("SEARCH_RECOVERY_TIMEOUT_SECONDS", "1200")
        monkeypatch.setenv("SEARCH_RECOVERY_COMMAND", "echo test")
        
        cfg = get_config()
        
        assert isinstance(cfg.search_recovery_retry_count, int)
        assert isinstance(cfg.search_recovery_timeout_seconds, int)
        assert cfg.search_recovery_command is None or isinstance(cfg.search_recovery_command, str)

    def test_standalone_env_var_reading(self, monkeypatch):
        """Config can read each SEARCH_RECOVERY_* var independently."""
        # Only set one
        monkeypatch.setenv("SEARCH_RECOVERY_RETRY_COUNT", "5")
        
        cfg = get_config()
        assert cfg.search_recovery_retry_count == 5
        assert cfg.search_recovery_timeout_seconds == 600  # default
        assert cfg.search_recovery_command is None  # default
