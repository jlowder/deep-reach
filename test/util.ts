import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { main, type Printer } from "../src/cli.js";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, "..");
export const EXAMPLES_DIR = join(ROOT, "examples");
export const FIXTURES_DIR = join(here, "fixtures");

export const DJ_EXAMPLE = join(
  EXAMPLES_DIR,
  "i want to explore the idea of creating an application that u_20260826_123424.json",
);
export const GP_EXAMPLE = join(EXAMPLES_DIR, "make a report on genetic programming_20260826_111539.json");

/** A Writable that accumulates everything written to it. */
export class CaptureStream extends Writable {
  chunks: Buffer[] = [];
  get data(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error) => void): void {
    this.chunks.push(Buffer.from(typeof chunk === "string" ? chunk : chunk));
    cb();
  }
}

export interface CliRunResult {
  code: number;
  out: string;
  err: string;
}

/** Run the CLI in-process with captured streams. */
export async function runCli(args: string[], opts: { cwd?: string } = {}): Promise<CliRunResult> {
  const out = new CaptureStream();
  const err = new CaptureStream();
  const printer: Printer = { out, err };
  const code = await main({ argv: args, printer, cwd: opts.cwd ?? ROOT });
  return { code, out: out.data, err: err.data };
}

/** Create a uniquely-named temp file with the given content. */
export function tempFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "paperbot-"));
  const p = join(dir, name);
  writeFileSync(p, content, "utf8");
  return p;
}
