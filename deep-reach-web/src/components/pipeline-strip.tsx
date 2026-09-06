import { Fragment } from "react";
import { cx } from "@/lib/cx";
import type { StripStage } from "@/lib/stages";

/**
 * THE SIGNATURE — five pipeline nodes on a 1px track.
 * done = accent fill, current = accent + breathing glow, todo = hairline
 * outline. `dim` renders the all-dim variant (pending tasks, empty state).
 */
export function PipelineStrip({
  stages,
  dim = false,
}: {
  stages: StripStage[];
  dim?: boolean;
}) {
  return (
    <div className="flex w-full items-start">
      {stages.map((stage, i) => (
        <Fragment key={stage.name}>
          {i > 0 && (
            <span
              aria-hidden
              className={cx(
                "mt-[5px] h-px min-w-3 flex-1",
                // a segment is lit once work has reached the node after it;
                // error nodes leave their leading segment unlit
                dim || stage.state === "todo" || stage.state === "err"
                  ? "bg-hairline"
                  : "bg-accent",
              )}
            />
          )}
          <div className="flex shrink-0 flex-col items-center gap-1.5">
            <span
              className={cx(
                "h-2.5 w-2.5 rounded-full",
                dim && "border border-dim/50",
                !dim && stage.state === "done" && "bg-accent",
                !dim && stage.state === "current" && "bg-accent animate-pulse-glow",
                !dim && stage.state === "err" && "bg-err",
                !dim && stage.state === "todo" && "border border-hairline",
              )}
            />
            <span
              className={cx(
                "font-mono text-[10px] uppercase tracking-[0.12em]",
                dim
                  ? "text-dim/70"
                  : stage.state === "todo"
                    ? "text-dim"
                    : stage.state === "err"
                      ? "text-err"
                      : "text-text",
              )}
            >
              {stage.name}
            </span>
          </div>
        </Fragment>
      ))}
    </div>
  );
}
