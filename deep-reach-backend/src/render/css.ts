/**
 * The full embedded <style> for generated documents.
 *
 * Print-first: body margin 0 (page margins come from page.pdf), serif body
 * with explicit CJK fallbacks, sans headings, small-caps table headers,
 * tinted callouts/panels, break-* rules for sane pagination.
 */
export const REPORT_CSS = `
:root {
  --ink: #202124;
  --ink-soft: #5f6368;
  --ink-faint: #9aa0a6;
  --rule: #d9dad5;
  --rule-soft: #e7e8e3;
  --accent: #3b6ea5;
  --tint-blue: #eef2f7;
  --tint-panel: #f6f6f4;
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
}

body {
  color: var(--ink);
  font-family: Charter, "Iowan Old Style", "Palatino Linotype", Georgia, "Times New Roman",
    "Noto Serif CJK SC", "Noto Serif CJK TC", "Hiragino Mincho ProN", "Yu Mincho", serif;
  font-size: 10.5pt;
  line-height: 1.65;
  orphans: 3;
  widows: 3;
  text-rendering: optimizeLegibility;
}

/* --- headings --- */

h1, h2, h3 {
  font-family: "Avenir Next", "Segoe UI", "Helvetica Neue", "Noto Sans CJK SC",
    "Noto Sans CJK TC", "Hiragino Sans", sans-serif;
  break-after: avoid;
  page-break-after: avoid;
}

h1 {
  font-size: 22pt;
  line-height: 1.25;
  font-weight: 700;
  letter-spacing: -0.01em;
  margin: 0 0 0.3em;
  color: #111213;
}

h2 {
  font-size: 15pt;
  line-height: 1.3;
  font-weight: 600;
  color: #1a1c1e;
  border-top: 1pt solid var(--rule);
  padding-top: 0.55em;
  margin: 1.7em 0 0.65em;
}

h3 {
  font-size: 12pt;
  line-height: 1.35;
  font-weight: 600;
  color: #2a2d30;
  margin: 1.3em 0 0.5em;
}

/* --- title area --- */

.title-area {
  border-bottom: 1.25pt solid #202124;
  padding-bottom: 1.1em;
  margin-bottom: 1.9em;
}

.subtitle {
  font-size: 13pt;
  color: var(--ink-soft);
  font-family: "Avenir Next", "Segoe UI", "Helvetica Neue", "Noto Sans CJK SC",
    "Noto Sans CJK TC", "Hiragino Sans", sans-serif;
  line-height: 1.4;
  margin: 0 0 0.9em;
}

.meta-line {
  font-family: "Avenir Next", "Segoe UI", "Helvetica Neue", "Noto Sans CJK SC",
    "Noto Sans CJK TC", "Hiragino Sans", sans-serif;
  font-size: 9.5pt;
  color: var(--ink-soft);
  margin: 0;
}

.meta-line .badge {
  display: inline-block;
  background: var(--tint-blue);
  color: #33415c;
  border: 0.75pt solid #c9d6e4;
  border-radius: 999px;
  padding: 1.5pt 9pt;
  font-size: 8.5pt;
  font-weight: 600;
  letter-spacing: 0.04em;
  margin-left: 4pt;
  vertical-align: 1pt;
}

/* --- executive summary --- */

.exec-summary {
  background: var(--tint-blue);
  border-radius: 4pt;
  padding: 0.9em 1.2em 0.45em;
  margin: 0 0 2.2em;
}

.exec-summary .label {
  font-family: "Avenir Next", "Segoe UI", "Helvetica Neue", "Noto Sans CJK SC",
    "Noto Sans CJK TC", "Hiragino Sans", sans-serif;
  font-variant: small-caps;
  letter-spacing: 0.1em;
  font-size: 10pt;
  font-weight: 600;
  color: #33415c;
  margin-bottom: 0.55em;
}

.exec-summary p {
  margin: 0 0 0.75em;
}

.exec-summary p:last-child {
  margin-bottom: 0.3em;
}

/* --- sections --- */

.doc-section {
  margin: 0 0 18pt;
}

/* --- tables --- */

table {
  border-collapse: collapse;
  table-layout: auto;
  width: 100%;
  margin: 1.1em 0;
  font-size: 9.5pt;
  line-height: 1.5;
  break-inside: avoid;
  page-break-inside: avoid;
}

table caption, .table-caption {
  caption-side: top;
  text-align: left;
  font-size: 9.5pt;
  font-style: italic;
  color: var(--ink-soft);
  padding: 0 0 4pt;
  word-wrap: break-word;
}

thead {
  display: table-header-group;
}

th {
  font-family: "Avenir Next", "Segoe UI", "Helvetica Neue", "Noto Sans CJK SC",
    "Noto Sans CJK TC", "Hiragino Sans", sans-serif;
  font-size: 9pt;
  font-variant: small-caps;
  letter-spacing: 0.05em;
  font-weight: 600;
  text-align: left;
  background: #f0f1ee;
  border-top: 1pt solid #c9cbc7;
  border-bottom: 1pt solid #c9cbc7;
  padding: 5pt 8pt;
  min-width: 3.5em;
  word-wrap: break-word;
  overflow-wrap: break-word;
}

td {
  padding: 5pt 8pt;
  border-bottom: 0.75pt solid var(--rule-soft);
  vertical-align: top;
  min-width: 3.5em;
  word-wrap: break-word;
  overflow-wrap: break-word;
}

tbody tr:nth-child(even) td {
  background: #fafaf8;
}

tr {
  break-inside: avoid;
  page-break-inside: avoid;
}

/* --- callouts --- */

.callout {
  border-left: 3px solid var(--accent);
  background: var(--tint-blue);
  padding: 7pt 12pt 6pt;
  margin: 1.1em 0;
  border-radius: 0 3pt 3pt 0;
  font-size: 10pt;
  break-inside: avoid;
  page-break-inside: avoid;
}

.callout p {
  margin: 0.35em 0;
}

.callout-title {
  display: block;
  font-family: "Avenir Next", "Segoe UI", "Helvetica Neue", "Noto Sans CJK SC",
    "Noto Sans CJK TC", "Hiragino Sans", sans-serif;
  font-size: 9.5pt;
  font-weight: 700;
  letter-spacing: 0.03em;
  margin-bottom: 2pt;
}

.callout.note    { border-color: #3b6ea5; background: #eef4fb; }
.callout.note .callout-title { color: #2c5382; }
.callout.warning { border-color: #b07d24; background: #fdf6e7; }
.callout.warning .callout-title { color: #8a611c; }
.callout.danger  { border-color: #c0392b; background: #fbeeec; }
.callout.danger .callout-title { color: #96271b; }
.callout.tip     { border-color: #2e8b57; background: #eefaf1; }
.callout.tip .callout-title { color: #23663f; }
.callout.info    { border-color: #5b5bd6; background: #f0f0fb; }
.callout.info .callout-title { color: #4343ad; }
.callout.key_insight { border-color: #8e44ad; background: #f7eef9; }
.callout.key_insight .callout-title { color: #6d3488; }

/* --- lists --- */

ul, ol {
  margin: 0.7em 0;
  padding-left: 1.6em;
}

ul { list-style: disc; }
ol { list-style: decimal; }

li {
  margin: 0.3em 0;
  break-inside: avoid;
  page-break-inside: avoid;
}

li > ul, li > ol {
  margin: 0.25em 0;
}

/* --- quotes --- */

.quote {
  border-left: 3px solid var(--rule);
  margin: 1.1em 0;
  padding: 3pt 14pt;
  font-style: italic;
  color: var(--ink-soft);
}

.quote p {
  margin: 0.3em 0;
}

/* --- code --- */

pre {
  background: #f6f6f4;
  border: 0.75pt solid var(--rule-soft);
  border-radius: 3pt;
  padding: 8pt 10pt;
  margin: 1.1em 0;
  font-family: "SF Mono", "JetBrains Mono", Menlo, Consolas, "Noto Sans Mono CJK SC", monospace;
  font-size: 8.5pt;
  line-height: 1.5;
  white-space: pre-wrap;
  word-wrap: break-word;
  overflow-wrap: anywhere;
  break-inside: avoid;
  page-break-inside: avoid;
}

code {
  font-family: "SF Mono", "JetBrains Mono", Menlo, Consolas, "Noto Sans Mono CJK SC", monospace;
  font-size: 0.92em;
}

/* --- citations --- */

.cite {
  margin-left: 1.5pt;
  white-space: nowrap;
}

.cite a {
  color: var(--accent);
  text-decoration: none;
}

/* --- references --- */

.references {
  margin-top: 1.2em;
}

.references ul {
  list-style: none;
  margin: 0;
  padding: 0;
}

.references li {
  break-inside: avoid;
  page-break-inside: avoid;
  margin: 0 0 8pt;
  font-size: 9pt;
  line-height: 1.5;
}

.ref-num {
  color: var(--ink-soft);
  margin-right: 5pt;
}

.ref-title {
  font-weight: 600;
}

.ref-detail {
  color: var(--ink-soft);
}

.ref-detail a, .ref-links a {
  color: var(--accent);
  text-decoration: none;
  word-wrap: break-word;
  overflow-wrap: anywhere;
}

.ref-links {
  color: var(--ink-soft);
}

/* --- figures / equations --- */

figure {
  margin: 1.2em 0;
  text-align: center;
  break-inside: avoid;
  page-break-inside: avoid;
}

figure img {
  max-width: 100%;
}

figcaption {
  font-size: 9pt;
  font-style: italic;
  color: var(--ink-soft);
  margin-top: 4pt;
}

.equation {
  margin: 1.1em 0;
  text-align: center;
  font-family: "STIX Two Math", "Cambria Math", "Times New Roman", serif;
  break-inside: avoid;
  page-break-inside: avoid;
}

/* --- page breaks --- */

.page-break {
  break-before: page;
  page-break-before: always;
  height: 0;
}
`;

/**
 * Companion rules for the math renderers (blocks.ts / math.ts). Kept apart
 * from REPORT_CSS so html.ts can pair it with katexStylesheet() (the KaTeX
 * stylesheet + inlined fonts) as a second embedded layer.
 */
export const MATH_CSS = `
/* --- math (KaTeX) --- */

.math-fallback {
  font-family: var(--mono, monospace);
  color: var(--faint, #888);
}

.equation .katex-display {
  margin: 1em 0;
}
`;
