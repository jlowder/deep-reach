# Paperbot API

HTTP service: POST a structured document (JSON or Markdown) and receive a
polished **PDF** or **HTML** as the response body. Everything is in-memory —
the service never writes files; the response *is* the deliverable. A single
Chromium instance is shared across requests and launched at startup.

## Running

```bash
npm run build            # first time only
npm run serve            # dev (tsx, runs source)
```

Environment: `PORT` (default `8322`), `HOST` (default `0.0.0.0`).

PDF rendering needs Playwright Chromium (`npx playwright install chromium`).
If it is missing at startup the service still starts — `/health` reports
`pdf_ready: false` and PDF renders answer **503**.

Machine-readable contract: `GET /openapi.json` (OpenAPI 3.1).

## Endpoints

| Method | Path            | Purpose                                              |
| ------ | --------------- | ---------------------------------------------------- |
| POST   | `/render`       | Render a document → PDF or HTML bytes                |
| GET    | `/health`       | `{service, version, pdf_ready, chromium_available}`  |
| GET    | `/`             | Service index (name, version, endpoint list)         |
| GET    | `/openapi.json` | OpenAPI 3.1 specification                            |

All responses carry CORS headers (`Access-Control-Allow-Origin: *`, methods
`GET, POST, OPTIONS`, allowed header `content-type`); `OPTIONS` preflights
are answered 204.

## POST /render

Body limit: **10 MB** (over → `413 Payload Too Large`). Request timeout:
5 minutes.

### Request shapes

**1. Wrapped** — a JSON object with an explicit envelope. Exactly one of
`document` / `markdown` is required (both or neither → 400):

```json
{
  "document": { "report": { "...": "see Document contract below" } },
  "format": "pdf",
  "page_format": "letter",
  "title": "Optional title override",
  "validate": true
}
```

| Field         | Type                                | Default  |
| ------------- | ----------------------------------- | -------- |
| `document`    | object                              | —        |
| `markdown`    | string                              | —        |
| `format`      | `"pdf"` \| `"html"`                 | `"pdf"`  |
| `page_format` | `letter`\|`a4`\|`legal`\|`a5`\|`tabloid` | `"letter"` |
| `title`       | string                              | —        |
| `validate`    | boolean                             | `true`   |

**2. Raw document** — the document object itself as the JSON body (detected
by a top-level `report` key and no `document`/`markdown` keys). Options come
from the **query string** instead:

```
POST /render?format=pdf&page_format=a4&title=My%20Title&validate=true
```

**3. Raw markdown** — body with `Content-Type: text/plain` or
`text/markdown`; treated as a markdown document (same query params).

Query parameters (raw shapes; body fields win when present):

| Name          | Values                                            | Default    |
| ------------- | ------------------------------------------------- | ---------- |
| `format`      | `pdf` \| `html`                                   | `pdf`      |
| `page_format` | `letter` \| `a4` \| `legal` \| `a5` \| `tabloid`  | `letter`   |
| `title`       | free text                                         | —          |
| `validate`    | `true` \| `false` (string)                        | `true`     |

`validate: false` skips the PDF text-layer title check (use when the title
gets clipped in the output).

### Document contract (the `document` field)

Envelope: `{ schema_version?, report, quality? }` (`quality` is a free-form
object, ignored by rendering). `report`:

- **`metadata`** — `title` (required); optional `subtitle`, `query`,
  `session_id`, `generated_at`, `author`, `report_type`.
- **`executive_summary`** — `string[]` (default `[]`), rendered as the
  executive-summary block.
- **`sections`** — required array of `{ id?, heading, blocks }` (`heading`
  required; `blocks` may be `[]`).
- **`sources`** — array of
  `{ id?, type?, title, author?, issued?, url | URL?, publisher?,
  doi | DOI?, citation_key?, accessed? }` — only `title` is required.
  `author` may be a string or string array. Numeric citations resolve to
  1-based array positions; string citations and bracket markers like `[W4]`
  resolve to `citation_key`.

**Blocks** (any order inside `sections[].blocks`; unknown `type` values are
kept and rendered as paragraphs when they carry text):

| Type                        | Fields                                                                     |
| --------------------------- | -------------------------------------------------------------------------- |
| `heading`                   | `text`, `level?` (default 3)                                               |
| `paragraph`, `quote`        | `spans: [{text, citations?}]` (span `text` may be a plain string)          |
| `callout`                   | `spans` + `callout_type` (`note`\|`warning`\|`danger`\|`tip`\|`info`\|`key_insight`, default `note`) + `callout_title?` |
| `citation_note`             | `spans` — verbatim, no citation resolution; `callout_title?`               |
| `comparison_table`          | `columns: string[]`, `rows: (string \| {text, citations?})[][]`, `caption?` |
| `ordered_list` / `unordered_list` | `items: [{text, citations?}]`                                            |
| `code_block`                | `text`, `language?` (`"latex"`/`"tex"` renders as a typeset equation)      |
| `figure`                    | `caption`, `url` or `src`                                                  |
| `equation`                  | `text`, `language?` (`"latex"`/`"tex"` → KaTeX; other → literal div)       |
| `page_break`                | —                                                                          |
| `source_list`, `appendix`   | paragraph-style aliases (`spans`)                                          |

Span `citations`: numbers are 1-based source indices, strings are
`citation_key`s.

**Math**: inline `$…$`, `\(…\)`, `\[…\]` in span text; `equation` blocks with
`language: "latex"|"tex"`. KaTeX CSS *and all fonts* are inlined into the
HTML, so renders work fully offline.

Valid examples: `test/fixtures/tiny.json`, `test/fixtures/unicode.json`,
`examples/*.json`.

### Response

**200** — the rendered bytes:

- `format=pdf`: `Content-Type: application/pdf`,
  `Content-Disposition: attachment; filename="<slug>.pdf"` (title
  lowercased, non-alphanumeric runs → `_`, leading/trailing `_` trimmed,
  capped at 80 chars, fallback `report.pdf`), `X-Paperbot-warnings: <n>`.
- `format=html`: `Content-Type: text/html; charset=utf-8`,
  `X-Paperbot-warnings: <n>`.

**Errors** — JSON `{"error": "<message>"}`:

| Status | When                                                                                       |
| ------ | ------------------------------------------------------------------------------------------ |
| 400    | Malformed JSON (fastify `FST_ERR_CTP_INVALID_JSON_BODY`); both/neither `document`+`markdown`; document schema violation (zod details, e.g. `document validation failed:\n  - report.sections: Required`); invalid `format`/`page_format` |
| 413    | Body over 10 MB                                                                             |
| 500    | Rendering or PDF generation failure (internal error message)                                |
| 503    | PDF requested but Chromium unavailable: `Chromium is not installed. Run: npx playwright install chromium` |

### Warnings

Non-fatal issues still produce a 200 body; the count is in
`X-Paperbot-warnings` (messages go to the server log). Examples:

- `36 unresolvable citation references (numeric index out of range for 18 sources)`
- `7 citation marker(s) without a matching source citation_key (stripped)`
- `citation 42 has no source anchor`
- `math: <KaTeX error message>` (the offending formula falls back to visible escaped text)

### Examples

```bash
# PDF from a report envelope (raw shape)
curl -sS -o report.pdf -H 'content-type: application/json' \
  -d @report.json 'http://localhost:8322/render?format=pdf'

# A4 HTML with a title override
curl -sS -o report.html -H 'content-type: application/json' \
  -d @report.json 'http://localhost:8322/render?format=html&page_format=a4&title=My%20Title'

# Markdown
curl -sS -o report.html -H 'content-type: text/markdown' \
  -d @notes.md 'http://localhost:8322/render?format=html'

# Wrapped shape
curl -sS -o report.pdf -H 'content-type: application/json' \
  -d '{"document": {"report": {"metadata": {"title": "T"}, "sections": []}}, "format": "pdf"}' \
  http://localhost:8322/render
```

## Programmatic use (skip HTTP)

The server is a thin shell over the same functions an app can import
directly from the built package (`main` → `dist/pipeline.js`):

```js
import { prepareContent } from "paperbot";            // document -> {model, html, warnings}
import { htmlToPdfBuffer, validatePdfBuffer } from "paperbot/dist/pdf.js";

const { html, model, warnings } = await prepareContent(json, "json", "api", {
  outPath: "", title: "Override", format: "a4", skipValidate: false,
});
const pdf = await htmlToPdfBuffer(html, { format: "a4", expectedTitle: model.metadata.title });
```

Note the package's `exports` map only exposes `.`; subpaths like
`paperbot/dist/pdf.js` are importable within this repo (the package is
`private`).
