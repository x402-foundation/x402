import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { warnLegacyDeprecation } from "./deprecation";

describe("warnLegacyDeprecation", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    delete process.env.X402_SUPPRESS_LEGACY_WARNING;
  });

  const cases = [
    {
      pkg: "x402-shared-test-core",
      replacement: "@x402/core",
      kind: "core" as const,
      contains: ["v1 implementation and is frozen", "@x402/core"],
    },
    {
      pkg: "x402-shared-test-axios",
      replacement: "@x402/axios",
      kind: "client" as const,
      contains: ["v1 client implementation", "PAYMENT-REQUIRED", "@x402/axios"],
    },
    {
      pkg: "x402-shared-test-express",
      replacement: "@x402/express",
      kind: "server" as const,
      contains: ["JSON response body", "PAYMENT-REQUIRED", "@x402/express"],
    },
  ];

  it.each(cases)(
    "builds the $kind message and warns once for $pkg",
    ({ pkg, replacement, kind, contains }) => {
      warnLegacyDeprecation(pkg, replacement, kind);
      warnLegacyDeprecation(pkg, replacement, kind);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = warnSpy.mock.calls[0][0] as string;
      expect(message).toContain(`[${pkg}]`);
      for (const substr of contains) {
        expect(message).toContain(substr);
      }
    },
  );

  it("suppresses the warning when X402_SUPPRESS_LEGACY_WARNING is set", () => {
    process.env.X402_SUPPRESS_LEGACY_WARNING = "1";
    warnLegacyDeprecation("x402-shared-test-suppressed", "@x402/fetch", "client");
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
