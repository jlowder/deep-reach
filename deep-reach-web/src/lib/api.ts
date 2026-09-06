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

export const api = {
  health(): Promise<Health> {
    return request<Health>("/api/health");
  },

  listTasks(): Promise<{ tasks: TaskSummary[] }> {
    return request<{ tasks: TaskSummary[] }>("/api/research");
  },

  getTask(id: string): Promise<Task> {
    return request<Task>(`/api/research/${encodeURIComponent(id)}`);
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
