"use client";

// The console shell: rail | main (task list + detail). Static sample data
// for now — live task wiring lands in the next dispatch.

import { useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { Rail } from "@/components/rail";
import { TaskDetail } from "@/components/task-detail";
import { TaskList } from "@/components/task-list";
import { UpstreamBanner } from "@/components/upstream-banner";
import { DEFAULT_SELECTED_ID, SAMPLE_TASKS } from "@/lib/samples";

export default function Page() {
  const [selectedId, setSelectedId] = useState(DEFAULT_SELECTED_ID);
  const selected = SAMPLE_TASKS.find((t) => t.id === selectedId) ?? null;

  return (
    <div className="grid min-h-dvh grid-cols-1 min-[960px]:grid-cols-[320px_1fr]">
      <Rail />

      <main className="flex min-w-0 flex-col">
        <header className="flex items-center gap-3 border-b border-hairline px-6 py-4">
          <h1 className="font-mono text-[10px] uppercase tracking-[0.18em] text-dim">
            Tasks
          </h1>
          <span className="border border-hairline bg-surface px-1.5 py-0.5 font-mono text-[11px]">
            {SAMPLE_TASKS.length}
          </span>
          <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.12em] text-dim/70">
            static sample — wiring next
          </span>
        </header>

        {/* Sample state: the banner shows its design (hidden when show=false). */}
        <div className="px-6 pt-5">
          <UpstreamBanner show />
        </div>

        {selected ? (
          <div className="grid flex-1 grid-cols-1 gap-x-8 gap-y-8 px-6 py-6 min-[960px]:grid-cols-[minmax(0,26rem)_1fr]">
            <TaskList
              tasks={SAMPLE_TASKS}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
            <TaskDetail task={selected} />
          </div>
        ) : (
          <EmptyState />
        )}
      </main>
    </div>
  );
}
