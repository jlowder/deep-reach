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

/** Deterministic quality metrics on the worker's final report: citation
 *  density, verification verdict, source counts, total size. Shape mirrors
 *  the worker's quality builder (citation_density.overall / per_section,
 *  verification.{confidence,coverage,gaps,unresolvable_citations,
 *  dropped_bare_citations}, sources_count.{documents,web}, total_words). */
export interface TaskQuality {
  citation_density: { overall: number; per_section: Record<string, number> };
  verification: {
    confidence?: string;
    coverage?: string;
    gaps?: string[];
    unresolvable_citations: string[];
    dropped_bare_citations: string[];
  };
  sources_count: { documents: number; web: number };
  total_words: number;
}

const _qobj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
const _qnum = (v: unknown, d = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : d;
const _qstr = (v: unknown): string | undefined =>
  typeof v === "string" && v ? v : undefined;
const _qstrs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const _qmap = (v: unknown): Record<string, number> =>
  typeof v === "object" && v !== null
    ? Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, _qnum(x)]),
      )
    : {};

/** Defensive normalization for `task.quality`: the worker emits the full
 *  shape, but older/edge responses may miss parts — default every field.
 *  Returns null when there is no quality object at all. */
export function normalizeQuality(raw: unknown): TaskQuality | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const cd = _qobj(r.citation_density);
  const v = _qobj(r.verification);
  const sc = _qobj(r.sources_count);
  return {
    citation_density: { overall: _qnum(cd.overall), per_section: _qmap(cd.per_section) },
    verification: {
      confidence: _qstr(v.confidence),
      coverage: _qstr(v.coverage),
      gaps: _qstrs(v.gaps),
      unresolvable_citations: _qstrs(v.unresolvable_citations),
      dropped_bare_citations: _qstrs(v.dropped_bare_citations),
    },
    sources_count: { documents: _qnum(sc.documents), web: _qnum(sc.web) },
    total_words: _qnum(r.total_words),
  };
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
  /** raw quality object from the worker — run through normalizeQuality() */
  quality?: unknown;
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
