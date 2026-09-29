import { describe, expect, it } from "vitest";

import { SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS } from "../../src/constants";
import { USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";
import {
  InMemoryPaymentChannelStorage,
  type PaymentChannelRecord,
} from "../../src/payment-channels/storage";

function record(overrides: Partial<PaymentChannelRecord> = {}): PaymentChannelRecord {
  return {
    channelId: "chan-a",
    expiresAt: 0,
    firstSeenAt: 10,
    lastActivityAt: 10,
    network: SOLANA_DEVNET_CAIP2,
    payTo: USDC_MAINNET_ADDRESS,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    ...overrides,
  };
}

describe("payment-channel facilitator storage", () => {
  it("keeps the first sighting and the latest activity across upserts", async () => {
    const storage = new InMemoryPaymentChannelStorage();
    await storage.upsert(record({ expiresAt: 50 }));
    await storage.upsert(record({ expiresAt: 40, firstSeenAt: 20, lastActivityAt: 30 }));
    await storage.upsert(record({ firstSeenAt: 25, lastActivityAt: 15 }));
    expect(await storage.get("chan-a")).toMatchObject({
      expiresAt: 50,
      firstSeenAt: 10,
      lastActivityAt: 30,
    });
  });
});
