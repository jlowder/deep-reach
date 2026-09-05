/**
 * .md input path (secondary): plain markdown -> DocumentModel via marked.
 *
 * Mapping (deliberately simple):
 *   - first H1            -> metadata.title (else --title, else filename)
 *   - "## Executive Summary" section content -> executive_summary strings
 *   - other H2            -> section; H3 inside -> heading block (level 3)
 *   - paragraph           -> paragraph block (single span, no citations)
 *   - ul / ol             -> unordered_list / ordered_list blocks
 *   - GFM table           -> comparison_table block
 *   - fenced code         -> code_block
 *   - blockquote          -> callout (type "note")
 *   - horizontal rule     -> page_break
 * sources is always [] (markdown carries no citations), so no References.
 *
 * Inline markdown formatting (bold/italic/links) is flattened to plain
 * text; the markdown path is the basic one by design.
 */
import { marked, type Token, type Tokens } from "marked";
import {
  type Block,
  type DocumentMetadata,
  type DocumentModel,
  type ListItem,
  type Section,
  type Span,
  type TableCell,
  type TableBlock,
} from "./document.js";

export interface MarkdownOptions {
  /** Title override (CLI --title). */
  title?: string;
  /** Fallback title source (input filename without extension). */
  fallbackTitle?: string;
  /** Warning channel: content-loss notices (e.g. dropped raw HTML fragments). */
  onWarning?: (w: string) => void;
}

/** Count raw-HTML tokens (block-level and inline) anywhere in the token tree. */
function countHtmlFragments(token: Token | Token[]): number {
  const tokens = Array.isArray(token) ? token : [token];
  let n = 0;
  for (const t of tokens) {
    if (t.type === "html") n++;
    const inner = (t as { tokens?: Token[] }).tokens;
    if (inner) n += countHtmlFragments(inner);
  }
  return n;
}

/** Recursively extract plain text from marked inline tokens. */
function inlineText(token: Token | Token[]): string {
  const tokens = Array.isArray(token) ? token : [token];
  let out = "";
  for (const t of tokens) {
    switch (t.type) {
      case "text":
        // marked's `text` token is already entity-escaped for HTML; decode
        // the common entities back so the renderer can re-escape uniformly.
        out += decodeEntities((t as Tokens.Text).text ?? "");
        break;
      case "space":
        out += " ";
        break;
      case "codespan":
        out += (t as Tokens.Codespan).text;
        break;
      case "em":
      case "strong":
        out += inlineText((t as Tokens.Em | Tokens.Strong).tokens);
        break;
      case "del":
        out += inlineText((t as Tokens.Del).tokens);
        break;
      case "link": {
        const link = t as Tokens.Link;
        out += inlineText(link.tokens ?? []);
        break;
      }
      case "image": {
        const img = t as Tokens.Image;
        out += img.text ?? "";
        break;
      }
      case "br":
        out += "\n";
        break;
      case "html":
        // Skip raw HTML passed through markdown; it is not safe text here.
        out += "";
        break;
      default: {
        const anyTok = t as { text?: string; tokens?: Token[] };
        if (anyTok.tokens) out += inlineText(anyTok.tokens);
        else if (anyTok.text !== undefined) out += decodeEntities(anyTok.text);
        break;
      }
    }
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** Extract plain text from a block token that wraps inline tokens. */
function blockInlineText(token: Token): string {
  if (token.type === "paragraph" || token.type === "heading") {
    const t = token as Tokens.Paragraph | Tokens.Heading;
    return inlineText(t.tokens ?? []).replace(/\s+/g, " ").trim();
  }
  if (token.type === "text") {
    return decodeEntities((token as Tokens.Text).text);
  }
  return "";
}

function listItemText(item: Tokens.ListItem): string {
  return (item.tokens ?? [])
    .map((t) => {
      if (t.type === "text" || t.type === "paragraph" || t.type === "heading") {
        return blockInlineText(t);
      }
      if (t.type === "list") return listItemText(t as Tokens.ListItem);
      return "";
    })
    .filter((s) => s !== "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function blockFromToken(token: Token): Block | null {
  switch (token.type) {
    case "heading": {
      const h = token as Tokens.Heading;
      if (h.depth === 1) return null; // handled as the document title
      const text = inlineText(h.tokens ?? []).trim();
      if (text === "") return null;
      if (h.depth === 2) return null; // handled as a section heading
      return { type: "heading", text, level: 3 };
    }
    case "paragraph": {
      const text = inlineText((token as Tokens.Paragraph).tokens ?? []).replace(/\s+/g, " ").trim();
      if (text === "") return null;
      const span: Span = { text, sourcePositions: [] };
      return { type: "paragraph", spans: [span] };
    }
    case "list": {
      const list = token as Tokens.List;
      const items: ListItem[] = (list.items ?? [])
        .map((it) => {
          const text = listItemText(it);
          if (text === "") return null;
          return { text, sourcePositions: [] as number[] };
        })
        .filter((it): it is ListItem => it !== null);
      if (items.length === 0) return null;
      return { type: list.ordered ? "ordered_list" : "unordered_list", items };
    }
    case "table": {
      const table = token as Tokens.Table;
      const textOfCell = (cell: Tokens.TableCell) =>
        inlineText(cell.tokens ?? []).replace(/\s+/g, " ").trim();
      const columns = (table.header ?? []).map(textOfCell);
      const rows: TableCell[][] = (table.rows ?? []).map((row) =>
        row.map((c) => ({ text: textOfCell(c), sourcePositions: [] })),
      );
      const hasContent = columns.some((c) => c !== "") || rows.length > 0;
      if (!hasContent) return null;
      const block: TableBlock = {
        type: "comparison_table",
        caption: "",
        columns,
        rows,
      };
      return block;
    }
    case "code": {
      const code = token as Tokens.Code;
      const text = (code.text ?? "").replace(/\n+$/, "");
      if (text.trim() === "") return null;
      return { type: "code_block", text, language: (code.lang ?? "").trim() };
    }
    case "blockquote": {
      const inner = (token as Tokens.Blockquote).tokens ?? [];
      const spans: Span[] = inner
        .map((t) => {
          const text = blockInlineText(t).replace(/\s+/g, " ").trim();
          if (text === "") return null;
          return { text, sourcePositions: [] as number[] };
        })
        .filter((s): s is Span => s !== null);
      if (spans.length === 0) return null;
      return { type: "callout", spans, calloutType: "note", calloutTitle: "" };
    }
    case "hr":
      return { type: "page_break" };
    default:
      return null;
  }
}

export function markdownToModel(markdown: string, opts: MarkdownOptions = {}): DocumentModel {
  const tokens = marked.lexer(markdown);

  const firstH1 = tokens.find(
    (t) => t.type === "heading" && (t as Tokens.Heading).depth === 1,
  ) as Tokens.Heading | undefined;
  const h1Text = firstH1 ? inlineText(firstH1.tokens ?? []).trim() : "";

  const titleOverride = opts.title?.trim();

  const title =
    titleOverride !== undefined && titleOverride !== ""
      ? titleOverride
      : h1Text !== ""
        ? h1Text
        : opts.fallbackTitle ?? "Untitled document";

  const metadata: DocumentMetadata = {
    title,
    subtitle: "",
    query: "",
    sessionId: "",
    generatedAt: "",
    author: "",
    reportType: "",
  };

  const executiveSummary: string[] = [];
  const sections: Section[] = [];
  let currentSection: Section | null = null;
  let skipUntilNextH2 = false; // inside the executive summary section
  let titleConsumed = false;

  for (const token of tokens) {
    if (token.type === "heading") {
      const h = token as Tokens.Heading;
      if (h.depth === 1 && !titleConsumed) {
        // First H1 is the document title (already extracted above).
        titleConsumed = true;
        currentSection = null;
        skipUntilNextH2 = false;
        continue;
      }
      const heading = inlineText(h.tokens ?? []).trim();
      if (h.depth <= 2) {
        if (/^executive\s+summary$/i.test(heading)) {
          currentSection = null;
          skipUntilNextH2 = true;
          continue;
        }
        // H2 (and any stray H1) start a new section.
        currentSection = { id: "", heading, blocks: [] };
        sections.push(currentSection);
        skipUntilNextH2 = false;
        continue;
      }
      // depth >= 3: a sub-heading block within the current section.
    }

    if (skipUntilNextH2) {
      if (token.type === "paragraph") {
        const text = inlineText((token as Tokens.Paragraph).tokens ?? [])
          .replace(/\s+/g, " ")
          .trim();
        if (text !== "") executiveSummary.push(text);
      }
      continue;
    }

    if (token.type === "space") continue;
    const block = blockFromToken(token);
    if (block === null) continue;
    if (currentSection === null) {
      currentSection = { id: "", heading: "", blocks: [] };
      sections.push(currentSection);
    }
    currentSection.blocks.push(block);
  }

  // Drop sections with no heading and no blocks.
  const pruned = sections.filter((s) => s.heading !== "" || s.blocks.length > 0);

  // Raw HTML passed through markdown is not rendered; surface the loss.
  const htmlFragments = countHtmlFragments(tokens);
  if (htmlFragments > 0) {
    opts.onWarning?.(`dropped ${htmlFragments} raw HTML fragment(s) from markdown`);
  }

  return {
    metadata,
    executiveSummary,
    sections: pruned,
    sources: [],
  };
}
