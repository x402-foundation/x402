import { describe, expect, it, vi, afterEach } from "vitest";
import type { Address } from "viem";
import { getTokenBalance, getTokenDecimals } from "./utils";

const TOKEN: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const OWNER: Address = "0x209693Bc6afc0C5328bA36FaF04C514EF312287C";

/**
 * Builds a minimal viem-compatible client whose `readContract` is a vi.fn we control.
 *
 * @param impl - Implementation for the mocked `readContract` call
 * @returns A client object with the mocked method, typed loosely for test ergonomics
 */
function makeClient(impl: (params: { functionName: string }) => unknown) {
  return {
    readContract: vi.fn(impl),
  } as unknown as Parameters<typeof getTokenBalance>[0];
}

describe("getTokenBalance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the balance reported by the token contract", async () => {
    const client = makeClient(({ functionName }) =>
      functionName === "balanceOf" ? 1234567890n : 0n,
    );

    const balance = await getTokenBalance(client, TOKEN, OWNER);
    expect(balance).toBe(1234567890n);
  });

  it("returns 0n and logs when the contract read throws", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = makeClient(() => {
      throw new Error("rpc unreachable");
    });

    const balance = await getTokenBalance(client, TOKEN, OWNER);
    expect(balance).toBe(0n);
    expect(errSpy).toHaveBeenCalled();
  });
});

describe("getTokenDecimals", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the decimals reported by the token contract", async () => {
    const client = makeClient(({ functionName }) => (functionName === "decimals" ? 18 : 0n));

    const decimals = await getTokenDecimals(client, TOKEN);
    expect(decimals).toBe(18);
  });

  it("coerces a bigint return value to a number", async () => {
    const client = makeClient(() => 6n);

    const decimals = await getTokenDecimals(client, TOKEN);
    expect(decimals).toBe(6);
  });

  it("falls back to 6 and logs when the contract read throws", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = makeClient(() => {
      throw new Error("not an erc20");
    });

    const decimals = await getTokenDecimals(client, TOKEN);
    expect(decimals).toBe(6);
    expect(errSpy).toHaveBeenCalled();
  });
});
