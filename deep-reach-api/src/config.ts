// Load + validate environment for the unified deep-reach API.
// Bun auto-loads .env from the working directory; here we just read process.env.
// Invalid values throw a descriptive error at load time (before the server
// binds), so `bun run src/index.ts` fails fast with a readable message.

const HOST_RE = /^(localhost|\[[0-9A-Fa-f:.]+\]|(?:\d{1,3}\.){3}\d{1,3}|[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*)$/;

function portFromEnv(): number {
  const raw = process.env["PORT"];
  if (raw === undefined || raw === "") return 8320;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`env PORT must be an integer between 1 and 65535, got "${raw}"`);
  }
  return value;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`env ${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

function hostFromEnv(): string {
  const raw = process.env["HOST"];
  if (raw === undefined || raw === "") return "0.0.0.0";
  if (!HOST_RE.test(raw)) {
    throw new Error(
      `env HOST must be an IP address or "localhost" (e.g. "0.0.0.0"), got "${raw}"`,
    );
  }
  return raw;
}

/**
 * Upstream base URL. Returns the normalized origin. A pathname or query in the
 * base would silently break every proxied request (double path / swallowed
 * query), so those are rejected with a descriptive error.
 */
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
  if (parsed.pathname !== "/" || parsed.search !== "") {
    throw new Error(
      `env ${name} must be a base URL without a path or query (e.g. "http://localhost:8321"), got "${raw}"`,
    );
  }
  return parsed.origin;
}

export const config = Object.freeze({
  port: portFromEnv(),
  host: hostFromEnv(),
  workerUrl: urlFromEnv("WORKER_URL", "http://localhost:8321"),
  paperbotUrl: urlFromEnv("PAPERBOT_URL", "http://localhost:8322"),
  upstreamTimeoutMs: intFromEnv("UPSTREAM_TIMEOUT_MS", 300000),
});
