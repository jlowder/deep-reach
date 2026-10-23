"""Unit tests: the degenerate callout/citation-note strip and the
title-less evidence fallback.

Two deterministic defenses against the empty-evidence-list artifact (a
writer that receives zero evidence still runs its "All claims in this
section are supported by the provided evidence sources" boilerplate, and
joining zero names leaves punctuation residue such as "sources,,,, and."):

- _strip_degenerate_callouts drops a callout/citation_note block whose
  (whitespace-normalized) prose is such a residue — and never real prose.
  Its signatures treat the terminal period as optional (",,," / a bare or
  dotted colon tail / trailing ", and"), because assembly runs the strip
  BEFORE the terminal-period citation lint.
- Assembly runs the strip BEFORE the empty-section guard, so a section
  reduced to a bare heading by the strip gets the not-generated
  placeholder (a >=30-word degenerate callout must not clear the guard
  first and then vanish).
- _domain_of gives a title-less web result a display name (the URL domain)
  so the writer never lists an empty source.

No LLM calls; everything is synthetic.
"""

from memory.helpers import _domain_of, render_evidence_text
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

from deep_research_structured import (
    _DEGENERATE_CALLOUT_RE,
    _NOT_GENERATED_TEXT,
    _apply_empty_section_guards,
    _strip_degenerate_callouts,
    assemble_structured_report,
)


# ---------------------------------------------------------------------------
# Builders
# ---------------------------------------------------------------------------

def _span(text: str, cits=()) -> Span:
    return Span(text=text, citations=list(cits))


def _callout(*spans: Span, text: str = "") -> ReportBlock:
    return ReportBlock(type=BlockType.callout, text=text, spans=list(spans))


def _note(*spans: Span, text: str = "") -> ReportBlock:
    return ReportBlock(type=BlockType.citation_note, text=text, spans=list(spans))


def _para(*spans: Span) -> ReportBlock:
    return ReportBlock(type=BlockType.paragraph, spans=list(spans))


def _heading(level: int, text: str) -> ReportBlock:
    return ReportBlock(type=BlockType.heading, level=level, text=text)


def _report(*blocks: ReportBlock) -> ResearchReport:
    return ResearchReport(
        schema_version="1.0",
        report=Report(
            metadata=Metadata(
                title="T",
                query="q",
                session_id="s1",
                generated_at="2026-01-01T00:00:00Z",
            ),
            sections=[Section(heading="Findings", blocks=list(blocks))],
            sources=[],
        ),
        quality=QualityMetrics(),
    )


def _blocks(report: ResearchReport) -> list[ReportBlock]:
    return report.report.sections[0].blocks


# ---------------------------------------------------------------------------
# _strip_degenerate_callouts
# ---------------------------------------------------------------------------

def test_double_comma_and_trailing_and_stripped():
    deg = (
        "All claims in this section are supported by the provided "
        "evidence sources,,,, and."
    )
    rep = _report(_callout(_span(deg)), _para(_span("Real substance remains.")))
    assert _strip_degenerate_callouts(rep) == 1
    assert [b.type for b in _blocks(rep)] == [BlockType.paragraph]


def test_single_comma_and_dot_stripped():
    deg = "All claims in this section are supported by the sources, and ."
    rep = _report(_callout(_span(deg)))
    assert _strip_degenerate_callouts(rep) == 1
    assert _blocks(rep) == []


def test_empty_list_after_colon_stripped():
    rep = _report(_note(_span("Evidence supporting the above: .")))
    assert _strip_degenerate_callouts(rep) == 1
    assert _blocks(rep) == []


def test_normal_callout_kept():
    rep = _report(
        _callout(_span("Note: the results are significant. They generalize.")),
    )
    assert _strip_degenerate_callouts(rep) == 0
    assert len(_blocks(rep)) == 1


def test_mid_prose_colon_dot_kept():
    # "time: .5" mid-sense is real prose; only the tail form is degenerate.
    rep = _report(
        _callout(
            _span("Convergence took time: .5 seconds on the A100, then plateaued.")
        )
    )
    assert _strip_degenerate_callouts(rep) == 0
    assert len(_blocks(rep)) == 1


def test_mid_text_and_dot_kept():
    # The terminal-period lint can leave "X, and." before a following
    # sentence; only the trailing form is the zero-member artifact.
    rep = _report(_callout(_span("X is true, and."), _span("Y is also true.")))
    assert _strip_degenerate_callouts(rep) == 0
    assert len(_blocks(rep)) == 1


def test_citation_note_scoped_paragraph_untouched():
    rep = _report(_note(_span("Sources: .")), _para(_span("x,, y. Substance here.")))
    assert _strip_degenerate_callouts(rep) == 1
    assert [b.type for b in _blocks(rep)] == [BlockType.paragraph]


def test_block_text_used_when_no_spans():
    rep = _report(
        _note(text="Cited works: ."),
        _note(text="The model was trained on 2025 data."),
    )
    assert _strip_degenerate_callouts(rep) == 1
    assert [b.text for b in _blocks(rep)] == ["The model was trained on 2025 data."]


def test_idempotent():
    deg = "supported by the provided sources,,,, and."
    rep = _report(_callout(_span(deg)))
    assert _strip_degenerate_callouts(rep) == 1
    assert _strip_degenerate_callouts(rep) == 0


def test_never_raises_on_garbage_sections():
    rep = _report(_callout(_span("fine note")))
    rep.report.sections[0] = "garbage"  # type: ignore[assignment]
    assert _strip_degenerate_callouts(rep) == 0  # no exception


# ---------------------------------------------------------------------------
# assemble_structured_report wiring
# ---------------------------------------------------------------------------

def test_assemble_strips_and_counts():
    deg = (
        "All claims in this section are supported by the provided "
        "evidence sources,,,, and."
    )
    # Paragraph padded so the section clears the 30-word empty-section guard.
    body = (
        "The field converges on the central point that scaling alone does not buy "
        "reasoning, and the evidence from interpretability work suggests that "
        "structure matters more than parameter counts do."
    )
    rep = assemble_structured_report(
        sections=[
            Section(
                heading="Findings",
                blocks=[_callout(_span(deg)), _para(_span(body))],
            )
        ],
        registry={},
        user_query="q",
        session_id="s1",
        exec_paragraphs=["Ex."],
        verification_status={"confidence": "high"},
        title="T",
    )
    assert [b.type for b in rep.report.sections[0].blocks] == [BlockType.paragraph]
    assert rep.quality.verification["degenerate_callouts_stripped"] == 1
    # Sibling verification keys are intact.
    assert rep.quality.verification["normalized_citations"]
    assert rep.quality.verification["decoded_unicode_escapes"] == 0


# ---------------------------------------------------------------------------
# _DEGENERATE_CALLOUT_RE: order-independence (the strip now runs before the
# terminal-period citation lint, so the trailing period must be optional)
# ---------------------------------------------------------------------------

def test_regex_matches_bare_trailing_colon():
    # No terminal period yet — the lint that adds it runs AFTER the strip.
    assert _DEGENERATE_CALLOUT_RE.search("Sources:")


def test_regex_matches_colon_with_terminal_period():
    assert _DEGENERATE_CALLOUT_RE.search("Sources: .")


def test_regex_matches_trailing_and_without_period():
    assert _DEGENERATE_CALLOUT_RE.search("Sources: a, b, and")


def test_regex_still_matches_original_artifact_shapes():
    # The reported ",,,, and." residue and its no-period variant.
    assert _DEGENERATE_CALLOUT_RE.search("evidence sources,,,, and.")
    assert _DEGENERATE_CALLOUT_RE.search("evidence sources,,,, and")


def test_regex_rejects_well_formed_list():
    assert not _DEGENERATE_CALLOUT_RE.search("Sources: a, b, and c.")


# ---------------------------------------------------------------------------
# Strip-vs-empty-guard ordering (the regression)
# ---------------------------------------------------------------------------

def test_guard_fires_on_heading_only_section():
    # A [heading-only] section is below the 30-word threshold, so the guard
    # replaces its blocks with the not-generated placeholder (heading kept).
    rep = _report(_heading(3, "Subtopic"))
    gaps = _apply_empty_section_guards(rep)
    assert gaps == ["not_generated: Findings"]
    assert [b.type for b in _blocks(rep)] == [BlockType.paragraph]
    assert _NOT_GENERATED_TEXT in _blocks(rep)[0].spans[0].text


def test_assemble_degenerate_callout_reduced_to_heading_gets_placeholder():
    """Regression: a section whose only content is a >=30-word degenerate
    callout. Before the reorder the guard ran FIRST, saw 30+ words, and
    passed; the later strip then left [heading] and the section shipped
    empty — no placeholder, no gap. After the reorder the strip runs
    before the guard, so the guard sees the heading-only section and
    replaces its blocks with the not-generated placeholder."""
    deg = (
        "All claims in this section are supported by the provided evidence "
        "sources,,,, and the interpretability literature on scaling limits, "
        "data quality, architecture choices, evaluation protocols, and the "
        "remaining secondary findings listed in the works cited above."
    )
    assert len(deg.split()) >= 30  # pre-reorder: would clear the guard
    rep = assemble_structured_report(
        sections=[
            Section(
                heading="Technological Advances",
                blocks=[_heading(3, "Subtopic One"), _callout(_span(deg))],
            )
        ],
        registry={},
        user_query="q",
        session_id="s1",
        exec_paragraphs=["Ex."],
        verification_status={"confidence": "medium"},
        title="T",
    )
    sec = rep.report.sections[0]
    assert sec.heading == "Technological Advances"  # heading preserved
    assert [b.type for b in sec.blocks] == [BlockType.paragraph]  # callout gone
    assert _NOT_GENERATED_TEXT in sec.blocks[0].spans[0].text
    assert rep.quality.verification["degenerate_callouts_stripped"] == 1
    assert any(
        g.startswith("not_generated:")
        for g in rep.quality.verification.get("gaps") or []
    )


def test_assemble_normal_callout_survives_strip_and_guard():
    """Non-regression: a substantive callout (no degenerate signature) is
    kept, the section stays non-empty, and nothing is recorded as a gap."""
    body = (
        "The interpretability literature converges on the view that scaling "
        "alone does not buy reasoning: the evidence favors data quality and "
        "evaluation design as the dominant levers, and practitioners should "
        "weight both when choosing a training recipe for new models."
    )
    rep = assemble_structured_report(
        sections=[
            Section(
                heading="Interpretability",
                blocks=[_heading(3, "Subtopic"), _callout(_span(body))],
            )
        ],
        registry={},
        user_query="q",
        session_id="s1",
        exec_paragraphs=["Ex."],
        verification_status={"confidence": "medium"},
        title="T",
    )
    sec = rep.report.sections[0]
    assert [b.type for b in sec.blocks] == [
        BlockType.heading,
        BlockType.callout,
    ]
    callout_words = len(" ".join(s.text for s in sec.blocks[1].spans).split())
    assert callout_words >= 30  # callout intact (not stripped)
    assert rep.quality.verification["degenerate_callouts_stripped"] == 0
    assert not any(
        g.startswith("not_generated:")
        for g in rep.quality.verification.get("gaps") or []
    )


# ---------------------------------------------------------------------------
# _domain_of + render_evidence_text fallback
# ---------------------------------------------------------------------------

def test_domain_of_variants():
    assert _domain_of("https://www.arxiv.org/abs/123") == "arxiv.org"
    assert _domain_of("http://example.com/page?q=1") == "example.com"
    assert _domain_of("") == ""
    assert _domain_of(None) == ""
    # Schemeless URL: urlparse sees no netloc -> stay as before.
    assert _domain_of("arxiv.org/abs/123") == ""


def test_web_title_falls_back_to_domain():
    text = render_evidence_text(
        [],
        [
            {
                "title": "",
                "url": "https://www.arxiv.org/abs/123",
                "content": "Transformer architecture content.",
                "published_date": "2025-01-01",
            }
        ],
        {},
        {"https://www.arxiv.org/abs/123": "W1"},
    )
    assert "[W1] arxiv.org (https://www.arxiv.org/abs/123, 2025-01-01)" in text
    assert "  (https" not in text  # no empty-name header


def test_web_title_present_unchanged():
    text = render_evidence_text(
        [],
        [
            {
                "title": "GP Survey",
                "url": "https://www.example.org/survey",
                "content": "Survey content.",
                "published_date": "2025-01-15",
            }
        ],
        {},
        {"https://www.example.org/survey": "W1"},
    )
    assert "[W1] GP Survey (https://www.example.org/survey, 2025-01-15)" in text


def test_doc_title_falls_back_to_filename():
    # A doc whose title is empty keeps its name via the existing join — a
    # keyed chunk always carries at least one identity field, so no change
    # was needed on the doc path (regression guard for that behavior).
    text = render_evidence_text(
        [
            {
                "document_name": "paper.pdf",
                "document_title": "",
                "page_number": 3,
                "chunk_id": "c1",
                "content": "Manual content about representation.",
            }
        ],
        [],
        {"c1": "D1"},
        {},
    )
    assert "[D1] paper.pdf p. 3" in text
