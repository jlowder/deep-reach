// Client-side fetch helpers. Every call goes to same-origin /api/… — the
// Next rewrite (next.config.ts) forwards /api/:path* to deep-reach-api, so
// the browser never needs to know the glue's address and there is no CORS.

import type {
  CreateResearchInput,
  CreateResearchResult,
  DeleteResult,
  Documents,
  Health,
  Task,
  TaskLinks,
  TaskStats,
  TaskStep,
  TaskSummary,
  UploadResult,
} from "./types";

/** Non-ok response (or network failure) from the API. */
export class ApiError extends Error {
  /** 0 = network-level failure (e.g. glue not running). */
  status: number;
  /** parsed upstream error body, or the raw text — for the banner. */
  body: string;

  constructor(status: number, body: string, message?: string) {
    super(message ?? (body || `API error ${status}`));
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    throw new ApiError(
      0,
      "cannot reach the deep-reach api",
      `cannot reach the deep-reach api (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (res.ok) {
    return (await res.json()) as T;
  }
  const text = await res.text().catch(() => "");
  let body = text.slice(0, 300);
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      body = String((parsed as Record<string, unknown>).error);
    }
  } catch {
    // keep the raw text
  }
  throw new ApiError(res.status, body);
}

// --- wire normalization -----------------------------------------------------
// The wire JSON is `as T`-cast and unvalidated. A record missing `steps` or
// `current_step` (worker bug, schema drift, old worker) must never reach a
// component — everything below degrades to render-safe defaults.

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const TASK_STATUSES = ["pending", "running", "completed", "failed"] as const;
function statusOf(v: unknown): Task["status"] {
  return (TASK_STATUSES as readonly string[]).includes(typeof v === "string" ? v : "")
    ? (v as Task["status"])
    : "running";
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Nullable number (timestamps) — missing/invalid → null. */
function optNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function stepsOf(v: unknown): TaskStep[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(isRecord)
    .map((s) => ({ stage: str(s.stage), detail: str(s.detail), ts: num(s.ts) }));
}

function statsOf(v: unknown): TaskStats | null {
  if (!isRecord(v)) return null;
  return {
    llm_calls: num(v.llm_calls),
    wall_s: num(v.wall_s),
    sections: num(v.sections),
    revisions: num(v.revisions),
  };
}

function linksOf(v: unknown): TaskLinks {
  const l = isRecord(v) ? v : {};
  return { status: str(l.status), report: str(l.report) };
}

/** Render-safe full task record (see above). */
export function normalizeTask(raw: unknown): Task {
  const r = isRecord(raw) ? raw : {};
  return {
    id: str(r.id),
    topic: str(r.topic),
    status: statusOf(r.status),
    current_step: str(r.current_step),
    steps: stepsOf(r.steps),
    started_at: optNum(r.started_at),
    finished_at: optNum(r.finished_at),
    error: typeof r.error === "string" ? r.error : null,
    stats: statsOf(r.stats),
    quality: isRecord(r.quality) ? r.quality : undefined,
    documents: strArray(r.documents),
    links: linksOf(r.links),
  };
}

/** Render-safe summary row. */
export function normalizeSummary(raw: unknown): TaskSummary {
  const r = isRecord(raw) ? raw : {};
  return {
    id: str(r.id),
    topic: str(r.topic),
    status: statusOf(r.status),
    current_step: str(r.current_step),
    step_count: num(r.step_count),
    started_at: optNum(r.started_at),
    finished_at: optNum(r.finished_at),
    error: typeof r.error === "string" ? r.error : null,
    documents: strArray(r.documents),
    links: linksOf(r.links),
  };
}

export const api = {
  health(): Promise<Health> {
    return request<Health>("/api/health");
  },

  listTasks(): Promise<{ tasks: TaskSummary[] }> {
    return request<{ tasks: unknown } | null>("/api/research").then((d) => ({
      tasks: isRecord(d) && Array.isArray(d.tasks) ? (d.tasks as unknown[]).map(normalizeSummary) : [],
    }));
  },

  getTask(id: string): Promise<Task> {
    return request<unknown>(`/api/research/${encodeURIComponent(id)}`).then(normalizeTask);
  },

  createResearch(input: CreateResearchInput): Promise<CreateResearchResult> {
    return request<CreateResearchResult>("/api/research", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  },

  deleteTask(id: string): Promise<DeleteResult> {
    return request<DeleteResult>(`/api/research/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },

  getDocuments(): Promise<Documents> {
    return request<Documents>("/api/documents");
  },

  /** Multipart upload; the worker dedupes + sanitizes and returns names. */
  uploadDocuments(files: File[]): Promise<UploadResult> {
    const form = new FormData();
    for (const file of files) form.append("files", file);
    return request<UploadResult>("/api/documents", { method: "POST", body: form });
  },

  deleteDocuments(): Promise<{ removed: string[] }> {
    return request<{ removed: string[] }>("/api/documents", { method: "DELETE" });
  },

  /**
   * Same-origin navigation URL (glue gates on completed, renders via
   * paperbot and streams the file back):
   * window.location.href = api.downloadUrl(id, "pdf")
   */
  downloadUrl(id: string, format: "pdf" | "html"): string {
    return `/api/research/${encodeURIComponent(id)}/download?format=${format}`;
  },
};
