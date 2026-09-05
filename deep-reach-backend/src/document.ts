/**
 * Input schema (zod) + normalization into the internal DocumentModel.
 *
 * The input is lenient on dirt (missing optional fields, "" / [] / 2 /
 * "note" defaults, capitalized URL/DOI keys, string-or-object cells,
 * passthrough extra keys) and strict on shape (a report must have a
 * metadata.title and a sections array; a section must have a heading).
 */
import { z } from "zod";
import { CitationResolver, hasVisibleContent } from "./citations.js";

// ---------------------------------------------------------------------------
// Internal DocumentModel (what the renderer consumes)
// ---------------------------------------------------------------------------

export interface DocumentMetadata {
  title: string;
  subtitle: string;
  query: string;
  sessionId: string;
  generatedAt: string;
  author: string;
  reportType: string;
}

export interface Span {
  /** Marker-stripped, still-raw text (escaped later by the renderer). */
  text: string;
  /** 1-based positions into the sources array, deduped, ascending. */
  sourcePositions: number[];
}

export interface TableCell {
  text: string;
  sourcePositions: number[];
}

export interface TableBlock {
  type: "comparison_table";
  caption: string;
  columns: string[];
  rows: TableCell[][];
}

export interface HeadingBlock {
  type: "heading";
  text: string;
  level: 2 | 3;
}

export const CALLOUT_TYPES = ["note", "warning", "danger", "tip", "info", "key_insight"] as const;
export type CalloutType = (typeof CALLOUT_TYPES)[number];

export type ParagraphishBlock =
  | { type: "paragraph"; spans: Span[] }
  | { type: "quote"; spans: Span[] }
  | {
      type: "callout";
      spans: Span[];
      calloutType: CalloutType;
      calloutTitle: string;
    };

export interface ListItem {
  text: string;
  sourcePositions: number[];
}

export interface ListBlock {
  type: "ordered_list" | "unordered_list";
  items: ListItem[];
}

export interface CodeBlock {
  type: "code_block";
  text: string;
  language: string;
}

export interface FigureBlock {
  type: "figure";
  caption: string;
  url: string;
}

export interface EquationBlock {
  type: "equation";
  text: string;
  /** Optional producer hint, e.g. "latex"/"tex" (default ""). */
  language: string;
}

export interface PageBreakBlock {
  type: "page_break";
}

/** Producer-provided source note: verbatim prose, no citation resolution. */
export interface CitationNoteBlock {
  type: "citation_note";
  spans: Span[];
  calloutTitle: string;
}

/** A block of unknown type, kept but rendered as a paragraph when it has text. */
export interface UnknownBlock {
  type: `unknown:${string}`;
  text: string;
}

export type Block =
  | HeadingBlock
  | ParagraphishBlock
  | TableBlock
  | ListBlock
  | CodeBlock
  | FigureBlock
  | EquationBlock
  | PageBreakBlock
  | CitationNoteBlock
  | UnknownBlock;

export interface Section {
  id: string;
  heading: string;
  blocks: Block[];
}

export interface Source {
  /** 1-based position in the sources array (identity for anchors). */
  position: number;
  id: string;
  type: string;
  title: string;
  author: string;
  issued: string;
  url: string;
  publisher: string;
  doi: string;
  citationKey: string;
  accessed: string;
}

export interface DocumentModel {
  metadata: DocumentMetadata;
  executiveSummary: string[];
  sections: Section[];
  sources: Source[];
}

export interface NormalizeResult {
  model: DocumentModel;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Zod schemas for the raw input
// ---------------------------------------------------------------------------

const spanSchema = z
  .object({
    text: z.string().default(""),
    citations: z.array(z.union([z.string(), z.number()])).default([]),
  })
  .passthrough();

const cellSchema = z
  .union([z.string(), spanSchema])
  .transform((c) => (typeof c === "string" ? { text: c, citations: [] as (string | number)[] } : c));
export type RawCell = z.infer<typeof cellSchema>;

const itemSchema = spanSchema;

const blockSchema = z
  .object({
    type: z.string(),
    text: z.string().default(""),
    spans: z.array(spanSchema).default([]),
    citations: z.array(z.union([z.string(), z.number()])).default([]),
    level: z.number().default(3),
    items: z.array(itemSchema).default([]),
    caption: z.string().default(""),
    columns: z.array(z.string()).default([]),
    rows: z.array(z.array(cellSchema)).default([]),
    callout_type: z.enum(CALLOUT_TYPES).default("note"),
    callout_title: z.string().default(""),
    language: z.string().default(""),
    // figure accepts url or src
    url: z.string().optional().default(""),
    src: z.string().optional().default(""),
  })
  .passthrough();
export type RawBlock = z.infer<typeof blockSchema>;

export interface RawSpan {
  text: string;
  citations: (string | number)[];
}

const sourceSchema = z
  .object({
    id: z.string().optional().default(""),
    type: z.string().optional().default(""),
    title: z.string(),
    author: z.union([z.string(), z.array(z.string())]).optional().default(""),
    issued: z.unknown().optional(),
    URL: z.string().optional().default(""),
    url: z.string().optional().default(""),
    publisher: z.string().optional().default(""),
    DOI: z.string().optional().default(""),
    doi: z.string().optional().default(""),
    citation_key: z.string().optional().default(""),
    accessed: z.string().optional().default(""),
  })
  .passthrough();
export type RawSource = z.infer<typeof sourceSchema>;

const metadataSchema = z
  .object({
    title: z.string(),
    subtitle: z.string().optional().default(""),
    query: z.string().optional().default(""),
    session_id: z.string().optional().default(""),
    generated_at: z.string().optional().default(""),
    author: z.string().optional().default(""),
    report_type: z.string().optional().default(""),
  })
  .passthrough();
export type RawMetadata = z.infer<typeof metadataSchema>;

const sectionSchema = z
  .object({
    id: z.string().optional().default(""),
    heading: z.string(),
    blocks: z.array(blockSchema).default([]),
  })
  .passthrough();
export type RawSection = z.infer<typeof sectionSchema>;

const reportSchema = z
  .object({
    metadata: metadataSchema,
    executive_summary: z.array(z.string()).default([]),
    sections: z.array(sectionSchema),
    sources: z.array(sourceSchema).default([]),
  })
  .passthrough();
export type RawReport = z.infer<typeof reportSchema>;

export const documentSchema = z
  .object({
    schema_version: z.string().optional().default(""),
    report: reportSchema,
    quality: z.record(z.string(), z.unknown()).optional().default({}),
  })
  .passthrough();
export type RawDocument = z.infer<typeof documentSchema>;

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

export interface NormalizeOptions {
  /** Override metadata.title (CLI --title). */
  title?: string;
}

/** A cell/item in raw form after zod. */
interface RawCitable {
  text: string;
  citations: (string | number)[];
}

function normalizeIssued(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v["date-parts"])) {
      const parts = (v["date-parts"] as unknown[])[0];
      if (Array.isArray(parts)) {
        const nums = parts.filter((p): p is number => typeof p === "number");
        if (nums.length > 0) {
          const [y, m, d] = nums;
          if (m != null && d != null) {
            return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          }
          if (m != null) return `${y}-${String(m).padStart(2, "0")}`;
          return String(y);
        }
      }
    }
    if (typeof v["literal"] === "string") return v["literal"];
  }
  return "";
}

function normalizeSource(raw: RawSource, position: number): Source {
  // Raw producer fields are unvalidated at runtime (the zod schema is
  // type-only): read every string field through str() so a null/number
  // value degrades to "" instead of crashing a downstream .trim().
  const author = Array.isArray(raw.author)
    ? raw.author.filter((a) => a !== "").join(", ")
    : str(raw.author);
  return {
    position,
    id: str(raw.id),
    type: str(raw.type),
    title: str(raw.title),
    author: str(author),
    issued: normalizeIssued(raw.issued),
    url: str(raw.URL).trim() !== "" ? str(raw.URL) : str(raw.url),
    publisher: str(raw.publisher),
    doi: str(raw.DOI).trim() !== "" ? str(raw.DOI) : str(raw.doi),
    citationKey: str(raw.citation_key),
    accessed: str(raw.accessed),
  };
}

/** Safe string read for raw producer fields (the schema is type-only). */
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Terminal sentence punctuation: `.`, `!`, `?`, `…`. */
const TERMINAL_PUNCT_RE = /[.!?\u2026]/u;

/**
 * Resolve citations on a single text/refs pair, then apply the dropping
 * rules. Returns null when the span/item should be dropped entirely.
 */
function resolveCitable(
  resolver: CitationResolver,
  raw: RawCitable | null | undefined,
  kind: "span" | "cell" | "item",
): { text: string; sourcePositions: number[] } | null {
  // Malformed producer entries (null/undefined, non-string text, or a missing
  // citations list) must never crash normalization: a ragged table row leaves
  // row[i] === undefined, and such a cell degrades to an EMPTY cell (kept —
  // an empty cell is a legitimate cell) while a span/item is dropped.
  if (raw == null || typeof raw.text !== "string") {
    return kind === "cell" ? { text: "", sourcePositions: [] } : null;
  }
  const citations = Array.isArray(raw.citations) ? raw.citations : [];
  const res = resolver.resolve(raw.text, citations);
  const text = res.text;
  if (kind === "cell") {
    // Empty cell text is fine for cells: keep the cell, drop its sup.
    const hasContent = hasVisibleContent(text);
    return { text: hasContent ? text : "", sourcePositions: hasContent ? res.sourcePositions : [] };
  }
  const trimmed = text.trim();
  // Keep spans whose only remaining content is terminal punctuation (e.g. the
  // lone "." left after stripping a marker-only span like "[D41] [D14].");
  // still drop whitespace-only spans.
  if (trimmed === "" || (!hasVisibleContent(text) && !TERMINAL_PUNCT_RE.test(trimmed))) {
    return null;
  }
  return { text, sourcePositions: res.sourcePositions };
}

function normalizeBlock(
  raw: RawBlock,
  resolver: CitationResolver,
  warnings: string[],
): Block | null {
  switch (raw.type) {
    case "heading": {
      const text = str(raw.text).trim();
      if (text === "") return null;
      const level = raw.level === 2 ? 2 : 3;
      return { type: "heading", text, level };
    }

    case "paragraph":
    case "quote":
    case "callout":
    case "source_list":
    case "appendix": {
      // source_list / appendix are treated as paragraphs. Raw text/citations/
      // spans are unvalidated: sanitize so a null field or a null span entry
      // degrades instead of crashing.
      const type = raw.type === "source_list" || raw.type === "appendix" ? "paragraph" : raw.type;
      const rawText = str(raw.text);
      const rawCitations = Array.isArray(raw.citations) ? raw.citations : [];
      const rawSpans: RawCitable[] =
        Array.isArray(raw.spans) && raw.spans.length > 0
          ? raw.spans
          : rawText.trim() !== ""
            ? [{ text: rawText, citations: rawCitations }]
            : [];
      const spans = rawSpans
        .map((s) => resolveCitable(resolver, s, "span"))
        .filter((s): s is NonNullable<typeof s> => s !== null);
      if (spans.length === 0) return null;
      if (type === "callout") {
        return {
          type: "callout",
          spans,
          calloutType: raw.callout_type ?? "note",
          calloutTitle: str(raw.callout_title).trim(),
        };
      }
      if (type === "quote") return { type: "quote", spans };
      return { type: "paragraph", spans };
    }

    case "comparison_table": {
      const columns = Array.isArray(raw.columns) ? raw.columns : [];
      const rows = Array.isArray(raw.rows) ? raw.rows : [];
      const hasColumns = columns.length > 0;
      const hasRows = rows.length > 0;
      if (!hasColumns && !hasRows) return null;
      const width = Math.max(
        columns.length,
        ...rows.map((r) => (Array.isArray(r) ? r.length : 0)),
        0,
      );
      const cells: TableCell[][] = rows.map((rawRow) => {
        const row = Array.isArray(rawRow) ? rawRow : [];
        return Array.from({ length: width }, (_, i) => {
          const cell = row[i];
          // Ragged rows (fewer cells than the table width) leave row[i]
          // undefined: pad with an empty cell instead of crashing.
          const rawCell: RawCitable =
            typeof cell === "string"
              ? { text: cell, citations: [] }
              : cell != null
                ? cell
                : { text: "", citations: [] };
          const res = resolveCitable(resolver, rawCell, "cell");
          return { text: res?.text ?? "", sourcePositions: res?.sourcePositions ?? [] };
        });
      });
      return {
        type: "comparison_table",
        caption: str(raw.caption).trim(),
        columns,
        rows: cells,
      };
    }

    case "ordered_list":
    case "unordered_list": {
      const rawItems = Array.isArray(raw.items) ? raw.items : [];
      const items = rawItems
        .map((it) => resolveCitable(resolver, it, "item"))
        .filter((it): it is NonNullable<typeof it> => it !== null);
      if (items.length === 0) return null;
      return {
        type: raw.type,
        items: items.map((it) => ({ text: it.text, sourcePositions: it.sourcePositions })),
      };
    }

    case "code_block": {
      const text = str(raw.text).trim();
      if (text === "") return null;
      return { type: "code_block", text, language: str(raw.language).trim() };
    }

    case "figure": {
      const url = raw.url !== undefined && raw.url !== "" ? raw.url : raw.src ?? "";
      if (str(raw.caption).trim() === "" && url === "") {
        warnings.push("figure with no url or caption skipped");
        return null;
      }
      return { type: "figure", caption: str(raw.caption).trim(), url };
    }

    case "equation": {
      const text = str(raw.text).trim();
      if (text === "") return null;
      return { type: "equation", text, language: str(raw.language).trim() };
    }

    case "page_break":
      return { type: "page_break" };

    case "citation_note": {
      // Producer source note: the span text is a self-contained source list
      // (W-references are deliberate prose, not bracket markers). Keep the
      // text verbatim (trimmed) — no marker stripping, no citation
      // resolution, no sourcePositions.
      const rawText = str(raw.text);
      const rawSpans: RawCitable[] =
        Array.isArray(raw.spans) && raw.spans.length > 0
          ? raw.spans
          : rawText.trim() !== ""
            ? [{ text: rawText, citations: [] }]
            : [];
      const spans = rawSpans
        .filter((s) => s != null && typeof s.text === "string")
        .map((s) => s.text.trim())
        .filter((t) => hasVisibleContent(t))
        .map((t) => ({ text: t, sourcePositions: [] as number[] }));
      if (spans.length === 0) return null;
      return { type: "citation_note", spans, calloutTitle: str(raw.callout_title).trim() };
    }

    default: {
      // Unknown type: keep the block, render its text (if any) as a
      // paragraph, and record a warning.
      warnings.push(`unknown block type "${raw.type}" skipped`);
      const text = str(raw.text);
      if (text.trim() === "") return null;
      const citations = Array.isArray(raw.citations) ? raw.citations : [];
      const res = resolver.resolve(text, citations);
      if (!hasVisibleContent(res.text)) return null;
      return { type: `unknown:${raw.type}` as const, text: res.text };
    }
  }
}

export function normalizeDocument(
  raw: RawDocument,
  opts: NormalizeOptions = {},
): NormalizeResult {
  const warnings: string[] = [];
  const report = raw.report;

  const titleOverride = opts.title?.trim();
  // metadata itself may be absent (unvalidated raw input): read every field
  // through str() so the document degrades to empty metadata, not a crash.
  const meta = (report.metadata ?? {}) as Record<string, unknown>;
  const metadata: DocumentMetadata = {
    title:
      titleOverride !== undefined && titleOverride !== ""
        ? titleOverride
        : str(meta.title).trim(),
    subtitle: str(meta.subtitle).trim(),
    query: str(meta.query).trim(),
    sessionId: str(meta.session_id).trim(),
    generatedAt: str(meta.generated_at).trim(),
    author: str(meta.author).trim(),
    reportType: str(meta.report_type).trim(),
  };

  const resolver = new CitationResolver(
    (report.sources ?? []).map((s) => ({
      citation_key: s.citation_key ?? "",
      id: s.id ?? "",
    })),
  );

  const sources: Source[] = (report.sources ?? []).map((s, i) => normalizeSource(s, i + 1));

  const executiveSummary = (report.executive_summary ?? [])
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter((s) => s !== "");

  const sections: Section[] = (report.sections ?? []).map((sec) => {
    let renderedSinceH2 = false;
    const blocks: Block[] = [];
    for (const rawBlock of sec.blocks ?? []) {
      // Duplicate-heading guard: if a heading block's text equals the
      // section heading (trim/case-insensitive) AND the section H2 was
      // just rendered (nothing else since), skip it (scaffolding noise).
      const isDuplicate =
        rawBlock.type === "heading" &&
        !renderedSinceH2 &&
        (rawBlock.text ?? "").trim().toLowerCase() === (sec.heading ?? "").trim().toLowerCase();
      if (isDuplicate) continue;
      const block = normalizeBlock(rawBlock, resolver, warnings);
      if (block === null) continue;
      blocks.push(block);
      renderedSinceH2 = true;
    }
    return {
      id: (sec.id ?? "").trim(),
      heading: (sec.heading ?? "").trim(),
      blocks,
    };
  });

  warnings.push(...resolver.warnings());

  return {
    model: { metadata, executiveSummary, sections, sources },
    warnings,
  };
}
