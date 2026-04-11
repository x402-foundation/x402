import { describe, expect, it, vi } from "vitest";
import type { Address, Chain, Client, Transport } from "viem";
import { getTokenBalance, getTokenDecimals } from "./utils";

function createMockClient(readContract: ReturnType<typeof vi.fn>) {
  return {
    chain: { id: 4326 } as Chain,
    readContract,
  } as unknown as Client<Transport, Chain, undefined>;
}

describe("evm token utils", () => {
  it("reads token balances from the requested asset address", async () => {
    const readContract = vi.fn().mockResolvedValue(1234567890123456789n);
    const client = createMockClient(readContract);
    const tokenAddress = "0xFAfDdbb3FC7688494971a79cc65DCa3EF82079E7" as Address;
    const holder = "0x209693Bc6afc0C5328bA36FaF04C514EF312287C" as Address;

    const balance = await getTokenBalance(client, tokenAddress, holder);

    expect(balance).toBe(1234567890123456789n);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: tokenAddress,
        functionName: "balanceOf",
        args: [holder],
      }),
    );
  });

  it("reads token decimals from the requested asset address", async () => {
    const readContract = vi.fn().mockResolvedValue(18);
    const client = createMockClient(readContract);
    const tokenAddress = "0xFAfDdbb3FC7688494971a79cc65DCa3EF82079E7" as Address;

    const decimals = await getTokenDecimals(client, tokenAddress);

    expect(decimals).toBe(18);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: tokenAddress,
        functionName: "decimals",
      }),
    );
  });

  it("falls back to a provided decimal value when token metadata lookup fails", async () => {
    const readContract = vi.fn().mockRejectedValue(new Error("rpc unavailable"));
    const client = createMockClient(readContract);
    const tokenAddress = "0xFAfDdbb3FC7688494971a79cc65DCa3EF82079E7" as Address;
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(getTokenDecimals(client, tokenAddress, 18)).resolves.toBe(18);
      expect(consoleErrorSpy).toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
