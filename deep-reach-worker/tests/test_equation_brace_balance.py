r"""Unit tests: equation-block brace balancing in assemble_structured_report.

Repro of real task 427f039f242340ec92f448daef400ad7: the LLM emitted an
equation block whose body carried an unmatched trailing brace
(`Q^* = \\dfrac{F}{p - c} - c}` — 2 opens, 3 closes). The worker's math
hygiene never validated raw equation-block bodies (the wrap pass corrupts
them, the heal pass bails on $-less text), so the unbalanced source
reached paperbot's KaTeX, which threw and the PDF printed the raw literal
`Q^* = \dfrac{F}{p - c} - c}` in a code box.

Fix under test: assemble skips the run-wrap pass for equation-typed block
bodies (they are intentional display math) and runs _balance_equation_bodies,
which drops unmatched CLOSING braces only.
"""

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
    _balance_equation_bodies,
    _balance_equation_braces,
    _wrap_undelimited_latex,
    assemble_structured_report,
)

# The exact body shipped by real task 427f039f.
REAL_UNBALANCED = r"Q^* = \dfrac{F}{p - c} - c}"
REAL_BALANCED = r"Q^* = \dfrac{F}{p - c} - c"


def _report_with_equation(body: str, language: str = "latex") -> ResearchReport:
    block = ReportBlock(type=BlockType.equation, text=body, language=language)
    section = Section(id="sec1", heading="Economic Viability", blocks=[block])
    return ResearchReport(
        schema_version="1.0",
        report=Report(
            metadata=Metadata(
                title="Spaceport Economics",
                query="spaceport economics",
                session_id="427f039f",
                generated_at="2025-09-07T09:43:00Z",
            ),
            executive_summary=[],
            sections=[section],
            sources=[],
        ),
        quality=QualityMetrics(),
    )


def _assemble_equation(body: str, language: str = "latex") -> ReportBlock:
    """Run the real 427f-shaped section (prose + equation + prose) through
    assemble_structured_report and return the surviving equation block."""
    prose_before = (
        "The available evidence shows that long-run profitability is driven "
        "by asset utilization, since fixed infrastructure costs are "
        "amortized across the launch schedule and the launch site."
    )
    prose_after = (
        "Here high cadence matters most, since the fixed cost base is "
        "spread over more launches and the per-unit curve flattens."
    )
    section = Section(
        id="sec1",
        heading="Economic Viability of Spaceport Operations",
        blocks=[
            ReportBlock(
                type=BlockType.paragraph, spans=[Span(text=prose_before, citations=[])]
            ),
            ReportBlock(type=BlockType.equation, text=body, language=language),
            ReportBlock(
                type=BlockType.paragraph, spans=[Span(text=prose_after, citations=[])]
            ),
        ],
    )
    rep = assemble_structured_report(
        sections=[section],
        registry={},
        user_query="spaceport economics",
        session_id="427f039f",
        exec_paragraphs=[],
        verification_status={},
        title="Spaceport Economics",
    )
    equations = [
        b
        for s in rep.report.sections
        for b in s.blocks
        if b.type == BlockType.equation
    ]
    assert len(equations) == 1, f"expected exactly one equation block, got {[b.type.value for b in section.blocks]} and {[(b.type.value, b.text[:40]) for b in rep.report.sections[0].blocks]}"
    return equations[0]


def test_real_427f_unbalanced_body_is_balanced():
    block = _assemble_equation(REAL_UNBALANCED)
    assert block.text == REAL_BALANCED
    assert block.type == BlockType.equation
    assert block.language == "latex"
    assert "$" not in block.text


def test_balanced_body_round_trips_byte_identical():
    block = _assemble_equation(REAL_BALANCED)
    assert block.text == REAL_BALANCED
    assert block.language == "latex"


def test_unmatched_opener_is_left_untouched():
    body = r"\dfrac{F"
    block = _assemble_equation(body)
    assert block.text == body  # no guessing on unclosed math


def test_non_latex_equation_language_untouched():
    body = "graph TD; A-->B; B-->C;"
    block = _assemble_equation(body, language="mermaid")
    assert block.text == body
    assert block.language == "mermaid"


def test_prose_spans_unaffected():
    prose_in = "This is the standard break-even relationship, where $Q^*$ is volume."
    prose_after = "The fixed cost base is spread over more launches and the curve flattens out."
    section = Section(
        id="sec1",
        heading="Economic Viability",
        blocks=[
            ReportBlock(
                type=BlockType.paragraph,
                spans=[Span(text=prose_in, citations=[]), Span(text=prose_after, citations=[])],
            ),
            ReportBlock(type=BlockType.equation, text=REAL_UNBALANCED, language="latex"),
        ],
    )
    rep = assemble_structured_report(
        sections=[section],
        registry={},
        user_query="spaceport economics",
        session_id="427f039f",
        exec_paragraphs=[],
        verification_status={},
        title="Spaceport Economics",
    )
    # prose block: text empty; spans keep their existing $ delimiters verbatim
    assert rep.report.sections[0].blocks[0].spans[0].text == prose_in
    assert rep.report.sections[0].blocks[0].spans[1].text == prose_after


def test_wrap_pass_skips_equation_block_bodies():
    # The run-wrap pass used to partial-wrap equation bodies in a duplicating
    # loop (Q^* = \dfrac{F}{p - c} - c  ->  ... - c - c} - c after one cycle).
    # Equation-typed block text must now bypass it entirely.
    report = _report_with_equation(REAL_BALANCED)
    changed = _wrap_undelimited_latex(report)
    assert changed == 0
    assert report.report.sections[0].blocks[0].text == REAL_BALANCED

    # ...while undelimited runs in PROSE blocks are still wrapped (no
    # regression in the pass's original job).
    prose = ReportBlock(
        type=BlockType.paragraph,
        spans=[Span(text="Energy is E = mc^2 everywhere.", citations=[])],
    )
    report.report.sections[0].blocks[0] = prose
    changed = _wrap_undelimited_latex(report)
    assert changed == 1
    assert "$" in report.report.sections[0].blocks[0].spans[0].text


def test_balance_equation_braces_helper():
    # the real 427f body
    assert _balance_equation_braces(REAL_UNBALANCED) == REAL_BALANCED
    # balanced inputs round-trip (byte-identical, incl. nested braces)
    assert _balance_equation_braces(REAL_BALANCED) == REAL_BALANCED
    assert _balance_equation_braces(r"\dfrac{F}{p - c}") == r"\dfrac{F}{p - c}"
    assert _balance_equation_braces(r"{a{b}c}") == r"{a{b}c}"
    # unmatched openers are never guessed at
    assert _balance_equation_braces(r"\dfrac{F") == r"\dfrac{F"
    assert _balance_equation_braces(r"\sum_{i=1}^{n") == r"\sum_{i=1}^{n"
    # multiple stray closers all drop
    assert _balance_equation_braces("x} y}}") == "x y"
    # text without any closer is returned untouched
    assert _balance_equation_braces("no braces at all") == "no braces at all"
    # multi-line bodies
    src = "line one}\nline two\n\\dfrac{a}{b} extra}}"
    assert _balance_equation_braces(src) == "line one\nline two\n\\dfrac{a}{b} extra"
    # never raises on adversarial input
    assert _balance_equation_braces("}}}{{{") == "{{{"


def test_balance_equation_bodies_counts_and_skips():
    report = _report_with_equation(REAL_UNBALANCED)
    assert _balance_equation_bodies(report) == 1
    assert report.report.sections[0].blocks[0].text == REAL_BALANCED
    # idempotent second run
    assert _balance_equation_bodies(report) == 0
    # non-latex language is skipped
    report2 = _report_with_equation("graph TD; A-->B};", language="mermaid")
    assert _balance_equation_bodies(report2) == 0
    assert report2.report.sections[0].blocks[0].text == "graph TD; A-->B};"
