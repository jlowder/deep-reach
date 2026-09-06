"use client";

// Left rail: wordmark, theme toggle, NEW RESEARCH form.
// All handlers are no-ops for now — real submission wiring lands next.

import { useRef, useState } from "react";
import { cx } from "@/lib/cx";
import { ThemeToggle } from "@/lib/theme";

// Static sample — real upload staging lands next dispatch.
const STAGED_DOCS = ["attention-mechanisms.pdf"];

const BUDGETS = [
  { label: "Max rounds", value: 3 },
  { label: "Docs", value: 10 },
  { label: "Web", value: 5 },
] as const;

export function Rail() {
  const [open, setOpen] = useState(false); // mobile collapse (below 960px)
  const fileRef = useRef<HTMLInputElement>(null);
  // Static sample: pretend a run is in flight so the queue hint renders.
  const busy = true; // wired next

  return (
    <aside className="border-b border-hairline bg-surface min-[960px]:border-b-0 min-[960px]:border-r">
      <div className="flex flex-col gap-6 p-5">
        <div className="flex flex-col gap-1">
          <p className="font-display text-[15px] font-bold tracking-[0.18em]">
            DEEP <span className="text-accent">REACH</span>
          </p>
          <p className="font-mono text-[10px] tracking-[0.14em] text-dim">
            DEEP RESEARCH CONSOLE
          </p>
        </div>

        <ThemeToggle />

        {/* Collapse control — mobile only; the form is always open at ≥960px. */}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center justify-between border border-hairline px-3 py-2 min-[960px]:hidden"
        >
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-dim">
            New research
          </span>
          <span aria-hidden className="font-mono text-[11px] text-dim">
            {open ? "▴" : "▾"}
          </span>
        </button>

        <div
          className={cx(
            "flex-col gap-5",
            open ? "flex" : "hidden min-[960px]:flex",
          )}
        >
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              /* wired next: POST /api/research with topic + budgets + docs */
            }}
          >
            <div className="flex flex-col gap-1.5">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-dim">
                New research
              </span>
              <textarea
                rows={3}
                placeholder="What should we dig into?"
                className="w-full resize-none rounded-none border border-hairline bg-field px-3 py-2 text-[13px] placeholder:text-dim/70"
              />
            </div>

            <div className="grid grid-cols-3 gap-2">
              {BUDGETS.map((b) => (
                <label key={b.label} className="flex flex-col gap-1">
                  <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-dim">
                    {b.label}
                  </span>
                  <input
                    type="number"
                    defaultValue={b.value}
                    min={0}
                    className="rounded-none border border-hairline bg-field px-2 py-1.5 font-mono text-[12px]"
                  />
                </label>
              ))}
            </div>

            <label className="block cursor-pointer border border-dashed border-hairline px-3 py-4 text-center hover:bg-field">
              <input
                ref={fileRef}
                type="file"
                accept="application/pdf"
                multiple
                className="sr-only"
                onChange={() => {
                  /* wired next: stage via POST /api/documents */
                }}
              />
              <span className="font-mono text-[11px] text-dim">
                Drop PDFs or <span className="text-accent">browse</span>
              </span>
            </label>

            {STAGED_DOCS.length > 0 && (
              <ul className="flex flex-wrap gap-1.5">
                {STAGED_DOCS.map((name) => (
                  <li
                    key={name}
                    className="flex items-center gap-1.5 border border-hairline bg-field px-2 py-1 font-mono text-[11px]"
                  >
                    {name}
                    <button
                      type="button"
                      aria-label={`Remove ${name}`}
                      className="text-dim hover:text-err"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <button
              type="submit"
              className="w-full rounded-none bg-accent py-2.5 font-display text-[12px] font-semibold uppercase tracking-[0.12em] text-field hover:shadow-[0_0_28px_var(--glow)]"
            >
              Start research
            </button>
            {busy && (
              <p className="text-center font-mono text-[11px] text-dim">
                queue: 1 ahead
              </p>
            )}
          </form>
        </div>
      </div>
    </aside>
  );
}
