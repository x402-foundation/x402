import path from "node:path";

import type { NextConfig } from "next";

// Workspace packages live in typescript/packages, outside examples/typescript.
const monorepoRoot = path.resolve(process.cwd(), "../../../..");

const nextConfig: NextConfig = {
  turbopack: {
    root: monorepoRoot,
  },
  outputFileTracingRoot: monorepoRoot,
};

export default nextConfig;
