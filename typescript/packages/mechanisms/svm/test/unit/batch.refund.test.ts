import {
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  decodePaymentSignatureHeader,
} from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";

import { refundBatchChannel } from "../../src/batch-settlement/client/refund";
import { SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS } from "../../src/constants";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";

const FEE_PAYER = USDC_MAINNET_ADDRESS;

function requirements(): PaymentRequirements {
  return {
    amount: "1000",
    asset: USDC_DEVNET_ADDRESS,
    extra: { feePayer: FEE_PAYER, tokenProgram: TOKEN_PROGRAM_ADDRESS, withdrawDelay: 900 },
    maxTimeoutSeconds: 300,
    network: SOLANA_DEVNET_CAIP2,
    payTo: USDC_MAINNET_ADDRESS,
    scheme: "batch-settlement",
  };
}

/** A close payload the driver should carry verbatim. */
const closePayload = {
  channelConfig: {
    openSlot: 1,
    payer: USDC_DEVNET_ADDRESS,
    payerAuthorizer: USDC_DEVNET_ADDRESS,
    receiver: USDC_MAINNET_ADDRESS,
    salt: "0",
    token: USDC_DEVNET_ADDRESS,
    withdrawDelay: 900,
  },
  transaction: "close-transaction",
  type: "refund" as const,
};

const build = async (x402Version: number) => ({ payload: closePayload, x402Version });

describe("batch-settlement refund driver", () => {
  it("probes the route, sends the close, and returns the settlement", async () => {
    const sent: { url: string; headers: Record<string, string> }[] = [];
    const settlement = {
      network: SOLANA_DEVNET_CAIP2,
      payer: USDC_DEVNET_ADDRESS,
      success: true,
      transaction: "close-signature",
    };
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      sent.push({ headers, url });
      if (!headers["PAYMENT-SIGNATURE"]) {
        // The unpaid probe advertises the terms the channel was opened against.
        return new Response(null, {
          headers: {
            "PAYMENT-REQUIRED": encodePaymentRequiredHeader({
              accepts: [requirements()],
              x402Version: 2,
            }),
          },
          status: 402,
        });
      }
      return new Response(null, {
        headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settlement) },
        status: 200,
      });
    }) as unknown as typeof fetch;

    await expect(
      refundBatchChannel(build, "https://example.test/paid", { fetch: fetchImpl }),
    ).resolves.toMatchObject({ success: true, transaction: "close-signature" });

    // The close travels as a payment payload against the probed requirements.
    expect(sent).toHaveLength(2);
    const decoded = decodePaymentSignatureHeader(sent[1]!.headers["PAYMENT-SIGNATURE"]!);
    expect(decoded).toMatchObject({
      accepted: { scheme: "batch-settlement" },
      payload: { transaction: "close-transaction", type: "refund" },
      x402Version: 2,
    });
  });

  it("skips the probe when the caller already holds the requirements", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(null, {
        headers: {
          "PAYMENT-RESPONSE": encodePaymentResponseHeader({
            network: SOLANA_DEVNET_CAIP2,
            success: true,
            transaction: "close-signature",
          }),
        },
        status: 200,
      });
    }) as unknown as typeof fetch;

    await expect(
      refundBatchChannel(build, "https://example.test/paid", {
        fetch: fetchImpl,
        requirements: requirements(),
      }),
    ).resolves.toMatchObject({ success: true });
    expect(calls).toBe(1);
  });

  it("surfaces the server's reason when the close is refused", async () => {
    const fetchImpl = (async () => {
      const body = encodePaymentRequiredHeader({
        accepts: [requirements()],
        error: "invalid_batch_settlement_svm_close_state",
        x402Version: 2,
      });
      return new Response(null, { headers: { "PAYMENT-REQUIRED": body }, status: 402 });
    }) as unknown as typeof fetch;

    await expect(
      refundBatchChannel(build, "https://example.test/paid", {
        fetch: fetchImpl,
        requirements: requirements(),
      }),
    ).rejects.toThrow(/invalid_batch_settlement_svm_close_state/);
  });

  it("refuses a route that does not answer with a 402", async () => {
    const fetchImpl = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    await expect(
      refundBatchChannel(build, "https://example.test/open", { fetch: fetchImpl }),
    ).rejects.toThrow(/expected 402/);
  });
});
