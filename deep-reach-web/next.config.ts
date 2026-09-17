import type { NextConfig } from "next";

// The browser only ever calls same-origin /api/* paths; Next rewrites them to
// the Deep Reach glue service (deep-reach-api). The rewrite destination is
// fixed when the server starts — point it elsewhere with DEEP_REACH_API_URL
// (.env.local, see .env.example).
const DEEP_REACH_API_URL =
  process.env.DEEP_REACH_API_URL ?? "http://localhost:8320";

const nextConfig: NextConfig = {
  experimental: {
    // Cap on request bodies proxied through the /api rewrite below. Next
    // truncates anything over this (default 10MB —
    // experimental.proxyClientMaxBodySize, renamed from
    // middlewareClientMaxBodySize in Next 16): the clone feeding the upstream
    // stream is cut off mid-body, so a 17MB PDF would reach the worker
    // silently incomplete. Raised to 20MB for the PDF upload flow.
    proxyClientMaxBodySize: "20mb",
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${DEEP_REACH_API_URL}/:path*`,
      },
    ];
  },
};

export default nextConfig;
