#!/usr/bin/env node
/**
 * paperbot CLI
 *
 *   paperbot [convert] <input> [options]
 *
 * Exit codes: 0 ok | 1 input error | 2 usage error | 3 render/PDF failure
 * (including missing Chromium).
 */
import { isAbsolute, resolve } from "node:path";
import type { Writable } from "node:stream";
import {
  EXIT_INPUT,
  EXIT_OK,
  EXIT_USAGE,
  defaultOutPath,
  run,
  type PipelineOptions,
} from "./pipeline.js";
import { PAGE_FORMATS, type PageFormat } from "./pdf.js";

export interface Printer {
  out: Writable;
  err: Writable;
}

const defaultPrinter: Printer = { out: process.stdout, err: process.stderr };

export const USAGE = `paperbot — convert structured research documents to polished PDFs

Usage:
  paperbot [convert] <input> [options]

Input (exactly one):
  <input>                .json (structured research document) or .md (markdown)
  -                      read the document from stdin (JSON or markdown, sniffed)
  "convert"              optional no-op subcommand, e.g. "paperbot convert x.json"

Options:
  -o, --out <path>       Output PDF path (default: out/<input-basename>.pdf)
      --format <fmt>     Page format: letter | a4 | legal | a5 | tabloid
                         (default: letter)
      --title <str>      Override the document title
      --keep-html[=path] Also write the intermediate HTML; the path may follow
                         in "--keep-html=path" or "--keep-html path" form
                         (default path: output .pdf with .html)
      --no-validate      Skip the pdf-parse text validation of the PDF
      --quiet            Suppress warnings and the success summary
  -h, --help             Show this help and exit (wins over other errors)

Exit codes:
  0  success
  1  input error (missing file, bad JSON, validation failure, empty stdin)
  2  usage error (unknown flag, bad value, more than one input file)
  3  render/PDF failure (including missing Chromium)

Examples:
  paperbot "examples/report.json" -o out/report.pdf
  paperbot report.md --format a4 --title "My Report"
  paperbot --keep-html /tmp/report.html report.json
  cat report.md | paperbot -`;

interface ParsedArgs {
  input?: string;
  out?: string;
  format?: PageFormat;
  title?: string;
  keepHtmlPath?: string;
  skipValidate: boolean;
  quiet: boolean;
  help: boolean;
  usageErrors: string[];
}

/** Hand-rolled argv parsing (no dependencies). */
export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    skipValidate: false,
    quiet: false,
    help: false,
    usageErrors: [],
  };
  let positional = 0;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eqSplit = arg.split("=");

    switch (eqSplit[0]) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "-o":
      case "--out": {
        const value = eqSplit[1] ?? (i + 1 < argv.length ? argv[++i] : undefined);
        if (value === undefined) args.usageErrors.push("--out requires a path");
        else args.out = value;
        break;
      }
      case "--format": {
        const value = eqSplit[1] ?? (i + 1 < argv.length ? argv[++i] : undefined);
        if (value === undefined) {
          args.usageErrors.push(`--format requires a value (${PAGE_FORMATS.join(" | ")})`);
        } else if ((PAGE_FORMATS as readonly string[]).includes(value)) {
          args.format = value as PageFormat;
        } else {
          args.usageErrors.push(`invalid --format "${value}" (expected ${PAGE_FORMATS.join(" or ")})`);
        }
        break;
      }
      case "--title": {
        const value = eqSplit[1] ?? (i + 1 < argv.length ? argv[++i] : undefined);
        if (value === undefined) args.usageErrors.push("--title requires a string");
        else args.title = value;
        break;
      }
      case "--keep-html": {
        // "--keep-html=path" form...
        if (eqSplit[1] !== undefined) {
          args.keepHtmlPath = eqSplit[1];
        } else if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
          // ...or "--keep-html path" form (value must not look like a flag).
          args.keepHtmlPath = argv[++i];
        } else {
          // bare flag: use the default path (output .pdf -> .html)
          args.keepHtmlPath = "";
        }
        break;
      }
      case "--no-validate":
        args.skipValidate = true;
        break;
      case "--quiet":
      case "-q":
        args.quiet = true;
        break;
      default: {
        if (arg.startsWith("-") && arg !== "-") {
          args.usageErrors.push(`unknown option "${arg}" (see --help)`);
        } else if (i === 0 && arg === "convert") {
          // Optional no-op subcommand: "convert" is accepted only as the
          // very first argument ("paperbot convert x.json" == "paperbot x.json").
          continue;
        } else if (positional === 0) {
          args.input = arg;
          positional++;
        } else {
          args.usageErrors.push(`unexpected extra argument '${arg}' (expected exactly one input file)`);
        }
      }
    }
  }

  if (!args.input && !args.help) {
    args.usageErrors.push("missing <input> file (see --help)");
  }
  return args;
}

export interface MainOptions {
  argv: string[];
  printer?: Printer;
  cwd?: string;
}

/**
 * CLI entry. Returns the process exit code. Streams are injectable so tests
 * can capture output in-process.
 */
export async function main(opts: MainOptions): Promise<number> {
  const printer = opts.printer ?? defaultPrinter;
  const baseDir = opts.cwd ?? process.cwd();
  const parsed = parseArgs(opts.argv);

  if (parsed.help) {
    // --help always wins: print usage, exit 0, regardless of other errors.
    printer.out.write(`${USAGE}\n`);
    return EXIT_OK;
  }

  if (parsed.usageErrors.length > 0) {
    for (const e of parsed.usageErrors) printer.err.write(`✗ ${e}\n`);
    printer.err.write(`\nRun with --help for usage.\n`);
    return EXIT_USAGE;
  }

  const inputPath = parsed.input!;
  const absInput = isAbsolute(inputPath) ? inputPath : resolve(baseDir, inputPath);
  const outPath = parsed.out
    ? (isAbsolute(parsed.out) ? parsed.out : resolve(baseDir, parsed.out))
    : defaultOutPath(absInput);

  const pipelineOpts: PipelineOptions = {
    outPath,
    format: parsed.format ?? "letter",
    title: parsed.title,
    skipValidate: parsed.skipValidate,
  };

  let keepHtmlPath: string | undefined;
  if (parsed.keepHtmlPath === "") {
    keepHtmlPath = outPath.replace(/\.pdf$/i, ".html");
  } else if (parsed.keepHtmlPath !== undefined) {
    keepHtmlPath = isAbsolute(parsed.keepHtmlPath)
      ? parsed.keepHtmlPath
      : resolve(baseDir, parsed.keepHtmlPath);
  }
  if (keepHtmlPath !== undefined) {
    pipelineOpts.keepHtmlPath = keepHtmlPath;
  }

  const result = await run(inputPath, pipelineOpts);

  if (result.ok) {
    const parts = [`✓ Wrote ${outPath}`];
    if (result.pages !== undefined) parts.push(`${result.pages} page${result.pages === 1 ? "" : "s"}`);
    if (result.sizeBytes !== undefined) {
      // size only in the verbose summary line when warnings are present
    }
    if (parsed.quiet) {
      printer.out.write(`${parts.join(", ")}\n`);
    } else {
      if (result.warnings.length > 0) {
        parts.push(`${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}`);
      }
      printer.out.write(`${parts.join(", ")}\n`);
      for (const w of result.warnings) printer.out.write(`  ⚠ ${w}\n`);
      if (result.htmlPath) printer.out.write(`  ✎ HTML kept at ${result.htmlPath}\n`);
    }
    return EXIT_OK;
  }

  printer.err.write(`✗ ${result.error}\n`);
  if (!parsed.quiet) {
    for (const w of result.warnings) printer.err.write(`  ⚠ ${w}\n`);
  }
  return result.exitCode;
}

/** Run the CLI from the built entry point (node dist/cli.js). */
export async function cliMain(argv: string[]): Promise<never> {
  const code = await main({ argv });
  process.exit(code);
}

if (import.meta.url === `file://${process.argv[1]}` || (process.argv[1] && import.meta.url.endsWith(process.argv[1])) || process.env.PAPERBOT_FORCE_MAIN === "1") {
  cliMain(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`✗ Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(3);
  });
}
