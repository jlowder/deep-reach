/**
 * Pipeline library entry point:
 *
 *   input path (.json | .md)
 *     -> load (utf8)
 *     -> parse (JSON | marked)
 *     -> validate (zod)
 *     -> normalize (DocumentModel + citation resolution)
 *     -> html (self-contained)
 *     -> pdf (Playwright Chromium) + validate (pdf-parse)
 *     -> result
 *
 * This module is the stable API the future paperbot API server will import.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import {
  documentSchema,
  normalizeDocument,
  type DocumentModel,
} from "./document.js";
import { markdownToModel } from "./markdown.js";
import { renderHtml } from "./render/html.js";
import { modelCitesMissingAnchors } from "./render/blocks.js";
import {
  PaperbotError,
  htmlToPdf,
  type PageFormat,
  type PdfOutput,
} from "./pdf.js";

export interface PipelineOptions {
  /** Output PDF path (default: input path with .pdf extension). */
  outPath: string;
  /** Page format (default "letter"). */
  format?: PageFormat;
  /** Override the document title. */
  title?: string;
  /** When set, also write the intermediate HTML to this path. */
  keepHtmlPath?: string;
  /** Skip the pdf-parse text-containment check (CLI --no-validate). */
  skipValidate?: boolean;
}

export interface PipelineResult {
  ok: boolean;
  /** Present when ok is false; safe to print verbatim. */
  error?: string;
  /** Process exit code: 0 ok, 1 input error, 3 render/PDF failure. */
  exitCode: number;
  outputPath: string;
  pages?: number;
  sizeBytes?: number;
  warnings: string[];
  htmlPath?: string;
}

export const EXIT_OK = 0;
export const EXIT_INPUT = 1;
export const EXIT_USAGE = 2;
export const EXIT_RENDER = 3;

export type InputFormat = "json" | "markdown";

export function detectFormat(inputPath: string): InputFormat {
  const ext = extname(inputPath).toLowerCase();
  if (ext === ".json") return "json";
  if (ext === ".md" || ext === ".markdown") return "markdown";
  throw new PaperbotError(
    `unsupported input extension "${ext || "(none)"}" (expected .json or .md)`,
    EXIT_INPUT,
  );
}

export function defaultOutPath(inputPath: string): string {
  const base = basename(inputPath, extname(inputPath));
  const name = base === "" || base === "-" || base === "." ? "stdin" : base;
  return join(resolve(process.cwd()), "out", `${name}.pdf`);
}

/**
 * Choose the input format for stdin content (no extension to inspect):
 * JSON when the content parses as a JSON value, markdown otherwise.
 */
export function sniffFormat(content: string): InputFormat {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      /* not JSON after all */
    }
  }
  return "markdown";
}

/**
 * Load + parse + validate + normalize + render HTML (no PDF).
 * Exposed so tests (and future API consumers) can use the pipeline without a browser.
 * Input: a file path (.json/.md) or "-" for stdin.
 */
export interface PreparedDocument {
  model: DocumentModel;
  html: string;
  warnings: string[];
}

export function prepare(inputPath: string, opts: PipelineOptions): PreparedDocument {
  const isStdin = inputPath === "-";

  let content: string;
  let format: InputFormat;
  if (isStdin) {
    if (process.stdin.isTTY) {
      throw new PaperbotError(
        "no data on stdin: stdin is a TTY — pipe a document instead (e.g. `cat doc.md | paperbot -`)",
        EXIT_INPUT,
      );
    }
    try {
      // fd 0: blocks until the pipe is closed.
      content = readFileSync(0, "utf8");
    } catch (err) {
      throw new PaperbotError(`could not read stdin: ${msg(err)}`, EXIT_INPUT);
    }
    if (content.trim() === "") {
      throw new PaperbotError("no data on stdin (pipe a JSON or markdown document, e.g. `cat doc.md | paperbot -`)", EXIT_INPUT);
    }
    format = sniffFormat(content);
  } else {
    const absInput = isAbsolute(inputPath) ? inputPath : resolve(process.cwd(), inputPath);
    if (!existsSync(absInput) || !statSync(absInput).isFile()) {
      throw new PaperbotError(`input file not found: ${inputPath}`, EXIT_INPUT);
    }
    try {
      content = readFileSync(absInput, "utf8");
    } catch (err) {
      throw new PaperbotError(
        `could not read input file: ${err instanceof Error ? err.message : String(err)}`,
        EXIT_INPUT,
      );
    }
    format = detectFormat(absInput);
  }

  return prepareContent(content, format, inputPath, opts);
}

export function prepareContent(
  content: string,
  format: InputFormat,
  sourceLabel: string,
  opts: PipelineOptions,
): PreparedDocument {
  let model: DocumentModel;
  let warnings: string[] = [];
  if (format === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      throw new PaperbotError(jsonParseErrorMessage(content, err), EXIT_INPUT);
    }
    const result = documentSchema.safeParse(parsed);
    if (!result.success) {
      throw new PaperbotError(zodErrorMessage(result.error), EXIT_INPUT);
    }
    const normalized = normalizeDocument(result.data, { title: opts.title });
    model = normalized.model;
    warnings = normalized.warnings;
  } else {
    const fallbackFromName = sourceLabel
      .replace(/\.[^.]+$/, "")
      .split(/[\\/]/)
      .pop();
    model = markdownToModel(content, {
      title: opts.title,
      fallbackTitle: sourceLabel === "-" ? undefined : fallbackFromName ?? "Untitled document",
      onWarning: (w) => warnings.push(w),
    });
  }

  // Thread renderer-side warnings (e.g. figures with no usable content)
  // into the same warnings channel as validation/normalization ones.
  const allWarnings = [...warnings, ...modelCitesMissingAnchors(model)];
  const html = renderHtml(model, { onWarning: (w) => allWarnings.push(w) });
  return { model, html, warnings: allWarnings };
}

/**
 * Run the full pipeline: prepare -> pdf -> validate -> result.
 * Never throws for expected failures; returns a PipelineResult instead.
 */
export async function run(inputPath: string, opts: PipelineOptions): Promise<PipelineResult> {
  const warnings: string[] = [];
  try {
    const prepared = prepare(inputPath, opts);
    warnings.push(...prepared.warnings);

    // Optional intermediate HTML.
    let htmlPath: string | undefined;
    if (opts.keepHtmlPath) {
      htmlPath = opts.keepHtmlPath;
      try {
        mkdirSync(dirname(htmlPath), { recursive: true });
        writeFileSync(htmlPath, prepared.html, "utf8");
      } catch (err) {
        return fail(EXIT_RENDER, `could not write --keep-html file: ${msg(err)}`, warnings, opts.outPath, htmlPath);
      }
    }

    const pdf = await htmlToPdf(prepared.html, {
      outputPath: opts.outPath,
      format: opts.format ?? "letter",
      expectedTitle: prepared.model.metadata.title,
      skipTextCheck: opts.skipValidate,
      onWarning: (w) => warnings.push(w),
    });

    if (!pdf.ok) {
      return fail(EXIT_RENDER, pdf.error ?? "PDF generation failed", warnings, opts.outPath, htmlPath);
    }

    return {
      ok: true,
      exitCode: EXIT_OK,
      outputPath: opts.outPath,
      pages: pdf.pages,
      sizeBytes: pdf.sizeBytes,
      warnings,
      htmlPath,
    };
  } catch (err) {
    if (err instanceof PaperbotError) {
      return fail(err.exitCode, err.message, warnings, opts.outPath);
    }
    return fail(EXIT_RENDER, `unexpected error: ${msg(err)}`, warnings, opts.outPath);
  }
}

function fail(
  exitCode: number,
  error: string,
  warnings: string[],
  outputPath: string,
  htmlPath?: string,
): PipelineResult {
  return { ok: false, exitCode, error, outputPath, warnings, htmlPath };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * JSON parse error -> actionable "line X, column Y" position.
 * Handles both V8 message shapes seen across Node versions:
 *   - "... at position 7 (line 1 column 8)" (old / Expected-* errors)
 *   - "Unexpected token '}', ...\"window\" is not valid JSON" (new V8 window)
 */
export function jsonParseErrorMessage(content: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);

  const lc = /line (\d+) column (\d+)/.exec(message);
  if (lc) {
    // The message already carries the exact position; keep it verbatim.
    return `invalid JSON: ${message}`;
  }

  let line = 1;
  let col = 1;
  let near = false;
  let located = false;

  const posMatch = /position (\d+)/.exec(message);
  if (posMatch) {
    [line, col] = lineCol(content, Number(posMatch[1]));
    located = true;
  } else {
    // New V8 window format: the quoted window is a contiguous tail of the
    // input; the unexpected token's first occurrence in it is the error.
    const winMatch = /(?:\.\.\.)?"([\s\S]*?)" is not valid JSON/.exec(message);
    const tokMatch = /Unexpected token '([^']*)'/.exec(message);
    if (winMatch) {
      const win = winMatch[1];
      const idx = Math.max(content.lastIndexOf(win), content.indexOf(win));
      if (idx >= 0) {
        const tokenIdx = tokMatch ? win.indexOf(tokMatch[1]) : -1;
        const offset = tokenIdx >= 0 ? idx + tokenIdx : idx;
        [line, col] = lineCol(content, offset);
        located = true;
        near = true;
      }
    }
    if (!located && /Unexpected end of JSON input/.test(message)) {
      [line, col] = lineCol(content, content.length);
      located = true;
    }
  }

  if (!located) return `invalid JSON: ${message}`;
  return `invalid JSON (near line ${line}, column ${col})${near ? " (approximate)" : ""}: ${message}`;
}

/** 1-based line/column for a 0-based offset. */
function lineCol(content: string, pos: number): [number, number] {
  let line = 1;
  let col = 1;
  const lim = Math.min(pos, content.length);
  for (let i = 0; i < lim; i++) {
    if (content[i] === "\n") {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return [line, col];
}

/** Format a zod error as actionable one-line-ish messages with JSON paths. */
export function zodErrorMessage(err: import("zod").ZodError): string {
  const issues = err.issues.slice(0, 5);
  const lines = issues.map((i) => {
    const path = i.path.length > 0 ? i.path.join(".") : "(root)";
    return `  - ${path}: ${i.message}`;
  });
  const more = err.issues.length > 5 ? `  … and ${err.issues.length - 5} more issue(s)` : "";
  return `document validation failed:\n${lines.join("\n")}${more ? `\n${more}` : ""}`;
}

export { documentSchema };
