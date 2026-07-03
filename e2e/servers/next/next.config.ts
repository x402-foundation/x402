import path from "node:path";

import type { NextConfig } from "next";

// Workspace packages live in typescript/packages, outside e2e.
const monorepoRoot = path.resolve(process.cwd(), "../../..");

const nextConfig: NextConfig = {
  turbopack: {
    root: monorepoRoot,
  },
  outputFileTracingRoot: monorepoRoot,
  serverExternalPackages: ["@keetanetwork/keetanet-client", "@keetanetwork/asn1-napi-rs"],
};

export default nextConfig;
