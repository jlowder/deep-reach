"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
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
  const listRef = useRef<HTMLDivElement>(null);

  // Keyboard: ArrowUp/Down step between rows, Home/End jump, Enter activates
  // (rows handle Enter/Space themselves). Focus follows the selection.
  function onListKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const rows = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>("[data-task-row]") ?? [],
    );
    if (rows.length === 0) return;
    const active = document.activeElement;
    const current = rows.findIndex((r) => r === active || r.contains(active as Node));
    let next: number;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = rows.length - 1;
    else if (current === -1)
      next = e.key === "ArrowDown" ? 0 : rows.length - 1;
    else
      next = Math.min(
        rows.length - 1,
        Math.max(0, current + (e.key === "ArrowDown" ? 1 : -1)),
      );
    rows[next].focus();
    onSelect(tasks[next].id);
  }

  return (
    <div
      ref={listRef}
      role="group"
      aria-label="Research tasks"
      tabIndex={0}
      onKeyDown={onListKeyDown}
      className="flex min-w-0 flex-col"
    >
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
            data-task-row
            aria-current={selected ? "true" : undefined}
            aria-label={`Task: ${task.topic}, ${task.status}`}
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
              <RowDelete topic={task.topic} onFire={() => onDelete(task.id)} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// Armed inline delete: first press turns the × into a red "!" for 2.5 s;
// a second press fires. No dialog — faster, and the armed state is the
// visible confirmation.
function RowDelete({ topic, onFire }: { topic: string; onFire: () => void }) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      aria-pressed={armed}
      aria-label={armed ? `Delete task: ${topic}, press again to confirm` : `Delete task: ${topic}`}
      onClick={(e) => {
        e.stopPropagation();
        if (!armed) {
          setArmed(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setArmed(false), 2500);
          return;
        }
        window.clearTimeout(timer.current);
        setArmed(false);
        onFire();
      }}
      className={cx(
        "justify-self-end px-1 font-mono text-[11px]",
        armed ? "font-bold text-err" : "text-dim hover:text-err",
      )}
    >
      {armed ? "!" : "×"}
    </button>
  );
}