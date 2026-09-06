"use client";

import { cx } from "@/lib/cx";
import type { SampleTask, TaskStatus } from "@/lib/samples";

function Lamp({ status }: { status: TaskStatus }) {
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

function StepLabel({ task }: { task: SampleTask }) {
  if (task.status === "pending") {
    return (
      <span className="border border-hairline bg-field px-1.5 py-0.5 font-mono text-[10px] tracking-[0.08em] text-wait">
        QUEUED · {task.queuePosition ?? "—"}
      </span>
    );
  }
  if (task.status === "failed") {
    return (
      <span className="font-mono text-[11px] text-err">failed</span>
    );
  }
  if (task.status === "completed") {
    return <span className="font-mono text-[11px] text-dim">complete</span>;
  }
  const current = task.stages.find((s) => s.state === "current");
  return (
    <span className="font-mono text-[11px] text-dim">
      {current?.name.toLowerCase() ?? "…"}
    </span>
  );
}

export function TaskList({
  tasks,
  selectedId,
  onSelect,
}: {
  tasks: SampleTask[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      {tasks.map((task, i) => {
        const selected = task.id === selectedId;
        return (
          <button
            key={task.id}
            type="button"
            onClick={() => onSelect(task.id)}
            aria-current={selected ? "true" : undefined}
            style={{ animationDelay: `${i * 30}ms` }}
            className={cx(
              "grid animate-fade-up items-center gap-x-3 border-b border-hairline px-4 py-3 text-left",
              // full 5-col grid at >=480px; below that the id/step cells
              // hide so the topic (the one thing that matters in a row)
              // keeps its space on small screens
              "grid-cols-[12px_minmax(0,1fr)_auto]",
              "min-[480px]:grid-cols-[12px_minmax(0,1fr)_auto_auto_auto]",
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
            <span className="hidden min-[480px]:block">
              <StepLabel task={task} />
            </span>
            <span className="justify-self-end font-mono text-[11px] text-dim">
              {task.elapsed}
            </span>
          </button>
        );
      })}
    </div>
  );
}
