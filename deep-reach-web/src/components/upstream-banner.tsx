/**
 * Shown when the task-list poll fails (glue down, 5xx); hidden on recovery.
 * Renders the real error message from the failed poll.
 */
export function UpstreamBanner({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div
      role="status"
      className="border border-err-hairline bg-err-soft px-4 py-2.5 font-mono text-[12px] text-err"
    >
      {message}
    </div>
  );
}
