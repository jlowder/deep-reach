# deep-reach

A multi-agent RAG deep-research system: an orchestrator coordinates Retriever/Writer/Verifier agents that ground their answers in local PDFs and the web, exposed through a Next.js web UI.

## Services

| service   | dir                 | runtime | command                     | port | health            |
|-----------|---------------------|---------|-----------------------------|------|-------------------|
| worker    | `deep-reach-worker` | python  | `venv/bin/python api_server.py` | 8321 | `/health`        |
| backend   | `deep-reach-backend`| node    | `npm run serve`             | 8322 | TCP (optionally `/openapi.json`) |
| api       | `deep-reach-api`    | bun     | `bun run src/index.ts`      | 8320 | `/health`         |
| web       | `deep-reach-web`    | node    | `npm run dev`               | 8323 | `/`               |

Dependency wiring: **web → api → { worker, backend }** — the web app rewrites `/api/*` to the glue api service, which proxies to the worker and backend.

## Usage

```sh
./run.sh start          # start all 4 (dependency order), wait for ports, print summary
./run.sh stop           # stop all 4 (reverse order), verify ports are free
./run.sh restart        # stop + start
./run.sh status         # pid / port / health / UP-DOWN table
./run.sh logs worker    # tail logs/worker.log (200 lines, follow)
./run.sh logs           # 30-line snapshot of all logs
./run.sh help
```

PIDs live in `logs/<service>.pid`, output in `logs/<service>.log`. Services that are already running are skipped; a missing runtime (e.g. no `bun`) warns and skips that service without aborting the run.

## External LLM dependency

The worker calls an external OpenAI-compatible LLM at `LLM_ENDPOINT` in `deep-reach-worker/utils/var.env` (default `http://localhost:8080`). Run that LLM server separately — if it is unreachable, the worker stays up but research requests will fail. `./run.sh start` prints a (non-fatal) warning when the endpoint is down.
