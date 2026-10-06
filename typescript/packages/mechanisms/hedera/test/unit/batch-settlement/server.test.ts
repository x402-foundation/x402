import { describe, expect, it } from "vitest";
import { HTS_ALLOWANCE_TRANSFER_METHOD } from "../../../src/batch-settlement";
import { BatchSettlementHederaScheme } from "../../../src/batch-settlement/server";
import {
  NETWORK,
  RECEIVER_ADDRESS,
  RECEIVER_ID,
  USDC_ADDRESS,
  USDC_ID,
  authorizerSigner,
  makeAccount,
} from "./helpers";

describe("server scheme", () => {
  it("accepts an account id or long-zero receiver", () => {
    expect(new BatchSettlementHederaScheme(RECEIVER_ID).getReceiverAddress()).toBe(
      RECEIVER_ADDRESS,
    );
    expect(new BatchSettlementHederaScheme(RECEIVER_ADDRESS).getReceiverAddress()).toBe(
      RECEIVER_ADDRESS,
    );
  });

  it("parses dollar prices into HTS token amounts with the hts-allowance method", async () => {
    const scheme = new BatchSettlementHederaScheme(RECEIVER_ID);
    const parsed = await scheme.parsePrice("$0.01", NETWORK);
    expect(parsed).toEqual({
      amount: "10000",
      asset: USDC_ID,
      extra: { assetTransferMethod: HTS_ALLOWANCE_TRANSFER_METHOD },
    });
    await expect(scheme.parsePrice({ amount: "5", asset: USDC_ADDRESS }, NETWORK)).rejects.toThrow(
      /HTS token id/,
    );
    await expect(scheme.parsePrice("$1", "eip155:296")).rejects.toThrow(/Unsupported/);
  });

  it("enhances payment requirements with authorizer, withdraw delay and minDeposit", async () => {
    const auth = authorizerSigner(makeAccount("ED25519"));
    const scheme = new BatchSettlementHederaScheme(RECEIVER_ID, {
      receiverAuthorizerSigner: auth,
      withdrawDelay: 3600,
    });
    const enhanced = await scheme.enhancePaymentRequirements(
      {
        scheme: "batch-settlement",
        network: NETWORK,
        amount: "1000",
        asset: USDC_ID,
        payTo: RECEIVER_ID,
        maxTimeoutSeconds: 60,
        extra: {},
      },
      { x402Version: 2, scheme: "batch-settlement", network: NETWORK },
      [],
    );
    expect(enhanced.extra).toEqual({
      assetTransferMethod: HTS_ALLOWANCE_TRANSFER_METHOD,
      receiverAuthorizer: auth.address,
      withdrawDelay: 3600,
      minDeposit: "10000",
    });

    await expect(
      scheme.enhancePaymentRequirements(
        {
          scheme: "batch-settlement",
          network: NETWORK,
          amount: "1",
          asset: USDC_ID,
          payTo: RECEIVER_ADDRESS,
          maxTimeoutSeconds: 1,
          extra: {},
        },
        { x402Version: 2, scheme: "batch-settlement", network: NETWORK },
        [],
      ),
    ).rejects.toThrow(/payTo/);
  });

  it("fails fast when no authorizer is available", () => {
    const scheme = new BatchSettlementHederaScheme(RECEIVER_ID);
    const problem = scheme.validateFacilitatorSupport(
      NETWORK,
      { x402Version: 2, scheme: "batch-settlement", network: NETWORK },
      [],
    );
    expect(problem).toMatch(/receiverAuthorizer/);
  });

  it("creates a channel manager bound to the token's long-zero address", () => {
    const scheme = new BatchSettlementHederaScheme(RECEIVER_ID);
    const facilitator = {
      verify: async () => ({ isValid: true }),
      settle: async () => ({ success: true, transaction: "", network: NETWORK }),
      getSupported: async () => ({ kinds: [], extensions: [], signers: {} }),
    };
    const manager = scheme.createChannelManager(facilitator, NETWORK);
    expect(manager).toBeDefined();
    expect(() => scheme.createChannelManager(facilitator, NETWORK, USDC_ADDRESS)).toThrow(
      /HTS token id/,
    );
  });
});
