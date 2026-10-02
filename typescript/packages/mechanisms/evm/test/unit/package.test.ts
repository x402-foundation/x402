import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";

type PackageManifest = {
  dependencies: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

const manifest = packageJson as PackageManifest;

describe("@x402/evm package manifest", () => {
  it("keeps viem optional for server-only consumers", () => {
    expect(manifest.dependencies).not.toHaveProperty("viem");
    expect(manifest.peerDependencies?.viem).toBe("^2.48.11");
    expect(manifest.peerDependenciesMeta?.viem?.optional).toBe(true);
  });
});
