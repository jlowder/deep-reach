# paperbot

Paperbot is a service that converts documents formatted as structured JSON (eg., the output of multi-agent-rag-researcher) into polished **PDF** or **HTML**.

This is accessible as a CLI tool and as an HTTP service.

## Install

```bash
npm install
npm run build
npx playwright install chromium   # one-time, ~170 MB
```

Requires Node ≥ 20 (uses the built-in test runner).

## CLI

```bash
node dist/cli.js <input> [options]
```

```
Input (exactly one):
  <input>                .json (structured report) or .md (markdown)
  -                      read the document from stdin (JSON or markdown, sniffed)

Options:
  -o, --out <path>       output PDF file (default: out/<input-basename>.pdf)
  --format <fmt>         letter | a4 | legal | a5 | tabloid (default: letter)
  --title <text>         override the document title
  --keep-html[=path]     also write the intermediate HTML; path in
                         "--keep-html=path" or "--keep-html path" form
                         (default: output path with .html)
  --no-validate          skip the post-render pdf-parse text check
  --quiet                suppress non-essential output
  -h, --help             show usage (wins over other errors, exit 0)
```

A second positional argument is a usage error:
`✗ unexpected extra argument 'b.json' (expected exactly one input file)`.

Exit codes: `0` ok · `1` input error (missing file, empty stdin, bad JSON,
schema violation) · `2` usage error (unknown flag, bad value, two inputs)
· `3` PDF/render failure (includes "Chromium not installed" with the install
command).

Example:

```bash
$ node dist/cli.js "my_report_20260101_120000.json"
✓ Wrote out/my_report_20260101_120000.pdf, 9 pages, 2 warnings
```

Markdown also works from a pipe: `cat report.md | node dist/cli.js - --out out/report.pdf`.

## Input format

JSON documents follow the deep-research agent's schema (see
`src/document.ts` — zod, lenient on dirt, strict on shape):

```jsonc
{
  "schema_version": "1.0",
  "report": {
    "metadata": { "title": "…", "author": "…", "generated_at": "ISO-8601",
                  "report_type": "deep_research" },
    "executive_summary": [ "plain string" ],
    "sections": [
      { "id": "s1", "heading": "…", "blocks": [
          { "type": "paragraph",        "spans": [ { "text": "… [W2]", "citations": [2] } ] },
          { "type": "heading",          "text": "Sub-heading", "level": 3 },
          { "type": "unordered_list",   "items": [ { "text": "…", "citations": [1] } ] },
          { "type": "ordered_list",     "items": [ { "text": "…" } ] },
          { "type": "comparison_table", "caption": "…", "columns": ["…"], "rows": [[ { "text": "…", "citations": [3] } ]] },
          { "type": "code_block",       "language": "python", "text": "…" },
          { "type": "callout",          "callout_type": "key_insight", "callout_title": "…", "spans": [ { "text": "…" } ] },
          { "type": "page_break" }
      ] }
    ],
    "sources": [ { "id": "s01", "title": "…", "URL": "…",
                   "citation_key": "W1", "author": "…", "issued": "2024" } ]
  }
}
```

`callout_type` is a strict enum: `note` | `warning` | `danger` | `tip` |
`info` | `key_insight` — any other value is a schema error naming the value.

Every string that reaches the HTML is escaped (`<`, `>`, `&`, quotes) at
render time. Bracket markers like `[W1]` / `[D6]` embedded in text resolve
against `sources[].citation_key` (case-insensitive) and are **always**
stripped from the visible text; the `citations` array on spans/cells/items
resolves positionally into `sources[]` (1-based). Each resolved source
becomes a `<sup>` anchor into the reference list (`<li id="src-N">`), so
PDF readers get clickable, bidirectional citations.

Markdown input maps straightforwardly: first H1 → title, `## Executive
Summary` → summary panel, other H2 → sections, H3+ → sub-headings, plus
lists, GFM tables, code fences, blockquotes (→ note callouts), and `---`
(→ page break).

## Citation algorithm

Per span/cell/item, exactly what `src/citations.ts` does:

1. **Numeric refs** in the `citations` array resolve 1-based *positionally*
   into `report.sources`: `2` or `"2"` → the second source, when
   `1 ≤ n ≤ sources.length`. Non-numeric strings get a lenient fallback
   (match `citation_key`, then `id`, both case-insensitive).
2. **Bracket markers** in the text — `…[W4]` / `…[D12]`
   (regex `\[(?:W|D)\d+\]`, case-insensitive) — resolve via
   `sources[].citation_key`.
3. **All bracket markers are stripped from visible text**, resolved or not.
   The superscript label is each resolved source's 1-based array position,
   deduped, sorted ascending, comma-joined (`[2,3]`).

Unresolvable references **never fail the build**; they aggregate into two
warnings (`N unresolvable citation references …`, `N citation marker(s)…`).
Spans/cells/items left with no visible content after stripping are dropped
(16 in the GP example); empty cells stay empty. One `CitationResolver`
instance serves the whole document, so the warning counts are document-wide.

## Layout & styling

All CSS is embedded in the generated HTML (`src/render/css.ts`): serif
(Charter/Georgia + CJK fallbacks) body at 10.5 pt, sans display, letter-spaced
overline labels, 1 pt rules, zebra-striped tables with `break-inside: avoid`
and repeated `thead`, page-number footer, and page-break rules (headings keep
with next block). Six callout variants, each with its own color:
`note` (blue), `warning` (amber), `danger` (red), `tip` (green), `info`
(indigo), `key_insight` (violet). Design language follows the reference spec
in `pdfgen.md`.

## Tests

```bash
npm test
```

## API server

```bash
npm run serve            # dev (tsx)
```

Environment: `PORT` (default `8322`), `HOST` (default `0.0.0.0`).

`POST /render` accepts a report envelope — wrapped
`{document | markdown, format, page_format, title, validate}` or raw —
plus markdown via `text/plain` / `text/markdown` — and responds with PDF or
HTML **bytes** (with `X-Paperbot-warnings`; PDF adds a slugified
`Content-Disposition`). A shared Chromium renders all requests; nothing is
written to disk. Also `GET /health`, `GET /`, `GET /openapi.json`.

Full reference: [API.md](./API.md).
