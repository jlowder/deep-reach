/**
 * Per-block-type HTML renderers.
 *
 * Every user-provided string (text, captions, cells, titles, sources,
 * metadata) is HTML-escaped. Citation markers are already stripped upstream
 * (see citations.ts); escaping happens on the clean text here.
 */
import {
  type Block,
  type DocumentModel,
  type ListItem,
  type Source,
  type Span,
  type TableCell,
} from "../document.js";
import { citationSup, CITATION_MARKER_RE } from "../citations.js";
import { renderMath, splitMath, stripMathDelimiters, _stripDollarDelimiters, balanceBraces } from "./math.js";

/** Escape a string for safe use in an HTML text node. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escape a string for safe use inside a double-quoted HTML attribute. */
export function escapeAttr(s: string): string {
  return escapeHtml(s);
}

/** True for URLs we are willing to emit as a real href. */
function isSafeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Flush renderer-side warnings (math fallbacks, skipped figures, ...).
 * Empty entries are aggregation placeholders (see aggregatePeriodWarnings).
 */
function reportWarnings(warnings: readonly string[], opts: BlockRenderOptions): void {
  for (const w of warnings) if (w !== "") opts.onWarning?.(w);
}

/**
 * First-word heads that legitimately start the next segment without a period
 * after the prior one: cross-references and honorifics ("Figure 2 shows", "a
 * NASA survey", "Dr. Smith"). Inserting a period before them would create a
 * false sentence boundary (worker R2's exception set; compared against the
 * next segment's first word, trailing dots dropped, casefolded).
 */
const PERIOD_FIRST_WORD_EXCEPTIONS = new Set([
  "figure", "table", "fig", "eq", "section", "appendix", "vol", "no",
  "dr", "mr", "mrs", "st", "us", "uk", "eu", "nasa",
  "e.g", "i.e", "eg", "ie", "etc", "min", "max", "ref", "src", "p", "pp", "h", "k",
]);

/**
 * True when a segment ends a sentence that is missing its terminal period
 * on plain-text grounds: it ends in a letter/digit (not . ! ? : ; or a
 * closing quote) — the worker's `_ends_plain_word`.
 */
function endsInPlainWord(text: string): boolean {
  const t = text.trim();
  return t !== "" && /[\p{L}\p{N}]/u.test(t[t.length - 1]);
}

/**
 * True when a segment starts a new sentence: an uppercase letter whose first
 * word is not one of the cross-reference / honorific heads above (the
 * worker's `_next_starts_new_sentence`).
 */
function startsNewSentence(text: string): boolean {
  const next = text.trim();
  if (next === "") return false;
  if (!/^\p{Lu}/u.test(next)) return false;
  const m = /^([A-Za-z]+(?:\.[A-Za-z]+)*)/.exec(next);
  if (m === null) return false;
  return !PERIOD_FIRST_WORD_EXCEPTIONS.has(m[1]!.replace(/\.+$/, "").toLowerCase());
}

/**
 * True when a text segment ends a sentence that is missing its terminal
 * period: it ends in a plain letter/digit and the next segment in the same
 * paragraph starts a new sentence. The renderer uses this to append the
 * period before the citation sup ("gravity [2]. Gas", not "gravity [2] Gas").
 */
export function needsTerminalPeriod(text: string, nextText: string): boolean {
  return endsInPlainWord(text) && startsNewSentence(nextText);
}

/** Per-event marker; the block renderer aggregates it into one entry. */
const PERIOD_INSERTED_MARK = "citations: inserted a missing terminal period";

/**
 * Collapse the per-event missing-period markers into a single aggregated
 * entry ("citations: inserted N missing terminal period(s)") — the same
 * one-entry-per-event-type pattern the resolver warnings use.
 */
function aggregatePeriodWarnings(warnings: string[]): void {
  let n = 0;
  for (const w of warnings) if (w === PERIOD_INSERTED_MARK) n += 1;
  if (n === 0) return;
  const aggregated = `citations: inserted ${n} missing terminal period(s)`;
  let first = true;
  for (let i = 0; i < warnings.length; i += 1) {
    if (warnings[i] !== PERIOD_INSERTED_MARK) continue;
    warnings[i] = first ? aggregated : "";
    first = false;
  }
}

/**
 * Render cited text (escaped text + math groups + citation sup). Math is
 * extracted first via splitMath: text segments are escaped, math groups are
 * typeset by renderMath (invalid TeX -> visible fallback + warning). The
 * terminal-punct rule (applied to the whole text when math is absent, to the
 * trailing text segment when it is present) orders the sup as `word [4,5].`,
 * never `word.[4,5]`: one space before the sup, the mark after it. The space
 * the marker strip in citations.ts consumed is re-inserted here; any other
 * trailing space before the mark is dropped (also normalizes "word ." ->
 * "word."). Without a citation the text just normalizes to "word."; a span
 * ending in a math group has no terminal punct (the formula is
 * self-contained) and the sup, if any, follows it.
 *
 * The missing-period repair (worker R2 mirror) is NOT done here: it must run
 * on the span list BEFORE the repeated-cite collapse (worker order R2 -> R3),
 * because a repaired span is terminal and therefore must not join a clause
 * run. See applyTerminalPeriodRepairs.
 */
function renderCitedText(text: string, positions: readonly number[], warnings: string[]): string {
  const raw = text.trim();
  const sup = citationSup(positions);
  const segments = splitMath(raw);

  // Empty / zero-width input (e.g. a cell whose text normalized to ""):
  // splitMath yields zero segmentS, and the trailing-segment index below
  // would read `undefined.kind`. Render empty: an empty cell stays an
  // empty cell.
  if (raw === "" || segments.length === 0) return "";

  if (segments.length === 1 && segments[0].kind === "text") {
    // No math markers: whole-text punct rule (unchanged legacy behavior).
    const m = raw.match(/^(.*?)([.!?]+)$/s);
    if (m) {
      const base = m[1].replace(/\s+$/, "");
      const punct = m[2];
      if (sup) return (base ? escapeHtml(base) + " " : " ") + sup + escapeHtml(punct);
      return escapeHtml(base + punct);
    }
    return escapeHtml(raw) + sup;
  }

  // Math present: render segment by segment; text segments are escaped.
  // The trailing-punct rule applies only to a trailing TEXT segment — a
  // span ending in a math group has no terminal punct (the formula is
  // self-contained); the sup, if any, follows the trailing group.
  let out = "";
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (seg.kind === "math") {
      out += renderMath(seg.tex, seg.display, warnings, "inline");
      continue;
    }
    if (i < segments.length - 1) {
      out += escapeHtml(seg.text);
      continue;
    }
    const m = seg.text.match(/^(.*?)([.!?]+)$/s);
    if (m) {
      const base = m[1].replace(/\s+$/, "");
      const punct = m[2];
      if (sup) out += (base ? escapeHtml(base) + " " : " ") + sup + escapeHtml(punct);
      else out += escapeHtml(base + punct);
    } else {
      out += escapeHtml(seg.text);
    }
  }
  if (segments[segments.length - 1].kind === "math" && sup !== "") out += sup;
  return out;
}

/** Render one span: see renderCitedText for the citation ordering rules. */
function renderSpan(span: Span, warnings: string[]): string {
  return renderCitedText(span.text, span.sourcePositions, warnings);
}

/**
 * Inline math for a flat prose string with no citations — the same shared
 * path the cited paragraph rendering uses: prose segments are HTML-escaped,
 * `$…$` / `\(…\)` groups are typeset by renderMath (the `_isWellFormedMath`
 * gate degrades malformed groups to plain text silently), everything else
 * unchanged. For math-free input this is byte-identical to `escapeHtml`.
 */
export function renderMathText(text: string, warnings: string[]): string {
  return renderCitedText(text, [], warnings);
}

/**
 * True when a span's trimmed text should receive a leading space in
 * joinSpans: it starts with a letter/digit, or it opens a math delimiter
 * (`$`, `$$`, `\(`, `\[`). The producer emits each inline formula as a
 * standalone span with the inter-word space at the span edge; renderCitedText
 * trims those edges, so without the math case a math span would glue to the
 * preceding word ("…form$\dot{x}$"). Punctuation-initial spans (".", ",")
 * still glue directly — the terminal-punct behavior is preserved.
 */
function startsWithMathOrWord(t: string): boolean {
  return (
    /^[\p{L}\p{N}]/u.test(t) ||
    /^\$\$/.test(t) ||
    /^\$(?!\$)/.test(t) ||
    /^\\\(/.test(t) ||
    /^\\\[/.test(t)
  );
}

/**
 * True when a span's text ends in a citation key group (single key or
 * multi-key group) — the worker's second "why repair" condition: a span
 * whose only trailing citation is a (kept, unresolvable) key group still
 * ends a sentence and gets the period.
 */
function endsKeyGroup(text: string): boolean {
  const t = text.trim();
  return t !== "" && /\[(?:[WD]\d+(?:\s*,\s*[WD]\d+)*)\]$/.test(t);
}

/**
 * Missing-terminal-period repair (worker R2 mirror), applied to a prose span
 * list BEFORE rendering and — crucially — before the repeated-cite collapse
 * (worker order: R2 then R3, so a repaired span is terminal and cannot join
 * a clause run). A span that (a) ends in a plain letter/digit (not . ! ? : ;
 * or a closing quote), (b) carries a citation (non-empty sourcePositions) or
 * ends in a key group, and (c) is followed in the same paragraph by a span
 * that starts a new sentence (uppercase, non-exception first word) gets a
 * terminal "." appended to its text; the established sup-before-period
 * ordering then yields "gravity [2].". Never at a paragraph end (no next
 * span), never for an uncited span with no trailing key group. Returns fresh
 * span objects; per-event warnings use PERIOD_INSERTED_MARK (aggregated by
 * the caller).
 */
export function applyTerminalPeriodRepairs(spans: Span[], warnings: string[]): Span[] {
  return spans.map((s, i) => {
    const hasNext = i + 1 < spans.length;
    if (!hasNext) return s;
    if (s.sourcePositions.length === 0 && !endsKeyGroup(s.text)) return s;
    const due =
      (endsInPlainWord(s.text) || endsKeyGroup(s.text)) && startsNewSentence(spans[i + 1].text);
    if (!due) return s;
    warnings.push(PERIOD_INSERTED_MARK);
    return { ...s, text: s.text + "." };
  });
}

/**
 * True when a span's text ends a sentence: last char is a terminal mark
 * (. ! ? : ;), or a closing quote that a terminal mark precedes
 * ("done.") — the worker's `_ends_terminal`.
 */
function endsTerminal(text: string): boolean {
  const t = text.trim();
  if (t === "") return false;
  if (/[.!?;]/.test(t[t.length - 1])) return true;
  return /[\"'\u201d\u2019]/.test(t[t.length - 1]) && /[.!?;]/.test(t[t.length - 2]);
}

/**
 * Repeated clause-cite collapse (worker R3 mirror, same algorithm): within
 * one prose block (paragraph/quote/callout), consecutive spans sharing the
 * IDENTICAL non-empty citation set form one over-fragmented logical sentence
 * (the model re-attached the same citation to every clause) — the renderer
 * would otherwise print "[1]" after each clause. The same-cite run extends
 * across terminal spans too; at every span that ends a sentence (or at the
 * run's end), every earlier span of the trailing clause segment is cleared
 * (its sup is not printed) while the sentence-final span keeps its
 * citation. Distinct sentences that legitimately re-cite the same source
 * therefore keep both sups. List items and table cells are out of scope
 * (the producer fragments prose spans, not cells). Returns fresh span
 * objects; the input model is not mutated.
 */
export function collapseRepeatedClauseCites(
  spans: Span[],
): { spans: Span[]; suppressed: number } {
  const out: Span[] = spans.map((s) => ({ ...s, sourcePositions: [...s.sourcePositions] }));
  let suppressed = 0;
  const n = out.length;
  let i = 0;
  while (i < n) {
    if (out[i].sourcePositions.length === 0) {
      i += 1;
      continue;
    }
    const sig = JSON.stringify(out[i].sourcePositions);
    let j = i;
    while (j + 1 < n && JSON.stringify(out[j + 1].sourcePositions) === sig) {
      j += 1;
    }
    if (j > i) {
      let segStart = i;
      for (let k = i; k <= j; k += 1) {
        const isEnd = k === j || endsTerminal(out[k].text);
        if (!isEnd) continue;
        let allClause = true;
        for (let x = segStart; x < k; x += 1) {
          if (endsTerminal(out[x].text)) {
            allClause = false;
            break;
          }
        }
        if (k - segStart + 1 >= 2 && allClause) {
          for (let x = segStart; x < k; x += 1) {
            out[x].sourcePositions = [];
            suppressed += 1;
          }
        }
        segStart = k + 1;
      }
    }
    i = j + 1;
  }
  return { spans: out, suppressed };
}

/**
 * Join span texts for a paragraph/quote: a single space is inserted before a
 * span only when its trimmed text starts with a letter, digit, or math
 * delimiter (see startsWithMathOrWord); spans starting with other
 * punctuation (e.g. a lone ".") glue directly to the prior span.
 */
function joinSpans(spans: Span[], warnings: string[]): string {
  let out = "";
  for (const span of spans) {
    if (out !== "" && startsWithMathOrWord(span.text.trim())) out += " ";
    out += renderSpan(span, warnings);
  }
  return out;
}

/**
 * How a callout span joins the paragraph being built (callout case):
 * `null` -> new <p>; `" "` -> append with one space; `""` -> append glued.
 * A span whose trimmed text is only citation markers continues with no
 * space (mirrors the paragraph marker-only glue rule); otherwise it
 * continues only when its first remaining char is a Unicode lowercase
 * letter — the producer splits sentences into spans mid-sentence, and the
 * continuation span starts lowercase. Capitals/digits/symbols start a new
 * <p>. (citation_note does NOT use this: its spans are deliberate separate
 * source lines, one <p> each.)
 */
function continuesPrevious(text: string): " " | "" | null {
  const rest = text
    .trim()
    .replace(new RegExp(`^(?:\\s*${CITATION_MARKER_RE.source})+`, "i"), "")
    .trim();
  if (rest === "") return "";
  return /^\p{Ll}/u.test(rest) ? " " : null;
}

function renderListItem(item: ListItem, warnings: string[]): string {
  return `<li>${renderCitedText(item.text, item.sourcePositions, warnings)}</li>`;
}

function renderTableCell(cell: TableCell, warnings: string[]): string {
  return `<td>${renderCitedText(cell.text, cell.sourcePositions, warnings)}</td>`;
}

export interface BlockRenderOptions {
  /** Called once per duplicate/unknown-ish anomaly, if any. */
  onWarning?: (w: string) => void;
}

export function renderBlock(block: Block, opts: BlockRenderOptions = {}): string {
  switch (block.type) {
    case "heading": {
      const tag = block.level === 2 ? "h2" : "h3";
      return `<${tag}>${escapeHtml(block.text)}</${tag}>`;
    }

    case "paragraph": {
      const warnings: string[] = [];
      // Worker assembly order: R2 (period repair) then R3 (clause-run
      // collapse) — a repaired span is terminal, so it must not join a run.
      const repaired = applyTerminalPeriodRepairs(block.spans, warnings);
      const { spans, suppressed } = collapseRepeatedClauseCites(repaired);
      if (suppressed > 0) {
        warnings.push(`citations: suppressed ${suppressed} repeated clause citation(s)`);
      }
      const html = `<p>${joinSpans(spans, warnings)}</p>`;
      aggregatePeriodWarnings(warnings);
      reportWarnings(warnings, opts);
      return html;
    }

    case "quote": {
      const warnings: string[] = [];
      const repaired = applyTerminalPeriodRepairs(block.spans, warnings);
      const { spans, suppressed } = collapseRepeatedClauseCites(repaired);
      if (suppressed > 0) {
        warnings.push(`citations: suppressed ${suppressed} repeated clause citation(s)`);
      }
      const html = `<div class="quote">${joinSpans(spans, warnings)}</div>`;
      aggregatePeriodWarnings(warnings);
      reportWarnings(warnings, opts);
      return html;
    }

    case "callout": {
      const warnings: string[] = [];
      const title = block.calloutTitle !== "" ? block.calloutTitle : "Note";
      // The producer splits a sentence into spans ("...open problems" [41]
      // + "and call for ..." [43]); a span that continues the previous one
      // joins the last <p> instead of breaking the line mid-sentence.
      // Same worker order as the paragraph case: R2 then R3.
      const repaired = applyTerminalPeriodRepairs(block.spans, warnings);
      const { spans, suppressed } = collapseRepeatedClauseCites(repaired);
      if (suppressed > 0) {
        warnings.push(`citations: suppressed ${suppressed} repeated clause citation(s)`);
      }
      const paras: string[] = [];
      for (let i = 0; i < spans.length; i += 1) {
        const s = spans[i];
        const rendered = renderSpan(s, warnings);
        if (paras.length > 0) {
          const sep = continuesPrevious(s.text);
          if (sep !== null) {
            paras[paras.length - 1] += sep + rendered;
            continue;
          }
        }
        paras.push(rendered);
      }
      const body = paras
        .filter((p) => p !== "")
        .map((p) => `<p>${p}</p>`)
        .join("");
      const html = `<div class="callout ${block.calloutType}"><span class="callout-title">${escapeHtml(
        title,
      )}</span>${body}</div>`;
      aggregatePeriodWarnings(warnings);
      reportWarnings(warnings, opts);
      return html;
    }

    case "citation_note": {
      // Source note: callout styling, verbatim prose (no citation sups).
      const warnings: string[] = [];
      const title = block.calloutTitle !== "" ? block.calloutTitle : "Sources";
      const body = block.spans
        .map((s) => `<p>${renderSpan(s, warnings)}</p>`)
        .join("");
      const html = `<div class="callout note"><span class="callout-title">${escapeHtml(title)}</span>${body}</div>`;
      reportWarnings(warnings, opts);
      return html;
    }

    case "comparison_table": {
      const parts: string[] = [];
      if (block.caption !== "") {
        parts.push(`<div class="table-caption">${escapeHtml(block.caption)}</div>`);
      }
      const warnings: string[] = [];
      // Column headers run through the same math pipeline as body cells
      // (renderMathText = the splitMath+renderMath pass without citation
      // sups): a header containing `$…$` typesets via KaTeX, and a broken
      // region degrades to the delimiter-free gray-mono fallback — never raw
      // `$`-soup with visible delimiters (the pre-fix behavior was a bare
      // escapeHtml, which printed the TeX verbatim in the PDF).
      const head = block.columns
        .map((c) => `<th>${renderMathText(c, warnings)}</th>`)
        .join("");
      const rows = block.rows
        .map((row) => `<tr>${row.map((c) => renderTableCell(c, warnings)).join("")}</tr>`)
        .join("");
      parts.push(
        `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`,
      );
      const html = parts.join("");
      reportWarnings(warnings, opts);
      return html;
    }

    case "ordered_list": {
      const warnings: string[] = [];
      const html = `<ol>${block.items.map((it) => renderListItem(it, warnings)).join("")}</ol>`;
      reportWarnings(warnings, opts);
      return html;
    }

    case "unordered_list": {
      const warnings: string[] = [];
      const html = `<ul>${block.items.map((it) => renderListItem(it, warnings)).join("")}</ul>`;
      reportWarnings(warnings, opts);
      return html;
    }

    case "code_block": {
      // latex/tex code blocks are typeset as a display equation; everything
      // else renders as a plain code block, unchanged.
      if (block.language.toLowerCase() === "latex" || block.language.toLowerCase() === "tex") {
        const warnings: string[] = [];
        // The body is typeset verbatim (display math): balance a stray
        // unmatched closing brace before the well-formedness gate so the
        // classic LLM typo (task 427f039f) still typesets; a body that is
        // still malformed (e.g. an unmatched opener) falls back to the
        // visible literal with a surfaced warning.
        const tex = balanceBraces(_stripDollarDelimiters(block.text.trim()));
        const html = `<div class="equation">${renderMath(tex, true, warnings, "equation")}</div>`;
        reportWarnings(warnings, opts);
        return html;
      }
      const langAttr =
        block.language !== "" ? ` class="language-${escapeAttr(block.language)}"` : "";
      return `<pre${langAttr}><code>${escapeHtml(block.text)}</code></pre>`;
    }

    case "figure": {
      const inner: string[] = [];
      if (block.url !== "" && isSafeUrl(block.url)) {
        inner.push(`<img src="${escapeAttr(block.url)}" alt="">`);
      }
      if (block.caption !== "") {
        inner.push(`<figcaption>${escapeHtml(block.caption)}</figcaption>`);
      }
      if (inner.length === 0) {
        opts.onWarning?.(`figure with no url or caption skipped`);
        return "";
      }
      return `<figure>${inner.join("")}</figure>`;
    }

    case "equation": {
      const t = block.text.trim();
      const tex = stripMathDelimiters(t);
      // Redundant inline `$` delimiters inside a display equation (a model
      // artifact) are stripped: `F($\psi$) = $\operatorname{Tr}$$` ->
      // `F(\psi) = \operatorname{Tr}…`. A `$`-bearing block without outer
      // delimiters now typesets (its `$` were its delimiters).
      const stripped = _stripDollarDelimiters(tex);
      // Same repair as the latex code_block path: drop a stray unmatched
      // closing brace before the gate (see balanceBraces).
      const balanced = balanceBraces(stripped);
      // Typeset when the producer said so (language latex/tex), when the
      // text carried $$ / \[ \] delimiters, or when it carried inline `$`.
      if (
        block.language.trim().toLowerCase() === "latex" ||
        block.language.trim().toLowerCase() === "tex" ||
        tex !== t ||
        stripped !== tex
      ) {
        const warnings: string[] = [];
        const html = `<div class="equation">${renderMath(balanced, true, warnings, "equation")}</div>`;
        reportWarnings(warnings, opts);
        return html;
      }
      return `<div class="equation">${escapeHtml(block.text)}</div>`;
    }

    case "page_break": {
      return `<div class="page-break" style="break-before: page"></div>`;
    }

    default: {
      // unknown:<type> blocks carry plain (already marker-stripped) text.
      if (block.text.trim() === "") return "";
      return `<p>${escapeHtml(block.text)}</p>`;
    }
  }
}

/** Render the References list: every source, original order, anchorable. */
export function renderReferences(sources: Source[]): string {
  if (sources.length === 0) return "";
  const items = sources
    .map((s) => {
      const details: string[] = [];
      if (s.author !== "") details.push(s.author);
      if (s.publisher !== "") details.push(s.publisher);
      if (s.issued !== "") details.push(s.issued);
      if (s.accessed !== "") details.push(`accessed ${s.accessed}`);
      const detail = details.filter((d) => d.trim() !== "").join(" · ");

      const links: string[] = [];
      if (s.url !== "" && isSafeUrl(s.url)) {
        links.push(`<a href="${escapeAttr(s.url)}">${escapeHtml(s.url)}</a>`);
      }
      if (s.doi !== "") {
        const doiUrl = `https://doi.org/${s.doi}`;
        links.push(
          isSafeUrl(doiUrl)
            ? `<a href="${escapeAttr(doiUrl)}">doi:${escapeHtml(s.doi)}</a>`
            : `doi:${escapeHtml(s.doi)}`,
        );
      }

      // The citation key (W1/D2, …) is the label producer-side prose may
      // still carry (older reports, direct uploads). The bibliography is
      // the only place it can be defined in-document, so print it beside
      // the positional number; sources without a key render exactly as
      // before (no empty element).
      const inner: string[] = [`<span class="ref-num">[${s.position}]</span>`];
      if (s.citationKey !== "") {
        inner.push(`<span class="ref-key">${escapeHtml(s.citationKey)}</span>`);
      }
      inner.push(`<span class="ref-title">${escapeHtml(s.title)}</span>`);
      if (detail !== "") inner.push(`<span class="ref-detail"> — ${escapeHtml(detail)}</span>`);
      if (links.length > 0) inner.push(`<div class="ref-links">${links.join(" ")}</div>`);
      return `<li id="src-${s.position}">${inner.join("")}</li>`;
    })
    .join("\n");
  return `<section class="doc-section references"><h2>References</h2><ul>${items}</ul></section>`;
}

/**
 * Check that every source position referenced by the model has a matching
 * anchor target (defensive; the normalizer guarantees it).
 */
export function modelCitesMissingAnchors(model: DocumentModel): string[] {
  const warnings: string[] = [];
  const known = new Set(model.sources.map((s) => s.position));
  const all = (pos: number[]) => {
    for (const p of pos) if (!known.has(p)) warnings.push(`citation ${p} has no source anchor`);
  };
  for (const sec of model.sections) {
    for (const b of sec.blocks) {
      if (b.type === "paragraph" || b.type === "quote" || b.type === "callout") {
        for (const s of b.spans) all(s.sourcePositions);
      } else if (b.type === "comparison_table") {
        for (const row of b.rows) for (const c of row) all(c.sourcePositions);
      } else if (b.type === "ordered_list" || b.type === "unordered_list") {
        for (const it of b.items) all(it.sourcePositions);
      }
    }
  }
  return [...new Set(warnings)];
}
