/**
 * OpenAPI 3.1 document for the Paperbot API (served at GET /openapi.json).
 * Compact and hand-written — small surface, no generator.
 */
import { createRequire } from "node:module";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

const PAGE_FORMAT_VALUES = ["letter", "a4", "legal", "a5", "tabloid"];

const jsonError = {
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/Error" },
    },
  },
};

export const openapiSpec = {
  openapi: "3.1.0",
  info: {
    title: "Paperbot API",
    version: pkg.version,
    description:
      "Render structured research documents (JSON or Markdown) into polished PDF or HTML bytes, in memory, with no files written.",
  },
  servers: [{ url: "/" }],
  paths: {
    "/health": {
      get: {
        summary: "Service health",
        operationId: "health",
        responses: {
          "200": {
            description: "Service status, including whether a PDF-rendering browser is available.",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
    "/": {
      get: {
        summary: "Service index",
        operationId: "index",
        responses: {
          "200": {
            description: "Service name, version, and endpoint list.",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
    "/openapi.json": {
      get: {
        summary: "This OpenAPI document",
        operationId: "openapi",
        responses: {
          "200": {
            description: "The OpenAPI 3.1 specification.",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
    "/render": {
      post: {
        summary: "Render a document to PDF or HTML bytes",
        operationId: "render",
        description: [
          "Two input shapes are accepted:",
          "",
          '1. WRAPPED: a JSON body {document?, markdown?, format?, page_format?, title?, validate?}. Exactly one of `document` (a Paperbot document object with a top-level "report" key) or `markdown` (a raw markdown string) must be present. Output format defaults to "pdf".',
          "",
          '2. RAW: the document object itself (top-level "report" key, no document/markdown keys) as the JSON body. For this shape the output format comes from the ?format= query parameter (pdf|html, default pdf) and title/page_format/validate from query parameters.',
          "",
          'Content-Types text/plain and text/markdown are treated as a raw markdown body. The response carries an X-paperbot-warnings header with the warning count; PDF responses add Content-Disposition with a slugified filename.',
        ].join("\n"),
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  { $ref: "#/components/schemas/WrappedRequest" },
                  { $ref: "#/components/schemas/Document" },
                ],
              },
            },
            "text/plain": { schema: { $ref: "#/components/schemas/MarkdownBody" } },
            "text/markdown": { schema: { $ref: "#/components/schemas/MarkdownBody" } },
          },
        },
        parameters: [
          {
            name: "format",
            in: "query",
            schema: { type: "string", enum: ["pdf", "html"], default: "pdf" },
            description: "Output format. Used for the RAW shape; for the WRAPPED shape the body's format field wins when present.",
          },
          {
            name: "page_format",
            in: "query",
            schema: { type: "string", enum: PAGE_FORMAT_VALUES, default: "letter" },
          },
          { name: "title", in: "query", schema: { type: "string" } },
          { name: "validate", in: "query", schema: { type: "boolean", default: true } },
        ],
        responses: {
          "200": {
            description:
              "Rendered bytes: application/pdf when format=pdf (with Content-Disposition), text/html; charset=utf-8 when format=html.",
            headers: {
              "X-Paperbot-Warnings": {
                schema: { type: "string" },
                description: "Number of non-fatal rendering warnings.",
              },
            },
          },
          "400": { description: "Invalid document or request parameters.", ...jsonError },
          "413": { description: "Request body exceeds the 10 MB limit." },
          "500": { description: "Rendering or PDF generation failed.", ...jsonError },
          "503": { description: "PDF requested but no Chromium browser is available.", ...jsonError },
        },
      },
    },
  },
  components: {
    schemas: {
      Document: {
        type: "object",
        description: "A Paperbot document (the multi-agent report envelope).",
        properties: {
          schema_version: { type: "string" },
          report: {
            type: "object",
            description: "Report: metadata, executive_summary, sections, sources.",
          },
          quality: { type: "object" },
        },
        required: ["report"],
      },
      WrappedRequest: {
        type: "object",
        properties: {
          document: { $ref: "#/components/schemas/Document" },
          markdown: { type: "string", description: "Raw markdown source." },
          format: { type: "string", enum: ["pdf", "html"], default: "pdf" },
          page_format: { type: "string", enum: PAGE_FORMAT_VALUES, default: "letter" },
          title: { type: "string" },
          validate: { type: "boolean", default: true },
        },
      },
      MarkdownBody: {
        type: "string",
        description: "Raw markdown (send with Content-Type text/plain or text/markdown).",
      },
      Error: {
        type: "object",
        properties: { error: { type: "string" } },
        required: ["error"],
      },
    },
  },
};
