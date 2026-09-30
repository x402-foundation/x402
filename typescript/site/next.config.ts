import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @aptos-labs/ts-sdk uses native crypto and other Node.js APIs that conflict with Next.js bundling
  // Its transitive dependencies (got, keyv, cacheable-request) also need to be externalized
  serverExternalPackages: [
    "@aptos-labs/ts-sdk",
    "@aptos-labs/aptos-client",
    "@hiero-ledger/sdk",
    "@keetanetwork/keetanet-client",
    "@keetanetwork/anchor",
    "got",
    "keyv",
    "cacheable-request",
  ],
};

export default nextConfig;
