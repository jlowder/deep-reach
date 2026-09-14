/**
 * DocumentModel -> single self-contained HTML document.
 * No external resources: one embedded <style>, no <link>, no <script>.
 */
import type { DocumentModel } from "../document.js";
import { escapeHtml, renderBlock, renderMathText, renderReferences } from "./blocks.js";
import { REPORT_CSS, MATH_CSS } from "./css.js";
import { katexStylesheet } from "./math.js";

/**
 * Format an ISO date (or date-only string) as "September 13, 2026" — the
 * calendar date of the instant in the LOCAL timezone (or the given
 * `timeZone` when provided). A report created at 8 PM US time is dated with
 * the day it was actually created, not the next-day UTC date (the old
 * getUTC* path rendered the UTC calendar date).
 * Returns "" when the input is missing or unparseable.
 */
export function formatDate(value: string, timeZone?: string): string {
  if (value.trim() === "") return "";
  const t = Date.parse(value);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  if (d.getUTCFullYear() < 1000) return "";
  const parts = new Intl.DateTimeFormat("en", {
    month: "long",
    day: "numeric",
    year: "numeric",
    ...(timeZone !== undefined ? { timeZone } : {}),
  }).formatToParts(d);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${part("month")} ${part("day")}, ${part("year")}`;
}

/** "deep_research" -> "Deep Research" for the meta pill. */
export function prettifyReportType(value: string): string {
  if (value.trim() === "") return "";
  return value
    .trim()
    .split(/[_\s-]+/)
    .filter((w) => w !== "")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export interface HtmlRenderOptions {
  /** Collects renderer-side warnings (e.g. a figure with no usable content). */
  onWarning?: (w: string) => void;
}

export function renderHtml(model: DocumentModel, opts: HtmlRenderOptions = {}): string {
  const { metadata } = model;

  // --- title area ---
  const titleParts: string[] = [];
  titleParts.push(`<h1>${escapeHtml(metadata.title)}</h1>`);
  if (metadata.subtitle !== "") {
    titleParts.push(`<p class="subtitle">${escapeHtml(metadata.subtitle)}</p>`);
  }
  const metaBits: string[] = [];
  if (metadata.author !== "") metaBits.push(escapeHtml(metadata.author));
  const date = formatDate(metadata.generatedAt);
  if (date !== "") metaBits.push(escapeHtml(date));
  const metaLine: string[] = [];
  if (metaBits.length > 0) metaLine.push(`<span>${metaBits.join(" &bull; ")}</span>`);
  const typeLabel = prettifyReportType(metadata.reportType);
  if (typeLabel !== "") {
    metaLine.push(`<span class="badge">${escapeHtml(typeLabel)}</span>`);
  }
  if (metaLine.length > 0) {
    titleParts.push(`<p class="meta-line">${metaLine.join("")}</p>`);
  }
  const titleArea = `<div class="title-area">${titleParts.join("\n")}</div>`;

  // --- executive summary ---
  let execSummary = "";
  if (model.executiveSummary.length > 0) {
    // Flat strings: run through the shared inline-math path (a lone
    // `escapeHtml` used to show literal `$` for `$H^A$`-style formulas).
    const mathWarnings: string[] = [];
    const paras = model.executiveSummary
      .map((s) => `<p>${renderMathText(s, mathWarnings)}</p>`)
      .join("");
    for (const w of mathWarnings) opts.onWarning?.(w);
    execSummary = `<div class="exec-summary"><div class="label">Executive Summary</div>${paras}</div>`;
  }

  // --- sections ---
  const sections = model.sections
    .map((sec) => {
      const blocks = sec.blocks
        .map((b) => renderBlock(b, opts))
        .filter((s) => s !== "")
        .join("\n");
      const heading = sec.heading !== "" ? `<h2>${escapeHtml(sec.heading)}</h2>` : "";
      const idAttr = sec.id !== "" ? ` id="${escapeHtml(sec.id)}"` : "";
      return `<section class="doc-section"${idAttr}>\n${heading}\n${blocks}\n</section>`;
    })
    .join("\n");

  // --- references (only when sources is non-empty) ---
  const references = renderReferences(model.sources);

  const body = [titleArea, execSummary, sections, references]
    .filter((s) => s !== "")
    .join("\n");

  const title = metadata.title !== "" ? metadata.title : "Document";

  return (
    `<!doctype html>\n` +
    `<html lang="en">\n` +
    `<head>\n` +
    `<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>${escapeHtml(title)}</title>\n` +
    `<style>${REPORT_CSS}\n${MATH_CSS}\n${katexStylesheet()}</style>\n` +
    `</head>\n` +
    `<body>\n${body}\n</body>\n` +
    `</html>\n`
  );
}
