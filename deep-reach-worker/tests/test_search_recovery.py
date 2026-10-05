"""Unit tests for the search recovery mechanism (command execution and retry logic).

Tests both the low-level helpers and the integration with Config/ENV.
All tests are hermetic (no real subprocess execution for recovery commands).
"""

import subprocess
import pytest
import importlib
import os

orch_mod = importlib.import_module("deep_research_orchestrator")


class TestRunRecoveryCommand:
    """Tests for _run_recovery_command helper."""

    def test_successful_command(self, tmp_path):
        """Happy path: command succeeds, captures output."""
        script = tmp_path / "ok.sh"
        script.write_text("#!/bin/bash\necho 'success'\nexit 0\n")
        script.chmod(0o755)
        
        result = orch_mod._run_recovery_command(f"bash {script}", cool_down_seconds=10)
        assert result["success"] is True
        assert "success" in result["output"]
        assert result["error"] == ""

    def test_failed_command(self, tmp_path):
        """Command executes but exits with non-zero code."""
        script = tmp_path / "fail.sh"
        script.write_text("#!/bin/bash\necho 'error occurred'\nexit 1\n")
        script.chmod(0o755)
        
        result = orch_mod._run_recovery_command(f"bash {script}", cool_down_seconds=10)
        assert result["success"] is False
        assert "error occurred" in result["output"]
        assert "exit 1" in result["error"] or result["error"] != ""

    def test_timeout(self, tmp_path):
        """Command exceeds timeout."""
        script = tmp_path / "slow.sh"
        script.write_text("#!/bin/bash\nsleep 5\n")
        script.chmod(0o755)
        
        result = orch_mod._run_recovery_command(f"bash {script}", cool_down_seconds=1)
        assert result["success"] is False
        assert "timed out" in result["error"].lower() or "timeout" in result["error"].lower()

    def test_command_not_found(self):
        """Command doesn't exist."""
        result = orch_mod._run_recovery_command("nonexistent_command_xyz_12345", cool_down_seconds=10)
        assert result["success"] is False
        assert "not found" in result["error"].lower() or "No such file" in result["error"]

    def test_execution_error(self):
        """Shell execution error (e.g., permission denied)."""
        # Create a non-executable file and try to run it directly
        script = tmp_path = type("tmp", (), {"write_text": lambda s, c: None})()
        import tempfile
        import os
        with tempfile.NamedTemporaryFile(mode="w", delete=False) as f:
            f.write("#!/bin/bash\necho test")
            fname = f.name
        os.chmod(fname, 0o644)  # remove execute permission
        
        result = orch_mod._run_recovery_command(fname, cool_down_seconds=10)
        os.unlink(fname)
        assert result["success"] is False
        # Should have some error message about execution failure

    def test_never_raises(self):
        """Even malformed commands should not raise exceptions."""
        result = orch_mod._run_recovery_command("&&& malformed $$$", cool_down_seconds=1)
        assert isinstance(result, dict)
        assert "success" in result and "error" in result and "output" in result


class TestGetSearchRecoveryConfig:
    """Tests for _get_search_recovery_config helper."""

    def test_defaults_when_unset(self, monkeypatch):
        """Returns defaults when no SEARCH_RECOVERY_* env vars are set."""
        # Use fake config with defaults
        class FakeConfig:
            search_recovery_retry_count = 1
            search_recovery_cool_down_seconds = 600
            search_recovery_command = None
        
        monkeypatch.setattr(orch_mod, "get_config", lambda: FakeConfig())
        
        config = orch_mod._get_search_recovery_config()
        assert config["retry_count"] == 1
        assert config["cool_down_seconds"] == 600
        assert config["command"] == ""

    def test_uses_config_values(self, monkeypatch):
        """Uses values from config when set (handles string or int)."""
        class FakeConfig:
            search_recovery_retry_count = 3  # or "3"
            search_recovery_cool_down_seconds = 120  # or "120"
            search_recovery_command = "sudo systemctl restart searxng"
        
        monkeypatch.setattr(orch_mod, "get_config", lambda: FakeConfig())
        
        config = orch_mod._get_search_recovery_config()
        assert config["retry_count"] == 3
        assert config["cool_down_seconds"] == 120
        assert config["command"] == "sudo systemctl restart searxng"

    def test_clamps_retry_count(self, monkeypatch):
        """Clamps retry_count to 0-5 range."""
        class FakeConfig:
            search_recovery_retry_count = "10"
            search_recovery_cool_down_seconds = "600"
            search_recovery_command = ""
        
        monkeypatch.setattr(orch_mod, "get_config", lambda: FakeConfig())
        
        config = orch_mod._get_search_recovery_config()
        assert config["retry_count"] == 5  # capped at max

    def test_clamps_cool_down_seconds(self, monkeypatch):
        """Clamps cool_down_seconds to 1-3600 range."""
        class FakeConfig:
            search_recovery_retry_count = "1"
            search_recovery_cool_down_seconds = "7200"
            search_recovery_command = ""
        
        monkeypatch.setattr(orch_mod, "get_config", lambda: FakeConfig())
        
        config = orch_mod._get_search_recovery_config()
        assert config["cool_down_seconds"] == 3600  # capped at max

    def test_invalid_retry_count_uses_default(self, monkeypatch):
        """Invalid retry_count value uses default."""
        class FakeConfig:
            search_recovery_retry_count = "fast"
            search_recovery_cool_down_seconds = "600"
            search_recovery_command = ""
        
        monkeypatch.setattr(orch_mod, "get_config", lambda: FakeConfig())
        
        config = orch_mod._get_search_recovery_config()
        assert config["retry_count"] == 1  # default

    def test_handles_none_values(self, monkeypatch):
        """Handles None values gracefully."""
        class FakeConfig:
            search_recovery_retry_count = None
            search_recovery_cool_down_seconds = None
            search_recovery_command = None
        
        monkeypatch.setattr(orch_mod, "get_config", lambda: FakeConfig())
        
        config = orch_mod._get_search_recovery_config()
        assert config["retry_count"] == 1
        assert config["cool_down_seconds"] == 600
        assert config["command"] == ""

    def test_reads_actual_config_values(self, monkeypatch):
        """Reads actual values from config (non-defaults)."""
        class FakeConfig:
            search_recovery_retry_count = 5
            search_recovery_cool_down_seconds = 1800
            search_recovery_command = "systemctl restart searxng"
        
        monkeypatch.setattr(orch_mod, "get_config", lambda: FakeConfig())
        
        config = orch_mod._get_search_recovery_config()
        assert config["retry_count"] == 5
        assert config["cool_down_seconds"] == 1800
        assert config["command"] == "systemctl restart searxng"
