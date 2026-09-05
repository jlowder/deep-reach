// Spawned by test/cli-fresh.test.ts. Runs in a FRESH minimal process: imports
// the BUILT pdf.js (which pulls in playwright — the real user boundary for
// validatePdf, e.g. the future API server), then validates the given file.
// Prints one JSON line and exits 0 (ok) / 3 (not ok).
import { validatePdf } from "../../dist/pdf.js";

const [path, title, format = "letter", skipText = "0"] = process.argv.slice(2);
if (!path || !title) {
  console.error("usage: validate-child.mjs <pdf> <expectedTitle> [format] [skipText]");
  process.exit(2);
}

const res = await validatePdf(
  { outputPath: path, format, expectedTitle: title, skipTextCheck: skipText === "1" },
  {},
);
process.stdout.write(JSON.stringify(res) + "\n");
process.exit(res.ok ? 0 : 3);
