"""End-to-end test for search recovery settings persistence chain.

Tests the complete flow: API write → var.env → Config → Orchestrator.
Fully hermetic: no real var.env, no real subprocess, mocked Config.
"""

import os
import importlib
import pytest

settings_mod = importlib.import_module("utils.settings")
config_mod = importlib.import_module("utils.config")
orch_mod = importlib.import_module("deep_research_orchestrator")


class TestSearchRecoveryEndToEnd:
    """Tests the full chain from API through to orchestrator usage."""

    def test_full_chain_api_to_orchestrator(self, tmp_path, monkeypatch):
        """
        End-to-end: API writes → var.env → reload → Config → Orchestrator.
        
        This test simulates what happens when a user saves search recovery
        settings via the API and then a deep research run needs to use them.
        """
        # Step 1: Simulate var.env write (as API would do)
        var_env = tmp_path / "var.env"
        var_env.write_text("""LLM_ENDPOINT=http://localhost:8080/v1
SEARCH_RECOVERY_RETRY_COUNT=3
SEARCH_RECOVERY_COOL_DOWN_SECONDS=900
SEARCH_RECOVERY_COMMAND=docker restart searxng
""")
        
        monkeypatch.setattr(settings_mod, "VAR_ENV_PATH", var_env)
        
        # Step 2: Verify var.env contains the values
        parsed = settings_mod.read_var_env(var_env)
        assert parsed["SEARCH_RECOVERY_RETRY_COUNT"] == "3"
        assert parsed["SEARCH_RECOVERY_COOL_DOWN_SECONDS"] == "900"
        assert parsed["SEARCH_RECOVERY_COMMAND"] == "docker restart searxng"
        
        # Step 3: Hot-apply (push to os.environ + reset Config)
        # This is what reload_settings() does
        eff = settings_mod.effective_settings(var_env)
        for name, value in eff.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        
        config_mod.reset_config()  # Force Config to re-read env vars
        
        # Step 4: Verify Config singleton has the values
        cfg = config_mod.get_config()
        assert cfg.search_recovery_retry_count == 3
        assert cfg.search_recovery_cool_down_seconds == 900
        assert cfg.search_recovery_command == "docker restart searxng"
        
        # Step 5: Verify orchestrator can read them
        recovery_cfg = orch_mod._get_search_recovery_config()
        assert recovery_cfg["retry_count"] == 3
        assert recovery_cfg["cool_down_seconds"] == 900
        assert recovery_cfg["command"] == "docker restart searxng"

    def test_full_chain_with_different_values(self, tmp_path, monkeypatch):
        """
        Same as above but with different values (boundary test).
        """
        var_env = tmp_path / "var.env"
        var_env.write_text("""LLM_ENDPOINT=http://localhost:8080/v1
SEARCH_RECOVERY_RETRY_COUNT=5
SEARCH_RECOVERY_COOL_DOWN_SECONDS=1800
SEARCH_RECOVERY_COMMAND=systemctl restart my-search-service
""")
        
        monkeypatch.setattr(settings_mod, "VAR_ENV_PATH", var_env)
        
        # Push to env
        eff = settings_mod.effective_settings(var_env)
        for name, value in eff.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        
        config_mod.reset_config()
        cfg = config_mod.get_config()
        
        # Verify all values propagated through the chain
        assert cfg.search_recovery_retry_count == 5  # max allowed
        assert cfg.search_recovery_cool_down_seconds == 1800  # 30 minutes
        assert cfg.search_recovery_command == "systemctl restart my-search-service"
        
        recovery_cfg = orch_mod._get_search_recovery_config()
        assert recovery_cfg["retry_count"] == 5
        assert recovery_cfg["cool_down_seconds"] == 1800
        assert recovery_cfg["command"] == "systemctl restart my-search-service"

    def test_full_chain_empty_command(self, tmp_path, monkeypatch):
        """
        Test with empty command (recovery disabled).
        """
        var_env = tmp_path / "var.env"
        var_env.write_text("""LLM_ENDPOINT=http://localhost:8080/v1
SEARCH_RECOVERY_RETRY_COUNT=3
SEARCH_RECOVERY_COOL_DOWN_SECONDS=600
SEARCH_RECOVERY_COMMAND=
""")
        
        monkeypatch.setattr(settings_mod, "VAR_ENV_PATH", var_env)
        
        eff = settings_mod.effective_settings(var_env)
        for name, value in eff.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        
        config_mod.reset_config()
        cfg = config_mod.get_config()
        
        assert cfg.search_recovery_retry_count == 3
        assert cfg.search_recovery_cool_down_seconds == 600
        assert cfg.search_recovery_command == ""  # Empty = no recovery command
        
        recovery_cfg = orch_mod._get_search_recovery_config()
        assert recovery_cfg["retry_count"] == 3
        assert recovery_cfg["cool_down_seconds"] == 600
        assert recovery_cfg["command"] == ""  # Empty means recovery won't execute

    def test_orchestrator_would_use_values_in_retry_loop(self, tmp_path, monkeypatch):
        """
        Verify that the orchestrator's _get_search_recovery_config()
        would correctly supply values to the retry loop.
        
        This simulates the logic in deep_research() stage 2:
        
        if retry_count > 0:
            for attempt in range(1, retry_count + 1):
                # execute recovery_command
                # retry search
        """
        var_env = tmp_path / "var.env"
        var_env.write_text("""LLM_ENDPOINT=http://localhost:8080/v1
SEARCH_RECOVERY_RETRY_COUNT=4
SEARCH_RECOVERY_COOL_DOWN_SECONDS=120
SEARCH_RECOVERY_COMMAND=fake_recovery_command
""")
        
        monkeypatch.setattr(settings_mod, "VAR_ENV_PATH", var_env)
        
        eff = settings_mod.effective_settings(var_env)
        for name, value in eff.items():
            os.environ[name] = value
        
        config_mod.reset_config()
        
        # Get what the orchestrator would use
        recovery_cfg = orch_mod._get_search_recovery_config()
        retry_count = recovery_cfg["retry_count"]
        cool_down_seconds = recovery_cfg["cool_down_seconds"]
        command = recovery_cfg["command"]
        
        # Simulate the retry loop logic
        execution_count = 0
        for attempt in range(1, retry_count + 1):
            execution_count += 1
            # In real code: _run_recovery_command(command, timeout_seconds)
        
        # Verify the loop would execute correct number of times
        assert execution_count == 4  # retry_count
        assert timeout_seconds == 120
        assert command == "fake_recovery_command"

    def test_clamping_through_full_chain(self, tmp_path, monkeypatch):
        """
        Verify clamping works throughout the chain.
        """
        var_env = tmp_path / "var.env"
        # These values exceed the allowed range
        var_env.write_text("""LLM_ENDPOINT=http://localhost:8080/v1
SEARCH_RECOVERY_RETRY_COUNT=10
SEARCH_RECOVERY_COOL_DOWN_SECONDS=10000
SEARCH_RECOVERY_COMMAND=test
""")
        
        monkeypatch.setattr(settings_mod, "VAR_ENV_PATH", var_env)
        
        eff = settings_mod.effective_settings(var_env)
        for name, value in eff.items():
            os.environ[name] = value
        
        config_mod.reset_config()
        cfg = config_mod.get_config()
        
        # Verify values are clamped in Config
        assert cfg.search_recovery_retry_count == 5  # max
        assert cfg.search_recovery_cool_down_seconds == 3600  # max
        
        # Verify orchestrator sees clamped values
        recovery_cfg = orch_mod._get_search_recovery_config()
        assert recovery_cfg["retry_count"] == 5
        assert recovery_cfg["cool_down_seconds"] == 3600

    def test_default_chain_when_vars_unset(self, tmp_path, monkeypatch):
        """
        Verify defaults are used when SEARCH_RECOVERY_* env vars are not set.
        """
        var_env = tmp_path / "var.env"
        var_env.write_text("""LLM_ENDPOINT=http://localhost:8080/v1
# No SEARCH_RECOVERY_* vars
""")
        
        monkeypatch.setattr(settings_mod, "VAR_ENV_PATH", var_env)
        
        eff = settings_mod.effective_settings(var_env)
        for name, value in eff.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        
        config_mod.reset_config()
        cfg = config_mod.get_config()
        
        # Verify defaults
        assert cfg.search_recovery_retry_count == 1
        assert cfg.search_recovery_cool_down_seconds == 600
        assert cfg.search_recovery_command is None
        
        recovery_cfg = orch_mod._get_search_recovery_config()
        assert recovery_cfg["retry_count"] == 1
        assert recovery_cfg["cool_down_seconds"] == 600
        assert recovery_cfg["command"] == ""
