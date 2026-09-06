"use client";

import { cx } from "@/lib/cx";
import type { SampleTask, TaskStatus } from "@/lib/samples";
import { PipelineStrip } from "./pipeline-strip";

const CHIP: Record<TaskStatus, string> = {
  pending: "bg-wait/15 text-wait",
  running: "bg-accent-soft text-accent",
  completed: "bg-ok/15 text-ok",
  failed: "bg-err-soft text-err",
};

function ActionButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      className="rounded-none border border-accent px-4 py-2 font-display text-[12px] font-semibold uppercase tracking-[0.12em] text-accent hover:bg-accent-soft"
      onClick={() => {
        /* wired next: GET /api/research/{id}/render */
      }}
    >
      {label}
    </button>
  );
}

function DeleteButton() {
  return (
    <button
      type="button"
      className="rounded-none px-2 py-2 font-display text-[12px] font-semibold uppercase tracking-[0.12em] text-dim hover:text-err"
      onClick={() => {
        /* wired next: DELETE /api/research/{id} */
      }}
    >
      Delete task
    </button>
  );
}

export function TaskDetail({ task }: { task: SampleTask }) {
  return (
    <section
      aria-label={`Task: ${task.topic}`}
      className="flex min-w-0 animate-fade-up flex-col gap-5"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-display text-[22px] font-semibold leading-tight">
          {task.topic}
        </h2>
        <span
          className={cx(
            "shrink-0 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em]",
            CHIP[task.status],
          )}
        >
          {task.status}
        </span>
      </div>

      <p className="font-mono text-[11px] text-dim">
        id {task.id} · created {task.created} · {task.elapsed}
      </p>

      {task.status === "running" && task.ticker && (
        <p
          aria-live="polite"
          className="max-w-[720px] font-mono text-[12px] text-dim"
        >
          {task.ticker}
        </p>
      )}

      <div className="max-w-[720px]">
        <PipelineStrip stages={task.stages} dim={task.status === "pending"} />
      </div>

      {task.status === "pending" && (
        <p className="font-mono text-[12px] text-dim">
          waiting in queue — position {task.queuePosition ?? "—"}
        </p>
      )}

      {task.status === "completed" && (
        <div className="flex flex-wrap items-center gap-3">
          <ActionButton label="Download PDF" />
          <ActionButton label="Download HTML" />
          <div className="ml-auto">
            <DeleteButton />
          </div>
        </div>
      )}

      {task.status === "failed" && (
        <>
          <div
            role="alert"
            className="border border-err-hairline bg-err-soft px-4 py-3 font-mono text-[12px] text-err"
          >
            {task.error}
          </div>
          <div>
            <DeleteButton />
          </div>
        </>
      )}
    </section>
  );
}
