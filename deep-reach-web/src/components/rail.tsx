"use client";

// Left rail: wordmark, NEW RESEARCH form, theme toggle (pinned to the bottom).
// Files upload to the worker immediately (staged for the NEXT created
// task); START posts the run. The worker's staging registry is the source
// of truth — chips mirror GET /documents after each upload.

import { useRef, useState } from "react";
import { ApiError, api } from "@/lib/api";
import { cx } from "@/lib/cx";
import type { QueueState } from "@/lib/types";
import { ThemeToggle } from "@/lib/theme";
import { SettingsButton } from "@/components/settings-dialog";
import type { RefObject } from "react";

type ChipState = "uploading" | "staged" | "error";

interface Chip {
  key: string;
  name: string;
  state: ChipState;
  reason?: string;
}

interface RailProps {
  /** Authoritative queue state from the 2s poll (useTasks). */
  queue: QueueState;
  /** useTasks lastUpdate — a poll completed at/after an optimistic flip is
   *  the authority to snap the display back to. */
  queueSyncedAt: number | null;
  /** true while the poll is showing an error (don't snap onto a stale poll). */
  queueSyncFailed: boolean;
  /** called with the new task id after a successful create */
  onCreated: (id: string) => void;
  onOpenSettings: () => void;
  /** the settings gear — the dialog refocuses it on close */
  settingsTriggerRef: RefObject<HTMLButtonElement | null>;
}

let chipSeq = 0;

export function Rail({ queue, queueSyncedAt, queueSyncFailed, onCreated, onOpenSettings, settingsTriggerRef }: RailProps) {
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
      <div className="flex h-full flex-col gap-6 p-5">
        <div className="flex flex-col gap-1">
          <p className="font-display text-[15px] font-bold tracking-[0.18em]">
            DEEP <span className="text-accent">REACH</span>
          </p>
          <p className="font-mono text-[10px] tracking-[0.14em] text-dim">
            DEEP RESEARCH CONSOLE
          </p>
        </div>

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
                rows={6}
                aria-label="Research topic"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="What should we dig into?"
                className="min-h-[120px] w-full resize-none rounded-none border border-hairline bg-field px-3 py-2 text-[15px] placeholder:text-dim/70"
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
          </form>
        </div>

        <div className="mt-auto border-t border-hairline pt-6">
          <div className="flex items-center gap-3">
            <QueueToggle paused={queue.paused} pending={queue.pending} syncedAt={queueSyncedAt} syncFailed={queueSyncFailed} />
            <ThemeToggle className="flex-1" />
            <SettingsButton onClick={onOpenSettings} buttonRef={settingsTriggerRef} />
          </div>
        </div>
      </div>
    </aside>
  );
}

/**
 * Queue pause control (in-memory on the worker; resets on its restart;
 * running runs are unaffected). Optimistic: the click flips the display
 * immediately and PUTs; the result is kept until the first poll that
 * completes after the click settles it (matching → silently absorb;
 * disagreeing, e.g. a worker restart in between → snap to the poll).
 * Not destructive — no arming; a failed PUT reverts + shows the worker's
 * verbatim error inline.
 */
function QueueToggle({
  paused,
  pending,
  syncedAt,
  syncFailed,
}: {
  paused: boolean;
  pending: number;
  syncedAt: number | null;
  syncFailed: boolean;
}) {
  const [optimistic, setOptimistic] = useState<{ paused: boolean; at: number } | null>(null);
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reconcile in the render phase (the documented derived-state pattern —
  // no effect, no paint of the stale value): once a non-error poll has
  // completed at/after the click, the poll is the truth again.
  if (optimistic !== null && syncedAt !== null && syncedAt >= optimistic.at && !syncFailed) {
    setOptimistic(null);
  }

  const shown = optimistic !== null ? optimistic.paused : paused;

  const toggle = () => {
    if (inFlight) return;
    const next = !shown;
    setOptimistic({ paused: next, at: Date.now() });
    setInFlight(true);
    setError(null);
    api
      .setQueue(next)
      .then(() => {
        // Keep the optimistic value; the post-click poll confirms and
        // clears it (absorbed silently above).
        setInFlight(false);
      })
      .catch((err: unknown) => {
        setOptimistic(null); // revert
        setInFlight(false);
        setError(err instanceof ApiError ? err.message : String(err));
      });
  };

  return (
    <div className="flex flex-col justify-center gap-1.5">
      <button
        type="button"
        onClick={toggle}
        disabled={inFlight}
        aria-pressed={shown}
        aria-label={
          shown
            ? `Queue paused${pending > 0 ? `, ${pending} waiting` : ""} — resume queue`
            : "Queue active — pause queue"
        }
        title={shown ? "Resume queue" : "Pause queue"}
        className="-mx-1 flex items-center gap-2 rounded-none px-1 py-1 text-dim hover:text-text focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-50"
      >
        <span
          aria-hidden
          className={
            shown
              ? "h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_8px_var(--glow)]"
              : "h-1.5 w-1.5 rounded-full bg-dim"
          }
        />
        {shown ? <PlayIcon className="h-3.5 w-3.5" /> : <PauseIcon className="h-3.5 w-3.5" />}
        <span className="font-mono text-[10px] uppercase tracking-[0.14em]">queue</span>
        <span className={cx("font-mono text-[10px]", shown ? "text-wait" : "text-dim/70")}>
          {shown ? (pending > 0 ? `paused · ${pending}` : "paused") : "active"}
        </span>
      </button>
      {error && (
        <p role="alert" className="max-w-56 font-mono text-[11px] leading-snug text-err">
          {error}
        </p>
      )}
    </div>
  );
}

function PauseIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden fill="currentColor" stroke="none">
      <rect x="6.5" y="5" width="3.5" height="14" />
      <rect x="14" y="5" width="3.5" height="14" />
    </svg>
  );
}

function PlayIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden fill="currentColor" stroke="none">
      <path d="M8 5.5v13l11-6.5z" />
    </svg>
  );
}
