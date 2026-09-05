import { config } from "./config.ts";
import { app } from "./app.ts";

const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  fetch: (req) => app(req),
});

console.log(`deep-reach-api listening on http://${server.hostname}:${server.port}`);
