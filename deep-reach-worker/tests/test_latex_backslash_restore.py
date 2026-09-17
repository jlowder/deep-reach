r"""Unit tests: the assembly late-backslash restore (_restore_late_backslash).

Artifact under test (recovered from real task 10b502cf, the Drosophila
connectome report): the writer emitted a SINGLE backslash before ``times``
inside its JSON (``\times``); the JSON parser consumed it as the tab
escape, and the ``t`` left with it. The decoded span read
``$8<TAB>imes 8<TAB>imes 8$`` — two real tabs, zero backslashes (the PDF
text layer shows ``8imes8imes8`` WITHOUT the ``t``: decisive that a JSON
escape, not a real tab byte, produced the artifact — a real tab would keep
the ``t``). Every downstream pass keyed on backslash/``$``/brace, so the
tabs survived into KaTeX, which italicized ``imes``.

Rule: at each control char (TAB LF CR FF BS VT), if the escape letter +
the following text form a known LaTeX command (times, nu, frac, …) and
the char after the command tail is a non-word char (or end) — replace the
control char with backslash + escape letter (``<TAB>imes `` ->
``\times ``). Fails forward: a real paragraph break before ``use`` is
byte-identical. Idempotent. Applied to every prose text holder; code
blocks never touched. The count lands in
``quality.verification.restored_late_backslash_commands``.
"""

import pytest

from deep_research_structured import (
    _restore_late_backslash,
    _restore_late_backslash_text,
)
from models.report_schema import BlockType, ResearchReport, ReportBlock, Span

METADATA = {
    "title": "T",
    "query": "q",
    "session_id": "s1",
    "generated_at": "2026-01-01T00:00:00Z",
}


def _counts():
    return {"restored_late_backslash_commands": 0}


def _run(text):
    counts = _counts()
    return _restore_late_backslash_text(text, counts), counts[
        "restored_late_backslash_commands"
    ]


# ---------------------------------------------------------------------------
# text-level rule
# ---------------------------------------------------------------------------


def test_real_sec3_span_tabs_restored_to_times():
    # The recovered sec3 span (task 10b502cf): 2 real TABs, 0 backslashes.
    text = (
        "producing a 160 teravoxel volume at $8\times 8\times 8$ nm "
        "isotropic resolution."
    )
    out, n = _run(text)
    assert n == 2
    assert out == (
        r"producing a 160 teravoxel volume at $8\times 8\times 8$ nm "
        "isotropic resolution."
    )
    assert "\t" not in out


def test_restored_span_wraps_to_well_formed_math():
    # After restore, the $ body is a proper balanced expression: the
    # structural gate accepts it, and the wrap pass leaves it untouched.
    from deep_research_structured import _region_malformed, _wrap_latex_in_text

    text = "volume at $8\times 8\times 8$ nm isotropic resolution."
    out, _ = _run(text)
    assert _region_malformed("8\\times 8\\times 8", False, False) is False
    wrapped, k = _wrap_latex_in_text(out)
    assert wrapped == out and k == 0  # already delimited — protected


def test_tab_between_prose_words_untouched():
    text = "the volume\twas measured twice"
    out, n = _run(text)
    assert n == 0
    assert out == text


def test_lf_before_word_is_untouched():
    # n + "use" = "nuse" is not a command; the real paragraph break stays.
    text = "first sentence\nused to be longer"
    out, n = _run(text)
    assert n == 0
    assert out == text


def test_lf_before_standalone_nu_restored():
    out, n = _run("decay rate \nu = 0.5 per second")
    assert n == 1
    assert out == r"decay rate \nu = 0.5 per second"


def test_tail_prefix_of_longer_word_untouched():
    # LF + "u" where the u starts "unit" — the matched tail "u" (from nu)
    # is a prefix of a word, not a command boundary.
    out, n = _run("each \nunit was imaged")
    assert n == 0
    assert out == "each \nunit was imaged"


def test_longest_tail_wins_over_prefix():
    # \nabla vs \nu: "abla" must match nabla, not "a" (nu)'s prefix logic.
    out, n = _run("the \nabla operator")
    assert n == 1
    assert out == r"the \nabla operator"


def test_crlf_pair_restored_and_prose_crlf_untouched():
    out, n = _run("bound \rangle closed")
    assert n == 1
    assert out == r"bound \rangle closed"
    out2, n2 = _run("line one\r\nline two")
    assert n2 == 0
    assert out2 == "line one\r\nline two"


def test_ff_frac_and_bs_bar_and_vt_vee():
    assert _run("a \frac{1}{2} share")[0] == r"a \frac{1}{2} share"
    assert _run("x \bar{y} conjugate")[0] == r"x \bar{y} conjugate"
    assert _run("p \vee q disjunction")[0] == r"p \vee q disjunction"


def test_citation_like_field_with_command_tail_restored():
    # The pass is text-agnostic: a bracketed marker carrying the same
    # artifact (tab + command tail) restores exactly the same way.
    out, n = _run("[1] \times 8 nm grid")
    assert out == r"[1] \times 8 nm grid" and n == 1


def test_digit_directly_after_tail_fails_forward():
    # The spec's boundary: the char after the matched tail must be a
    # non-word char (or end) — `times8` looks like one identifier, so a
    # bare digit keeps the control char untouched.
    out, n = _run("[1] \times8 nm grid")
    assert out == "[1] \times8 nm grid" and n == 0


def test_idempotent():
    text = "at $8\times 8\times 8$ nm resolution, again \frac{a}{b} once"
    once, n1 = _run(text)
    twice, n2 = _run(once)
    assert twice == once
    assert n1 == 3 and n2 == 0


def test_real_backslash_command_untouched():
    # A model that DID write the double backslash decodes to a real
    # `\times` — the restore must not double-escape it.
    text = r"volume at $8\times 8$ nm resolution"
    out, n = _run(text)
    assert n == 0
    assert out == text


# ---------------------------------------------------------------------------
# report-level pass
# ---------------------------------------------------------------------------


def _para(text):
    return ReportBlock(type=BlockType.paragraph, spans=[Span(text=text, citations=[])])


def _report(*blocks):
    return ResearchReport.model_validate(
        {
            "schema_version": "1.0",
            "report": {
                "metadata": METADATA,
                "sections": [
                    {
                        "id": "s1",
                        "heading": "S",
                        "blocks": [b.model_dump() for b in blocks],
                    }
                ],
                "sources": [],
            },
            "quality": {},
        }
    )


def test_report_level_restores_spans_cells_and_exec_summary():
    rep = _report(
        _para("volume at $8\times 8\times 8$ nm resolution."),
        _para("no artifacts here"),
    )
    cell = Span(text="grid \frac{a}{b} cell", citations=[])
    table = ReportBlock(
        type=BlockType.comparison_table,
        columns=["a", "b"],
        rows=[[cell, "x"]],
    )
    rep.report.sections[0].blocks.append(table)
    rep.report.executive_summary = ["scale \nu summary"]

    n = _restore_late_backslash(rep)
    assert n == 4  # 2x times + frac + nu
    assert (
        rep.report.sections[0].blocks[0].spans[0].text
        == r"volume at $8\times 8\times 8$ nm resolution."
    )
    assert rep.report.sections[0].blocks[1].spans[0].text == "no artifacts here"
    assert rep.report.sections[0].blocks[2].rows[0][0].text == r"grid \frac{a}{b} cell"
    assert rep.report.executive_summary[0] == r"scale \nu summary"


def test_report_level_skips_code_blocks():
    code = ReportBlock(type=BlockType.code_block, text="keep a real\ttab in code")
    rep = _report(code)
    assert _restore_late_backslash(rep) == 0
    assert rep.report.sections[0].blocks[0].text == "keep a real\ttab in code"


def test_never_raises_on_empty_and_weird():
    assert _restore_late_backslash_text("", _counts()) == ""
    out, _ = _run("\t\n\r\f\b\v all controls, no commands")
    assert out == "\t\n\r\f\b\v all controls, no commands"


@pytest.mark.parametrize(
    "text,expected",
    [
        # the spec's three canonical cases
        ("x\times 8", r"x\times 8"),
        ("p\nuse q", "p\nuse q"),
        ("p\nu q", r"p\nu q"),
    ],
)
def test_spec_canonical_cases(text, expected):
    assert _run(text)[0] == expected


# ---------------------------------------------------------------------------
# assemble_structured_report integration
# ---------------------------------------------------------------------------


def test_assemble_restores_real_sec3_span_and_counts():
    """The full assembly chain with the recovered sec3 span: the tabs are
    restored to a well-formed $8\times 8\times 8$ region (the wrap pass then
    protects it) and the count lands in quality.verification."""
    from models.report_schema import Section
    from deep_research_structured import assemble_structured_report

    span_text = (
        "Building a neuron-level sparse recurrent model on the MaleCNS "
        "begins with the complete synaptic connectivity graph: the fully "
        "proofread adult male CNS was imaged with seven eFIB-SEM systems "
        "over thirteen months, producing a 160 teravoxel volume at "
        "$8\times 8\times 8$ nm isotropic resolution."
    )
    # the span above carries two REAL TABS where the JSON decode consumed
    # `\t` from `\times` — the corrupted input, exactly as recovered
    section = Section(id="s3", heading="Neuron-level sparse recurrent model design",
                      blocks=[_para(span_text)])
    report = assemble_structured_report(
        sections=[section],
        registry={},
        user_query="q",
        session_id="s1",
        exec_paragraphs=[],
        verification_status={},
        title="T",
    )
    final = report.report.sections[0].blocks[0].spans[0].text
    assert "\t" not in final
    assert r"$8\times 8\times 8$" in final
    assert (
        report.quality.verification["restored_late_backslash_commands"] == 2
    )
    # the restored region must survive the wrap+heal chain byte-identical
    assert r"8\times 8\times 8" in final
    assert final.count("$8") == 1
