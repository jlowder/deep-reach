// Tiny time formatters over the worker's epoch-second timestamps.

/** 1788272018.03 -> "13:58:12" (local). */
export function fmtClock(ts: number | null | undefined): string {
  if (ts === null || ts === undefined) return "—";
  return new Date(ts * 1000).toLocaleTimeString("en-GB", { hour12: false });
}

/** (end - start) seconds -> "04:12" or "1:04:12". */
export function fmtElapsed(start: number | null, end: number | null): string {
  if (start === null) return "—";
  const s = Math.max(0, Math.round((end ?? Date.now() / 1000) - start));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}
