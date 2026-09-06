"use client";

// Live task state for the console.
//
// useTasks       — polls GET /research every 2 s (immediately on mount),
//                  pauses while the tab is hidden, resumes on return.
// useTaskDetail  — loads GET /research/{id}; while the task is pending or
//                  running, re-polls every 1.5 s so steps/current_step stay
//                  fresh; terminal tasks load once.

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "./api";
import type { Task, TaskSummary } from "./types";

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err);
}

export function useTasks(intervalMs = 2000) {
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const { tasks: next } = await api.listTasks();
      if (!alive.current) return;
      setTasks(next);
      setError(null);
      setLastUpdate(Date.now());
    } catch (err) {
      if (!alive.current) return;
      setError(message(err));
      setLastUpdate(Date.now());
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    let chainAlive = true; // closure-local: a ref is shared across the
    // dev strict-mode double-mount, which would let a dead chain reschedule
    let timer: number | undefined;
    let inFlight = false; // a tick already running — never start a second chain
    const tick = async () => {
      timer = undefined;
      if (document.hidden) return; // paused; visibilitychange resumes
      if (inFlight) return; // one tick at a time; the settler reschedules
      inFlight = true;
      try {
        await refresh();
      } finally {
        inFlight = false;
      }
      if (chainAlive && !document.hidden) timer = window.setTimeout(tick, intervalMs);
    };
    void tick();
    const onVisibility = () => {
      if (!document.hidden && timer === undefined && !inFlight) void tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      chainAlive = false;
      alive.current = false;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh, intervalMs]);

  /** Optimistic delete: drop the row locally, fire the API call, resync. */
  const removeTask = useCallback(
    (id: string) => {
      setTasks((prev) => (prev ? prev.filter((t) => t.id !== id) : prev));
      api
        .deleteTask(id)
        .then(() => void refresh())
        .catch(() => void refresh()); // 404/409 race: the refetch is the truth
    },
    [refresh],
  );

  return { tasks, error, lastUpdate, refresh, removeTask };
}

/** Detail fetch + fast poll for live tasks. `active` = pending/running. */
export function useTaskDetail(
  id: string | null,
  active: boolean,
  intervalMs = 1500,
) {
  // `alive` is intentionally a closure-local (not a ref): dev strict-mode
  // double-mounts effects, and a shared ref would let the dead first chain
  // reschedule after the second chain resets it — permanent double polling.
  const [state, setState] = useState<{
    id: string | null;
    task: Task | null;
    error: string | null;
  }>({ id: null, task: null, error: null });

  // Reset on id change (render-phase adjustment — the documented pattern for
  // derived state; avoids a synchronous setState in an effect).
  if (state.id !== id) {
    setState({ id, task: null, error: null });
  }

  useEffect(() => {
    if (!id) return;
    let chainAlive = true;
    let timer: number | undefined;
    let inFlight = false; // a tick already running — never start a second chain
    const tick = async () => {
      timer = undefined;
      if (document.hidden) return;
      if (inFlight) return; // one tick at a time; the settler reschedules
      inFlight = true;
      try {
        try {
          const task = await api.getTask(id);
          if (!chainAlive) return;
          setState((s) =>
            s.id === id ? { id, task, error: null } : s,
          );
        } catch (err) {
          if (!chainAlive) return;
          if (err instanceof ApiError && err.status === 404) {
            setState((s) => (s.id === id ? { id, task: null, error: null } : s));
          } else {
            setState((s) => (s.id === id ? { id, task: s.task, error: message(err) } : s));
          }
        }
      } finally {
        inFlight = false;
      }
      if (chainAlive && active && !document.hidden) {
        timer = window.setTimeout(tick, intervalMs);
      }
    };
    void tick();
    const onVisibility = () => {
      if (!document.hidden && timer === undefined && !inFlight) void tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      chainAlive = false;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [id, active, intervalMs]);

  return { task: state.task, error: state.error };
}
