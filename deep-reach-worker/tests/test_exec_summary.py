"""Executive summary substantive-content gate (task ce4e9c72).

The executive summary is an OPTIONAL SIBLING field of report.sections: the
section-level guards (empty-section, degenerate callouts) never inspect it,
and the UI renders a tinted "Executive Summary" panel for any non-empty
list. Task ce4e9c72's local model returned a fenced, malformed-JSON
response whose salvage left the single paragraph "```" — the stored
report rendered a near-empty callout.

These tests pin the fix:
  * ``_is_structural_garbage`` — blank / code-fence residue / bare JSON.
  * ``clean_executive_summary`` — garbage filter + 30-word TOTAL floor
    (degenerate summary -> absent, never a one-token panel).
  * the assembly backstop (``assemble_structured_report``) and the
    orchestrator, which retries a structurally empty response exactly
    once (hard exceptions fail without retry, as before).

No live LLM/network: every run_model surface is monkeypatched (the same
hermetic stubs the deep-pipeline suite uses).
"""

import json
import shutil

import pytest

import deep_research_orchestrator as dpo
import test_deep_pipeline as tdp
from deep_research_structured import (
    _is_structural_garbage,
    assemble_structured_report,
    clean_executive_summary,
)
from models.report_schema import (
    BlockType,
    ResearchReport,
    ReportBlock,
    Section,
    Span,
)


@pytest.fixture(autouse=True)
def _llm_key_resolvable(pin_keyring):
    # deep_research refuses to start when no LLM key resolves (keyring ->
    # env); pin one so the suite is deterministic on keyring-less hosts.
    pin_keyring(llm="test-llm-key")


_CACHE_TMP_DIRS: list = []


@pytest.fixture(autouse=True)
def _cleanup_evidence_cache_tmp_dirs():
    yield
    for d in _CACHE_TMP_DIRS:
        shutil.rmtree(d, ignore_errors=True)
    _CACHE_TMP_DIRS.clear()
    # tdp._install_stubs appends its per-test evidence-cache DB dirs to ITS
    # module list (its autouse cleanup only runs inside that module).
    for d in tdp._CACHE_TMP_DIRS:
        shutil.rmtree(d, ignore_errors=True)
    tdp._CACHE_TMP_DIRS.clear()


def _para(words: int, prefix: str = "w") -> str:
    """A paragraph of exactly ``words`` (deterministic filler)."""
    return " ".join(f"{prefix}{i}" for i in range(words))


P_60A = _para(60, "alpha")
P_60B = _para(60, "beta")
P_15 = _para(15)


# ---------------------------------------------------------------------------
# _is_structural_garbage
# ---------------------------------------------------------------------------

class TestIsStructuralGarbage:
    def test_blank_is_garbage(self):
        assert _is_structural_garbage("")
        assert _is_structural_garbage("   \n\t ")

    def test_backtick_residue_is_garbage(self):
        # The exact stored artifact of task ce4e9c72.
        assert _is_structural_garbage("```")

    def test_fenced_block_is_garbage(self):
        assert _is_structural_garbage("```json\n[\"a\", \"b\"]\n```")

    def test_bare_json_array_is_garbage(self):
        assert _is_structural_garbage('["one", "two"]')

    def test_bare_json_object_is_garbage(self):
        assert _is_structural_garbage('{"summary": "x"}')

    def test_real_prose_is_not_garbage(self):
        assert not _is_structural_garbage(
            "The study found that the treatment reduced recovery time."
        )

    def test_citation_lead_in_line_is_not_garbage(self):
        # A line that STARTS with a bracket citation is prose (F7).
        assert not _is_structural_garbage("[1] shows a real finding.")

    def test_inline_code_is_not_garbage(self):
        # One inline-code backtick pair is normal prose, not a fence.
        assert not _is_structural_garbage("The `pipeline` runs nightly.")


# ---------------------------------------------------------------------------
# clean_executive_summary
# ---------------------------------------------------------------------------

class TestCleanExecutiveSummary:
    def test_backtick_residue_collapses_to_absent(self):
        assert clean_executive_summary(["```"]) == []

    def test_fenced_json_block_collapses_to_absent(self):
        assert clean_executive_summary(['```json\n["a", "b"]\n```']) == []

    def test_bare_json_array_collapses_to_absent(self):
        assert clean_executive_summary(['["a", "b"]']) == []

    def test_two_real_paragraphs_kept(self):
        out = clean_executive_summary([P_60A, P_60B])
        assert out == [P_60A, P_60B]

    def test_garbage_dropped_real_kept(self):
        assert clean_executive_summary([P_60A, "```"]) == [P_60A]

    def test_single_short_string_collapses_to_absent(self):
        # One 5-word paragraph: no fence, but far under the word floor.
        assert clean_executive_summary(["one two three four five"]) == []

    def test_total_floor_counts_across_paragraphs(self):
        # Four 15-word paragraphs = 60 words total: the floor is on the
        # TOTAL, not per paragraph, so all four survive.
        out = clean_executive_summary([P_15] * 4)
        assert out == [P_15] * 4

    def test_none_input(self):
        assert clean_executive_summary(None) == []


# ---------------------------------------------------------------------------
# assembly backstop
# ---------------------------------------------------------------------------

def _content_section() -> Section:
    """A section comfortably past the ship-guard's 30-word floor."""
    return Section(
        id="s1",
        heading="One",
        blocks=[
            ReportBlock(
                type=BlockType.paragraph,
                spans=[Span(text=_para(40, "fact"), citations=[])],
            )
        ],
    )


def _assemble(exec_paragraphs) -> ResearchReport:
    return assemble_structured_report(
        sections=[_content_section()],
        registry={},
        user_query="q",
        session_id="s1",
        exec_paragraphs=exec_paragraphs,
        verification_status={},
        title="T",
    )


class TestAssemblyBackstop:
    def test_backtick_summary_dropped(self):
        # The reported artifact: the optional panel must render nothing.
        rep = _assemble(["```"])
        assert rep.report.executive_summary == []

    def test_short_stub_summary_dropped(self):
        rep = _assemble(["one two three four five"])
        assert rep.report.executive_summary == []

    def test_real_summary_kept(self):
        rep = _assemble([P_60A, P_60B])
        assert rep.report.executive_summary == [P_60A, P_60B]

    def test_real_and_garbage_mixed(self):
        rep = _assemble([P_60A, "```", P_60B])
        assert rep.report.executive_summary == [P_60A, P_60B]


# ---------------------------------------------------------------------------
# orchestrator: one retry for structurally empty responses (no live LLM)
# ---------------------------------------------------------------------------

def _run_pipeline(monkeypatch, exec_stub, output_format: str) -> tuple:
    """Full deep_research with every LLM surface stubbed; ``exec_stub``
    (attempt_index_1based) replaces the orchestrator's exec-summary
    run_model and returns a tdp._FakeResponse."""
    env = tdp._basic_env()
    tdp._install_stubs(monkeypatch, env)
    calls = []

    def stub(*a, **k):
        calls.append(len(calls) + 1)
        return exec_stub(len(calls))

    monkeypatch.setattr(dpo, "run_model", stub)
    result = dpo.deep_research(
        "test research query", verbose=False, max_rounds=3, output_format=output_format
    )
    return result, calls


def test_json_mode_retries_fence_residue_and_keeps_real(monkeypatch, capsys):
    # First call returns the fence artifact, the retry returns a real 2-
    # paragraph summary: the final report carries the real one.
    def exec_stub(n):
        if n == 1:
            return tdp._FakeResponse(text="```")
        return tdp._FakeResponse(text=json.dumps([P_60A, P_60B]))

    result, calls = _run_pipeline(monkeypatch, exec_stub, output_format="json")
    assert len(calls) == 2  # exactly one retry
    rep = ResearchReport.model_validate_json(result["state"]["report_json"])
    assert rep.report.executive_summary == [P_60A, P_60B]
    assert "## Executive Summary" in result["final_answer"]
    out = capsys.readouterr().out
    assert "structurally empty" in out


def test_json_mode_fence_twice_yields_absent_summary(monkeypatch, capsys):
    # Both attempts return fence residue: exactly one retry, then the
    # summary is absent — the optional panel renders nothing.
    result, calls = _run_pipeline(
        monkeypatch, lambda n: tdp._FakeResponse(text="```"), output_format="json"
    )
    assert len(calls) == 2  # one retry, never a third call
    rep = ResearchReport.model_validate_json(result["state"]["report_json"])
    assert rep.report.executive_summary == []
    assert "## Executive Summary" not in result["final_answer"]
    # The report itself is intact: sections + the failure is not fatal.
    assert len(rep.report.sections) == 2
    assert result["stats"]["exec_summary_failed"] is False  # the calls succeeded
    out = capsys.readouterr().out
    assert "still empty after retry" in out


def test_markdown_mode_valid_content_unchanged(monkeypatch):
    # A short-but-real summary is NOT structural garbage: no retry, and the
    # prose ships verbatim (the markdown path must stay byte-identical for
    # valid content).
    prose = "Synthesized executive summary prose."
    result, calls = _run_pipeline(
        monkeypatch, lambda n: tdp._FakeResponse(text=prose), output_format="markdown"
    )
    assert len(calls) == 1  # no spurious retry for valid content
    assert prose in result["final_answer"]
    assert "## Section One" in result["final_answer"]


def test_markdown_mode_fence_residue_cleared(monkeypatch, capsys):
    # A fence-only response in markdown mode is cleared after one retry so
    # the "```" residue never reaches the final body.
    result, calls = _run_pipeline(
        monkeypatch, lambda n: tdp._FakeResponse(text="```"), output_format="markdown"
    )
    assert len(calls) == 2
    assert "```" not in result["final_answer"]
    assert "## Section One" in result["final_answer"]
    out = capsys.readouterr().out
    assert "still empty after retry" in out
