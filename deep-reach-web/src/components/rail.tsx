"use client";

// Left rail: wordmark, theme toggle, NEW RESEARCH form.
// Files upload to the worker immediately (staged for the NEXT created
// task); START posts the run. The worker's staging registry is the source
// of truth — chips mirror GET /documents after each upload.

import { useRef, useState } from "react";
import { ApiError, api } from "@/lib/api";
import { cx } from "@/lib/cx";
import { ThemeToggle } from "@/lib/theme";

type ChipState = "uploading" | "staged" | "error";

interface Chip {
  key: string;
  name: string;
  state: ChipState;
  reason?: string;
}

interface RailProps {
  pendingCount: number;
  runningCount: number;
  /** called with the new task id after a successful create */
  onCreated: (id: string) => void;
}

let chipSeq = 0;

export function Rail({ pendingCount, runningCount, onCreated }: RailProps) {
  const [open, setOpen] = useState(false); // mobile collapse (below 960px)
  const fileRef = useRef<HTMLInputElement>(null);
  const [topic, setTopic] = useState("");
  const [maxRounds, setMaxRounds] = useState("3");
  const [budgetDoc, setBudgetDoc] = useState("10");
  const [budgetWeb, setBudgetWeb] = useState("5");
  const [chips, setChips] = useState<Chip[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); // any upload in flight

  async function addFiles(list: File[]) {
    if (list.length === 0) return;
    const incoming: Chip[] = list.map((f) => ({
      key: `c${++chipSeq}`,
      name: f.name,
      state: "uploading",
    }));
    setChips((prev) => [...prev, ...incoming]);
    setBusy(true);
    try {
      const res = await api.uploadDocuments(list);
      const docs = await api.getDocuments(); // confirm against the registry
      const rejected: Chip[] = Object.entries(res.rejected).map(([name, reason]) => ({
        key: `c${++chipSeq}`,
        name,
        state: "error",
        reason,
      }));
      setChips((prev) => [
        ...prev.filter((c) => c.state === "error"),
        ...rejected,
        ...docs.staged.map((name): Chip => ({
          key: `c${++chipSeq}`,
          name,
          state: "staged",
        })),
      ]);
    } catch (err) {
      const reason = err instanceof ApiError ? err.body || err.message : String(err);
      setChips((prev) =>
        prev.map((c) =>
          c.state === "uploading" ? { ...c, state: "error", reason } : c,
        ),
      );
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = ""; // allow re-select
    }
  }

  async function clearStaged() {
    setBusy(true);
    try {
      await api.deleteDocuments();
      setChips((prev) => prev.filter((c) => c.state === "error"));
    } catch {
      // keep the chips; the next upload refetch reconciles
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!topic.trim()) {
      setCreateError("enter a topic first");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const res = await api.createResearch({
        topic: topic.trim(),
        max_rounds: Math.max(1, parseInt(maxRounds, 10) || 3),
        budget_doc: Math.max(0, parseInt(budgetDoc, 10) || 10),
        budget_web: Math.max(0, parseInt(budgetWeb, 10) || 5),
      });
      // The worker attached the whole staging area to this task (and cleared
      // it), so the chips go with it.
      setTopic("");
      setChips((prev) => prev.filter((c) => c.state === "error"));
      onCreated(res.task_id);
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.body || err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

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

        <div className={cx("flex-col gap-5", open ? "flex" : "hidden min-[960px]:flex")}>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void start();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-dim">
                New research
              </span>
              <textarea
                rows={3}
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="What should we dig into?"
                className="w-full resize-none rounded-none border border-hairline bg-field px-3 py-2 text-[13px] placeholder:text-dim/70"
              />
            </div>

            <div className="grid grid-cols-3 gap-2">
              <label className="flex flex-col gap-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-dim">
                  Max rounds
                </span>
                <input
                  type="number"
                  value={maxRounds}
                  min={1}
                  onChange={(e) => setMaxRounds(e.target.value)}
                  className="rounded-none border border-hairline bg-field px-2 py-1.5 font-mono text-[12px]"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-dim">
                  Docs
                </span>
                <input
                  type="number"
                  value={budgetDoc}
                  min={0}
                  onChange={(e) => setBudgetDoc(e.target.value)}
                  className="rounded-none border border-hairline bg-field px-2 py-1.5 font-mono text-[12px]"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-dim">
                  Web
                </span>
                <input
                  type="number"
                  value={budgetWeb}
                  min={0}
                  onChange={(e) => setBudgetWeb(e.target.value)}
                  className="rounded-none border border-hairline bg-field px-2 py-1.5 font-mono text-[12px]"
                />
              </label>
            </div>

            <label
              className="block cursor-pointer border border-dashed border-hairline px-3 py-4 text-center hover:bg-field"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                void addFiles(Array.from(e.dataTransfer.files));
              }}
            >
              <input
                ref={fileRef}
                type="file"
                accept="application/pdf"
                multiple
                className="sr-only"
                onChange={(e) => void addFiles(Array.from(e.target.files ?? []))}
              />
              <span className="font-mono text-[11px] text-dim">
                Drop PDFs or <span className="text-accent">browse</span>
              </span>
            </label>

            {chips.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <ul className="flex flex-wrap gap-1.5">
                  {chips.map((chip) => (
                    <li
                      key={chip.key}
                      title={chip.reason}
                      className={cx(
                        "flex items-center gap-1.5 border px-2 py-1 font-mono text-[11px]",
                        chip.state === "uploading" && "border-hairline bg-field text-dim",
                        chip.state === "staged" && "border-hairline bg-field",
                        chip.state === "error" && "border-err-hairline bg-err-soft text-err",
                      )}
                    >
                      {chip.name}
                      {chip.state === "uploading" && <span aria-hidden>…</span>}
                      {chip.state === "error" && <span aria-hidden>×</span>}
                    </li>
                  ))}
                </ul>
                {chips.some((c) => c.state === "staged") && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void clearStaged()}
                    className="self-start font-mono text-[10px] uppercase tracking-[0.12em] text-dim hover:text-err disabled:opacity-50"
                  >
                    clear all staged
                  </button>
                )}
                <p className="font-mono text-[10px] text-dim/70">
                  staged PDFs attach to the next research you start
                </p>
              </div>
            )}

            <button
              type="submit"
              disabled={creating || busy}
              className="w-full rounded-none bg-accent py-2.5 font-display text-[12px] font-semibold uppercase tracking-[0.12em] text-field hover:shadow-[0_0_28px_var(--glow)] disabled:opacity-50"
            >
              {creating ? "Starting…" : "Start research"}
            </button>
            {createError && (
              <p role="alert" className="font-mono text-[11px] text-err">
                {createError}
              </p>
            )}
            {runningCount > 0 && pendingCount > 0 && !creating && (
              <p className="text-center font-mono text-[11px] text-dim">
                queue: {pendingCount} ahead
              </p>
            )}
          </form>
        </div>
      </div>
    </aside>
  );
}
