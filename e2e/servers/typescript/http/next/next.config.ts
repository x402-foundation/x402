import path from "node:path";

import type { NextConfig } from "next";

// Workspace packages live in typescript/packages, outside e2e.
const monorepoRoot = path.resolve(process.cwd(), "../../../../../");

const nextConfig: NextConfig = {
  turbopack: {
    root: monorepoRoot,
  },
  outputFileTracingRoot: monorepoRoot,
  serverExternalPackages: ["@keetanetwork/keetanet-client", "@keetanetwork/asn1-napi-rs"],
  // App Router treats `_`-prefixed segments as private; harness uses /__e2e/...
  async rewrites() {
    return [
      {
        source: "/__e2e/auth-capture/capture",
        destination: "/api/e2e/auth-capture/capture",
      },
    ];
  },
};

export default nextConfig;
