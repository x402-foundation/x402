import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  probeBatchRequirements,
  refundBatchChannel,
} from "../../src/batch-settlement/client/refund";
import { SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS } from "../../src/constants";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";

function requirements(scheme = "batch-settlement"): PaymentRequirements {
  return {
    amount: "1000",
    asset: USDC_DEVNET_ADDRESS,
    extra: {
      feePayer: USDC_MAINNET_ADDRESS,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      withdrawDelay: 900,
    },
    maxTimeoutSeconds: 300,
    network: SOLANA_DEVNET_CAIP2,
    payTo: USDC_MAINNET_ADDRESS,
    scheme,
  };
}

const refundPayload = {
  channelConfig: {
    openSlot: 1,
    payer: USDC_DEVNET_ADDRESS,
    payerAuthorizer: USDC_DEVNET_ADDRESS,
    receiver: USDC_MAINNET_ADDRESS,
    receiverAuthorizer: USDC_MAINNET_ADDRESS,
    salt: "0",
    token: USDC_DEVNET_ADDRESS,
    withdrawDelay: 900,
  },
  type: "refund" as const,
  voucher: {
    channelId: USDC_MAINNET_ADDRESS,
    expiresAt: 0,
    maxClaimableAmount: "0",
    signature: "sig",
  },
};

const build = async (x402Version: number) => ({ payload: refundPayload, x402Version });

/** A fetch that answers every call with the same response. */
function respond(status: number, headers: Record<string, string> = {}): typeof fetch {
  return (async () => new Response(null, { headers, status })) as unknown as typeof fetch;
}

describe("batch-settlement refund driver edge cases", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("rejects a 402 probe that carries no PAYMENT-REQUIRED header", async () => {
    await expect(probeBatchRequirements("https://example.test/paid", respond(402))).rejects.toThrow(
      /no PAYMENT-REQUIRED header/,
    );
  });

  it("selects the Solana accept when an EVM batch-settlement accept is listed first", async () => {
    const evm = {
      ...requirements(),
      extra: {},
      network: "eip155:84532",
    };
    const header = encodePaymentRequiredHeader({
      accepts: [evm, requirements()],
      x402Version: 2,
    });
    await expect(
      probeBatchRequirements(
        "https://example.test/paid",
        respond(402, { "PAYMENT-REQUIRED": header }),
      ),
    ).resolves.toMatchObject({
      requirements: {
        extra: { feePayer: USDC_MAINNET_ADDRESS },
        network: SOLANA_DEVNET_CAIP2,
      },
    });
  });

  it("rejects a route that advertises no batch-settlement accept", async () => {
    const header = encodePaymentRequiredHeader({
      accepts: [requirements("exact")],
      x402Version: 2,
    });
    await expect(
      probeBatchRequirements(
        "https://example.test/paid",
        respond(402, { "PAYMENT-REQUIRED": header }),
      ),
    ).rejects.toThrow(/does not offer batch-settlement/);
  });

  it("falls back to globalThis.fetch when no fetch is supplied", async () => {
    const settlement = {
      network: SOLANA_DEVNET_CAIP2,
      success: true,
      transaction: "close-signature",
    };
    globalThis.fetch = respond(200, {
      "PAYMENT-RESPONSE": encodePaymentResponseHeader(settlement),
    });
    await expect(
      refundBatchChannel(build, "https://example.test/paid", { requirements: requirements() }),
    ).resolves.toMatchObject({ success: true, transaction: "close-signature" });
  });

  it("fails clearly when no fetch implementation exists at all", async () => {
    globalThis.fetch = undefined as unknown as typeof fetch;
    await expect(refundBatchChannel(build, "https://example.test/paid")).rejects.toThrow(
      /requires a fetch implementation/,
    );
  });

  it("reports a refusal without a reason when the 402 carries no header", async () => {
    await expect(
      refundBatchChannel(build, "https://example.test/paid", {
        fetch: respond(402),
        requirements: requirements(),
      }),
    ).rejects.toThrow(/refund refused: no reason given/);
  });

  it("reports a refusal whose 402 header carries no error field", async () => {
    const header = encodePaymentRequiredHeader({ accepts: [requirements()], x402Version: 2 });
    await expect(
      refundBatchChannel(build, "https://example.test/paid", {
        fetch: respond(402, { "PAYMENT-REQUIRED": header }),
        requirements: requirements(),
      }),
    ).rejects.toThrow(/refund refused: no reason given/);
  });

  it("rejects a non-402 response that lacks a PAYMENT-RESPONSE header", async () => {
    await expect(
      refundBatchChannel(build, "https://example.test/paid", {
        fetch: respond(500),
        requirements: requirements(),
      }),
    ).rejects.toThrow(/no PAYMENT-RESPONSE header \(status 500\)/);
  });
});
