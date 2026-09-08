"use client";

// Detail pane. Renders from the full record (useTaskDetail) when it has
// arrived, falling back to the list summary in the gap; a null of both
// (deleted / unknown) renders nothing — the page shows the empty state.

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { cx } from "@/lib/cx";
import { fmtClock, fmtElapsed } from "@/lib/format";
import {
  STAGE_KEYS,
  STAGE_NAMES,
  deriveStageStates,
  normalizeStage,
  type StripStage,
} from "@/lib/stages";
import {
  normalizeQuality,
  type Task,
  type TaskStatus,
  type TaskStep,
  type TaskSummary,
} from "@/lib/types";
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
  /** a failed detail poll (5xx / network) — stale data is still shown */
  updateError?: string | null;
  onDelete: (id: string) => void;
}

export function TaskDetail({ task, summary, queuePosition, updateError, onDelete }: DetailProps) {
  const base = task ?? summary;
  if (!base) return null;
  const status = base.status;
  const id = base.id;

  const last = task?.steps[task.steps.length - 1];
  const docs = base.documents ?? [];
  const quality = task ? normalizeQuality(task.quality) : null;
  const totalSources = quality
    ? quality.sources_count.documents + quality.sources_count.web
    : null;
  // A completed run that retrieved no evidence: the report ships with zero
  // citations by construction — make that legible, not invisible.
  const unsourced = status === "completed" && totalSources === 0;

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
        {unsourced && (
          <span className="shrink-0 bg-err-soft px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-err">
            unsourced
          </span>
        )}
      </div>

      <p className="font-mono text-[11px] text-dim">
        id {id} · created {fmtClock(base.started_at)} ·{" "}
        {fmtElapsed(base.started_at, base.finished_at)}
        {totalSources !== null && (
          <> · {totalSources} source{totalSources === 1 ? "" : "s"}</>
        )}
      </p>

      {unsourced && (
        <p className="font-mono text-[11px] text-dim">
          No evidence was retrieved — this report has no citations (see step
          log).
        </p>
      )}

      {updateError && (
        <p
          role="status"
          className="max-w-[720px] border border-err-hairline bg-err-soft/30 px-3 py-1.5 font-mono text-[11px] text-err"
        >
          task update failed — showing last known state
        </p>
      )}

      {status === "running" && last && (
        <p aria-live="polite" className="max-w-[720px] font-mono text-[12px] text-dim">
          ▸ {last.detail} · {fmtClock(last.ts)}
        </p>
      )}

      {/* Decorative for screen readers — the ticker carries state. */}
      <div aria-hidden="true" className="max-w-[720px]">
        <PipelineStrip
          stages={
            task
              ? deriveStageStates(task)
              : placeholderStages(status, base.current_step)
          }
          dim={status === "pending"}
        />
      </div>

      <StepLog steps={task?.steps ?? []} status={status} queuePosition={queuePosition} />

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
  // No confirm dialog (fast console): first press arms the button ("Sure?",
  // error color) for 2.5 s; a second press fires. Any other key/timeout
  // disarms it.
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      aria-pressed={armed}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setArmed(false), 2500);
          return;
        }
        window.clearTimeout(timer.current);
        setArmed(false);
        onClick();
      }}
      className={cx(
        "rounded-none px-2 py-2 font-display text-[12px] font-semibold uppercase tracking-[0.12em]",
        armed ? "text-err" : "text-dim hover:text-err",
      )}
    >
      {armed ? "Sure?" : "Delete task"}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Step log: one line per step, newest at the bottom, "hh:mm:ss · STAGE ·
// detail". Grows live for running tasks (the 1.5 s detail poll); pending
// shows the queue notice instead. Auto-scrolls to the bottom on new steps —
// an instant jump, never smooth, so reduced-motion users get no scroll
// animation. aria-hidden: the ticker is the screen-reader channel for state.

function StepLog({
  steps,
  status,
  queuePosition,
}: {
  steps: TaskStep[];
  status: TaskStatus;
  queuePosition?: number;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [steps.length]);

  if (status === "pending") {
    return (
      <p className="font-mono text-[12px] text-dim">
        waiting in queue — position {queuePosition ?? "—"}
      </p>
    );
  }
  if (steps.length === 0) {
    return <p className="font-mono text-[12px] text-dim">no steps yet</p>;
  }
  return (
    <div
      ref={boxRef}
      aria-hidden="true"
      className="max-h-[40vh] overflow-y-auto border-t border-hairline pt-3"
    >
      <ol className="flex flex-col gap-1">
        {steps.map((s, i) => (
          <li
            key={`${s.ts}-${i}`}
            title={s.detail}
            className="line-clamp-2 font-mono text-[12px] text-dim"
          >
            <span className="tabular-nums text-dim/70">{fmtClock(s.ts)}</span>
            <span className="text-dim/40"> · </span>
            <span
              className={cx(
                "text-[10px] uppercase tracking-[0.1em]",
                i === steps.length - 1 ? "text-accent" : "text-dim",
              )}
            >
              {s.stage}
            </span>
            <span className="text-dim/40"> · </span>
            <span>{s.detail}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The detail pane usually renders from the full record via
// deriveStageStates (lib/stages.ts). This fallback covers the brief window
// where only the list summary has arrived (summaries carry current_step
// but no steps[]): the same locked mapping — current_step through the
// shared normalize, earlier stages done, it current (running) / err
// (failed), later stages todo; off-track → all todo.

function placeholderStages(status: TaskStatus, currentStep: string): StripStage[] {
  if (status === "pending") {
    return STAGE_NAMES.map((name) => ({ name, state: "todo" as const }));
  }
  if (status === "completed") {
    return STAGE_NAMES.map((name) => ({ name, state: "done" as const }));
  }
  const key = normalizeStage(currentStep);
  const current = key === null ? null : STAGE_KEYS.indexOf(key);
  return STAGE_NAMES.map((name, i) => ({
    name,
    state:
      current === null
        ? "todo"
        : i < current
          ? "done"
          : i === current
            ? status === "failed"
              ? "err"
              : "current"
            : "todo",
  }));
}
