r"""Unit tests: the assembly citation-mark normalizer (_normalize_citation_marks).

Artifact classes under test (recovered from real task 7a111172, the single
EXAONE-document run): adjacent doubled bracket groups ``[X][X]``, bracketed
registry titles (``[EXAONE Forecast for Finance]``), and literal empty
brackets ``[]`` written into synthesis text by the model.

Rules: (a) collapse adjacent identical bracket groups, any whitespace
between the pairs, chained; (b) strip brackets from groups whose content
equals a registered source title (case-insensitive, internal-whitespace
normalized) — non-registered brackets are never touched; (c) remove empty /
whitespace-only bracket pairs. Math segments, code and equation blocks are
never touched. Idempotent.
"""

import json
import re
from pathlib import Path

import pytest

from models.report_schema import (
    BlockType,
    Metadata,
    QualityMetrics,
    Report,
    ResearchReport,
    ReportBlock,
    Section,
    Source,
    Span,
)

from deep_research_structured import (
    _normalize_citation_mark_text,
    _normalize_citation_marks,
    _normalize_ws_key,
    assemble_structured_report,
)

EXAONE_TITLE = "EXAONE Forecast for Finance"


def _title_map(*titles: str) -> dict:
    return {_normalize_ws_key(t): t for t in titles if t}


def _counts() -> dict:
    return {
        "adjacent_duplicates_collapsed": 0,
        "title_brackets_stripped": 0,
        "empty_brackets_removed": 0,
    }


def _norm(text: str, titles=()) -> tuple[str, dict]:
    c = _counts()
    return _normalize_citation_mark_text(text, _title_map(*titles), c), c


def _report_with(blocks: list, sources: list | None = None, exec_summary: list | None = None) -> ResearchReport:
    section = Section(id="sec1", heading="Section", blocks=blocks)
    return ResearchReport(
        schema_version="1.0",
        report=Report(
            metadata=Metadata(
                title="T",
                query="q",
                session_id="test",
                generated_at="2025-09-07T10:00:00Z",
            ),
            executive_summary=list(exec_summary or []),
            sections=[section],
            sources=list(sources or []),
        ),
        quality=QualityMetrics(),
    )


def _exaone_source() -> Source:
    return Source(
        id="source-d1",
        type="report",
        title=EXAONE_TITLE,
        citation_key="D1",
    )


# ---------------------------------------------------------------------------
# (a) adjacent identical bracket groups
# ---------------------------------------------------------------------------


def test_adjacent_doubled_group_collapses():
    out, c = _norm("a [X][X] b")
    assert out == "a [X] b"
    assert c["adjacent_duplicates_collapsed"] == 1


def test_adjacent_doubled_group_whitespace_insensitive():
    out, c = _norm("a [X] [X] b")
    assert out == "a [X] b"
    assert c["adjacent_duplicates_collapsed"] == 1


def test_chained_tripled_group_collapses_to_one():
    out, c = _norm("see [X][X][X].")
    assert out == "see [X]."
    assert c["adjacent_duplicates_collapsed"] == 2


def test_different_adjacent_groups_untouched():
    out, c = _norm("a [A][B] b")
    assert out == "a [A][B] b"
    assert c == _counts()


def test_non_adjacent_repeats_untouched():
    out, c = _norm("[A] middle [A]")
    assert out == "[A] middle [A]"
    assert c == _counts()


def test_doubled_key_groups_collapse_to_single_key():
    out, c = _norm("Most TSFMs rely on self-attention [D1][D1].")
    assert out == "Most TSFMs rely on self-attention [D1]."
    assert c["adjacent_duplicates_collapsed"] == 1


# ---------------------------------------------------------------------------
# (b) bracketed registered titles → bare mentions
# ---------------------------------------------------------------------------


def test_title_brackets_stripped_canonical_restored():
    out, c = _norm(f"[EXAONE Forecast for Finance] leads", (EXAONE_TITLE,))
    assert out == f"{EXAONE_TITLE} leads"
    assert c["title_brackets_stripped"] == 1


def test_title_match_case_and_whitespace_insensitive():
    out, c = _norm("[exaone   forecast  for  finance] the model", (EXAONE_TITLE,))
    assert out == f"{EXAONE_TITLE} the model"
    assert c["title_brackets_stripped"] == 1


def test_non_registered_brackets_never_touched():
    out, c = _norm("See [arXiv:2401.12345] and [Some Random Title] here.", (EXAONE_TITLE,))
    assert out == "See [arXiv:2401.12345] and [Some Random Title] here."
    assert c == _counts()


def test_doubled_title_collapses_then_debrackets():
    out, c = _norm(
        "It uses an attention-free architecture "
        f"[{EXAONE_TITLE}][{EXAONE_TITLE}]"
        f" and emits forecasts [{EXAONE_TITLE}].",
        (EXAONE_TITLE,),
    )
    assert out == (
        "It uses an attention-free architecture "
        f"{EXAONE_TITLE} and emits forecasts {EXAONE_TITLE}."
    )
    assert c["adjacent_duplicates_collapsed"] == 1
    assert c["title_brackets_stripped"] == 2


# ---------------------------------------------------------------------------
# (c) empty bracket pairs
# ---------------------------------------------------------------------------


def test_trailing_empty_brackets_removed():
    out, c = _norm("Three field-level implications follow from combining these sections. []")
    assert out == "Three field-level implications follow from combining these sections."
    assert c["empty_brackets_removed"] == 1


def test_whitespace_only_brackets_removed():
    out, c = _norm("a [ ] b")
    assert out == "a b"
    assert c["empty_brackets_removed"] == 1


def test_leading_empty_brackets_removed():
    out, c = _norm("[] it begins")
    assert out == "it begins"
    assert c["empty_brackets_removed"] == 1


# ---------------------------------------------------------------------------
# safety: math segments, physics prose, unregistered content
# ---------------------------------------------------------------------------


def test_inline_and_display_math_protected():
    out, c = _norm("The $[A][A]$ model and \\([B][B]\\) remain.", ("A",))
    assert out == "The $[A][A]$ model and \\([B][B]\\) remain."
    assert c == _counts()


def test_physics_prose_with_keys_untouched():
    """No rule fires on a bare key + a non-title bracketed key: byte-identical."""
    out, c = _norm("The D1 representation [D2] is one-dimensional.", (EXAONE_TITLE,))
    assert out == "The D1 representation [D2] is one-dimensional."
    assert c == _counts()


def test_empty_group_with_content_is_not_empty():
    out, c = _norm("a [1] b")  # a cited marker: content "1" is not empty
    assert out == "a [1] b"
    assert c == _counts()


# ---------------------------------------------------------------------------
# report-level: every text holder + exec summary; code/equation skipped
# ---------------------------------------------------------------------------


def _all_texts(report: ResearchReport) -> list[str]:
    texts: list[str] = []
    for sec in report.report.sections:
        for b in sec.blocks:
            texts.append(b.text or "")
            texts.extend(s.text for s in b.spans or [])
            texts.extend(i.text for i in b.items or [])
            for row in b.rows or []:
                texts.extend(c.text for c in row if isinstance(c, Span))
    texts.extend(p for p in report.report.executive_summary if isinstance(p, str))
    return texts


def test_report_level_coverage_and_counts():
    blocks = [
        ReportBlock(
            type=BlockType.heading,
            level=3,
            text=f"Notes on [{EXAONE_TITLE}][{EXAONE_TITLE}]",
        ),
        ReportBlock(
            type=BlockType.paragraph,
            spans=[Span(text="Body claim [D1][D1] and more []", citations=["1"])],
        ),
        ReportBlock(
            type=BlockType.callout,
            callout_type="note",
            spans=[Span(text=f"A callout fact [{EXAONE_TITLE}].", citations=["1"])],
        ),
        ReportBlock(
            type=BlockType.citation_note,
            spans=[Span(text="A note fact [W1][W1] here.", citations=["1"])],
        ),
        ReportBlock(
            type=BlockType.unordered_list,
            items=[Span(text="A list fact. []", citations=[])],
        ),
        ReportBlock(
            type=BlockType.comparison_table,
            columns=["Dim", "EXAONE"],
            rows=[[Span(text="Arch [D1]", citations=["1"]), Span(text="attention-free", citations=[])]],
        ),
        ReportBlock(
            type=BlockType.code_block,
            language="python",
            text="x = [A][A]  # must survive",
        ),
        ReportBlock(
            type=BlockType.equation,
            language="latex",
            text="E = mc^2, with [A][A] in the braces",
        ),
    ]
    report = _report_with(
        blocks,
        sources=[_exaone_source(), Source(id="source-w1", type="webpage", title="Exaone Web Page", citation_key="W1")],
        exec_summary=[f"The model was released [{EXAONE_TITLE}] and [] later."],
    )

    counts = _normalize_citation_marks(report)

    # (a) heading doubled title, body [D1][D1], note [W1][W1]
    assert counts["adjacent_duplicates_collapsed"] == 3
    # (b) heading title (post-collapse), callout title, exec summary title
    assert counts["title_brackets_stripped"] == 3
    # (c) body [], list item [], exec summary []
    assert counts["empty_brackets_removed"] == 3

    texts = _all_texts(report)
    assert "Notes on EXAONE Forecast for Finance" in texts  # heading debracketed
    assert "Body claim [D1] and more" in texts  # body: key collapsed, [] gone
    assert "A callout fact EXAONE Forecast for Finance." in texts
    assert "A note fact [W1] here." in texts  # [W1] is a KEY, not a title: stays
    assert "A list fact." in texts
    assert "The model was released EXAONE Forecast for Finance and later." in texts
    assert "x = [A][A]  # must survive" in texts  # code untouched
    assert "E = mc^2, with [A][A] in the braces" in texts  # equation untouched


def test_report_level_idempotent():
    blocks = [
        ReportBlock(
            type=BlockType.callout,
            spans=[
                Span(
                    text=f"fact [{EXAONE_TITLE}][{EXAONE_TITLE}] tail []",
                    citations=["1"],
                )
            ],
        ),
    ]
    report = _report_with(blocks, sources=[_exaone_source()])

    first = _normalize_citation_marks(report)
    after_first = {id(s): s.text for b in report.report.sections[0].blocks for s in b.spans}
    second = _normalize_citation_marks(report)
    after_second = {id(s): s.text for b in report.report.sections[0].blocks for s in b.spans}

    assert first == {
        "adjacent_duplicates_collapsed": 1,
        "title_brackets_stripped": 1,
        "empty_brackets_removed": 1,
    }
    assert second == _counts()
    assert after_first == after_second


# ---------------------------------------------------------------------------
# (c) quality: the four counters on a synthetic assembly
# ---------------------------------------------------------------------------


def test_assembly_quality_normalized_citations_counters():
    callout = ReportBlock(
        type=BlockType.callout,
        callout_type="note",
        spans=[
            Span(
                text=(
                    f"EXAONE Finance is a foundation model from LG AI Research [{EXAONE_TITLE}]. "
                    f"It is attention-free [{EXAONE_TITLE}][{EXAONE_TITLE}] and keyless per W1 in the registry. "
                    "The paper reports strong multi-quantile calibration on financial benchmarks."
                ),
                citations=["D1", "W1"],
            )
        ],
    )
    synthesis = ReportBlock(
        type=BlockType.paragraph,
        spans=[
            Span(
                text=(
                    "Three field-level implications follow from combining these sections. [] "
                    "The combined picture is that the model trades depth of domain tailoring "
                    "for breadth of series coverage, and its reported strengths rest on the "
                    "benchmarks it was pretrained against."
                ),
                citations=[],
            )
        ],
    )
    section = Section(id="purpose", heading="Purpose", blocks=[callout])
    synth_section = Section(id="synthesis", heading="Synthesis", blocks=[synthesis])

    report = assemble_structured_report(
        sections=[section, synth_section],
        registry={
            "D1": {"kind": "doc", "title": EXAONE_TITLE, "document_name": "exaone.pdf"},
            "W1": {"kind": "web", "title": "Exaone Web Page", "url": "https://example.com/t"},
        },
        user_query="q",
        session_id="test",
        exec_paragraphs=[f"The model was released [{EXAONE_TITLE}] with [] appended."],
        verification_status={"confidence": "medium", "coverage": "moderate"},
        title="T",
    )

    vc = report.quality.verification["normalized_citations"]
    assert vc == {
        "bare_key_rewrites": 1,  # the bare W1 in the callout
        "adjacent_duplicates_collapsed": 1,  # the doubled title
        "title_brackets_stripped": 3,  # callout single + callout collapsed + exec summary
        "empty_brackets_removed": 2,  # synthesis + exec summary
    }
    # the pre-existing verification keys survive alongside the new one
    assert report.quality.verification["unresolvable_citations"] == []
    assert report.quality.verification["dropped_bare_citations"] == []
    # callout text shape: bare titles, no brackets left around them, no []
    text = report.report.sections[0].blocks[0].spans[0].text
    assert f"[{EXAONE_TITLE}]" not in text and "[]" not in text
    assert text.count(EXAONE_TITLE) == 2


# ---------------------------------------------------------------------------
# (d) regression: the ACTUAL recovered EXAONE spans from task 7a111172
#     (/tmp/dr-exaone/report.json — quoted verbatim)
# ---------------------------------------------------------------------------

REAL_DOUBLED_CALLOUT_SPAN = (
    "It uses an attention-free architecture [EXAONE Forecast for Finance]"
    "[EXAONE Forecast for Finance], targets financial rather than general-domain data "
    "[EXAONE Forecast for Finance][EXAONE Forecast for Finance], and emits "
    "probabilistic multi-quantile forecasts [EXAONE Forecast for Finance]"
    "[EXAONE Forecast for Finance]."
)
REAL_SINGLE_TITLE_CALLOUT_SPAN = (
    "EXAONE Finance is a financial time series foundation model from LG AI Research "
    "[EXAONE Forecast for Finance]."
)
REAL_DOUBLED_BODY_SPAN = (
    "Most contemporary TSFMs are developed for general-domain time series and rely on "
    "self-attention backbones whose computational cost grows quadratically with both "
    "sequence length and variate count [D1][D1]."
)
REAL_EMPTY_SYNTHESIS_SPAN = (
    "Three field-level implications follow from combining these sections. []"
)


def test_recovered_exaone_spans_normalize_to_expected_text():
    callout = ReportBlock(
        type=BlockType.callout,
        callout_type="note",
        spans=[
            Span(text=REAL_SINGLE_TITLE_CALLOUT_SPAN, citations=["1"]),
            Span(text=REAL_DOUBLED_CALLOUT_SPAN, citations=["1"]),
        ],
    )
    body = ReportBlock(
        type=BlockType.paragraph,
        spans=[Span(text=REAL_DOUBLED_BODY_SPAN, citations=["1"])],
    )
    synthesis = ReportBlock(
        type=BlockType.paragraph,
        spans=[Span(text=REAL_EMPTY_SYNTHESIS_SPAN, citations=[])],
    )
    purpose = Section(id="purpose", heading="Purpose and scope", blocks=[body, callout])
    synth = Section(id="synthesis", heading="Synthesis", blocks=[synthesis])
    report = ResearchReport(
        schema_version="1.0",
        report=Report(
            metadata=Metadata(
                title="EXAONE Financial Model: Uses and Applications",
                query="Describe the potential uses and applications of the EXAONE financial model",
                session_id="df1b3aa4-d681-46af-a3cb-5f6627b0c073",
                generated_at="2026-09-09T02:20:13Z",
            ),
            executive_summary=[],
            sections=[purpose, synth],
            sources=[_exaone_source()],
        ),
        quality=QualityMetrics(),
    )

    counts = _normalize_citation_marks(report)

    assert counts == {
        "adjacent_duplicates_collapsed": 4,  # 3 callout pairs + 1 body pair
        "title_brackets_stripped": 4,  # 1 single + 3 collapsed
        "empty_brackets_removed": 1,
    }

    spans = {id(s): s for b in purpose.blocks for s in b.spans}
    synth_span = synth.blocks[0].spans[0]
    texts = {s.text for s in spans.values()}
    assert (
        "EXAONE Finance is a financial time series foundation model from LG AI Research "
        "EXAONE Forecast for Finance." in texts
    )
    assert (
        "It uses an attention-free architecture EXAONE Forecast for Finance, targets "
        "financial rather than general-domain data EXAONE Forecast for Finance, and "
        "emits probabilistic multi-quantile forecasts EXAONE Forecast for Finance."
        in texts
    )
    assert (
        "Most contemporary TSFMs are developed for general-domain time series and rely "
        "on self-attention backbones whose computational cost grows quadratically with "
        "both sequence length and variate count [D1]." in texts
    )
    assert synth_span.text == "Three field-level implications follow from combining these sections."
    # citations arrays are data: untouched
    assert synth_span.citations == []
    assert all(s.citations == ["1"] for s in spans.values())


def test_recovered_exaone_report_file_end_to_end_if_present():
    """Optional: run the real recovered envelope through the normalizer."""
    path = Path("/tmp/dr-exaone/report.json")
    if not path.exists():
        pytest.skip("recovered artifact /tmp/dr-exaone/report.json not present")
    report = ResearchReport.model_validate(json.loads(path.read_text()))
    counts = _normalize_citation_marks(report)
    # the recovered report carried 16 [D1][D1] + 3 doubled-title pairs and 2 []
    assert counts["adjacent_duplicates_collapsed"] == 19
    # 14 title groups: 3 pairs collapse to singles, so 11 remain to strip
    assert counts["title_brackets_stripped"] == 11
    assert counts["empty_brackets_removed"] == 2
    for sec in report.report.sections:
        for b in sec.blocks:
            for s in b.spans or []:
                assert "[]" not in s.text
                assert "[EXAONE Forecast for Finance]" not in s.text
                assert not re.search(r"\[([^\[\]]*)\]\s*\[\1\]", s.text)
