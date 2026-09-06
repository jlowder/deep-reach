# Deep Reach Web

Deep Reach is a deep-research console: a Next.js app that talks to the unified
`deep-reach-api` glue service, which proxies two upstreams — `deep-reach-worker`
(async 5-stage research pipeline with a FIFO task queue and a local vector store)
and `deep-reach-backend` "paperbot" (renders completed reports to PDF/HTML). The
browser only ever calls same-origin `/api/*` paths; the Next rewrite forwards
them to the glue, so client code never knows the glue's address and there is no
CORS to configure.

```
deep-reach-web :3000  →  deep-reach-api (glue) :8320  →  deep-reach-worker :8321 (pipeline)  +  deep-reach-backend "paperbot" :8322 (render)
```

## Run locally

Start in dependency order — the two upstreams first, then the glue, then the console.

| Service | Start | Port | Env (defaults) |
| --- | --- | --- | --- |
| deep-reach-worker | `cd deep-reach-worker && venv/bin/python api_server.py` | 8321 | `PORT` / `HOST` (8321 / 0.0.0.0). LLM config in `utils/var.env`: `LLM_ENDPOINT` (any OpenAI-compatible base URL), `LLM_API_KEY`, `LLM_MODEL`; the file is auto-created from `.env.example` if missing. One-time venv: `python3 -m venv venv && venv/bin/pip install -r utils/requirements.txt` |
| deep-reach-backend ("paperbot") | `cd deep-reach-backend && npm run serve` (or `npm run serve:prod`) | 8322 | `PORT` / `HOST` (8322 / 0.0.0.0). One-time `npm run setup` (installs deps + Playwright Chromium). Requires Node ≥ 20 |
| deep-reach-api (glue) | `cd deep-reach-api && bun run src/index.ts` (`bun run dev` for `--watch`) | 8320 | `.env` (Bun auto-loads): `WORKER_URL` (http://localhost:8321), `PAPERBOT_URL` (http://localhost:8322), `UPSTREAM_TIMEOUT_MS` (300000). Invalid values fail fast at boot |
| deep-reach-web | `cd deep-reach-web && npm install`, then `npm run dev` (or `npx next dev`) | 3000 | `.env.local` (template in `.env.example`): `DEEP_REACH_API_URL=http://localhost:8320`. `next.config.ts` bakes the rewrite target in at server start — restart the dev server after changing it |

## How it works

- **Create** — the form POSTs `/api/research`; the glue forwards to the worker, which answers `202 {task_id, links}`. Runs are serialized: accepted while the pipeline is free it starts as `running`, accepted while busy it is queued as `pending` (FIFO).
- **Monitor** — the console polls the task list every 2 s and the selected task's detail every 1.5 s (both pause while the tab is hidden). The live strip maps the task onto the fixed 5-stage track — decompose → investigate → draft → critique → assemble — with done / current / todo / err per stage.
- **Documents** — dropped PDFs are staged via `POST /api/documents` for the next research task; they are ingested into the vector store at task start and removed from disk again when the task exits (or is deleted).
- **Download** — a same-origin navigation to `/api/research/{id}/download?format=pdf|html`; the glue only serves completed tasks, renders via paperbot, and streams the file back.
- **Delete** — `DELETE /api/research/{id}` is a true delete (record + its documents). A running task cannot be killed: the API answers `409` until the run finishes.

## Design

- Two themes — **ink** (dark, default) and **paper** (light) — as CSS token sets on `<html data-theme>` in `globals.css`; a pre-paint script in `layout.tsx` applies the stored choice, so switching never flashes the wrong palette.
- **Chakra Petch** for display, **IBM Plex Sans** for body, **IBM Plex Mono** for data — self-hosted via `next/font/google`.
- Amber accent on a deep-navy field: an "amber-lit observatory" reading of a research console.
- The **pipeline strip** (`src/components/pipeline-strip.tsx`) is the signature element: a fixed 5-stage track whose cells light up as the run progresses.

## Project layout

| File | Role |
| --- | --- |
| `next.config.ts` | Rewrites `/api/:path*` → `DEEP_REACH_API_URL` (the glue); read when the server starts |
| `.env.example` / `.env.local` | `DEEP_REACH_API_URL` (default `http://localhost:8320`) |
| `src/lib/api.ts` | Same-origin fetch helpers: `/api/research`, `/api/documents`, download URL |
| `src/lib/types.ts` | `Task`, `TaskSummary`, create/delete/documents/health shapes |
| `src/lib/useTasks.ts` | 2 s list poll, 1.5 s detail poll, optimistic delete |
| `src/lib/stages.ts` | Maps a task's steps onto the 5-stage track |
| `src/lib/theme.tsx` | ink/paper theme state + `ThemeToggle` |
| `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css` | Console shell, theme bootstrap, design tokens |
| `src/components/` | `pipeline-strip`, `task-list`, `task-detail`, `rail`, `upstream-banner`, `empty-state` |

## API contract

The full contracts live next door — this README cites rather than duplicates them:

- `../deep-reach-api/API.md` — the unified glue API (what the console actually calls)
- `../deep-reach-worker/API.md` — the upstream pipeline service
- `../deep-reach-backend/API.md` — the upstream renderer (paperbot)
