"use client";

// Detail pane. Renders from the full record (useTaskDetail) when it has
// arrived, falling back to the list summary in the gap; a null of both
// (deleted / unknown) renders nothing — the page shows the empty state.

import { api } from "@/lib/api";
import { cx } from "@/lib/cx";
import { fmtClock, fmtElapsed } from "@/lib/format";
import type { StripStage } from "@/lib/stages";
import type { Task, TaskStatus, TaskSummary } from "@/lib/types";
import { PipelineStrip } from "./pipeline-strip";

const CHIP: Record<TaskStatus, string> = {
  pending: "bg-wait/15 text-wait",
  running: "bg-accent-soft text-accent",
  completed: "bg-ok/15 text-ok",
  failed: "bg-err-soft text-err",
};

export interface DetailProps {
  /** full record (has steps/stats) — null while the first fetch is in flight */
  task: Task | null;
  /** row from the list; used for topic/status until `task` arrives */
  summary?: TaskSummary | null;
  /** pending queue position (1-based), when the task is pending */
  queuePosition?: number;
  onDelete: (id: string) => void;
}

export function TaskDetail({ task, summary, queuePosition, onDelete }: DetailProps) {
  const base = task ?? summary;
  if (!base) return null;
  const status = base.status;
  const id = base.id;

  const last = task?.steps[task.steps.length - 1];
  const docs = base.documents ?? [];

  return (
    <section
      aria-label={`Task: ${base.topic}`}
      className="flex min-w-0 animate-fade-up flex-col gap-5"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-display text-[22px] font-semibold leading-tight">
          {base.topic}
        </h2>
        <span
          className={cx(
            "shrink-0 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em]",
            CHIP[status],
          )}
        >
          {status}
        </span>
      </div>

      <p className="font-mono text-[11px] text-dim">
        id {id} · created {fmtClock(base.started_at)} ·{" "}
        {fmtElapsed(base.started_at, base.finished_at)}
      </p>

      {status === "running" && last && (
        <p aria-live="polite" className="max-w-[720px] font-mono text-[12px] text-dim">
          ▸ {last.detail} · {fmtClock(last.ts)}
        </p>
      )}

      {/* The stage derivation for the strip lands in the next commit. */}
      <div className="max-w-[720px]">
        <PipelineStrip
          stages={task ? taskStages(task) : placeholderStages(status, base.current_step)}
          dim={status === "pending"}
        />
      </div>

      {status === "pending" && (
        <p className="font-mono text-[12px] text-dim">
          waiting in queue — position {queuePosition ?? "—"}
        </p>
      )}

      {status === "completed" && (
        <>
          {task?.stats && (
            <p className="font-mono text-[11px] text-dim">
              {task.stats.llm_calls} llm calls · {task.stats.sections} section
              {task.stats.sections === 1 ? "" : "s"} · {task.stats.revisions} revision
              {task.stats.revisions === 1 ? "" : "s"} · {task.stats.wall_s.toFixed(0)}s wall
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <ActionButton
              label="Download PDF"
              onClick={() => {
                window.location.href = api.downloadUrl(id, "pdf");
              }}
            />
            <ActionButton
              label="Download HTML"
              onClick={() => {
                window.location.href = api.downloadUrl(id, "html");
              }}
            />
            <div className="ml-auto">
              <DeleteButton onClick={() => onDelete(id)} />
            </div>
          </div>
        </>
      )}

      {status === "failed" && (
        <>
          <div
            role="alert"
            className="border border-err-hairline bg-err-soft px-4 py-3 font-mono text-[12px] text-err"
          >
            {base.error || "unknown error"}
          </div>
          <div>
            <DeleteButton onClick={() => onDelete(id)} />
          </div>
        </>
      )}

      {docs.length > 0 && (
        <p className="font-mono text-[11px] text-dim">
          docs: {docs.join(", ")}
        </p>
      )}
    </section>
  );
}

function ActionButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-none border border-accent px-4 py-2 font-display text-[12px] font-semibold uppercase tracking-[0.12em] text-accent hover:bg-accent-soft"
    >
      {label}
    </button>
  );
}

function DeleteButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-none px-2 py-2 font-display text-[12px] font-semibold uppercase tracking-[0.12em] text-dim hover:text-err"
    >
      Delete task
    </button>
  );
}

// ---------------------------------------------------------------------------
// Stage derivation (placeholder — replaced by lib/stages.ts in the next
// commit): current_step's stage prefix maps onto the fixed 5-stage track.

const STAGE_NAMES = ["Decompose", "Investigate", "Draft", "Critique", "Assemble"];
const STAGE_KEYS = ["decompose", "investigate", "draft", "critique", "assemble"];

function taskStages(task: Task): StripStage[] {
  const last = task.steps[task.steps.length - 1];
  return deriveStages(stageKey(last ? last.stage : task.current_step));
}

function placeholderStages(status: TaskStatus, currentStep: string): StripStage[] {
  if (status === "pending") return allTodo();
  if (status === "completed") {
    return STAGE_NAMES.map((name) => ({ name, state: "done" as const }));
  }
  return deriveStages(stageKey(currentStep));
}

function allTodo() {
  return STAGE_NAMES.map((name) => ({ name, state: "todo" as const }));
}

/** Stages before the given index = done, at it = current, after = todo.
    Index -1 (pre-pipeline: queued/documents) lights the first stage. */
function deriveStages(current: number): StripStage[] {
  return STAGE_NAMES.map((name, i) => ({
    name,
    state: current === -1 ? (i === 0 ? "current" : "todo") : i < current ? "done" : i === current ? "current" : "todo",
  }));
}

function stageKey(step: string): number {
  const key = step.split(":")[0].trim().toLowerCase();
  if (key === "section") return STAGE_KEYS.indexOf("draft"); // drafting a section
  if (key === "documents" || key === "queued") return -1; // pre-pipeline
  return STAGE_KEYS.indexOf(key);
}
