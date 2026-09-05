/**
 * Paperbot API server entry point: `paperbot-server` / `npm run serve:prod`.
 *
 *   PORT=8322 HOST=0.0.0.0 node dist/start-server.js
 *
 * Renders documents to PDF/HTML bytes in memory; nothing is written to disk.
 */
import { createServer } from "./server.js";

const app = await createServer();

const port = Number(process.env.PORT ?? 8322);
const host = process.env.HOST ?? "0.0.0.0";

await app.listen({ port, host });
app.log.info(`paperbot API listening on http://${host}:${port} — render: POST /render, docs: GET /openapi.json`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app.log.info(`${signal} received — shutting down`);
    app
      .close()
      .then(() => process.exit(0))
      .catch((err) => {
        app.log.error({ err }, "error during shutdown");
        process.exit(1);
      });
  });
}
