// Wire types for the deep-reach API (same-origin /api/* via the Next
// rewrite onto deep-reach-api). Field names mirror deep-reach-worker's
// JSON; the glue adds `links` (public paths) to task payloads.

export type TaskStatus = "pending" | "running" | "completed" | "failed";

export interface TaskStep {
  stage: string; // "queued" | "documents" | "decompose" | … | "section i/n"
  detail: string;
  /** epoch seconds */
  ts: number;
}

export interface TaskStats {
  llm_calls: number;
  wall_s: number;
  sections: number;
  revisions: number;
}

export interface TaskLinks {
  status: string;
  report: string;
}

/** Full record from GET /research/{id}. */
export interface Task {
  id: string;
  topic: string;
  status: TaskStatus;
  /** "<stage>: <detail>" of the latest step, or "queued" */
  current_step: string;
  steps: TaskStep[];
  started_at: number | null;
  finished_at: number | null;
  error?: string | null;
  stats?: TaskStats | null;
  documents?: string[];
  links?: TaskLinks;
}

/** Row from GET /research (summary). */
export interface TaskSummary {
  id: string;
  topic: string;
  status: TaskStatus;
  current_step: string;
  step_count: number;
  started_at: number | null;
  finished_at: number | null;
  error?: string | null;
  documents?: string[];
  links?: TaskLinks;
}

export interface Documents {
  staged: string[];
  on_disk: string[];
  indexed: string[];
}

export interface UploadResult {
  /** sanitized names the worker staged */
  documents: string[];
  /** original filename -> rejection reason */
  rejected: Record<string, string>;
}

export interface DeleteResult {
  deleted: string;
  documents: string[];
}

export interface CreateResearchInput {
  topic: string;
  max_rounds: number;
  budget_doc: number;
  budget_web: number;
}

export interface CreateResearchResult {
  task_id: string;
  status: TaskStatus;
  current_step: string;
  documents: string[];
  links: TaskLinks;
}

/** One side of GET /health (worker / paperbot probe). */
export interface UpstreamStatus {
  ok: boolean;
  running?: boolean;
  pending?: number;
  deep_configured?: boolean;
  status?: number;
  error?: string;
}

export interface Health {
  service: string;
  worker: UpstreamStatus;
  paperbot: UpstreamStatus;
}
