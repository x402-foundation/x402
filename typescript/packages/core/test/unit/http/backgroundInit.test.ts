import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachBackgroundInitHandler,
  isFatalStartupInitError,
} from "../../../src/http/backgroundInit";
import { RouteConfigurationError } from "../../../src/http/x402HTTPResourceServer";
import { FacilitatorCapabilityError } from "../../../src/types/facilitator";

describe("backgroundInit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("isFatalStartupInitError", () => {
    it("treats capability and route configuration errors as fatal", () => {
      expect(
        isFatalStartupInitError(new FacilitatorCapabilityError(["upto on solana:devnet: missing"])),
      ).toBe(true);
      expect(
        isFatalStartupInitError(
          new RouteConfigurationError([
            {
              routePattern: "GET /api/generate",
              scheme: "upto",
              network: "solana:devnet",
              reason: "missing_facilitator",
              message: "missing facilitator",
            },
          ]),
        ),
      ).toBe(true);
    });

    it("treats facilitator timeouts as retryable", () => {
      expect(isFatalStartupInitError(new Error("facilitator request timed out"))).toBe(false);
    });
  });

  describe("attachBackgroundInitHandler", () => {
    it("exits the process on a capability mismatch", async () => {
      const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      attachBackgroundInitHandler(
        Promise.reject(new FacilitatorCapabilityError(["upto on solana:devnet: missing"])),
      );
      await Promise.resolve();
      await Promise.resolve();

      expect(exit).toHaveBeenCalledWith(1);
    });

    it("does not exit on a retryable facilitator timeout", async () => {
      const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

      attachBackgroundInitHandler(Promise.reject(new Error("facilitator request timed out")));
      await Promise.resolve();
      await Promise.resolve();

      expect(exit).not.toHaveBeenCalled();
    });
  });
});
