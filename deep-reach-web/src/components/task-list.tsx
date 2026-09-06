"use client";

import { cx } from "@/lib/cx";
import { fmtElapsed } from "@/lib/format";
import type { TaskSummary } from "@/lib/types";

function Lamp({ status }: { status: TaskSummary["status"] }) {
  return (
    <span
      aria-hidden
      className={cx(
        "h-2 w-2 shrink-0 rounded-full",
        status === "pending" && "border border-wait",
        status === "running" && "bg-accent animate-pulse-glow",
        status === "completed" && "bg-ok",
        status === "failed" && "bg-err",
      )}
    />
  );
}

/** "draft: drafting 1 section(s)" -> "draft" (non-stage steps pass through). */
function stepLabel(task: TaskSummary): { text: string; className: string } {
  if (task.status === "pending") {
    return { text: "queued", className: "text-wait" };
  }
  const stage = task.current_step.split(":")[0].trim();
  if (task.status === "failed") {
    return { text: "failed", className: "text-err" };
  }
  if (task.status === "completed") {
    return { text: "complete", className: "" };
  }
  return { text: stage, className: "" };
}

export function TaskList({
  tasks,
  selectedId,
  onSelect,
  onDelete,
}: {
  tasks: TaskSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const pendingIds = tasks.filter((t) => t.status === "pending");
  return (
    <div className="flex min-w-0 flex-col">
      {tasks.map((task, i) => {
        const selected = task.id === selectedId;
        const label = stepLabel(task);
        const queuePos =
          task.status === "pending"
            ? pendingIds.findIndex((t) => t.id === task.id) + 1
            : null;
        return (
          <div
            key={task.id}
            role="button"
            tabIndex={0}
            aria-current={selected ? "true" : undefined}
            onClick={() => onSelect(task.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(task.id);
              }
            }}
            style={{ animationDelay: `${i * 30}ms` }}
            className={cx(
              "grid animate-fade-up cursor-pointer items-center gap-x-3 border-b border-hairline px-4 py-3",
              // full 6-col grid at >=480px; below that the id/step cells
              // hide so the topic (the one thing that matters in a row)
              // keeps its space on small screens
              "grid-cols-[12px_minmax(0,1fr)_auto_auto]",
              "min-[480px]:grid-cols-[12px_minmax(0,1fr)_auto_auto_auto_auto]",
              selected
                ? "bg-raised shadow-[inset_2px_0_0_var(--accent)]"
                : "hover:bg-surface",
            )}
          >
            <Lamp status={task.status} />
            <span className="truncate text-[13px]">{task.topic}</span>
            <span className="hidden font-mono text-[11px] text-dim min-[480px]:inline">
              {task.id.slice(0, 8)}
            </span>
            <span
              className={cx(
                "hidden font-mono text-[11px] text-dim min-[480px]:block",
                label.className,
              )}
            >
              {label.text}
              {queuePos !== null && <span className="text-wait"> · {queuePos}</span>}
            </span>
            <span className="justify-self-end font-mono text-[11px] text-dim">
              {task.status === "pending"
                ? "00:00"
                : fmtElapsed(task.started_at, task.finished_at)}
            </span>
            {task.status !== "running" && (
              <button
                type="button"
                aria-label={`Delete task: ${task.topic}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(task.id);
                }}
                className="justify-self-end px-1 font-mono text-[11px] text-dim hover:text-err"
              >
                ×
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}