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
 * Render TeX to an HTML fragment via KaTeX (`renderToString`,
 * `throwOnError: true`). Regions that fail the structural gate
 * (`_isWellFormedMath`) are returned as the escaped `math-fallback` span
 * WITHOUT touching KaTeX and WITHOUT a scary warning — malformed model math
 * degrades to plain text silently. Well-formed regions — including kets and
 * norms — proceed to KaTeX; the rare well-formed-but-KaTeX-rejects case still
 * records `math: <message>` in `warnings` and falls back.
 */
export function renderMath(tex: string, display: boolean, warnings: string[]): string {
  if (!_isWellFormedMath(tex)) {
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
