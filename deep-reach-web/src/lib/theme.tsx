"use client";

// Theme system: "ink" (default) | "paper". The value lives in localStorage
// under THEME_KEY and is applied to <html data-theme>. An inline script in
// src/app/layout.tsx runs the same read before first paint, so switching
// never flashes the wrong palette.

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { cx } from "./cx";

export type Theme = "ink" | "paper";

export const THEME_KEY = "deep-reach-theme";
const DEFAULT_THEME: Theme = "ink";
// Fired after our own writes; "storage" fires for other tabs.
const SELF_EVENT = "deepreach:theme-change";

function readStoredTheme(): Theme {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    return v === "paper" ? "paper" : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(SELF_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(SELF_EVENT, callback);
  };
}

const getSnapshot = () => readStoredTheme();
const getServerSnapshot = () => DEFAULT_THEME;

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Make sure the DOM attribute matches (it should, via the pre-paint script;
  // this covers the no-JS-script edge and mid-session other-tab writes).
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      // private mode: the switch still works for this session
    }
    window.dispatchEvent(new Event(SELF_EVENT));
  }, []);

  return { theme, setTheme };
}

/** Segmented INK / PAPER control. */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  return (
    <div
      role="group"
      aria-label="Theme"
      className={cx("flex border border-hairline", className)}
    >
      {(["ink", "paper"] as Theme[]).map((t) => (
        <button
          key={t}
          type="button"
          aria-pressed={theme === t}
          onClick={() => setTheme(t)}
          className={cx(
            "flex-1 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em]",
            theme === t
              ? "bg-raised text-accent"
              : "text-dim hover:text-text",
          )}
        >
          {t}
        </button>
      ))}
    </div>
  );
}