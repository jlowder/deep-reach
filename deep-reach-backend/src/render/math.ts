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
// Late-backslash restore (mirror of the worker's _restore_late_backslash,
// task 10b502cf defect B)
// ---------------------------------------------------------------------------

// Control chars a JSON decode can produce where the model meant a LaTeX
// command: the model writes a SINGLE backslash in its JSON (\\times), the
// parser consumes it as the escape, and the letter the escape names (t) is
// gone with it — the decoded text is <TAB>imes. Map each C0 escape to the
// letter it consumes.
const CONTROL_ESCAPE_LETTER: Record<string, string> = {
  "\t": "t",
  "\n": "n",
  "\r": "r",
  "\f": "f",
  "\b": "b",
  "\v": "v",
};

// Known LaTeX commands whose first letter is a JSON-escape letter (the full
// family is listed for documentation; only entries whose first letter is a
// control-escape letter can ever match — the JSON escape letters are
// lowercase, so Re/Im are unreachable). Same set as the worker.
const LATEX_COMMAND_TAILS = [
  "times", "text", "theta", "tau", "tan", "nu", "nabla", "neq", "nint",
  "not", "rho", "rangle", "right", "rceil", "rfloor", "frac", "forall",
  "leq", "geq", "approx", "equiv", "pm", "cdot", "sqrt", "sum", "int",
  "oint", "infty", "ldots", "dots", "alpha", "beta", "gamma", "delta",
  "epsilon", "zeta", "eta", "iota", "kappa", "lambda", "mu", "xi", "pi",
  "sigma", "phi", "chi", "psi", "omega", "partial", "exists", "cup", "cap",
  "vee", "wedge", "mapsto", "sim", "propto", "le", "ge", "mid", "ang",
  "deg", "hbar", "ell", "Re", "Im", "sin", "cos", "log", "exp", "min",
  "max", "lim", "arg", "mod", "bar",
];

// Escape letter -> command tails that follow the control char (the command
// minus the letter the escape consumed), longest first so a specific
// command (nabla) wins over a prefix (nu).
const ESCAPE_TAILS: Record<string, string[]> = {};
const ESCAPE_LETTERS = new Set(Object.values(CONTROL_ESCAPE_LETTER));
for (const cmd of LATEX_COMMAND_TAILS) {
  const first = cmd[0];
  if (ESCAPE_LETTERS.has(first) && first === first.toLowerCase()) {
    (ESCAPE_TAILS[first] ??= []).push(cmd.slice(1));
  }
}
for (const letter of Object.keys(ESCAPE_TAILS)) {
  ESCAPE_TAILS[letter].sort((a, b) => b.length - a.length);
}

/**
 * Restore LaTeX commands whose backslash a JSON decode consumed (worker
 * `_restore_late_backslash` mirror). Where the model meant `\\times` in its
 * JSON it sometimes wrote a single `\\t`; the parser turned that into a TAB
 * and the `t` left with it — the decoded text reads `<TAB>imes` (the PDF of
 * task 10b502cf typeset an italic `imes`: KaTeX saw the tab as a math space
 * and the identifier after it). At each control char, if the escape letter
 * + the following text form a known command and the char after the tail is
 * a non-word char (or end) — the control char becomes backslash + escape
 * letter (`<TAB>imes ` -> `\\times `). Fails forward (a real paragraph
 * break before `use` stays byte-identical); idempotent; never throws.
 *
 * This is the paperbot's defense for reports produced by a worker that
 * predates the assembly pass (e.g. the delivered 10b502cf report): the
 * count feeds the aggregate warning so a re-rendered legacy report surfaces
 * what it repaired.
 */
export function restoreLateBackslash(
  text: string,
): { text: string; restored: number } {
  if (text === "" || !/[\t\n\r\f\b\v]/.test(text)) return { text, restored: 0 };
  let restored = 0;
  let out = "";
  let last = 0;
  const n = text.length;
  let i = 0;
  while (i < n) {
    const letter = CONTROL_ESCAPE_LETTER[text.charAt(i)];
    if (letter === undefined) {
      i += 1;
      continue;
    }
    let matched = false;
    for (const tail of ESCAPE_TAILS[letter] ?? []) {
      const at = i + 1;
      if (at + tail.length > n) continue;
      if (text.slice(at, at + tail.length) !== tail) continue;
      const after = text.charAt(at + tail.length);
      if (after !== "" && /[A-Za-z0-9]/.test(after)) continue; // mid-word
      out += text.slice(last, at - 1) + "\\" + letter;
      last = at;
      i = at + tail.length;
      restored += 1;
      matched = true;
      break;
    }
    if (!matched) i += 1;
  }
  out += text.slice(last);
  return { text: out, restored };
}

/**
 * Per-event warning marker pushed by the restore call sites; the block
 * renderer aggregates the per-block count into a single
 * `math: restored N backslash(es) a JSON decode consumed` entry (one-entry-
 * per-event-type, like the missing-period marker).
 */
export const LATE_BACKSLASH_RESTORED_MARK = "math: restored a backslash a JSON decode consumed";

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
 *
 * After the decode, case-fold repair: an undefined UPPERCASE command whose
 * lowercase form IS defined (`\\VEE` → `\\vee`, `\\MATHBB` → `\\mathbb`) is a
 * model case mistake — KaTeX 0.18 is case-sensitive, so it would otherwise
 * throw and fall back. Each distinct name is folded once with a surfaced
 * `case-folded undefined command …` warning; a name whose lowercase form is
 * also undefined (`\\MATHRBUN`) is left untouched and rides the existing
 * fallback. Folding rewrites names only, so the structural gate result is
 * unchanged and well-formed regions proceed to KaTeX either way.
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
  // Case-fold repair (after the \\u decode, before the gate): an undefined
  // UPPERCASE command whose lowercase form is defined (\\VEE → \\vee) is a
  // model case mistake, not a real TeX entity. All-lowercase tex skips the
  // pass entirely (byte-identical fast path).
  if (/[A-Z]/.test(tex)) {
    tex = _caseFoldUndefinedCommands(tex, warnings, kind);
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
// Case-fold repair
// ---------------------------------------------------------------------------

// Per-process memo of KaTeX command defined-ness. The probe renders `\\NAME`
// followed by four neutral `{}` groups: every 0-, 1-, and 2-argument command
// (\vee, \mathrm, \frac …) renders its empty braced groups as empty atoms, so
// the probe succeeds iff the command is defined. Commands requiring a
// following delimiter character (\left, \right) probe as undefined — a
// conservative miss: such tokens are left untouched and fall to the existing
// fallback rather than risking a misfold.
const commandDefined = new Map<string, boolean>();

/** Is `\\NAME` a command KaTeX accepts? Probed lazily, memoized per name. */
export function _isCommandDefined(name: string): boolean {
  let defined = commandDefined.get(name);
  if (defined === undefined) {
    try {
      katex.renderToString(`\\${name}{}{}{}{}`, {
        throwOnError: true,
        strict: false,
      });
      defined = true;
    } catch {
      defined = false;
    }
    commandDefined.set(name, defined);
  }
  return defined;
}

/**
 * Rewrite `\\NAME` tokens to `\\name` where NAME is alphabetic, contains an
 * uppercase letter, is UNDEFINED in KaTeX, and its lowercase form IS defined
 * (`\\VEE` → `\\vee`, `\\MATHBB` → `\\mathbb`, `\\FRAC` → `\\frac`). One
 * `case-folded undefined command \\NAME → \\name` warning is pushed per
 * distinct folded name. Names whose lowercase form is also undefined
 * (`\\MATHRBUN`) — and already-correct lowercase names — are never touched.
 * All-lowercase input returns byte-identical with zero warnings.
 */
export function _caseFoldUndefinedCommands(
  tex: string,
  warnings: string[],
  kind: MathKind = "inline",
): string {
  if (!/[A-Z]/.test(tex)) return tex;
  const folds = new Map<string, string>();
  for (const m of tex.matchAll(/\\([A-Za-z]+)/g)) {
    const name = m[1];
    if (!/[A-Z]/.test(name)) continue;
    const lower = name.toLowerCase();
    if (folds.has(lower)) continue; // one warning + one rewrite per name
    if (!_isCommandDefined(name) && _isCommandDefined(lower)) {
      folds.set(lower, name);
      warnings.push(
        `${kind}: case-folded undefined command \\${name} → \\${lower}`,
      );
    }
  }
  if (folds.size === 0) return tex;
  let out = tex;
  for (const [lower, upper] of folds) {
    out = out.replace(new RegExp(`\\\\${upper}`, "g"), `\\${lower}`);
  }
  return out;
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
