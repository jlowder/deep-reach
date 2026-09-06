import { STAGES } from "@/lib/samples";
import { PipelineStrip } from "./pipeline-strip";

/** No tasks at all: one faint, all-dim pipeline strip as the decoration. */
export function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 py-24">
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-dim">
        No research in flight
      </p>
      <p className="text-dim">
        Start a topic in the panel — or wait for one queued elsewhere.
      </p>
      <div className="w-80 max-w-full opacity-60">
        <PipelineStrip
          dim
          stages={STAGES.map((name) => ({ name, state: "todo" as const }))}
        />
      </div>
    </div>
  );
}
