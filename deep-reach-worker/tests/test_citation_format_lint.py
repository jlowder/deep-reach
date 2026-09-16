r"""Unit tests: the assembly citation-format linter (_lint_citation_format).

Artifact classes under test (recovered from real task 3803fb3c — luminous
black-hole objects; /tmp/dr-lint/report.json):

  R1 key_groups_removed         — spans whose text carries a literal
                                  [W#]/[D#] key group AND a non-empty
                                  citations array (the renderer would
                                  print the numbers AND the keys).
  R2 terminal_periods_inserted  — "…powered by gravity" [2] followed by
                                  "Gas falling…" — missing terminal
                                  period on a cited sentence-final span.
  R3 repeated_cites_collapsed   — one long sentence split into clause
                                  spans, each repeating the same [1].

Rules are guarded and fail-safe (unsure = leave untouched), idempotent,
and must not alter span text beyond the three targeted operations.
"""

import json
import re

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

from deep_research_structured import _lint_citation_format, assemble_structured_report


# ---------------------------------------------------------------------------
# Builders
# ---------------------------------------------------------------------------

def _span(text: str, cits) -> Span:
    return Span(text=text, citations=list(cits))


def _para(*spans: Span) -> ReportBlock:
    return ReportBlock(type=BlockType.paragraph, spans=list(spans))


def _source(key: str) -> Source:
    return Source(
        id=f"source-{key.lower()}",
        type="webpage",
        title=f"Source {key}",
        URL=f"https://example.com/{key.lower()}",
        citation_key=key,
    )


def _report(*sections: Section, sources=None, exec_summary=None) -> ResearchReport:
    return ResearchReport(
        schema_version="1.0",
        report=Report(
            metadata=Metadata(
                title="T",
                query="q",
                session_id="s1",
                generated_at="2026-01-01T00:00:00Z",
            ),
            executive_summary=list(exec_summary or []),
            sections=list(sections),
            sources=list(sources or []),
        ),
        quality=QualityMetrics(),
    )


def _lint(report: ResearchReport, registry: dict = None) -> dict:
    return _lint_citation_format(report, registry)


def _dump(report: ResearchReport) -> str:
    return json.dumps(report.model_dump(), sort_keys=True)


def _spans(rep: ResearchReport, si: int = 0, bi: int = 0) -> list:
    return rep.report.sections[si].blocks[bi].spans


# ---------------------------------------------------------------------------
# R1 — redundant key groups
# ---------------------------------------------------------------------------

class TestR1KeyGroups:
    def test_single_key_group_stripped_when_array_nonempty(self):
        rep = _report(
            Section(id="s", heading="S", blocks=[_para(_span("Budget set by [W20].", ["1"]))]),
            sources=[_source("W20")],
        )
        counts = _lint(rep)
        span = _spans(rep)[0]
        assert span.text == "Budget set by."
        assert span.citations == ["1"]
        assert counts == {
            "key_groups_removed": 1,
            "terminal_periods_inserted": 0,
            "repeated_cites_collapsed": 0,
        }

    def test_multi_key_group_stripped(self):
        rep = _report(
            Section(
                id="s",
                heading="S",
                blocks=[_para(_span("Light and wind [W2, W5, W17].", ["2", "3", "4"]))],
            ),
            sources=[_source("W2"), _source("W5"), _source("W17")],
        )
        counts = _lint(rep)
        span = _spans(rep)[0]
        assert span.text == "Light and wind."
        assert span.citations == ["2", "3", "4"]
        assert counts["key_groups_removed"] == 1

    def test_group_left_when_array_empty(self):
        rep = _report(
            Section(
                id="s",
                heading="S",
                blocks=[_para(_span("See [W20] for the budget.", []))],
            ),
            sources=[_source("W20")],
        )
        before = _spans(rep)[0].text
        assert _lint(rep)["key_groups_removed"] == 0
        assert _spans(rep)[0].text == before

    def test_unregistered_key_group_left(self):
        rep = _report(
            Section(
                id="s",
                heading="S",
                blocks=[_para(_span("See [W99] for the budget.", ["1"]))],
            ),
            sources=[_source("W20")],
        )
        before = _spans(rep)[0].text
        assert _lint(rep)["key_groups_removed"] == 0
        assert _spans(rep)[0].text == before

    def test_non_key_brackets_and_math_untouched(self):
        rep = _report(
            Section(
                id="s",
                heading="S",
                blocks=[
                    _para(
                        _span("ArXiv note [arXiv:2401.12345] here.", ["1"]),
                        _span("The bound $L = L_{Edd} [W20]$ is tight.", ["1"]),
                    )
                ],
            ),
            sources=[_source("W20")],
        )
        counts = _lint(rep)
        texts = [s.text for s in _spans(rep)]
        assert texts[0].endswith("[arXiv:2401.12345] here.")
        assert texts[1] == "The bound $L = L_{Edd} [W20]$ is tight."
        assert counts == {
            "key_groups_removed": 0,
            "terminal_periods_inserted": 0,
            "repeated_cites_collapsed": 0,
        }


# ---------------------------------------------------------------------------
# R2 — missing terminal periods
# ---------------------------------------------------------------------------

class TestR2TerminalPeriods:
    def test_gravity_gas_inserts(self):
        rep = _report(
            Section(
                id="s",
                heading="S",
                blocks=[
                    _para(
                        _span("…appears to be powered by gravity", ["2"]),
                        _span("Gas falling towards the central black hole heats up.", []),
                    )
                ],
            ),
            sources=[_source("W2")],
        )
        counts = _lint(rep)
        spans = _spans(rep)
        assert spans[0].text == "…appears to be powered by gravity."
        assert spans[0].citations == ["2"]
        assert spans[1].text == "Gas falling towards the central black hole heats up."
        assert counts["terminal_periods_inserted"] == 1

    def test_figure_exception_word_not_inserted(self):
        rep = _report(
            Section(
                id="s",
                heading="S",
                blocks=[
                    _para(
                        _span("The survey found a red object", ["1"]),
                        _span("Figure 3 shows the spectrum.", []),
                    )
                ],
            ),
            sources=[_source("W1")],
        )
        assert _lint(rep)["terminal_periods_inserted"] == 0
        assert _spans(rep)[0].text == "The survey found a red object"

    def test_lowercase_next_not_inserted(self):
        rep = _report(
            Section(
                id="s",
                heading="S",
                blocks=[
                    _para(
                        _span("The survey found a red object", ["1"]),
                        _span("which then cools quickly.", []),
                    )
                ],
            ),
            sources=[_source("W1")],
        )
        assert _lint(rep)["terminal_periods_inserted"] == 0
        assert _spans(rep)[0].text == "The survey found a red object"

    def test_already_punctuated_unchanged(self):
        rep = _report(
            Section(
                id="s",
                heading="S",
                blocks=[
                    _para(
                        _span("The survey found a red object.", ["1"]),
                        _span("It is compact.", []),
                    )
                ],
            ),
            sources=[_source("W1")],
        )
        assert _lint(rep)["terminal_periods_inserted"] == 0
        assert _spans(rep)[0].text == "The survey found a red object."

    def test_paragraph_boundary_never_inserted(self):
        s1 = Section(id="a", heading="A", blocks=[_para(_span("It ends on a bare word", ["1"]))])
        s2 = Section(
            id="b",
            heading="B",
            blocks=[_para(_span("A new paragraph opens here.", []))],
        )
        rep = _report(s1, s2, sources=[_source("W1")])
        assert _lint(rep)["terminal_periods_inserted"] == 0
        assert rep.report.sections[0].blocks[0].spans[0].text == "It ends on a bare word"

    def test_uncited_word_end_unchanged(self):
        rep = _report(
            Section(
                id="s",
                heading="S",
                blocks=[
                    _para(
                        _span("A purely connective clause", []),
                        _span("continues the argument.", []),
                    )
                ],
            )
        )
        assert _lint(rep)["terminal_periods_inserted"] == 0
        assert _spans(rep)[0].text == "A purely connective clause"

    def test_key_group_end_with_empty_array_gets_period(self):
        rep = _report(
            Section(
                id="s",
                heading="S",
                blocks=[
                    _para(
                        _span("The budget argument rests on [W99]", []),
                        _span("It is contested.", []),
                    )
                ],
            )
        )
        counts = _lint(rep)
        assert _spans(rep)[0].text == "The budget argument rests on [W99]."
        assert counts["terminal_periods_inserted"] == 1


# ---------------------------------------------------------------------------
# R3 — repeated clause citations
# ---------------------------------------------------------------------------

class TestR3RepeatedCites:
    def test_clause_run_collapses_to_last(self):
        rep = _report(
            Section(
                id="s",
                heading="S",
                blocks=[
                    _para(
                        _span("an object identified with the James Webb Space Telescope", ["1"]),
                        _span("which looks remarkably like a star", ["1"]),
                        _span("yet shines far too brightly", ["1"]),
                    )
                ],
            ),
            sources=[_source("W1")],
        )
        counts = _lint(rep)
        spans = _spans(rep)
        assert [s.citations for s in spans] == [[], [], ["1"]]
        assert counts["repeated_cites_collapsed"] == 2
        # text is never touched by R3
        assert spans[0].text == "an object identified with the James Webb Space Telescope"

    def test_sentence_run_all_kept(self):
        rep = _report(
            Section(
                id="s",
                heading="S",
                blocks=[
                    _para(
                        _span("First claim.", ["1"]),
                        _span("Second claim.", ["1"]),
                        _span("Third claim.", ["1"]),
                    )
                ],
            ),
            sources=[_source("W1")],
        )
        assert _lint(rep)["repeated_cites_collapsed"] == 0
        assert [s.citations for s in _spans(rep)] == [["1"], ["1"], ["1"]]

    def test_boundary_breaks_run(self):
        rep = _report(
            Section(
                id="s",
                heading="S",
                blocks=[
                    _para(
                        _span("an opening clause", ["1"]),
                        _span("a complete sentence.", ["1"]),
                        _span("another clause", ["1"]),
                        _span("the final clause", ["1"]),
                    )
                ],
            ),
            sources=[_source("W1")],
        )
        counts = _lint(rep)
        assert [s.citations for s in _spans(rep)] == [[], ["1"], [], ["1"]]
        assert counts["repeated_cites_collapsed"] == 2

    def test_different_cite_sets_never_collapsed(self):
        rep = _report(
            Section(
                id="s",
                heading="S",
                blocks=[
                    _para(
                        _span("a clause citing one source", ["1"]),
                        _span("another citing a different one", ["2"]),
                    )
                ],
            ),
            sources=[_source("W1"), _source("W2")],
        )
        assert _lint(rep)["repeated_cites_collapsed"] == 0
        assert [s.citations for s in _spans(rep)] == [["1"], ["2"]]


# ---------------------------------------------------------------------------
# Idempotence + non-interference
# ---------------------------------------------------------------------------

class TestIdempotence:
    def _kitchen_sink(self) -> ResearchReport:
        s0 = Section(
            id="s0",
            heading="Defining properties",
            blocks=[
                _para(
                    _span("A star-like object", ["1"]),
                    _span("which is far too bright", ["1"]),
                    _span("so it must be a black hole", ["1"]),
                ),
                _para(
                    _span("The budget is powered by gravity", ["1"]),
                    _span("Gas then falls in.", []),
                    _span("The budget rests on [W1, W2].", ["1", "2"]),
                ),
            ],
        )
        return _report(s0, sources=[_source("W1"), _source("W2")])

    def test_second_run_changes_nothing(self):
        rep = self._kitchen_sink()
        first = _lint(rep)
        mid = _dump(rep)
        second = _lint(rep)
        assert first["key_groups_removed"] == 1
        assert first["terminal_periods_inserted"] == 1
        assert first["repeated_cites_collapsed"] == 2
        assert second == {
            "key_groups_removed": 0,
            "terminal_periods_inserted": 0,
            "repeated_cites_collapsed": 0,
        }
        assert _dump(rep) == mid


class TestNonInterference:
    def test_other_text_holders_untouched(self):
        heading = ReportBlock(type=BlockType.heading, level=3, text="A heading [W1]")
        code = ReportBlock(type=BlockType.code_block, language="python", text="x = 1  # [W1]")
        equation = ReportBlock(type=BlockType.equation, text="L = L_{Edd} [W1]", language="latex")
        callout = ReportBlock(
            type=BlockType.callout,
            callout_type="note",
            spans=[_span("A title [EXAONE Forecast for Finance] here.", ["1"])],
        )
        rep = _report(
            Section(id="s", heading="S", blocks=[heading, code, equation, callout]),
            sources=[_source("W1")],
            exec_summary=["Summary with [W1] and [] marks."],
        )
        before = {
            "heading": heading.text,
            "code": code.text,
            "equation": equation.text,
            "exec": rep.report.executive_summary[0],
        }
        _lint(rep)
        assert heading.text == before["heading"]
        assert code.text == before["code"]
        assert equation.text == before["equation"]
        assert rep.report.executive_summary[0] == before["exec"]
        # the callout span's TITLE group is the normalizer's job, not the linter's
        assert callout.spans[0].text == "A title [EXAONE Forecast for Finance] here."
        assert callout.spans[0].citations == ["1"]


# ---------------------------------------------------------------------------
# The ACTUAL recovered spans from task 3803fb3c (/tmp/dr-lint/report.json)
# ---------------------------------------------------------------------------

# S0 "Defining properties and classification" — the seven class-A spans live
# in these blocks; arrays are the worker-remapped positions, text is
# model-raw (quoted verbatim from the recovered report).
S0_PARAS = [
    [
        ("The target class is exemplified by an object identified with the James Webb Space Telescope and located only 660 million years after the Big Bang", ["1"]),
        ("which looks remarkably like a star yet shines with roughly 100 billion times the Sun's luminosity", ["1"]),
        ("a brightness far too large to be powered by normal stellar fusion", ["1"]),
        ("and best explained as a growing black hole wrapped in an extraordinarily dense hydrogen envelope spanning roughly the size of the object", ["1"]),
    ],
    [
        ("A defining property is therefore not colour alone but the mismatch between a stellar disguise and a non-stellar energy budget: a normal star pays for its light through nuclear fusion, whereas this object appears to be powered by gravity", ["2"]),
        ("Gas falling towards the central black hole heats up and releases energy before crossing the event horizon", ["2"]),
        ("The black hole itself remains dark, and the surrounding hydrogen then transforms the escaping radiation into the faint, red-appearing signal that mimics a star", ["2"]),
    ],
    [
        ("Among JWST discoveries such hydrogen-rich, black-holed targets are classified as little red dots (LRDs)", ["3"]),
        ("a class of small, red-tinted astronomical objects with unexpected characteristics observed using the James Webb Space Telescope", ["3"]),
        ("LRDs were first reported in a preprint in June 2023 and first published in a peer-reviewed scientific journal in March 2024", ["3"]),
        ("and they appear to have existed between 0.6 and 1.6 billion years after the Big Bang, i.e. 13.2 to 12.2 billion years ago", ["3"]),
    ],
    [
        ("An additional defining property is their host context: JWST observations reveal extended components of little red dots in the rest-frame optical", ["4"]),
        ("showing that these early objects are embedded in extended host galaxies around which the black hole grew together with its host", ["4"]),
        ("which places them at the faint, compact end of the active-nucleus population rather than in the bright quasar regime", []),
    ],
    [
        ("The general framework for interpreting such an object examines the electromagnetic, optical, and energetic properties of astrophysical black holes and their surrounding matter", ["5"]),
        ("so the class sits between a stellar-mimicking point source and a low-luminosity active galactic nucleus, with its classification fixed by the combined test that a luminosity of billions of suns exceeds the fusion limit while a red, star-like appearance conceals a dark central engine", ["1", "2"]),
    ],
]

# Synthesis block 0 + block 2 — class-B key groups, verbatim.
SYNTH_PARAS = [
    [
        ("The target class sits where several independent lines of argument partly agree and partly pull apart. ", []),
        ("The Defining properties and classification section fixes the object as a growing black hole swathed in an extraordinarily dense hydrogen envelope, whose roughly 100-billion-solar-luminosity power budget cannot be paid by normal stellar fusion [W20].", ["1"]),
        ("Its identity is therefore defined not by colour but by a mismatch: a stellar disguise masking a gravity-powered energy budget.", []),
    ],
    [
        ("Accretion-powered luminosity models supply the conversion that Defining properties and classification assumes, showing how a thin-disk state, a hard-X-ray thick flow, and super-Eddington, photon-trapped outflows each partition accreted rest mass into light and mechanical wind [W2, W5, W17].", ["6", "7", "10"]),
        ("When the mass flux greatly exceeds the Eddington rate, photons are trapped and advected inward, so the object can keep shining near or above a billion-solar luminosity while its neutral hydrogen envelope outlasts a naïve budget argument [W17].", ["10"]),
    ],
]


def _s0_section() -> Section:
    return Section(
        id="defining-properties",
        heading="Defining properties and classification",
        blocks=[
            _para(*[Span(text=t, citations=list(c)) for t, c in pairs]) for pairs in S0_PARAS
        ],
    )


def _synth_section() -> Section:
    return Section(
        id="synthesis",
        heading="Synthesis",
        blocks=[
            _para(*[Span(text=t, citations=list(c)) for t, c in pairs]) for pairs in SYNTH_PARAS
        ],
    )


class TestRecoveredRealPatterns:
    def test_s0_terminal_periods_and_repeated_cites(self):
        rep = _report(
            _s0_section(),
            sources=[_source(k) for k in ("W20", "W12", "W29", "W10", "W31")],
        )
        counts = _lint(rep)
        b0, b2, b4, b5, b7 = rep.report.sections[0].blocks
        # R2 — exactly the recoverable in-paragraph boundaries (B2 ×2, B4 ×1)
        assert counts["terminal_periods_inserted"] == 3
        assert b2.spans[0].text.endswith("powered by gravity.")
        assert b2.spans[1].text.endswith("event horizon.")
        assert b2.spans[2].text.endswith("mimics a star")  # paragraph-final: untouched
        assert b4.spans[0].text.endswith("(LRDs)")  # next span lowercase: untouched
        assert b4.spans[1].text.endswith("Space Telescope.")  # next 'LRDs' is a sentence
        assert b4.spans[2].text.endswith("March 2024")  # next 'and they' lowercase
        # R3 — 3 (para 0) + 2 (LRDs para) + 1 (host-context para) clause cites
        assert counts["repeated_cites_collapsed"] == 6
        assert [s.citations for s in b0.spans] == [[], [], [], ["1"]]
        assert [s.citations for s in b4.spans] == [[], ["3"], [], ["3"]]
        assert [s.citations for s in b5.spans] == [[], ["4"], []]
        # R1 — no key groups in S0
        assert counts["key_groups_removed"] == 0

    def test_synthesis_key_groups_stripped(self):
        rep = _report(
            _synth_section(),
            sources=[_source(k) for k in ("W20", "W2", "W5", "W17")],
        )
        counts = _lint(rep)
        assert counts["key_groups_removed"] == 3
        assert counts["terminal_periods_inserted"] == 0  # all end in '.' already
        assert counts["repeated_cites_collapsed"] == 0  # distinct cite sets
        b0 = rep.report.sections[0].blocks[0].spans
        b1 = rep.report.sections[0].blocks[1].spans
        assert b0[1].text.endswith("normal stellar fusion.")
        assert "[W20]" not in b0[1].text
        assert b0[1].citations == ["1"]
        assert b1[0].text.endswith("mechanical wind.")
        assert "[W2, W5, W17]" not in b1[0].text
        assert b1[0].citations == ["6", "7", "10"]
        assert b1[1].text.endswith("naïve budget argument.")
        assert b1[1].citations == ["10"]

    def test_idempotent_on_real_patterns(self):
        rep = _report(
            _s0_section(),
            _synth_section(),
            sources=[_source(k) for k in ("W20", "W12", "W29", "W10", "W31", "W2", "W5", "W17")],
        )
        first = _lint(rep)
        mid = _dump(rep)
        second = _lint(rep)
        assert first == {
            "key_groups_removed": 3,
            "terminal_periods_inserted": 3,
            "repeated_cites_collapsed": 6,
        }
        assert second == {
            "key_groups_removed": 0,
            "terminal_periods_inserted": 0,
            "repeated_cites_collapsed": 0,
        }
        assert _dump(rep) == mid


# ---------------------------------------------------------------------------
# Assembly-level: counters surface in quality.verification
# ---------------------------------------------------------------------------

WEB = {
    "W20": {"kind": "web", "title": "JWST finds star-like object", "url": "https://example.com/w20", "published_date": "2025"},
    "W2": {"kind": "web", "title": "Accretion-powered luminosity models", "url": "https://example.com/w2"},
    "W5": {"kind": "web", "title": "Thin-disk states", "url": "https://example.com/w5"},
    "W17": {"kind": "web", "title": "Photon-trapped outflows", "url": "https://example.com/w17"},
}

_KEY_OF = {"1": "W20", "6": "W2", "7": "W5", "10": "W17"}


class TestAssemblyCounters:
    def test_real_shapes_through_assembly(self):
        # Model-shaped input: key arrays in the cites, key groups in the
        # synthesis text (exactly what the writer/synthesis prompts emit).
        s0 = _s0_section()
        for bi, block in enumerate(s0.blocks):
            for si, sp in enumerate(block.spans):
                if sp.citations:
                    sp.citations = (
                        ["W20", "W2"] if (bi == 4 and si == 1) else ["W20"]
                    )
        synth = _synth_section()
        for block in synth.blocks:
            for sp in block.spans:
                sp.citations = [_KEY_OF[c] for c in sp.citations if c in _KEY_OF]

        rep = assemble_structured_report(
            sections=[s0, synth],
            registry=WEB,
            user_query="luminous black hole objects",
            session_id="3803fb3c",
            exec_paragraphs=["The class is real and measurable."],
            verification_status={"confidence": "medium", "coverage": "moderate"},
            title="Theoretical Models for Luminous Black-Hole-Centered Objects",
        )

        vc = rep.quality.verification["normalized_citations"]
        assert vc["key_groups_removed"] == 3
        assert vc["terminal_periods_inserted"] == 3
        assert vc["repeated_cites_collapsed"] == 6
        # pre-existing counters present alongside the new ones
        assert set(vc) == {
            "bare_key_rewrites",
            "adjacent_duplicates_collapsed",
            "title_brackets_stripped",
            "empty_brackets_removed",
            "key_groups_removed",
            "terminal_periods_inserted",
            "repeated_cites_collapsed",
        }
        # no key group survives in any prose span
        for section in rep.report.sections:
            for block in section.blocks:
                for sp in block.spans or []:
                    assert not re.search(r"\[[WD]\d+(?:\s*,\s*[WD]\d+)*\]", sp.text or "")
        # the recovered double-group span is single-cited
        s7s0 = rep.report.sections[1].blocks[1].spans[0]
        assert s7s0.text.endswith("mechanical wind.")
        assert s7s0.citations == ["2", "3", "4"]
