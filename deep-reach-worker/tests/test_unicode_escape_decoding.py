r"""Unit tests: the assembly JSON-escape decoder (_decode_unicode_escapes).

Artifact under test (recovered from real task acf41000, the Langlands
"wormholes" report): the synthesis LLM call freshly emitted six literal
ASCII ``\u2014`` sequences (the model thinking "JSON unicode escape")
inside ``$…$`` math spans, meaning the em dash. Every one of them reached
KaTeX, which natively defines ``\u`` as the BREVE ACCENT
(katex/src/symbols.ts) and typeset ``\u2014`` as "2"+brevé+"014" — the
user-visible "2014 rendered as 2+bowl+014" on PDF page 11. The worker
report JSON itself carried no combining marks; the bowl was born at
render time from the ASCII escape.

Rules: (a) ``\u`` + EXACTLY 4 hex digits (case-insensitive) + a following
char that is NOT another hex digit decodes to ``chr(int(hex, 16))`` — a
5+-hex run is not a JSON escape and is left alone; ``\u{…}`` / ``\u x``
accent uses never match (TeX ``\u`` accents take a non-hex base). (b) a
math region that is a SINGLE decoded escape (whitespace aside) unwraps
its delimiters — the decoded char is prose, not math. Control chars
(C0/C1/DEL) decode to nothing. Applied to every prose text holder at
assembly; code blocks never touched. Idempotent. The count lands in
``quality.verification.decoded_unicode_escapes``.
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
    Span,
)

from deep_research_structured import (
    _decode_unicode_escapes,
    _decode_unicode_escapes_text,
    assemble_structured_report,
)

HEX = r"\\u[0-9a-fA-F]{4}"


def _decode(text: str) -> tuple[str, int]:
    counts = {"decoded_unicode_escapes": 0}
    return _decode_unicode_escapes_text(text, counts), counts["decoded_unicode_escapes"]


def _report_with(blocks: list, exec_summary: list | None = None) -> ResearchReport:
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
            sources=[],
        ),
        quality=QualityMetrics(),
    )


# ---------------------------------------------------------------------------
# (a) escape decoding: em/en dash, accents, arrow; case-insensitive hex
# ---------------------------------------------------------------------------


def test_em_dash_escape_decodes():
    out, n = _decode(r"a \u2014 b")
    assert out == "a \u2014 b"
    assert n == 1


def test_en_dash_escape_decodes():
    out, n = _decode(r"a \u2013 b")
    assert out == "a \u2013 b"
    assert n == 1


def test_accented_char_escape_decodes():
    out, n = _decode(r"caf\u00e9")
    assert out == "café"
    assert n == 1


def test_arrow_escape_decodes():
    out, n = _decode(r"x \u2194 y")
    assert out == "x ↔ y"
    assert n == 1


def test_hex_is_case_insensitive():
    out, n = _decode(r'x \u201c q \u00E9')
    assert out == 'x “ q é'
    assert n == 2


# ---------------------------------------------------------------------------
# (a) safety: 5+-hex runs, \u{} accents, \u x accents are never touched
# ---------------------------------------------------------------------------


def test_five_hex_run_untouched():
    out, n = _decode(r"run \u20149 done")
    assert out == r"run \u20149 done"
    assert n == 0


def test_eight_digit_run_untouched():
    out, n = _decode(r"run \u20142014 done")
    assert out == r"run \u20142014 done"
    assert n == 0


def test_braced_accent_untouched():
    out, n = _decode(r"accent \u{x} stays")
    assert out == r"accent \u{x} stays"
    assert n == 0


def test_space_token_accent_untouched():
    out, n = _decode(r"accent \u x stays")
    assert out == r"accent \u x stays"
    assert n == 0


def test_non_math_prose_escape_decodes():
    out, n = _decode("paid \\u2014 and left \\u2014 ok")
    assert out == "paid — and left — ok"
    assert n == 2


# ---------------------------------------------------------------------------
# (b) lone-escape math regions unwrap their delimiters
# ---------------------------------------------------------------------------


def test_inline_math_lone_escape_unwraps():
    out, n = _decode(r"$\u2014$")
    assert out == "—"
    assert n == 1


def test_display_math_lone_escape_unwraps():
    out, n = _decode(r"$$\u2014$$")
    assert out == "—"
    assert n == 1


def test_inline_lone_escape_with_inner_whitespace_unwraps():
    out, n = _decode(r"before $\u2014$ after")
    assert out == "before — after"
    assert n == 1


def test_real_math_with_escape_inside_keeps_delimiters():
    out, n = _decode(r"$a \u2014 b$")
    assert out == "$a — b$"
    assert n == 1


def test_real_math_without_escape_untouched():
    out, n = _decode(r"$E = mc^2$ and $$\int_0^1 x\,dx$$")
    assert out == r"$E = mc^2$ and $$\int_0^1 x\,dx$$"
    assert n == 0


def test_dollar_money_not_math_stays():
    out, n = _decode(r"costs $5 and $10, \u2014 marked")
    assert out == r"costs $5 and $10, — marked"
    assert n == 1  # only the prose escape decodes; no unwrapping of $5/$10


# ---------------------------------------------------------------------------
# control chars decode to nothing
# ---------------------------------------------------------------------------


def test_c0_escape_removed_space_pair_collapses():
    out, n = _decode(r"ctrl \u0000 here")
    assert out == "ctrl here"
    assert n == 1


def test_c0_escape_glued_sides_removed():
    out, n = _decode(r"ab\u0009x")
    assert out == "abx"
    assert n == 1


def test_consecutive_c0_escapes_collapse():
    out, n = _decode(r"x \u0001\u0002 y")
    assert out == "x y"
    assert n == 2


def test_lone_c0_region_unwraps_to_nothing():
    out, n = _decode(r"spaced $$\u0000$$ here")
    assert out == "spaced here"
    assert n == 1


# ---------------------------------------------------------------------------
# idempotency
# ---------------------------------------------------------------------------


def test_second_pass_is_noop():
    first, n1 = _decode(r"unrelated $\u2014$ two mouths \u00e9 \u20149")
    second, n2 = _decode(first)
    assert first == second
    assert n1 == 2
    assert n2 == 0


# ---------------------------------------------------------------------------
# report level: every text holder; code untouched; the real 2014 case
# ---------------------------------------------------------------------------


def test_report_level_decodes_all_holders():
    blocks = [
        ReportBlock(
            type=BlockType.paragraph,
            spans=[
                Span(
                    text=(
                        "shortcut between domains that look unrelated "
                        r"$\u2014$ two mouths joined by a throat."
                    ),
                    citations=[],
                ),
                Span(text=r"prose \u2194 here", citations=[]),
            ],
        ),
        ReportBlock(
            type=BlockType.ordered_list,
            items=[
                Span(
                    text=(
                        r"payoffs $\u2014$ Fermat's $\u2014$ last"
                    ),
                    citations=[],
                ),
            ],
        ),
        ReportBlock(
            type=BlockType.comparison_table,
            columns=["A", "B"],
            rows=[[Span(text=r"cell \u00e9", citations=[])]],
        ),
        ReportBlock(
            type=BlockType.equation,
            language="latex",
            text=r"E = \u2014 x^2",
        ),
        ReportBlock(
            type=BlockType.code_block,
            language="python",
            text=r's = "\u2014"',  # literal JSON-escape inside code: must survive
        ),
        ReportBlock(
            type=BlockType.heading,
            level=2,
            text=r"Heading with \u2013 dash",
        ),
    ]
    report = _report_with(blocks, exec_summary=[r"summary \u2014 mark"])

    n = _decode_unicode_escapes(report)

    # 2 (span pair) + 2 (list item) + 1 (cell) + 1 (equation body)
    # + 1 (heading) + 1 (exec) = 8; the code block escape is NOT counted
    assert n == 8

    assert (
        report.report.sections[0].blocks[0].spans[0].text
        == "shortcut between domains that look unrelated — two mouths joined by a throat."
    )
    assert report.report.sections[0].blocks[0].spans[1].text == "prose ↔ here"
    assert (
        report.report.sections[0].blocks[1].items[0].text
        == "payoffs — Fermat's — last"
    )
    assert report.report.sections[0].blocks[2].rows[0][0].text == "cell é"
    assert report.report.sections[0].blocks[3].text == "E = — x^2"
    assert report.report.sections[0].blocks[4].text == r's = "\u2014"'  # code untouched
    assert report.report.sections[0].blocks[5].text == "Heading with – dash"
    assert report.report.executive_summary[0] == "summary — mark"

    # no decodable escape remains in any prose holder
    for sec in report.report.sections:
        for b in sec.blocks:
            if b.type == BlockType.code_block:
                continue
            for t in [b.text or ""] + [s.text for s in b.spans or []] + [
                i.text for i in b.items or [] if not isinstance(i, str)
            ]:
                assert not re.search(HEX + r"(?![0-9a-fA-F])", t), t
    for p in report.report.executive_summary:
        assert not re.search(HEX + r"(?![0-9a-fA-F])", p)


def test_report_level_idempotent():
    blocks = [
        ReportBlock(
            type=BlockType.paragraph,
            spans=[Span(text=r"one $\u2014$ two \u00e9 \u20149", citations=[])],
        ),
    ]
    report = _report_with(blocks)

    first = _decode_unicode_escapes(report)
    snapshot = [s.text for s in report.report.sections[0].blocks[0].spans]
    second = _decode_unicode_escapes(report)

    assert first == 2
    assert second == 0
    assert [s.text for s in report.report.sections[0].blocks[0].spans] == snapshot


# ---------------------------------------------------------------------------
# assembly: the quality counter
# ---------------------------------------------------------------------------


def test_assembly_quality_counter():
    # a realistic-length synthesis (> 30 words, past the empty-section floor)
    # carrying the recovered artifact's lone-escape math spans
    section = Section(
        id="synthesis",
        heading="Synthesis",
        blocks=[
            ReportBlock(
                type=BlockType.paragraph,
                spans=[
                    Span(
                        text=(
                            r"In synthesis we argue that the bridge program is best read as a "
                            r"portfolio of partial isomorphisms: each correspondence succeeds "
                            r"where the local maps are well-behaved $\u2014$ functoriality "
                            r"$\u2014$ is the load-bearing virtue, and payoffs $\u2014$ reward "
                            r"exactly the well-behaved strata, which justifies sustaining the "
                            r"program overall despite its open strands."
                        ),
                        citations=[],
                    ),
                ],
            ),
        ],
    )
    report = assemble_structured_report(
        sections=[section],
        registry={},
        user_query="q",
        session_id="test",
        exec_paragraphs=[r"summary $\u2014$ marked"],
        verification_status={"confidence": "high", "coverage": "full"},
        title="T",
    )

    assert report.quality.verification["decoded_unicode_escapes"] == 4
    # the pre-existing verification keys survive alongside the new one
    assert report.quality.verification["unresolvable_citations"] == []
    assert report.quality.verification["dropped_bare_citations"] == []
    assert "normalized_citations" in report.quality.verification

    span = report.report.sections[0].blocks[0].spans[0]
    assert span.text == (
        "In synthesis we argue that the bridge program is best read as a "
        "portfolio of partial isomorphisms: each correspondence succeeds "
        "where the local maps are well-behaved — functoriality "
        "— is the load-bearing virtue, and payoffs — reward "
        "exactly the well-behaved strata, which justifies sustaining the "
        "program overall despite its open strands."
    )
    assert report.report.executive_summary[0] == "summary — marked"


# ---------------------------------------------------------------------------
# regression: the ACTUAL recovered report from task acf41000
# (/tmp/dr-2014/report.json) — the six bowl-2014 escapes, run through the
# transform with no model: all six decode to U+2014, all six $…$ wrappers
# unwrap, zero \u+4hex remain, and everything else is byte-identical.
# ---------------------------------------------------------------------------


def test_recovered_langlands_report_end_to_end_if_present():
    path = Path("/tmp/dr-2014/report.json")
    if not path.exists():
        pytest.skip("recovered artifact /tmp/dr-2014/report.json not present")

    raw = path.read_text()
    report = ResearchReport.model_validate(json.loads(raw))

    assert _decode_unicode_escapes(report) == 6  # the six synthesis \u2014

    # (1) no decodable escape remains anywhere in the envelope
    fixed = json.loads(report.model_dump_json())
    flat = json.dumps(fixed, ensure_ascii=False)
    assert not re.search(HEX + r"(?![0-9a-fA-F])", flat)

    # (2) the six em dashes are now REAL U+2014 (15 pre-existing + 6 decoded)
    assert flat.count("\u2014") == 21

    # (3) the six synthesis passages carry the unwrapped dash
    synthesis = next(
        s for s in fixed["report"]["sections"] if s.get("heading") == "Synthesis"
    )
    for expect in (
        "look unrelated — two mouths joined",
        "supplies the masonry — the Satake isomorphism",
        "transfer principle — functoriality — that actually does the work",
        "arithmetic payoffs — Fermat's last theorem",
        "low analytic rank — show that even a partially bridged",
    ):
        assert expect in json.dumps(synthesis, ensure_ascii=False)

    # (4) everything else byte-identical: the whole envelope equals the raw
    #     file with the six `$\u2014$` (JSON-escaped `\\u2014` in the file
    #     bytes) replaced by a real em dash, and nothing else
    expected = json.loads(raw.replace("$\\\\u2014$", "—"))
    assert fixed == expected
