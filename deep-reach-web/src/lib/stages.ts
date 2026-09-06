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
