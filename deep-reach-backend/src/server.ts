/**
 * HTTP API service: POST a report (JSON or markdown) -> rendered PDF/HTML bytes.
 *
 * Design: in-memory only — no output files, no servers of record. A single
 * shared Chromium instance is launched at startup (unless pdf: false) and
 * reused across renders. Responses are bytes with Content-Type and an
 * X-paperbot-warnings header.
 */
import { createRequire } from "node:module";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { z } from "zod";
import type { Browser } from "playwright";
import { documentSchema } from "./document.js";
import {
  EXIT_RENDER,
  prepareContent,
  type InputFormat,
  zodErrorMessage,
} from "./pipeline.js";
import {
  CHROMIUM_MISSING_MESSAGE,
  PaperbotError,
  chromiumAvailable,
  htmlToPdfBuffer,
  launchChromium,
  PAGE_FORMATS,
  type PageFormat,
} from "./pdf.js";
import { openapiSpec } from "./openapi.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
const VERSION: string = pkg.version;

export interface ServerOptions {
  /** Launch a shared Chromium at startup for PDF rendering (default true). */
  pdf?: boolean;
  /** Enable the pino request logger (default true). */
  logger?: boolean;
}

const OUTPUT_FORMATS = ["pdf", "html"] as const;
type OutputFormat = (typeof OUTPUT_FORMATS)[number];

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * filename slug: lowercased, non-alphanumeric runs collapsed to "_", leading/
 * trailing underscores trimmed, capped at 80 chars, "report" as fallback.
 */
export function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return s === "" ? "report" : s;
}

const badRequest = (reply: FastifyReply, error: string) => reply.code(400).send({ error });

/**
 * Create (but do not listen) the API app. Returns the Fastify instance so
 * tests can drive it with app.inject().
 */
export async function createServer(opts: ServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? true,
    bodyLimit: 10 * 1024 * 1024, // 10 MB -> fastify answers 413
    requestTimeout: 5 * 60 * 1000, // rendering big documents is slow
  });

  // ---- CORS (permissive: this is an internal rendering service) ----------
  // onSend runs before the response flushes, so these reach the wire. Do NOT
  // use onResponse: it fires on the socket 'finish' event, AFTER headers are
  // already sent, so reply.header() there silently no-ops.
  app.addHook("onSend", async (_req, reply) => {
    reply.header("access-control-allow-origin", "*");
    reply.header("access-control-allow-methods", "GET, POST, OPTIONS");
    reply.header("access-control-allow-headers", "content-type");
  });
  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "OPTIONS") reply.code(204).send();
  });

  // ---- Shared browser ------------------------------------------------------
  let browser: Browser | null = null;
  if (opts.pdf !== false) {
    try {
      browser = await launchChromium();
    } catch (err) {
      browser = null;
      app.log.warn(`chromium unavailable, PDF rendering disabled: ${msg(err)}`);
    }
  }
  app.addHook("onClose", async () => {
    if (browser !== null) await browser.close().catch(() => {});
  });

  // Markdown content types -> wrapped {markdown} body.
  const markdownParser = (
    _req: import("fastify").FastifyRequest,
    body: unknown,
    done: (err: Error | null, value?: { markdown: string }) => void,
  ) => done(null, { markdown: String(body) });
  app.addContentTypeParser("text/plain", { parseAs: "string" }, markdownParser);
  app.addContentTypeParser("text/markdown", { parseAs: "string" }, markdownParser);

  // ---- Routes ---------------------------------------------------------------
  app.get("/health", async (_req, reply) => {
    reply.send({
      service: "paperbot",
      version: VERSION,
      pdf_ready: browser !== null,
      chromium_available: chromiumAvailable(),
    });
  });

  app.get("/", async (_req, reply) => {
    reply.send({
      service: "paperbot",
      version: VERSION,
      endpoints: ["POST /render", "GET /health", "GET /openapi.json"],
      docs: "API.md",
    });
  });

  app.get("/openapi.json", async (_req, reply) => {
    reply.type("application/json").send(openapiSpec);
  });

  app.post("/render", async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;

    const queryFormat: string = q.format ?? "pdf";
    if (!OUTPUT_FORMATS.includes(queryFormat as OutputFormat)) {
      return badRequest(reply, `invalid format "${queryFormat}" (expected ${OUTPUT_FORMATS.join(" or ")})`);
    }
    const queryPageFormat = q.page_format ?? "letter";
    if (!(PAGE_FORMATS as readonly string[]).includes(queryPageFormat)) {
      return badRequest(
        reply,
        `invalid page_format "${queryPageFormat}" (expected ${PAGE_FORMATS.join(" | ")})`,
      );
    }
    const queryValidate = q.validate === undefined ? true : q.validate !== "false";
    const queryTitle = q.title !== undefined && q.title !== "" ? q.title : undefined;

    const body = req.body as unknown;
    const isRawDocument =
      isPlainObject(body) && "report" in body && !("document" in body) && !("markdown" in body);

    let content: string;
    let inputFormat: InputFormat;
    let title: string | undefined;
    let pageFormat: PageFormat;
    let validate: boolean;
    let outFormat: OutputFormat;

    if (isRawDocument) {
      // RAW shape: the document object itself; options from the query string.
      const parsed = documentSchema.safeParse(body);
      if (!parsed.success) return badRequest(reply, zodErrorMessage(parsed.error));
      content = JSON.stringify(body);
      inputFormat = "json";
      title = queryTitle;
      pageFormat = queryPageFormat as PageFormat;
      validate = queryValidate;
      outFormat = queryFormat as OutputFormat;
    } else {
      // WRAPPED shape: {document | markdown, options}
      const wrapped = z
        .object({
          document: z.unknown().optional(),
          markdown: z.string().optional(),
          format: z.enum(OUTPUT_FORMATS).optional(),
          page_format: z.enum([...PAGE_FORMATS]).optional(),
          title: z.string().optional(),
          validate: z.boolean().optional(),
        })
        .refine((v) => (v.document == null) !== (v.markdown == null), {
          message: 'exactly one of "document" or "markdown" must be provided',
        })
        .safeParse(body);
      if (!wrapped.success) {
        const issue = wrapped.error.issues[0];
        if (!issue) return badRequest(reply, "invalid request body");
        const field = issue.path[0];
        // Name the offending field for enum-style failures (zod's message
        // alone does not say which key it was).
        const message =
          field === "page_format" || field === "format"
            ? `invalid ${String(field)}: ${issue.message}`
            : issue.message;
        return badRequest(reply, message);
      }
      const w = wrapped.data;
      if (w.document !== undefined) {
        const parsed = documentSchema.safeParse(w.document);
        if (!parsed.success) return badRequest(reply, zodErrorMessage(parsed.error));
        content = JSON.stringify(w.document);
        inputFormat = "json";
      } else {
        content = w.markdown ?? "";
        inputFormat = "markdown";
      }
      // Body options win over query options when present.
      title = w.title !== undefined && w.title !== "" ? w.title : queryTitle;
      pageFormat = (w.page_format ?? queryPageFormat) as PageFormat;
      validate = w.validate ?? queryValidate;
      outFormat = (w.format ?? queryFormat) as OutputFormat;
    }

    try {
      const prepared = await prepareContent(content, inputFormat, "api", {
        outPath: "", // unused by prepareContent; kept for the PipelineOptions shape
        title,
        format: pageFormat,
        skipValidate: validate === false,
      });

      reply.header("x-paperbot-warnings", String(prepared.warnings.length));

      if (outFormat === "html") {
        reply.header("content-type", "text/html; charset=utf-8");
        return reply.send(prepared.html);
      }

      if (browser === null) {
        return reply.code(503).send({ error: CHROMIUM_MISSING_MESSAGE });
      }

      const buffer = await htmlToPdfBuffer(
        prepared.html,
        {
          format: pageFormat,
          expectedTitle: prepared.model.metadata.title,
          skipTextCheck: validate === false,
        },
        browser,
      );
      reply.header("content-type", "application/pdf");
      reply.header("content-disposition", `attachment; filename="${slugify(prepared.model.metadata.title)}.pdf"`);
      return reply.send(buffer);
    } catch (err) {
      if (err instanceof PaperbotError) {
        // EXIT_INPUT(1) / EXIT_USAGE(2) are caller mistakes -> 400;
        // EXIT_RENDER(3) is our rendering failure -> 500.
        const code = err.exitCode === EXIT_RENDER ? 500 : 400;
        return reply.code(code).send({ error: err.message });
      }
      app.log.error({ err }, "render failed");
      return reply.code(500).send({ error: "internal rendering error" });
    }
  });

  return app;
}

export { VERSION as SERVER_VERSION };
