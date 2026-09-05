// Load + validate environment for the unified deep-reach API.
// Bun auto-loads .env from the working directory; here we just read process.env.

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`env ${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

function urlFromEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`env ${name} must be an absolute URL, got "${raw}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`env ${name} must be an http(s) URL, got "${raw}"`);
  }
  return parsed.toString();
}

export const config = Object.freeze({
  port: intFromEnv("PORT", 8320),
  host: process.env["HOST"] ?? "0.0.0.0",
  workerUrl: urlFromEnv("WORKER_URL", "http://localhost:8321"),
  paperbotUrl: urlFromEnv("PAPERBOT_URL", "http://localhost:8322"),
  upstreamTimeoutMs: intFromEnv("UPSTREAM_TIMEOUT_MS", 300000),
});
