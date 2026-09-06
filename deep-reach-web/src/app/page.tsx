"use client";

import { useEffect, useState } from "react";

// Placeholder proving the /api/* rewrite works: fetch the glue service's
// /health same-origin and dump it. Ugly on purpose — design comes later.

type Health = {
  service: string;
  running: boolean;
  pending: number;
  deep_configured: boolean;
};

export default function Home() {
  const [body, setBody] = useState<string>("loading /api/health…");

  useEffect(() => {
    fetch("/api/health")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as Health;
        setBody(JSON.stringify(data, null, 2));
      })
      .catch((e) => setBody(`failed: ${e}`));
  }, []);

  return (
    <main className="flex flex-1 items-start justify-center p-8">
      <pre className="font-mono text-sm">{body}</pre>
    </main>
  );
}
