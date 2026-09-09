r"""Unit tests: resolving bare registry keys in citation-note/callout prose.

Repro of real task 0992eb851fde4b9e8136af0f269082d9: the writer emitted a
structured ``citation_note`` (empty callout title — paperbot defaults it to
"Sources") whose prose said "All factual claims in this section are keyed to
the report source W1, which establishes…". "W1" is the worker's registry key
(the writer's evidence view shows sources as ``[W1] {title} ({url}, {date})``
so the model naturally echoes the label), but the bibliography prints
POSITIONAL ``[1]``–``[5]`` and never the key — so the label resolved to
nothing in the document.

Fix under test: _rewrite_prose_source_keys substitutes a bare registry key
(W1, D2, …) in citation_note/callout span TEXT with the source's title —
only keys present in the registry, never touching citations arrays, code,
or equation spans, and idempotent.
"""

import json
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
    Span,
)

from deep_research_structured import _rewrite_prose_source_keys, assemble_structured_report

# The recovered real report (data-recovery artifact for task 0992eb85).
REAL_REPORT_PATH = Path("/tmp/dr-src/report.json")

REAL_TITLE = "Effective field theory - Wikipedia"


def _report_with(blocks: list[ReportBlock]) -> ResearchReport:
    section = Section(id="sec1", heading="Limitations and frontiers", blocks=blocks)
    return ResearchReport(
        schema_version="1.0",
        report=Report(
            metadata=Metadata(
                title="EFT Hydrodynamics",
                query="EFT derivation of fluid dynamics",
                session_id="0992eb85",
                generated_at="2025-09-07T10:00:00Z",
            ),
            executive_summary=[],
            sections=[section],
            sources=[],
        ),
        quality=QualityMetrics(),
    )


def _registry() -> dict:
    return {
        "W1": {"kind": "web", "title": REAL_TITLE, "url": "https://en.wikipedia.org/wiki/Effective_field_theory"},
        "W2": {"kind": "web", "title": "Effective Field Theory - an overview", "url": "https://example.com/topics"},
        "D2": {"kind": "doc", "title": "Gradient Expansion Notes", "document_name": "notes.pdf"},
    }


def test_real_string_w1_replaced_title_rest_byte_identical():
    """(a) THE REAL STRING from the recovered 0992eb85 report."""
    if not REAL_REPORT_PATH.exists():
        pytest.skip(f"recovered artifact {REAL_REPORT_PATH} not present")
    data = json.loads(REAL_REPORT_PATH.read_text())
    span_text = data["report"]["sections"][6]["blocks"][17]["spans"][0]["text"]
    assert "W1" in span_text and "keyed to the report source" in span_text

    block = ReportBlock(
        type=BlockType.citation_note,
        callout_type="note",
        callout_title="",
        spans=[Span(text=span_text, citations=["1"])],
    )
    report = _report_with([block])

    rewritten = _rewrite_prose_source_keys(report, _registry())

    assert rewritten == {"spans_rewritten": 1, "keys_rewritten": 1}
    new_text = report.report.sections[0].blocks[0].spans[0].text
    expected = span_text.replace("W1", REAL_TITLE)
    assert new_text == expected  # everything else byte-identical
    assert "W1" not in new_text
    assert REAL_TITLE in new_text
    # The citations array is data, not prose — untouched.
    assert report.report.sections[0].blocks[0].spans[0].citations == ["1"]


def test_two_keys_resolved_unknown_key_and_citations_untouched():
    """(b) two known keys resolve; unknown W99 and the citations array survive."""
    text = "Claims rest on W1 and D2, plus the unresolved prior W99."
    block = ReportBlock(
        type=BlockType.citation_note,
        callout_type="note",
        spans=[Span(text=text, citations=["1", "2"])],
    )
    report = _report_with([block])

    _rewrite_prose_source_keys(report, _registry())

    span = report.report.sections[0].blocks[0].spans[0]
    assert span.text == "Claims rest on Effective field theory - Wikipedia and Gradient Expansion Notes, plus the unresolved prior W99."
    assert span.citations == ["1", "2"]  # never touched


def test_non_citation_note_prose_not_rewritten():
    """(c) scoping guard: a plain paragraph mentioning "D1" (physics prose)
    is never rewritten, even though D1 resolves in the registry."""
    text = "For a compact group the D1 representation is one-dimensional."
    block = ReportBlock(type=BlockType.paragraph, spans=[Span(text=text, citations=["D2"])])
    report = _report_with([block])

    rewritten = _rewrite_prose_source_keys(report, _registry())

    assert rewritten == {"spans_rewritten": 0, "keys_rewritten": 0}
    assert report.report.sections[0].blocks[0].spans[0].text == text


def test_idempotent():
    """(d) a second pass over already-rewritten prose changes nothing."""
    text = "All factual claims in this section are keyed to the report source W1."
    block = ReportBlock(type=BlockType.citation_note, spans=[Span(text=text, citations=[])])
    report = _report_with([block])

    first = _rewrite_prose_source_keys(report, _registry())
    after_first = report.report.sections[0].blocks[0].spans[0].text
    second = _rewrite_prose_source_keys(report, _registry())

    assert first == {"spans_rewritten": 1, "keys_rewritten": 1}
    assert second == {"spans_rewritten": 0, "keys_rewritten": 0}
    assert report.report.sections[0].blocks[0].spans[0].text == after_first


def test_key_with_blank_title_left_as_is():
    """(e) a registry entry without a usable title: the key stays verbatim."""
    registry = {"W1": {"kind": "web", "title": "  ", "url": "https://example.com"}}
    text = "keyed to the report source W1 for details."
    block = ReportBlock(type=BlockType.citation_note, spans=[Span(text=text, citations=[])])
    report = _report_with([block])

    rewritten = _rewrite_prose_source_keys(report, registry)

    assert rewritten == {"spans_rewritten": 0, "keys_rewritten": 0}
    assert report.report.sections[0].blocks[0].spans[0].text == text


def test_title_containing_other_key_does_not_cascade():
    """A key whose title contains ANOTHER resolvable key is left untouched —
    substituting it would cascade on a second pass (idempotency guard)."""
    registry = {
        "W1": {"kind": "web", "title": "Notes on D2 and friends", "url": "https://example.com"},
        "D2": {"kind": "doc", "title": "Something else entirely", "document_name": "x.pdf"},
    }
    text = "See W1 for background."
    block = ReportBlock(type=BlockType.citation_note, spans=[Span(text=text, citations=[])])
    report = _report_with([block])

    first = _rewrite_prose_source_keys(report, registry)
    second = _rewrite_prose_source_keys(report, registry)

    assert report.report.sections[0].blocks[0].spans[0].text == text
    assert first == {"spans_rewritten": 0, "keys_rewritten": 0}
    assert second == {"spans_rewritten": 0, "keys_rewritten": 0}


# ---------------------------------------------------------------------------
# Scope: BARE keys only — bracket-enclosed keys are valid citation markers
# (the renderer maps them to the deduped numeric marker) and must survive
# this function untouched. (Real task 7a111172: substituting titles into
# [D1] produced the mixed "[Title] [1]" style in callouts.)
# ---------------------------------------------------------------------------


def test_bracketed_key_at_end_untouched():
    """A [D1]-form marker at the end of a note sentence is valid and stays."""
    registry = {"D1": {"kind": "doc", "title": "EXAONE Forecast for Finance", "document_name": "exaone.pdf"}}
    text = "EXAONE Finance is a financial time series foundation model [D1]."
    block = ReportBlock(type=BlockType.citation_note, spans=[Span(text=text, citations=["1"])])
    report = _report_with([block])

    rewritten = _rewrite_prose_source_keys(report, registry)

    assert rewritten == {"spans_rewritten": 0, "keys_rewritten": 0}
    assert report.report.sections[0].blocks[0].spans[0].text == text
    assert report.report.sections[0].blocks[0].spans[0].citations == ["1"]


def test_bracketed_key_mid_sentence_untouched():
    """Mid-sentence bracketed markers (twice, here) are left exactly as-is."""
    registry = {"D1": {"kind": "doc", "title": "EXAONE Forecast for Finance", "document_name": "exaone.pdf"}}
    text = "See [D1] for the architecture, and [D1] for the benchmarks."
    block = ReportBlock(type=BlockType.callout, spans=[Span(text=text, citations=["1"])])
    report = _report_with([block])

    rewritten = _rewrite_prose_source_keys(report, registry)

    assert rewritten == {"spans_rewritten": 0, "keys_rewritten": 0}
    assert report.report.sections[0].blocks[0].spans[0].text == text


def test_doubled_bracketed_keys_untouched():
    """[D1][D1] is out of THIS function's scope (the assembly normalizer
    collapses it); the rewriter must not rewrite either copy to a title."""
    registry = {"D1": {"kind": "doc", "title": "EXAONE Forecast for Finance", "document_name": "exaone.pdf"}}
    text = "It positions itself as the first attention-free entry [D1][D1]."
    block = ReportBlock(type=BlockType.citation_note, spans=[Span(text=text, citations=["1"])])
    report = _report_with([block])

    rewritten = _rewrite_prose_source_keys(report, registry)

    assert rewritten == {"spans_rewritten": 0, "keys_rewritten": 0}
    assert report.report.sections[0].blocks[0].spans[0].text == text


def test_bare_and_bracketed_same_key_only_bare_rewritten():
    """Mixed span: the bare key resolves to the title, the bracketed copy
    (even of the same key) is untouched."""
    registry = {"W1": {"kind": "web", "title": "Effective field theory - Wikipedia", "url": "https://en.wikipedia.org/wiki/Effective_field_theory"}}
    text = "Claims rest on W1, not [W1]."
    block = ReportBlock(type=BlockType.citation_note, spans=[Span(text=text, citations=["1"])])
    report = _report_with([block])

    rewritten = _rewrite_prose_source_keys(report, registry)

    assert rewritten == {"spans_rewritten": 1, "keys_rewritten": 1}
    assert (
        report.report.sections[0].blocks[0].spans[0].text
        == "Claims rest on Effective field theory - Wikipedia, not [W1]."
    )


def test_assemble_wires_rewrite_for_real_string():
    """Integration: assemble_structured_report resolves the real 0992eb85
    citation_note end-to-end (section scope walks every section)."""
    if not REAL_REPORT_PATH.exists():
        pytest.skip(f"recovered artifact {REAL_REPORT_PATH} not present")
    data = json.loads(REAL_REPORT_PATH.read_text())
    real_section = data["report"]["sections"][6]
    section = Section.model_validate(real_section)
    assert any("W1" in (getattr(s, "text", None) or "") for b in section.blocks if b.type == "citation_note" for s in (b.spans or []))

    report = assemble_structured_report(
        sections=[section],
        registry=_registry(),
        user_query="EFT derivation of fluid dynamics",
        session_id="0992eb85",
        exec_paragraphs=[],
        verification_status={},
        title="EFT Hydrodynamics",
    )

    notes = [b for b in report.report.sections[0].blocks if b.type == "citation_note"]
    assert notes, "the citation_note must survive assembly"
    for b in notes:
        for s in b.spans or []:
            assert "W1" not in (s.text or ""), f"dangling key survived: {s.text!r}"
            assert REAL_TITLE in (s.text or "")
