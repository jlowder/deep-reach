import type { Task } from "./types";

// The fixed 5-stage pipeline track. Stage KEYS are the worker's on_stage
// names; the display names are the design's labels.

export const STAGE_KEYS = [
  "decompose",
  "investigate",
  "draft",
  "critique",
  "assemble",
] as const;

export type StageKey = (typeof STAGE_KEYS)[number];

export const STAGE_NAMES = [
  "Decompose",
  "Investigate",
  "Draft",
  "Critique",
  "Assemble",
] as const;

export type StageState = "done" | "current" | "todo" | "err";

export interface StripStage {
  name: string;
  state: StageState;
}

/**
 * Resolve a worker stage string to one of STAGE_KEYS, or null when it is
 * off the track. Input forms: a bare step stage ("decompose", …,
 * "section i/n") or a current_step ("<stage>: <detail>" / "queued").
 * "section i/n" (emitted per drafted section — no colon in it, so a prefix
 * match) belongs to draft; "documents" (indexing/cleanup), "queued" and
 * anything unknown never light a stage.
 */
export function normalizeStage(v: string | null | undefined): StageKey | null {
  if (!v) return null;
  let key = v.trim().toLowerCase();
  const colon = key.indexOf(":");
  if (colon >= 0) key = key.slice(0, colon).trim();
  if (key.startsWith("section")) return "draft";
  return (STAGE_KEYS as readonly string[]).includes(key) ? (key as StageKey) : null;
}

/** Track index (0-4) of a worker stage string; null when off-track. */
function stageIdx(v: string | null | undefined): number | null {
  const key = normalizeStage(v);
  return key === null ? null : STAGE_KEYS.indexOf(key);
}

/**
 * Map a task onto the 5-stage track.
 *
 * The pipeline is FORWARD-ONLY (it never returns to an earlier stage), so
 * the current stage is the MAX track index across ALL steps: "section i/n"
 * counts as draft, the per-sub-question investigate repeats keep
 * investigate current, "documents"/"queued" never count. The max stage is
 * current (pulses) for a running task / err for a failed one; earlier
 * stages are done, later ones todo. With no on-track step yet,
 * task.current_step falls through the same normalize; still none → all
 * todo.
 *
 *  - pending   → all todo (the strip renders its all-dim variant)
 *  - completed → all done
 *  - running   → i < cur done · i === cur current · i > cur todo
 *  - failed    → i < cur done · i === cur err · i > cur todo
 */
export function deriveStageStates(task: Task): StripStage[] {
  if (task.status === "pending") {
    return STAGE_NAMES.map((name) => ({ name, state: "todo" as const }));
  }
  if (task.status === "completed") {
    return STAGE_NAMES.map((name) => ({ name, state: "done" as const }));
  }

  let currentIdx: number | null = null;
  for (const step of task.steps) {
    const i = stageIdx(step.stage);
    if (i !== null && (currentIdx === null || i > currentIdx)) {
      currentIdx = i;
    }
  }
  if (currentIdx === null) currentIdx = stageIdx(task.current_step);

  const failed = task.status === "failed";
  return STAGE_NAMES.map((name, i) => {
    const state: StageState =
      currentIdx === null
        ? "todo"
        : i < currentIdx
          ? "done"
          : i === currentIdx
            ? failed
              ? "err"
              : "current"
            : "todo";
    return { name, state };
  });
}
