"""Regression: empty model plan -> decompose retry -> run still completes.

Task 9deb0f48 (Ornith-1.5-35B): the model returned a *valid* structured
ResearchPlan with an empty sub_questions list. The plan validated with
source='structured', the retry never fired, and the run early-finished with
zero sections while the API finalized the record "completed" and the report
endpoint served literal `null`.

After the fixes: the empty list fails schema validation (min_length=1), the
fallback plan (source='fallback') triggers exactly one retry, the retry line
is recorded in the API step log, and the run proceeds to a real report.

No live LLM/network: the decomposer's run_model is stubbed with a 2-call
sequence (empty plan, then the normal text-JSON plan) and the rest of the
pipeline is stubbed via test_deep_pipeline._install_stubs.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pytest

import test_deep_pipeline as tdp
import worker_agents.decomposition_agent as dmod
from test_deep_pipeline import _FakeResponse

import deep_research_orchestrator as dpo

EMPTY_PLAN = {"is_simple": False, "sub_questions": []}


@pytest.fixture
def empty_plan_env(monkeypatch) -> dict:
    """tdp's stub env, with the decomposer sequenced: call #1 returns the
    empty structured plan, the retry returns the 2-sq text-JSON plan.
    Decompose calls and stage notifications are recorded on the env dict."""
    env = tdp._basic_env()
    env["writer_text"] = lambda i, _k: tdp._json_writer(i)
    tdp._install_stubs(monkeypatch, env)

    env["decompose_calls"] = []
    env["stages"] = []

    def _seq_run_model(*args, **kwargs):
        env["decompose_calls"].append(kwargs)
        if len(env["decompose_calls"]) == 1:
            return _FakeResponse(parsed=EMPTY_PLAN, text="")
        return _FakeResponse(text=env["plan_json"])

    monkeypatch.setattr(dmod, "run_model", _seq_run_model)
    env["on_stage"] = lambda n, d: env["stages"].append((n, d))
    return env


def test_empty_plan_retries_once_and_completes(empty_plan_env):
    env = empty_plan_env
    result = dpo.deep_research(
        "test research query",
        verbose=False,
        max_rounds=1,
        budget_doc=2,
        budget_web=2,
        output_format="json",
        on_stage=env["on_stage"],
    )

    # Exactly one retry: the decomposer was asked twice in total.
    assert len(env["decompose_calls"]) == 2

    # The fallback cause is visible in the API step log (stage 1 = decompose).
    assert (
        1,
        "model returned an empty plan — retrying with fallback",
    ) in env["stages"]

    # The retry's 2-sq plan won (more sub-questions than the fallback's 1).
    state = result["state"]
    assert len(state["plan"]["sub_questions"]) == 2
    assert state["plan"]["sub_questions"][0]["question"].startswith("Q1")

    # ...and the run produced a real structured report, not the 9deb failure.
    assert state.get("report_json") is not None
    report = json.loads(state["report_json"])
    assert report["report"]["sections"], "report must not be empty"
    assert result["final_answer"]

    # Stage 5 reports completion in structured mode.
    final = [d for n, d in env["stages"] if n == 5][-1]
    assert final.startswith("complete (structured): 2 section(s)")
