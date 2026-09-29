import { generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";

import { BatchSvmScheme as BatchFacilitatorScheme } from "../../src/batch-settlement/facilitator/scheme";
import { InMemoryBatchReceiverAuthorizerStore } from "../../src/batch-settlement/facilitator/receiverAuthorizerStore";
import { SOLANA_DEVNET_CAIP2 } from "../../src/constants";
import { toFacilitatorSvmSigner } from "../../src/signer";

const NETWORK = SOLANA_DEVNET_CAIP2;

/** Reaches the private channel-read helpers. */
type Internals = {
  readChannel(network: string, channelId: string): Promise<unknown>;
  rememberSlot(network: string, slot: bigint): void;
  waitForChannelRead(attempt: number): Promise<void>;
};

/**
 * A facilitator whose account reads are scripted by `getAccountInfo`.
 *
 * @param getAccountInfo - Scripted transport read
 * @returns The facilitator's private read helpers
 */
async function facilitator(getAccountInfo: ReturnType<typeof vi.fn>): Promise<Internals> {
  const wallet = await generateKeyPairSigner();
  const transport = { ...toFacilitatorSvmSigner(wallet), getAccountInfo };
  const scheme = new BatchFacilitatorScheme(transport, {
    receiverAuthorizerStore: new InMemoryBatchReceiverAuthorizerStore(),
  }) as unknown as Internals;
  vi.spyOn(scheme, "waitForChannelRead").mockResolvedValue(undefined);
  return scheme;
}

describe("batch-settlement channel reads under a confirmation slot floor", () => {
  it("retries a read the backend rejects for the remembered slot, then returns the account", async () => {
    const getAccountInfo = vi
      .fn()
      .mockRejectedValueOnce(new Error("Minimum context slot has not been reached"))
      .mockRejectedValueOnce(new Error("Minimum context slot has not been reached"))
      .mockResolvedValueOnce(null);
    const internals = await facilitator(getAccountInfo);
    internals.rememberSlot(NETWORK, 321n);

    await expect(internals.readChannel(NETWORK, "channel")).resolves.toBeUndefined();

    expect(getAccountInfo).toHaveBeenCalledTimes(3);
    for (const call of getAccountInfo.mock.calls) {
      expect(call[2]).toMatchObject({ commitment: "confirmed", minContextSlot: 321n });
    }
  });

  it("gives up after the read budget when the backend never catches up", async () => {
    const getAccountInfo = vi
      .fn()
      .mockRejectedValue(new Error("Minimum context slot has not been reached"));
    const internals = await facilitator(getAccountInfo);
    internals.rememberSlot(NETWORK, 321n);

    await expect(internals.readChannel(NETWORK, "channel")).rejects.toThrow(
      "Minimum context slot has not been reached",
    );
    expect(getAccountInfo).toHaveBeenCalledTimes(5);
  });

  it("surfaces a read error at once when no slot floor is in effect", async () => {
    const getAccountInfo = vi.fn().mockRejectedValue(new Error("rpc unavailable"));
    const internals = await facilitator(getAccountInfo);

    await expect(internals.readChannel(NETWORK, "channel")).rejects.toThrow("rpc unavailable");
    expect(getAccountInfo).toHaveBeenCalledTimes(1);
    expect(getAccountInfo.mock.calls[0][2]).toMatchObject({ minContextSlot: undefined });
  });
});
