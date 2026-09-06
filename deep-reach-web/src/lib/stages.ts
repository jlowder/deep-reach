import type { Task } from "./types";

// The fixed 5-stage pipeline track. Stage KEYS are the worker's on_stage
// names; the display names are the design's labels. (The derivation logic
// that maps a task onto this track lands in the next commit.)

export const STAGE_KEYS = [
  "decompose",
  "investigate",
  "draft",
  "critique",
  "assemble",
] as const;

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
 * Resolve one of the worker's step.stage strings to a track index:
 * the five on_stage names map 1:1; "section i/n" belongs to draft; the
 * pre-pipeline steps ("queued", "documents") are off-track (-1).
 */
function stageIndex(stage: string): number {
  const key = stage.split(":")[0].trim().toLowerCase();
  if (key === "section") return (STAGE_KEYS as readonly string[]).indexOf("draft");
  if (key === "documents" || key === "queued" || key === "") return -1;
  return (STAGE_KEYS as readonly string[]).indexOf(key);
}

/**
 * Map a task onto the 5-stage track:
 *  - pending   → all todo (the strip renders its all-dim variant)
 *  - completed → all done
 *  - running   → the latest step's stage = current (pulses); stages before
 *                it = done; a stage that appears anywhere earlier in the
 *                steps (multi-round repeats) is done too; current wins for
 *                its own stage. A pre-pipeline last step (queued/documents)
 *                lights the first stage.
 *  - failed    → stages before the last step's stage = done, that stage =
 *                err (solid red), the rest dim.
 */
export function deriveStageStates(task: Task): StripStage[] {
  if (task.status === "pending") {
    return STAGE_NAMES.map((name) => ({ name, state: "todo" }));
  }
  if (task.status === "completed") {
    return STAGE_NAMES.map((name) => ({ name, state: "done" }));
  }

  const last = task.steps[task.steps.length - 1];
  const currentIdx = stageIndex(last ? last.stage : task.current_step);

  // Stages that appeared in any step before the last one (round repeats).
  const lastPos = Math.max(0, task.steps.length - 1);
  const seen = new Set<number>();
  for (const step of task.steps.slice(0, lastPos)) {
    const i = stageIndex(step.stage);
    if (i >= 0) seen.add(i);
  }

  return STAGE_NAMES.map((name, i) => {
    let state: StageState;
    if (task.status === "failed") {
      state = i < currentIdx ? "done" : i === currentIdx ? "err" : "todo";
    } else {
      const cur = currentIdx === -1 ? 0 : currentIdx;
      state =
        i === cur ? "current" : i < cur || (currentIdx !== -1 && seen.has(i)) ? "done" : "todo";
    }
    return { name, state };
  });
}
