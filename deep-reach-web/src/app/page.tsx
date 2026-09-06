"use client";

// The console shell, live: rail | main (task list + detail), driven by
// useTasks (2 s poll of GET /research) + useTaskDetail (1.5 s poll for the
// selected pending/running task).

import { useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { ErrorBoundary } from "@/components/error-boundary";
import { Rail } from "@/components/rail";
import { TaskDetail } from "@/components/task-detail";
import { TaskList } from "@/components/task-list";
import { UpstreamBanner } from "@/components/upstream-banner";
import { fmtClock } from "@/lib/format";
import { useTaskDetail, useTasks } from "@/lib/useTasks";

export default function Page() {
  const { tasks, error, lastUpdate, refresh, removeTask } = useTasks();
  const [explicitId, setExplicitId] = useState<string | null>(null);

  // Selection: an explicit pick if it still exists, else the running task,
  // else the first. Pure derivation — no effect, no stale state.
  const selectedId =
    explicitId && tasks?.some((t) => t.id === explicitId)
      ? explicitId
      : tasks?.find((t) => t.status === "running")?.id ??
        tasks?.[0]?.id ??
        null;

  const selectedSummary = tasks?.find((t) => t.id === selectedId) ?? null;
  const detailActive =
    selectedSummary !== null &&
    (selectedSummary.status === "running" || selectedSummary.status === "pending");
  const { task: detailTask, error: detailError } = useTaskDetail(selectedId, detailActive);

  const pendingCount = tasks?.filter((t) => t.status === "pending").length ?? 0;
  const runningCount = tasks?.filter((t) => t.status === "running").length ?? 0;
  const queuePosition =
    selectedSummary?.status === "pending" && tasks
      ? tasks.filter((t) => t.status === "pending").findIndex((t) => t.id === selectedId) + 1
      : undefined;

  const hasContent = (selectedSummary ?? detailTask) !== null;

  return (
    <ErrorBoundary>
      <div className="grid min-h-dvh grid-cols-1 min-[960px]:grid-cols-[320px_1fr]">
      <Rail
        pendingCount={pendingCount}
        runningCount={runningCount}
        onCreated={(id) => {
          setExplicitId(id);
          void refresh();
        }}
      />

      <main className="flex min-w-0 flex-col">
        <header className="flex items-center gap-3 border-b border-hairline px-6 py-4">
          <h1 className="font-mono text-[10px] uppercase tracking-[0.18em] text-dim">
            Tasks
          </h1>
          {tasks && (
            <span className="border border-hairline bg-surface px-1.5 py-0.5 font-mono text-[11px]">
              {tasks.length}
            </span>
          )}
          <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.12em] text-dim/70">
            {lastUpdate ? `synced ${fmtClock(lastUpdate / 1000)}` : "connecting…"}
          </span>
        </header>

        {error && (
          <div className="px-6 pt-5">
            <UpstreamBanner message={error} />
          </div>
        )}

        {hasContent ? (
          <div className="grid flex-1 grid-cols-1 gap-x-8 gap-y-8 px-6 py-6 min-[960px]:grid-cols-[minmax(0,26rem)_1fr]">
            <TaskList
              tasks={tasks ?? []}
              selectedId={selectedId}
              onSelect={setExplicitId}
              onDelete={removeTask}
            />
            <TaskDetail
              task={detailTask}
              summary={selectedSummary}
              queuePosition={queuePosition}
              updateError={detailError ?? null}
              onDelete={removeTask}
            />
          </div>
        ) : (
          <EmptyState />
        )}
      </main>
    </div>
    </ErrorBoundary>
  );
}
