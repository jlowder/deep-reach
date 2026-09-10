/**
 * Offline KaTeX typesetting.
 *
 * The PDF path renders `page.setContent(html)` in memory (no filesystem,
 * no server), so every font the math markup needs must ship inside the
 * document: `katexStylesheet()` loads the installed katex package's CSS and
 * rewrites every `url(...)` font reference to a `data:` URI, reading the
 * .woff2/.woff/.ttf files from `node_modules/katex/dist/fonts`.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, isAbsolute, join } from "node:path";
import katex from "katex";
import { escapeHtml } from "./blocks.js";

// ---------------------------------------------------------------------------
// Stylesheet with inlined fonts
// ---------------------------------------------------------------------------

const FONT_MIME: Record<string, string> = {
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
};

/** Memoized: the file reads happen once per process. */
let cachedStylesheet: string | null = null;

/**
 * katex.min.css with every resolvable `url(...)` font reference rewritten to
 * `url("data:<mime>;base64,...")`. The `url(...)` wrapper is required — a
 * bare `data:` token is not a valid CSS `<url>` value, so headless Chromium
 * silently ignores such `@font-face` src lists and falls back to system
 * fonts (math ends up in Times in the PDF). Unresolvable URLs are dropped;
 * absolute / `data:` / `http(s):` references pass through untouched.
 */
export function katexStylesheet(): string {
  if (cachedStylesheet !== null) return cachedStylesheet;
  try {
    // The installed package entry (katex/dist/katex.js under require
    // conditions); katex.min.css and fonts/ sit next to it. Resolving via
    // createRequire works from both src/ (tsx) and dist/ (tsc build).
    const entry = createRequire(import.meta.url).resolve("katex");
    const cssDir = dirname(entry);
    const css = readFileSync(join(cssDir, "katex.min.css"), "utf8");
    cachedStylesheet = css.replace(
      /url\(\s*(['"]?)([^'")]+?)\1\s*\)/g,
      (whole, _quote: string, ref: string) => {
        const target = ref.trim();
        if (
          target.startsWith("//") ||
          isAbsolute(target) ||
          /^(?:data:|https?:|blob:)/i.test(target)
        ) {
          return whole;
        }
        const abs = join(cssDir, target);
        if (!existsSync(abs)) return ""; // skip unresolvable url()
        const mime = FONT_MIME[extname(abs).toLowerCase()] ?? "application/octet-stream";
        return `url("data:${mime};base64,${readFileSync(abs).toString("base64")}")`;
      },
    );
  } catch {
    // katex is a hard dependency, so this should not happen; degrade to an
    // empty stylesheet rather than crash document generation.
    cachedStylesheet = "";
  }
  return cachedStylesheet;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Decode one `\\uXXXX` hex value to its character, or null for a control
 * char (C0/C1/DEL) that should vanish. Mirrors the worker's
 * _decoded_escape_char: supplementary code points come back as a JS
 * surrogate pair, so both halves ship in the output.
 */
function decodeUnicodeEscape(hex: string): string | null {
  const cp = parseInt(hex, 16);
  if (cp > 0xffff) {
    const hi = 0xd800 + ((cp - 0x10000) >> 10);
    const lo = 0xdc00 + ((cp - 0x10000) & 0x3ff);
    return String.fromCharCode(hi, lo);
  }
  if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) return null;
  return String.fromCharCode(cp);
}

// `\\u` + EXACTLY 4 hex digits (case-insensitive) + a following char that is
// NOT another hex digit. The optional trailing space is captured so a
// control-char removal can consume at most one adjacent space and the splice
// never doubles one. \\u{...} / \\u x accent uses never match.
const UNICODE_ESCAPE_RE = /\\u([0-9a-fA-F]{4})(?![0-9a-fA-F])( )?/g;

/**
 * Rule (a) of the JSON-escape decode: every decodable `\\uXXXX` becomes its
 * character (`\\u2014` → `—`, `\\u00e9` → é, `\\u2194` → ↔); control chars
 * decode to nothing, consuming at most one adjacent space. Input without a
 * `\\u` sequence is returned byte-identical with count 0. Idempotent: a
 * decoded char is never re-matched (a real em dash has no backslash).
 */
export function decodeUnicodeEscapes(
  tex: string,
): { text: string; count: number } {
  if (!tex.includes("\\u")) return { text: tex, count: 0 };
  let count = 0;
  let dropped = 0;
  let out = "";
  let last = 0;
  for (const m of tex.matchAll(UNICODE_ESCAPE_RE)) {
    count++;
    const at = m.index ?? 0;
    const trailing = m[2] ?? "";
    const ch = decodeUnicodeEscape(m[1]);
    out += tex.slice(last, at);
    if (ch !== null) {
      out += ch + trailing;
    } else {
      dropped++;
      const before = at > 0 ? tex[at - 1] : "";
      out += before && /\s/.test(before) ? "" : trailing;
    }
    last = at + m[0].length;
  }
  out += tex.slice(last);
  if (dropped) out = out.replace(/ {2,}/g, " ");
  return { text: out, count };
}
/**
 * Structural well-formedness gate applied before KaTeX ever sees a region.
 * Returns false when the tex has any of: an interior `$` (a mis-split
 * region), or unbalanced `{`/`}` (count mismatch, escaped pairs ignored). It
 * deliberately does NOT balance delimiter commands — kets (`|\psi\rangle`)
 * and norms (`|x\rvert`) are legitimately asymmetric (`\rangle` with no
 * `\langle` is valid math); delimiter truncation still degrades safely via
 * the existing throwOnError fallback. Such regions are
 * emitted as plain text instead — a mis-split `a$̲S_A$ = -b` or a truncated
 * `\left(\sum…` would otherwise surface to API users as a scary
 * `KaTeX parse error: …` warning.
 */
export function _isWellFormedMath(tex: string): boolean {
  if (tex.includes("$")) return false;
  let depth = 0;
  for (let i = 0; i < tex.length; i++) {
    const c = tex[i];
    if (c === "\\") { i++; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth < 0) return false; }
  }
  return depth === 0;
}

/**
 * Drop closing braces that have no matching opener; everything else is kept
 * byte-identical.
 *
 * Single left-to-right pass tracking brace depth (escaped braces are skipped
 * exactly like _isWellFormedMath: a `\\` consumes its following character).
 * Any `}` that would take the depth negative is an unmatched closer — the
 * classic LLM typo, real task 427f039f shipped `Q^* = \\dfrac{F}{p - c} - c}`
 * (2 opens, 3 closes), which fails the gate and degraded to a literal
 * `math-fallback` in the PDF — and is dropped, giving the intended
 * `Q^* = \\dfrac{F}{p - c} - c`. No closers are ever added, unmatched
 * OPENERS are left untouched (no guessing), and an already-balanced input
 * round-trips exactly.
 */
export function balanceBraces(tex: string): string {
  if (!tex.includes("}")) return tex;
  let out = "";
  let depth = 0;
  let changed = false;
  for (let i = 0; i < tex.length; i++) {
    const c = tex[i];
    if (c === "\\") {
      out += c;
      if (i + 1 < tex.length) {
        out += tex[i + 1];
        i++;
      }
      continue;
    }
    if (c === "{") {
      depth++;
      out += c;
    } else if (c === "}") {
      if (depth === 0) {
        changed = true;
        continue; // unmatched closer — drop it
      }
      depth--;
      out += c;
    } else {
      out += c;
    }
  }
  return changed ? out : tex;
}

/** Where a math region came from; decides whether the gate fallback is surfaced. */
export type MathKind = "equation" | "inline";

/**
 * Render TeX to an HTML fragment via KaTeX (`renderToString`,
 * `throwOnError: true`). Regions that fail the structural gate
 * (`_isWellFormedMath`) are returned as the escaped `math-fallback` span
 * WITHOUT touching KaTeX and without a scary `KaTeX parse error` warning.
 *
 * `kind` decides how the gate fallback is reported: `"equation"`
 * (display equation blocks, latex code blocks) pushes the diagnostic
 * `math fallback: unbalanced braces in equation — showing raw LaTeX`
 * into `warnings` (surfaced via the X-paperbot-warnings header); `"inline"`
 * (prose math segments) keeps the documented silent degradation.
 * Well-formed regions — including kets and norms — proceed to KaTeX; the
 * rare well-formed-but-KaTeX-rejects case still records `math: <message>`
 * in `warnings` and falls back.
 *
 * Before any of that, JSON-escape decode: a lone `\\uXXXX` whole region is
 * returned as the decoded plain-text char (no katex span, no fallback) and
 * everything else decodes every `\\u`+4-hex escape (`\\u2014` → `—`) with a
 * `decoded N \\uXXXX unicode escape(s)…` warning, so the breve-on-2014
 * artifact cannot reach KaTeX.
 */
export function renderMath(
  tex: string,
  display: boolean,
  warnings: string[],
  kind: MathKind = "inline",
): string {
  // A model thinking in JSON can emit a literal \\u2014 (backslash-u-2-0-1-4)
  // inside a $...$ region meaning the em dash. KaTeX natively defines \\u as
  // the breve accent, so \\u2014 typesets as "2"+bowl+"014" — the recovered
  // Langlands report rendered 2014 that way on PDF page 11, all the way
  // through the PDF text layer. A 4-hex run after \\u is unambiguously a
  // JSON-escape mistake, never an intended accent, so decode before the gate
  // and KaTeX; \\u{...} / \\u x (the real accent forms) never match.
  if (tex.includes("\\u")) {
    const lone = tex.trim().match(/^\\u([0-9a-fA-F]{4})(?![0-9a-fA-F])$/);
    if (lone) {
      // The whole equation is a single escape: prose, not math — return the
      // decoded char as plain text, no katex span, no fallback.
      warnings.push(
        `${kind}: lone \\u${lone[1]} unicode escape is not math; rendered as plain text`,
      );
      return escapeHtml(decodeUnicodeEscape(lone[1]) ?? "");
    }
    const decoded = decodeUnicodeEscapes(tex);
    if (decoded.count > 0) {
      warnings.push(
        `${kind}: decoded ${decoded.count} \\uXXXX unicode escape(s) that are not valid TeX`,
      );
      tex = decoded.text;
    }
  }
  if (!_isWellFormedMath(tex)) {
    if (kind === "equation") {
      warnings.push("math fallback: unbalanced braces in equation — showing raw LaTeX");
    }
    console.debug(`math: malformed region rendered as plain text (no KaTeX call): ${tex.slice(0, 60)}`);
    return `<span class="math-fallback">${escapeHtml(tex)}</span>`;
  }
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`math: ${msg}`);
    return `<span class="math-fallback">${escapeHtml(tex)}</span>`;
  }
}

// ---------------------------------------------------------------------------
// Math-delimiter tokenization
// ---------------------------------------------------------------------------

/** One slice of text after math extraction: plain text or a TeX group. */
export type MathSegment =
  | { kind: "text"; text: string }
  | { kind: "math"; tex: string; display: boolean };

/**
 * Remove every unescaped `$` (and therefore `$$`) from a string, preserving
 * `\$` (an escaped literal dollar). A display equation block is ONE pure
 * LaTeX region; inline `$…$` segments inside it are redundant model
 * artifacts (`F($\psi$) = …` -> `F(\psi) = …`) — see stripMathDelimiters for
 * the outer-delimiter case.
 */
export function _stripDollarDelimiters(tex: string): string {
  return tex.replace(/(?<!\\)\$/g, "");
}

/**
 * Strip one pair of `$$…$$` or `\[…\]` delimiters from a whole string (an
 * equation block). Returns the string unchanged when no pair wraps it.
 */
export function stripMathDelimiters(tex: string): string {
  const t = tex.trim();
  if (t.length > 4 && t.startsWith("$$") && t.endsWith("$$")) {
    return t.slice(2, -2).trim();
  }
  if (t.length > 4 && t.startsWith("\\[") && t.endsWith("\\]")) {
    return t.slice(2, -2).trim();
  }
  return t;
}

/**
 * Find the closing `$` of an inline group opened just before `open`,
 * applying the pandoc rules: no whitespace right after the opening `$`,
 * none right before the closing `$`, and the character after the closing
 * `$` must not be a digit (`$5 and $10` stays prose, not math).
 * Returns -1 when no valid closer exists.
 */
function findInlineClose(text: string, open: number): number {
  for (let j = open + 1; j < text.length; j++) {
    if (text.charAt(j) !== "$") continue;
    const before = text.charAt(j - 1);
    if (before === "$") continue; // second $ of a $$ pair, not a single $
    if (/\s/.test(before)) continue; // whitespace right before closing $
    const after = text.charAt(j + 1);
    if (after !== "" && /\d/.test(after)) continue; // digit after closing $
    return j;
  }
  return -1;
}

/**
 * Split text into text and math segments in a single left-to-right pass.
 *
 *   `\[` … `\]`   -> display math
 *   `$$` … `$$`   -> display math
 *   `$` … `$`     -> inline math (pandoc rules, see findInlineClose)
 *   `\\(` … `\\)` -> inline math
 *   `\\$`         -> a literal `$`
 *
 * Anything else — including markers without a valid closer — stays text.
 */
export function splitMath(text: string): MathSegment[] {
  const segments: MathSegment[] = [];
  let buf = "";
  const flushText = (): void => {
    if (buf !== "") {
      segments.push({ kind: "text", text: buf });
      buf = "";
    }
  };

  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text.charAt(i);

    // `\$` -> literal dollar sign.
    if (ch === "\\" && text.charAt(i + 1) === "$") {
      buf += "$";
      i += 2;
      continue;
    }

    // `\( … \)` -> inline math (unclosed marker stays text).
    if (ch === "\\" && text.charAt(i + 1) === "(") {
      const close = text.indexOf("\\)", i + 2);
      if (close !== -1) {
        flushText();
        segments.push({ kind: "math", tex: text.slice(i + 2, close), display: false });
        i = close + 2;
      } else {
        buf += ch;
        i += 1;
      }
      continue;
    }

    // `\[ … \]` -> display math (unclosed marker stays text).
    if (ch === "\\" && text.charAt(i + 1) === "[") {
      const close = text.indexOf("\\]", i + 2);
      if (close !== -1) {
        flushText();
        segments.push({ kind: "math", tex: text.slice(i + 2, close), display: true });
        i = close + 2;
      } else {
        buf += ch;
        i += 1;
      }
      continue;
    }

    // `$$ … $$` -> display math (an unclosed pair: one literal `$`).
    if (ch === "$" && text.charAt(i + 1) === "$") {
      const close = text.indexOf("$$", i + 2);
      if (close !== -1) {
        flushText();
        segments.push({ kind: "math", tex: text.slice(i + 2, close), display: true });
        i = close + 2;
      } else {
        buf += "$";
        i += 1;
      }
      continue;
    }

    // `$ … $` -> inline math, pandoc: no whitespace right after the opening
    // `$` (the closer rules are in findInlineClose).
    if (ch === "$") {
      const next = text.charAt(i + 1);
      if (next !== "" && !/\s/.test(next)) {
        const close = findInlineClose(text, i);
        if (close !== -1) {
          flushText();
          segments.push({ kind: "math", tex: text.slice(i + 1, close), display: false });
          i = close + 1;
          continue;
        }
      }
      buf += "$";
      i += 1;
      continue;
    }

    buf += ch;
    i += 1;
  }
  flushText();
  return segments;
}
