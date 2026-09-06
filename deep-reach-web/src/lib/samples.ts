// Static sample data — the shell dispatch predates API wiring. Replace with
// live tasks (GET /api/research) in the next dispatch.

export type TaskStatus = "pending" | "running" | "completed" | "failed";

export type StageState = "done" | "current" | "todo";

export interface SampleStage {
  name: string;
  state: StageState;
}

export interface SampleTask {
  id: string;
  topic: string;
  status: TaskStatus;
  /** "13:58:12" */
  created: string;
  /** "04:12" */
  elapsed: string;
  /** pending only */
  queuePosition?: number;
  /** running only — the live ticker line */
  ticker?: string;
  /** failed only */
  error?: string;
  stages: SampleStage[];
}

export const STAGES = [
  "Decompose",
  "Investigate",
  "Draft",
  "Critique",
  "Assemble",
] as const;

function stages(...states: StageState[]): SampleStage[] {
  return STAGES.map((name, i) => ({ name, state: states[i] ?? "todo" }));
}

export const SAMPLE_TASKS: SampleTask[] = [
  {
    id: "4b91f0d2",
    topic: "Map the current state of small-language-model distillation",
    status: "pending",
    created: "14:03:02",
    elapsed: "00:00",
    queuePosition: 2,
    stages: stages("todo", "todo", "todo", "todo", "todo"),
  },
  {
    id: "7f3a21c8",
    topic: "How do MoE routing strategies scale past 100B parameters",
    status: "running",
    created: "13:58:12",
    elapsed: "04:12",
    ticker: "▸ investigate — querying web: “scaling laws”  ·  14:02:31",
    stages: stages("done", "current", "todo", "todo", "todo"),
  },
  {
    id: "c0d5e7aa",
    topic: "Attention mechanisms: what actually transfers across architectures",
    status: "completed",
    created: "13:41:05",
    elapsed: "11:38",
    stages: stages("done", "done", "done", "done", "done"),
  },
  {
    id: "9e2b46f1",
    topic: "Synthetic data flywheels in post-training",
    status: "failed",
    created: "13:12:47",
    elapsed: "03:20",
    error: "runner lost the provider connection after 3.2 min — no sections drafted",
    stages: stages("done", "done", "current", "todo", "todo"),
  },
  {
    id: "58a1c3e9",
    topic: "The economics of inference at the edge, 2024–2025",
    status: "completed",
    created: "12:58:33",
    elapsed: "09:54",
    stages: stages("done", "done", "done", "done", "done"),
  },
];

/** The running task is the interesting one — select it by default. */
export const DEFAULT_SELECTED_ID = SAMPLE_TASKS[1].id;
