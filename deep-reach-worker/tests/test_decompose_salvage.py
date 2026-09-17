"""Truncation-aware decomposition: salvage, re-prompt flow, per-call usage log.

Unit tests (no LLM): the bracket scanner, salvage, _parse_plan sources,
_plan_better, the reprompt-only no-prose line, config values, and the
summarize_usage entry shape. Flow tests run the full deep_research pipeline
with stubbed agents (same harness as test_decompose_retry) and assert the
single/double-call matrices and stats.llm_call_log.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pytest  # noqa: F401

import test_deep_pipeline as tdp


@pytest.fixture(autouse=True)
def _llm_key_resolvable(pin_keyring):
    # deep_research refuses to start when no LLM key resolves (keyring ->
    # env); pin one so the suite is deterministic on keyring-less hosts.
    pin_keyring(llm="test-llm-key")

import test_deep_pipeline as tdp
import utils.config as config_mod
from test_deep_pipeline import _FakeResponse

from worker_agents import decomposition_agent as dmod
from worker_agents.decomposition_agent import (
    _is_truncated_json,
    _salvage_truncated_plan,
    _scan_json_containers,
    _parse_plan,
)
import worker_agents.model_runner as mr
import deep_research_orchestrator as dpo

_plan_better = dpo._plan_better


SQ1 = {
    "id": "sq1",
    "question": "What are the characteristic molecular markers of a metabolism-first origin of life, and how do they differ from RNA-world scenarios?",
    "angle": "origin-of-life biochemistry",
    "expected_sources": "both",
    "priority": 1,
    "heading": "RNA-World vs Metabolism-First Biochemistry",
}
SQ2 = {
    "id": "sq2",
    "question": "What abiotic processes could produce false-positive biosignatures, and how would a JWST observer rule them out?",
    "angle": "false positives and controls",
    "expected_sources": "web",
    "priority": 2,
    "heading": "Abiotic False Positives",
}
COMPLETE = (
    '{"is_simple": false,\n "report_title": "Detecting Prebiotic Origin-of-Life '
    'Biosignatures on Exoplanets",\n "sub_questions": ['
    + json.dumps(SQ1)
    + ", "
    + json.dumps(SQ2)
    + "]}"
)
# The 14:33 failure shape: complete sq1, then sq2 cut off mid-KEY (after the
# `"question` opening quote — even the key string was not finished).
FRAG_AFTER_SQ1 = (
    '{"is_simple": false,\n "report_title": "Detecting Prebiotic Origin-of-Life '
    'Biosignatures on Exoplanets",\n "sub_questions": ['
    + json.dumps(SQ1)
    + ',\n {"id": "sq2",\n "question'
)
# Cut inside sq1: no complete sub-question object exists anywhere.
FRAG_INSIDE_SQ1 = FRAG_AFTER_SQ1[:60]
PLAN_2 = json.dumps({"is_simple": False, "report_title": "Biosignatures", "sub_questions": [SQ1, SQ2]})
PLAN_1 = json.dumps({"is_simple": False, "sub_questions": [SQ1]})


def _resp(text: str, parsed=None, usage=None, max_output_tokens=None) -> _FakeResponse:
    r = _FakeResponse(text=text, parsed=parsed)
    if usage is not None:
        r.usage = usage
    if max_output_tokens is not None:
        r.max_output_tokens = max_output_tokens
    return r


def _usage(in_n, out_n, reasoning_n=None):
    class _Details:
        pass

    class _U:
        pass

    details = _Details()
    details.reasoning_tokens = reasoning_n
    u = _U()
    u.input_tokens = in_n
    u.output_tokens = out_n
    u.output_tokens_details = details
    return u


# ---------------------------------------------------------------------------
# unit: truncation scan + salvage
# ---------------------------------------------------------------------------

def test_complete_plan_is_not_truncated():
    assert _is_truncated_json(COMPLETE) is False
    _, stack = _scan_json_containers(COMPLETE)
    assert stack == []


def test_fragment_after_sq1_is_truncated():
    assert _is_truncated_json(FRAG_AFTER_SQ1) is True
    _, stack = _scan_json_containers(FRAG_AFTER_SQ1)
    assert len(stack) >= 3  # top object, sub_questions array, sq2 object


def test_salvage_after_sq1_recovers_one():
    repaired = _salvage_truncated_plan(FRAG_AFTER_SQ1)
    assert repaired is not None
    doc = json.loads(repaired)
    assert len(doc["sub_questions"]) == 1
    assert doc["sub_questions"][0]["question"] == SQ1["question"]
    assert doc["report_title"].startswith("Detecting")


def test_salvage_inside_sq1_is_none():
    assert _salvage_truncated_plan(FRAG_INSIDE_SQ1) is None


def test_salvage_of_complete_doc_is_byte_identical():
    assert _salvage_truncated_plan(COMPLETE) == COMPLETE


def test_salvage_of_junk_is_none():
    assert _salvage_truncated_plan("I cannot help with that [sorry].") is None


def test_balanced_but_unusable_is_not_truncated():
    # balanced prose with a stray bracket — NOT a truncation (no open containers)
    assert _is_truncated_json("Sorry, I cannot help [with] this.") is False


# ---------------------------------------------------------------------------
# unit: _parse_plan sources
# ---------------------------------------------------------------------------

def test_parse_salvaged_source():
    plan = _parse_plan(_resp(FRAG_AFTER_SQ1), "EXPLORE QUERY")
    assert plan["source"] == "salvaged"
    assert len(plan["sub_questions"]) == 1
    assert plan["salvage_capped"] is False
    assert plan["sub_questions"][0]["id"] == "sq1"


def test_parse_salvaged_capped_flag():
    # cap-hit usage (omlx shape): output consumed the whole budget
    r = _resp(FRAG_AFTER_SQ1, usage=_usage(100, 2000, 1930), max_output_tokens=2000)
    plan = _parse_plan(r, "Q")
    assert plan["source"] == "salvaged"
    assert plan["salvage_capped"] is True


def test_parse_truncated_inside_sq1_falls_back_with_reason():
    plan = _parse_plan(_resp(FRAG_INSIDE_SQ1), "Q")
    assert plan["source"] == "fallback"
    assert plan["fallback_reason"] == "truncated plan"
    assert plan["fallback_truncated"] is True
    assert len(plan["sub_questions"]) == 1
    assert plan["sub_questions"][0]["question"] == "Q"


def test_parse_complete_json_fallback_unchanged():
    plan = _parse_plan(_resp(PLAN_2), "Q")
    assert plan["source"] == "json-fallback"
    assert len(plan["sub_questions"]) == 2


def test_parse_empty_plan_unchanged():
    empty = json.dumps({"is_simple": False, "sub_questions": []})
    plan = _parse_plan(_resp(empty), "Q")
    assert plan["source"] == "fallback"
    assert plan["fallback_reason"] == "empty plan"
    assert plan.get("fallback_truncated") is not True


def test_parse_structured_unchanged():
    parsed = dmod.ResearchPlan(
        is_simple=False,
        sub_questions=[
            dmod.SubQuestion(id="sq1", question="q?", angle="a", expected_sources="both", priority=1),
            dmod.SubQuestion(id="sq2", question="q2?", angle="a", expected_sources="both", priority=2),
        ],
    )
    plan = _parse_plan(_resp("", parsed=parsed), "Q")
    assert plan["source"] == "structured"
    assert len(plan["sub_questions"]) == 2


# ---------------------------------------------------------------------------
# unit: _plan_better + reprompt line + config + summarize_usage
# ---------------------------------------------------------------------------

def test_plan_better_matrix():
    f1 = dmod._fallback_plan("Q")
    f2 = dmod._fallback_plan("Q", truncated=True)
    j1 = json.loads(PLAN_1)
    j2 = json.loads(PLAN_2)
    assert not _plan_better(f1, j2)      # 1-SQ fallback vs 2-SQ model plan
    assert _plan_better(j2, f1)          # reverse
    assert not _plan_better(f1, f1)      # identical fallbacks: "better" is strict
    assert _plan_better(j1, f1)          # tie on count: model-produced beats fallback
    assert not _plan_better(f1, j1)      # ...but never a worse plan
    assert f1.get("fallback_truncated") is False
    assert f2.get("fallback_truncated") is True


def test_reprompt_line_only_on_retry(monkeypatch):
    calls = []

    def fake(*a, **k):
        calls.append(k)
        return _resp(FRAG_AFTER_SQ1)  # truncated on both calls

    monkeypatch.setattr(dmod, "run_model", fake)
    dmod.decompose_query("EXPLORE QUERY", [], verbose=False)
    dmod.decompose_query("EXPLORE QUERY", [], verbose=False, reprompt=True)
    first, second = calls[0]["input_data"], calls[1]["input_data"]
    assert first == second[: len(first)]           # first-shot prompt untouched
    assert "JSON object only" not in first
    assert "JSON object only" in second            # trailing no-prose line only on the retry
    assert second.startswith(first)


def test_config_decomposer_values_and_env(monkeypatch):
    config = config_mod.get_config()
    assert config.get_max_output_tokens("decomposer") == 8000
    assert config.decomposer_thinking_budget == 1024
    assert config.decomposer_thinking_budget or None == 1024

    monkeypatch.setenv("DECOMPOSER_MAX_OUTPUT_TOKENS", "5555")
    monkeypatch.setenv("DECOMPOSER_THINKING_BUDGET", "256")
    config_mod.reset_config()
    config = config_mod.get_config()
    assert config.get_max_output_tokens("decomposer") == 5555
    assert config.decomposer_thinking_budget == 256

    # 0 disables the per-call budget -> the agent passes None (global
    # LLM_ENABLE_THINKING default takes over)
    monkeypatch.setenv("DECOMPOSER_THINKING_BUDGET", "0")
    config_mod.reset_config()
    assert (config_mod.get_config().decomposer_thinking_budget or None) is None


def test_summarize_usage_shape_and_derivation():
    # full omlx-shape usage, cap hit -> capped True + finish_reason "length"
    r = _resp("x", usage=_usage(1100, 8000, 7000), max_output_tokens=8000)
    entry = mr.summarize_usage(r, model="Ornith", stage="decomposer", elapsed_ms=1234.4)
    assert set(entry) == {
        "stage", "model", "tokens_in", "tokens_out",
        "reasoning_out", "finish_reason", "ms", "capped",
    }
    assert entry["stage"] == "decomposer"
    assert entry["tokens_in"] == 1100
    assert entry["tokens_out"] == 8000
    assert entry["reasoning_out"] == 7000
    assert entry["capped"] is True
    assert entry["finish_reason"] == "length"
    assert entry["ms"] == 1234
    assert r.capped is True

    # usage below the cap -> not capped, no derived finish
    r2 = _resp("x", usage=_usage(100, 1900, 1500), max_output_tokens=8000)
    e2 = mr.summarize_usage(r2, stage="writer")
    assert e2["capped"] is False
    assert e2["finish_reason"] is None
    assert e2["stage"] == "writer"
    assert e2["model"] is None and e2["ms"] is None

    # nothing at all -> all-null entry (capped False = "not capped"), never raises
    e3 = mr.summarize_usage(_resp("x"))
    assert e3["tokens_in"] is None and e3["capped"] is False
    assert e3["finish_reason"] is None


# ---------------------------------------------------------------------------
# flow: full deep_research with stubbed agents
# ---------------------------------------------------------------------------

def _run(monkeypatch, plan_factory):
    """Run the whole deep pipeline; the decomposer's run_model returns
    plan_factory(call_index). Records decompose kwargs + step lines."""
    env = tdp._basic_env()
    env["writer_text"] = lambda i, _k: tdp._json_writer(i)
    tdp._install_stubs(monkeypatch, env)
    calls = []

    def fake(*a, **k):
        calls.append(k)
        return plan_factory(len(calls) - 1)

    monkeypatch.setattr(dmod, "run_model", fake)
    env["decompose_calls"] = calls
    env["stages"] = []
    env["on_stage"] = lambda n, d: env["stages"].append((n, d))
    result = dpo.deep_research(
        "test research query",
        verbose=False,
        max_rounds=1,
        budget_doc=2,
        budget_web=2,
        output_format="json",
        on_stage=env["on_stage"],
    )
    return result, env


def test_flow_complete_plan_single_call(monkeypatch):
    result, env = _run(monkeypatch, lambda i: _resp(PLAN_2))
    assert len(env["decompose_calls"]) == 1
    assert all("re-prompting" not in s for _, s in env["stages"])
    assert all("salvaged" not in s for _, s in env["stages"])
    plan = result["state"]["plan"]
    assert len(plan["sub_questions"]) == 2


def test_flow_truncated_after_sq1_salvages_single_call(monkeypatch):
    # complete sq1 then cut in sq2 -> salvage 1, NO re-prompt (saves the call)
    result, env = _run(monkeypatch, lambda i: _resp(FRAG_AFTER_SQ1))
    assert len(env["decompose_calls"]) == 1
    lines = [s for _, s in env["stages"]]
    assert any(
        s == "plan truncated mid-JSON — salvaged 1 complete sub-question(s)"
        for s in lines
    )
    assert not any("re-prompting" in s for s in lines)
    plan = result["state"]["plan"]
    assert len(plan["sub_questions"]) == 1
    assert plan["sub_questions"][0]["question"] == SQ1["question"]
    assert result["final_answer"]  # the run completed


def test_flow_truncated_capped_names_the_cap(monkeypatch):
    cap = config_mod.get_config().get_max_output_tokens("decomposer")
    result, env = _run(
        monkeypatch,
        lambda i: _resp(FRAG_AFTER_SQ1, usage=_usage(1100, cap, 7000), max_output_tokens=cap),
    )
    assert len(env["decompose_calls"]) == 1
    lines = [s for _, s in env["stages"]]
    assert any(
        s == f"plan truncated at {cap} tokens — salvaged 1 complete sub-question(s)"
        for s in lines
    )
    # the per-call log carries the derived finish_reason + usage
    entry = result["stats"]["llm_call_log"][0]
    assert entry["stage"] == "decomposer"
    assert entry["tokens_out"] == cap
    assert entry["reasoning_out"] == 7000
    assert entry["capped"] is True
    assert entry["finish_reason"] == "length"


def test_flow_truncated_inside_sq1_reprompt_then_complete(monkeypatch):
    def factory(i):
        if i == 0:
            return _resp(FRAG_INSIDE_SQ1)
        return _resp(PLAN_2)

    result, env = _run(monkeypatch, factory)
    assert len(env["decompose_calls"]) == 2
    lines = [s for _, s in env["stages"]]
    assert "model returned an truncated plan — re-prompting" in lines
    assert "re-prompt returned a complete plan — using 2 sub-questions" in lines
    plan = result["state"]["plan"]
    assert len(plan["sub_questions"]) == 2
    # the no-prose line was added for the retry ONLY
    assert "JSON object only" not in env["decompose_calls"][0]["input_data"]
    assert "JSON object only" in env["decompose_calls"][1]["input_data"]


def test_flow_truncated_twice_falls_back(monkeypatch):
    result, env = _run(monkeypatch, lambda i: _resp(FRAG_INSIDE_SQ1))
    assert len(env["decompose_calls"]) == 2
    lines = [s for _, s in env["stages"]]
    assert "model returned an truncated plan — re-prompting" in lines
    assert "re-prompt still returned a truncated plan — using single-sub-question fallback" in lines
    plan = result["state"]["plan"]
    assert plan["source"] == "fallback"
    assert plan["sub_questions"][0]["question"] == "test research query"
    assert result["final_answer"]  # the run still completed


def test_llm_call_log_full_run_shape(monkeypatch):
    result, env = _run(monkeypatch, lambda i: _resp(PLAN_2))
    stats = result["stats"]
    log = stats["llm_call_log"]
    assert isinstance(log, list) and len(log) >= 3
    for entry in log:
        assert set(entry) == {
            "stage", "model", "tokens_in", "tokens_out",
            "reasoning_out", "finish_reason", "ms", "capped",
        }
    stages = {e["stage"] for e in log}
    assert {"decomposer", "writer", "synthesis"} <= stages
    # one entry per LLM call: every call goes through a tracked module
    assert len(log) == stats["llm_calls"]
