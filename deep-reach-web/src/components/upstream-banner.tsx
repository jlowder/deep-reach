export function UpstreamBanner({ show }: { show?: boolean }) {
  if (!show) return null;
  return (
    <div
      role="status"
      className="border border-err-hairline bg-err-soft px-4 py-2.5 font-mono text-[12px] text-err"
    >
      API unreachable — start deep-reach-api?{" "}
      <span className="text-dim">(GET /api/health failed)</span>
    </div>
  );
}
