import { describe, it, expect, vi } from "vitest";
import { BatchSettlementEvmScheme } from "../../../src/batch-settlement/server/scheme";
import {
  handleManagedAfterSettle,
  handleManagedAfterVerify,
  handleManagedBeforeSettle,
  handleManagedBeforeVerify,
  handleManagedEnrichPaymentRequiredResponse,
  handleManagedEnrichSettlementPayload,
  handleManagedEnrichSettlementResponse,
  handleManagedSettleFailure,
  handleManagedSettleOnCancel,
  handleManagedVerifiedPaymentCanceled,
  handleManagedVerifyFailure,
} from "../../../src/batch-settlement/server/managed";
import { InMemoryChannelStorage } from "../../../src/batch-settlement/server/storage";
import type { ChannelConfig } from "../../../src/batch-settlement/types";
import type { PaymentPayload, VerifyResponse } from "@x402/core/types";
import { privateKeyToAccount } from "viem/accounts";
import * as Errors from "../../../src/batch-settlement/errors";
import { computeChannelId as computeChannelIdForNetwork } from "../../../src/batch-settlement/utils";

const NETWORK = "eip155:84532";
const RECEIVER = "0x9876543210987654321098765432109876543210" as `0x${string}`;
const PAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as `0x${string}`;
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`;
const RECEIVER_AUTHORIZER = "0x1111111111111111111111111111111111111111" as `0x${string}`;

function buildConfig(): ChannelConfig {
  return {
    payer: PAYER,
    payerAuthorizer: PAYER,
    receiver: RECEIVER,
    receiverAuthorizer: RECEIVER_AUTHORIZER,
    token: TOKEN,
    withdrawDelay: 900,
    salt: "0x0000000000000000000000000000000000000000000000000000000000000000",
  };
}

function computeChannelId(config: ChannelConfig): `0x${string}` {
  return computeChannelIdForNetwork(config, NETWORK);
}

function buildManagedServer(
  storage = new InMemoryChannelStorage(),
  options: { enforceMinDeposit?: boolean } = {},
): BatchSettlementEvmScheme {
  const refundSigner = privateKeyToAccount(
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  );
  return new BatchSettlementEvmScheme(RECEIVER, {
    voucherStoreMode: "facilitator",
    storage,
    enforceMinDeposit: options.enforceMinDeposit,
    refundAuthorizerSigner: {
      address: refundSigner.address,
      signTypedData: msg =>
        refundSigner.signTypedData({
          domain: msg.domain,
          types: msg.types,
          primaryType: msg.primaryType,
          message: msg.message,
        } as Parameters<typeof refundSigner.signTypedData>[0]),
    },
  });
}

function voucherPayload(channelId: string, maxClaimable = "1000"): PaymentPayload {
  const config = buildConfig();
  return {
    x402Version: 2,
    accepted: { scheme: "batch-settlement", network: NETWORK },
    payload: {
      type: "voucher",
      channelConfig: config,
      voucher: {
        channelId: channelId as `0x${string}`,
        maxClaimableAmount: maxClaimable,
        signature: "0xdeadbeef",
      },
    },
  } as PaymentPayload;
}

function depositPayload(channelId: string): PaymentPayload {
  const config = buildConfig();
  return {
    x402Version: 2,
    accepted: { scheme: "batch-settlement", network: NETWORK },
    payload: {
      type: "deposit",
      channelConfig: config,
      voucher: {
        channelId: channelId as `0x${string}`,
        maxClaimableAmount: "1000",
        signature: "0xdeadbeef",
      },
      deposit: {
        amount: "10000",
        authorization: {
          erc3009Authorization: {
            validAfter: "0",
            validBefore: "9999999999",
            salt: "0x01",
            signature: "0xfeedface",
          },
        },
      },
    },
  } as PaymentPayload;
}

function refundPayload(channelId: string): PaymentPayload {
  const config = buildConfig();
  return {
    x402Version: 2,
    accepted: { scheme: "batch-settlement", network: NETWORK },
    payload: {
      type: "refund",
      channelConfig: config,
      voucher: {
        channelId: channelId as `0x${string}`,
        maxClaimableAmount: "1000",
        signature: "0xdeadbeef",
      },
    },
  } as PaymentPayload;
}

function cancelContext(
  paymentPayload: PaymentPayload,
  reason: "handler_failed" | "handler_threw" | "after_verify_aborted" = "handler_failed",
) {
  return {
    paymentPayload,
    requirements: {
      scheme: "batch-settlement",
      network: NETWORK,
      amount: "1000",
      asset: TOKEN,
      payTo: RECEIVER,
      maxTimeoutSeconds: 3600,
      extra: { voucherManager: "facilitator" },
    },
    declaredExtensions: {},
    phase: "cancel" as const,
    reason,
    settledPhases: [] as const,
  };
}

describe("facilitator-managed server hooks", () => {
  it("rejects a client-supplied pendingId on the managed verify path", async () => {
    const server = buildManagedServer();
    const config = buildConfig();
    const channelId = computeChannelId(config);
    const result = await handleManagedBeforeVerify(server, {
      paymentPayload: {
        x402Version: 2,
        accepted: { scheme: "batch-settlement", network: NETWORK },
        payload: {
          type: "voucher",
          channelConfig: config,
          voucher: { channelId, maxClaimableAmount: "1000", signature: "0xdeadbeef" },
          pendingId: "0xclient",
        },
      } as PaymentPayload,
      requirements: {
        scheme: "batch-settlement",
        network: NETWORK,
        amount: "1000",
        asset: TOKEN,
        payTo: RECEIVER,
        maxTimeoutSeconds: 3600,
        extra: { voucherManager: "facilitator" },
      },
    } as never);
    expect(result).toMatchObject({
      abort: true,
      reason: Errors.ErrUnexpectedPendingId,
    });
  });

  it("rejects a client-supplied cancel flag on the managed verify path", async () => {
    const server = buildManagedServer();
    const config = buildConfig();
    const channelId = computeChannelId(config);
    const result = await handleManagedBeforeVerify(server, {
      paymentPayload: {
        x402Version: 2,
        accepted: { scheme: "batch-settlement", network: NETWORK },
        payload: {
          type: "voucher",
          channelConfig: config,
          voucher: { channelId, maxClaimableAmount: "1000", signature: "0xdeadbeef" },
          cancel: true,
        },
      } as PaymentPayload,
      requirements: {
        scheme: "batch-settlement",
        network: NETWORK,
        amount: "1000",
        asset: TOKEN,
        payTo: RECEIVER,
        maxTimeoutSeconds: 3600,
        extra: { voucherManager: "facilitator" },
      },
    } as never);
    expect(result).toMatchObject({
      abort: true,
      reason: Errors.ErrUnexpectedCancel,
    });
  });

  it("aborts managed verify when an enforced deposit is below minDeposit", async () => {
    const server = buildManagedServer(new InMemoryChannelStorage(), { enforceMinDeposit: true });
    const config = buildConfig();
    const channelId = computeChannelId(config);
    const result = await handleManagedBeforeVerify(server, {
      paymentPayload: {
        x402Version: 2,
        accepted: { scheme: "batch-settlement", network: NETWORK },
        payload: {
          type: "deposit",
          channelConfig: config,
          voucher: { channelId, maxClaimableAmount: "1000", signature: "0xdeadbeef" },
          deposit: { amount: "1000", authorization: {} },
        },
      } as PaymentPayload,
      requirements: {
        scheme: "batch-settlement",
        network: NETWORK,
        amount: "1000",
        asset: TOKEN,
        payTo: RECEIVER,
        maxTimeoutSeconds: 3600,
        extra: { voucherManager: "facilitator", minDeposit: "10000" },
      },
    } as never);
    expect(result).toMatchObject({
      abort: true,
      reason: Errors.ErrDepositBelowMinDeposit,
    });
  });

  it("aborts managed verify when the payload channel id does not match the config", async () => {
    const server = buildManagedServer();
    const config = buildConfig();
    const channelId = computeChannelId(config);
    const wrongId = `${channelId.slice(0, -2)}ff` as `0x${string}`;
    const result = await handleManagedBeforeVerify(server, {
      paymentPayload: {
        x402Version: 2,
        accepted: { scheme: "batch-settlement", network: NETWORK },
        payload: {
          type: "voucher",
          channelConfig: config,
          voucher: { channelId: wrongId, maxClaimableAmount: "1000", signature: "0xdeadbeef" },
        },
      } as PaymentPayload,
      requirements: {
        scheme: "batch-settlement",
        network: NETWORK,
        amount: "1000",
        asset: TOKEN,
        payTo: RECEIVER,
        maxTimeoutSeconds: 3600,
        extra: { voucherManager: "facilitator", minDeposit: "0" },
      },
    } as never);
    expect(result).toMatchObject({
      abort: true,
      reason: Errors.ErrChannelIdMismatch,
    });
  });

  it("forwards managed settle without local short-circuiting", async () => {
    const server = buildManagedServer();
    await expect(handleManagedBeforeSettle(server, {} as never)).resolves.toBeUndefined();
  });

  it("ignores beforeVerify for claim-only facilitator payloads", async () => {
    const server = buildManagedServer();
    const result = await handleManagedBeforeVerify(server, {
      paymentPayload: {
        x402Version: 2,
        accepted: { scheme: "batch-settlement", network: NETWORK },
        payload: { type: "claim", claims: [] },
      } as PaymentPayload,
      requirements: {
        scheme: "batch-settlement",
        network: NETWORK,
        amount: "0",
        asset: TOKEN,
        payTo: RECEIVER,
        maxTimeoutSeconds: 3600,
        extra: { voucherManager: "facilitator" },
      },
    } as never);
    expect(result).toBeUndefined();
  });

  it("does not stash corrective extras when verify fails for a non-mismatch reason", async () => {
    const server = buildManagedServer();
    const config = buildConfig();
    const channelId = computeChannelId(config);
    const paymentPayload = voucherPayload(channelId);

    await handleManagedAfterVerify(server, {
      paymentPayload,
      requirements: { network: NETWORK } as never,
      result: {
        isValid: false,
        invalidReason: Errors.ErrChannelBusy,
      } as VerifyResponse,
    } as never);

    expect(server.readRequestContext(paymentPayload)?.correctiveChannelState).toBeUndefined();
  });

  it("does not enrich payment-required when corrective voucher proof is missing", async () => {
    const server = buildManagedServer();
    const config = buildConfig();
    const channelId = computeChannelId(config);
    const requirements = {
      scheme: "batch-settlement",
      network: NETWORK,
      amount: "1000",
      asset: TOKEN,
      payTo: RECEIVER,
      maxTimeoutSeconds: 3600,
      extra: { voucherManager: "facilitator" },
    };
    const paymentPayload = voucherPayload(channelId);
    server.mergeRequestContext(paymentPayload, {
      correctiveChannelState: {
        channelId,
        balance: "10000",
        totalClaimed: "0",
        withdrawRequestedAt: 0,
        refundNonce: "0",
        chargedCumulativeAmount: "0",
      },
    });

    await handleManagedEnrichPaymentRequiredResponse(server, {
      requirements: [requirements],
      paymentPayload,
      resourceInfo: { url: "https://example.com" },
      error: Errors.ErrCumulativeAmountMismatch,
      paymentRequiredResponse: {
        x402Version: 2,
        resource: { url: "https://example.com" },
        accepts: [requirements],
      },
    } as never);

    expect(requirements.extra?.voucherState).toBeUndefined();
  });

  it("upserts replica storage from a managed deposit settle using the verify snapshot fallback", async () => {
    const storage = new InMemoryChannelStorage();
    const server = buildManagedServer(storage);
    const config = buildConfig();
    const channelId = computeChannelId(config);
    const paymentPayload = {
      x402Version: 2,
      accepted: { scheme: "batch-settlement", network: NETWORK },
      payload: {
        type: "deposit",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "2000", signature: "0xabc" },
        deposit: { amount: "1000", authorization: {} },
      },
    } as PaymentPayload;
    server.mergeRequestContext(paymentPayload, {
      channelSnapshot: {
        channelId,
        channelConfig: config,
        chargedCumulativeAmount: "1000",
        signedMaxClaimable: "1000",
        signature: "0xold",
        balance: "5000",
        totalClaimed: "0",
        withdrawRequestedAt: 0,
        refundNonce: 0,
        lastRequestTimestamp: Date.now(),
      },
    });

    await handleManagedAfterSettle(server, {
      paymentPayload,
      requirements: { network: NETWORK } as never,
      result: {
        success: true,
        transaction: "0xdep",
        network: NETWORK,
        extra: {
          channelState: {
            channelId,
            balance: "6000",
            totalClaimed: "0",
            withdrawRequestedAt: 0,
            refundNonce: "0",
          },
        },
      },
    } as never);

    expect(await storage.get(channelId)).toMatchObject({
      chargedCumulativeAmount: "1000",
      balance: "6000",
      signedMaxClaimable: "2000",
    });
  });

  it("does not stash corrective extras when mismatch verify omits resync payloads", async () => {
    const server = buildManagedServer();
    const paymentPayload = voucherPayload(computeChannelId(buildConfig()));
    await handleManagedAfterVerify(server, {
      paymentPayload,
      requirements: { network: NETWORK } as never,
      result: {
        isValid: false,
        invalidReason: Errors.ErrCumulativeAmountMismatch,
        extra: {},
      } as VerifyResponse,
    } as never);
    expect(server.readRequestContext(paymentPayload)?.correctiveChannelState).toBeUndefined();
  });

  it("stashes corrective voucher proof when channelState is absent on mismatch", async () => {
    const server = buildManagedServer();
    const config = buildConfig();
    const channelId = computeChannelId(config);
    const paymentPayload = voucherPayload(channelId);

    await handleManagedAfterVerify(server, {
      paymentPayload,
      requirements: { network: NETWORK } as never,
      result: {
        isValid: false,
        invalidReason: Errors.ErrCumulativeAmountMismatch,
        extra: {
          voucherState: { signedMaxClaimable: "4000", signature: "0xonly" },
        },
      } as VerifyResponse,
    } as never);

    expect(server.readRequestContext(paymentPayload)).toMatchObject({
      correctiveVoucherState: { signedMaxClaimable: "4000", signature: "0xonly" },
    });
    expect(server.readRequestContext(paymentPayload)?.correctiveChannelState).toBeUndefined();
  });

  it("builds managed refund settlement fields from the verify snapshot", async () => {
    const server = buildManagedServer();
    const config = buildConfig();
    const channelId = computeChannelId(config);
    const paymentPayload = {
      x402Version: 2,
      accepted: { scheme: "batch-settlement", network: NETWORK },
      payload: {
        type: "refund",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "5000", signature: "0xdeadbeef" },
        amount: "1000",
      },
    } as PaymentPayload;
    server.mergeRequestContext(paymentPayload, {
      pendingId: "0xabc123",
      channelSnapshot: {
        channelId,
        channelConfig: config,
        chargedCumulativeAmount: "3000",
        signedMaxClaimable: "5000",
        signature: "0xdeadbeef",
        balance: "10000",
        totalClaimed: "2000",
        withdrawRequestedAt: 0,
        refundNonce: 1,
        lastRequestTimestamp: Date.now(),
      },
    });

    const fields = await handleManagedEnrichSettlementPayload(server, {
      paymentPayload,
      requirements: { network: NETWORK, amount: "0" } as never,
    } as never);

    expect(fields).toMatchObject({
      pendingId: "0xabc123",
      refundNonce: "1",
      claims: expect.any(Array),
    });
    expect(fields).not.toHaveProperty("amount");
    expect(fields?.claimAuthorizerSignature).toBeUndefined();
    expect(typeof fields?.refundAuthorizerSignature).toBe("string");
  });

  it("throws when managed refund enrichment lacks a verify snapshot", async () => {
    const server = buildManagedServer();
    const config = buildConfig();
    const channelId = computeChannelId(config);
    await expect(
      handleManagedEnrichSettlementPayload(server, {
        paymentPayload: {
          x402Version: 2,
          accepted: { scheme: "batch-settlement", network: NETWORK },
          payload: {
            type: "refund",
            channelConfig: config,
            voucher: { channelId, maxClaimableAmount: "1000", signature: "0xdead" },
          },
        } as PaymentPayload,
        requirements: { network: NETWORK, amount: "0" } as never,
      } as never),
    ).rejects.toMatchObject({ message: Errors.ErrMissingChannel });
  });

  it("ignores afterVerify for facilitator settle payloads", async () => {
    const server = buildManagedServer();
    const paymentPayload = {
      x402Version: 2,
      accepted: { scheme: "batch-settlement", network: NETWORK },
      payload: {
        type: "settle",
        receiver: RECEIVER,
        token: TOKEN,
      },
    } as PaymentPayload;

    await handleManagedAfterVerify(server, {
      paymentPayload,
      requirements: { network: NETWORK } as never,
      result: { isValid: true, payer: PAYER } as VerifyResponse,
    } as never);

    expect(server.readRequestContext(paymentPayload)).toBeUndefined();
  });

  it("ignores afterSettle for unsuccessful facilitator responses", async () => {
    const storage = new InMemoryChannelStorage();
    const server = buildManagedServer(storage);
    const config = buildConfig();
    const channelId = computeChannelId(config);
    await storage.updateChannel(channelId, () => ({
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: "1000",
      signature: "0xdeadbeef",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
    }));

    await handleManagedAfterSettle(server, {
      paymentPayload: voucherPayload(channelId),
      requirements: { network: NETWORK } as never,
      result: {
        success: false,
        errorReason: Errors.ErrInvalidVoucherSignature,
        transaction: "",
        network: NETWORK,
      },
    } as never);

    expect(await storage.get(channelId)).toMatchObject({ chargedCumulativeAmount: "1000" });
  });

  it("allows managed lifecycle no-ops for verify failure and cancellation hooks", async () => {
    const server = buildManagedServer();
    await expect(handleManagedVerifyFailure(server, {} as never)).resolves.toBeUndefined();
    await expect(handleManagedSettleFailure(server, {} as never)).resolves.toBeUndefined();
    await expect(
      handleManagedVerifiedPaymentCanceled(server, {} as never),
    ).resolves.toBeUndefined();
    await expect(
      handleManagedEnrichSettlementResponse(server, {} as never),
    ).resolves.toBeUndefined();
  });

  it.each(["handler_failed", "handler_threw", "after_verify_aborted"] as const)(
    "returns a zero-amount settle for managed cancel on %s",
    reason => {
      const server = buildManagedServer();
      const config = buildConfig();
      const channelId = computeChannelId(config);
      const expected = {
        scheme: "batch-settlement",
        network: NETWORK,
        amount: "0",
        asset: TOKEN,
        payTo: RECEIVER,
        maxTimeoutSeconds: 3600,
        extra: { voucherManager: "facilitator" },
      };
      expect(handleManagedSettleOnCancel(cancelContext(voucherPayload(channelId), reason))).toEqual(
        expected,
      );
      expect(handleManagedSettleOnCancel(cancelContext(depositPayload(channelId), reason))).toEqual(
        expected,
      );
      expect(handleManagedSettleOnCancel(cancelContext(refundPayload(channelId), reason))).toEqual(
        expected,
      );
      expect(server.settleOnCancel(cancelContext(voucherPayload(channelId), reason))).toEqual(
        expected,
      );
    },
  );

  it("stamps pendingId and cancel on managed cancel settle enrichment", async () => {
    const server = buildManagedServer();
    const config = buildConfig();
    const channelId = computeChannelId(config);
    const paymentPayload = voucherPayload(channelId);
    server.mergeRequestContext(paymentPayload, { pendingId: "0xabc123" });

    const fields = await handleManagedEnrichSettlementPayload(server, {
      paymentPayload,
      requirements: { network: NETWORK, amount: "1000" } as never,
      phase: "cancel",
    } as never);
    expect(fields).toEqual({ pendingId: "0xabc123", cancel: true });
  });

  it("stamps cancel on deposit and refund enrich without building refund fields", async () => {
    const server = buildManagedServer();
    const config = buildConfig();
    const channelId = computeChannelId(config);

    await expect(
      handleManagedEnrichSettlementPayload(server, {
        paymentPayload: depositPayload(channelId),
        requirements: { network: NETWORK, amount: "1000" } as never,
        phase: "cancel",
      } as never),
    ).resolves.toEqual({ cancel: true });

    await expect(
      handleManagedEnrichSettlementPayload(server, {
        paymentPayload: refundPayload(channelId),
        requirements: { network: NETWORK, amount: "0" } as never,
        phase: "cancel",
      } as never),
    ).resolves.toEqual({ cancel: true });
  });

  it("does not settle on cancel in self-managed mode", () => {
    const server = new BatchSettlementEvmScheme(RECEIVER);
    const config = buildConfig();
    const channelId = computeChannelId(config);
    expect(server.settleOnCancel(cancelContext(voucherPayload(channelId)))).toBeUndefined();
  });

  it("does not upsert the replica on a managed cancel settle", async () => {
    const storage = new InMemoryChannelStorage();
    const server = buildManagedServer(storage);
    const config = buildConfig();
    const channelId = computeChannelId(config);
    await storage.updateChannel(channelId, () => ({
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: "1000",
      signature: "0xdeadbeef",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
    }));

    await handleManagedAfterSettle(server, {
      paymentPayload: voucherPayload(channelId),
      requirements: { network: NETWORK } as never,
      phase: "cancel",
      result: {
        success: true,
        transaction: "",
        network: NETWORK,
        extra: {
          channelState: {
            channelId,
            balance: "1",
            totalClaimed: "999",
            chargedCumulativeAmount: "1000",
          },
        },
      },
    } as never);

    expect(await storage.get(channelId)).toMatchObject({
      chargedCumulativeAmount: "1000",
      balance: "10000",
      totalClaimed: "0",
    });
  });

  it("records a verify snapshot after a successful managed voucher verify", async () => {
    const server = buildManagedServer();
    const config = buildConfig();
    const channelId = computeChannelId(config);
    const paymentPayload = voucherPayload(channelId);

    await handleManagedAfterVerify(server, {
      paymentPayload,
      requirements: { network: NETWORK } as never,
      result: {
        isValid: true,
        payer: PAYER,
        extra: {
          balance: "10000",
          totalClaimed: "1000",
          withdrawRequestedAt: 2,
          refundNonce: 3,
        },
      } as VerifyResponse,
    } as never);

    expect(server.readRequestContext(paymentPayload)?.channelSnapshot).toMatchObject({
      channelId,
      balance: "10000",
      totalClaimed: "1000",
      withdrawRequestedAt: 2,
      refundNonce: 3,
      chargedCumulativeAmount: "0",
    });
    expect(server.readRequestContext(paymentPayload)?.pendingId).toBeUndefined();
  });

  it("stashes verify pendingId and echoes it on voucher settle enrichment", async () => {
    const server = buildManagedServer();
    const config = buildConfig();
    const channelId = computeChannelId(config);
    const paymentPayload = voucherPayload(channelId);

    await handleManagedAfterVerify(server, {
      paymentPayload,
      requirements: { network: NETWORK } as never,
      result: {
        isValid: true,
        payer: PAYER,
        extra: {
          balance: "10000",
          totalClaimed: "1000",
          pendingId: "0xabc123",
        },
      } as VerifyResponse,
    } as never);

    expect(server.readRequestContext(paymentPayload)?.pendingId).toBe("0xabc123");
    expect(server.readRequestContext(paymentPayload)?.reservationCommitted).toBe(true);

    const fields = await handleManagedEnrichSettlementPayload(server, {
      paymentPayload,
      requirements: { network: NETWORK, amount: "1000" } as never,
    } as never);
    expect(fields).toEqual({ pendingId: "0xabc123" });
  });

  it("returns skipHandler for a successful managed refund verify", async () => {
    const server = buildManagedServer();
    const config = buildConfig();
    const channelId = computeChannelId(config);
    const paymentPayload = {
      x402Version: 2,
      accepted: { scheme: "batch-settlement", network: NETWORK },
      payload: {
        type: "refund",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "1000", signature: "0xdeadbeef" },
      },
    } as PaymentPayload;

    const directive = await handleManagedAfterVerify(server, {
      paymentPayload,
      requirements: { network: NETWORK } as never,
      result: {
        isValid: true,
        payer: PAYER,
        extra: { balance: "10000", totalClaimed: "0", chargedCumulativeAmount: "1000" },
      } as VerifyResponse,
    } as never);

    expect(directive).toMatchObject({
      skipHandler: true,
      response: { body: { channelId } },
    });
  });

  it("stashes corrective verify extras for a cumulative amount mismatch", async () => {
    const server = buildManagedServer();
    const config = buildConfig();
    const channelId = computeChannelId(config);
    const paymentPayload = voucherPayload(channelId, "7000");

    await handleManagedAfterVerify(server, {
      paymentPayload,
      requirements: { network: NETWORK } as never,
      result: {
        isValid: false,
        invalidReason: Errors.ErrCumulativeAmountMismatch,
        extra: {
          channelState: {
            channelId,
            balance: "10000",
            totalClaimed: "1000",
            chargedCumulativeAmount: "5000",
          },
          voucherState: { signedMaxClaimable: "5000", signature: "0xstored" },
        },
      } as VerifyResponse,
    } as never);

    expect(server.readRequestContext(paymentPayload)).toMatchObject({
      correctiveChannelState: expect.objectContaining({ channelId, balance: "10000" }),
      correctiveVoucherState: { signedMaxClaimable: "5000", signature: "0xstored" },
    });
  });

  it("copies corrective extras onto the matching 402 accept", async () => {
    const server = buildManagedServer();
    const config = buildConfig();
    const channelId = computeChannelId(config);
    const requirements = {
      scheme: "batch-settlement",
      network: NETWORK,
      amount: "1000",
      asset: TOKEN,
      payTo: RECEIVER,
      maxTimeoutSeconds: 3600,
      extra: { voucherManager: "facilitator" },
    };
    const paymentPayload = voucherPayload(channelId);
    server.mergeRequestContext(paymentPayload, {
      correctiveChannelState: {
        channelId,
        balance: "10000",
        totalClaimed: "1000",
        withdrawRequestedAt: 0,
        refundNonce: "0",
        chargedCumulativeAmount: "5000",
      },
      correctiveVoucherState: { signedMaxClaimable: "5000", signature: "0xstored" },
    });

    await handleManagedEnrichPaymentRequiredResponse(server, {
      requirements: [requirements],
      paymentPayload,
      resourceInfo: { url: "https://example.com" },
      error: Errors.ErrCumulativeAmountMismatch,
      paymentRequiredResponse: {
        x402Version: 2,
        resource: { url: "https://example.com" },
        accepts: [requirements],
      },
    } as never);

    expect(requirements.extra?.voucherState).toEqual({
      signedMaxClaimable: "5000",
      signature: "0xstored",
    });
    expect(requirements.extra?.channelState).toMatchObject({
      channelId,
      balance: "10000",
      chargedCumulativeAmount: "5000",
    });
  });

  it("copies corrective extras when verify fails with cumulative below claimed", async () => {
    const server = buildManagedServer();
    const config = buildConfig();
    const channelId = computeChannelId(config);
    const requirements = {
      scheme: "batch-settlement",
      network: NETWORK,
      amount: "1000",
      asset: TOKEN,
      payTo: RECEIVER,
      maxTimeoutSeconds: 3600,
      extra: { voucherManager: "facilitator" },
    };
    const paymentPayload = voucherPayload(channelId);
    server.mergeRequestContext(paymentPayload, {
      correctiveChannelState: {
        channelId,
        balance: "10000",
        totalClaimed: "1000",
        withdrawRequestedAt: 0,
        refundNonce: "0",
        chargedCumulativeAmount: "5000",
      },
      correctiveVoucherState: { signedMaxClaimable: "5000", signature: "0xstored" },
    });

    await handleManagedEnrichPaymentRequiredResponse(server, {
      requirements: [requirements],
      paymentPayload,
      resourceInfo: { url: "https://example.com" },
      error: Errors.ErrCumulativeAmountBelowClaimed,
      paymentRequiredResponse: {
        x402Version: 2,
        resource: { url: "https://example.com" },
        accepts: [requirements],
      },
    } as never);

    expect(requirements.extra?.voucherState).toEqual({
      signedMaxClaimable: "5000",
      signature: "0xstored",
    });
  });

  it("returns nothing when enriching settlement payload for a non-refund payload", async () => {
    const server = buildManagedServer();
    const config = buildConfig();
    const channelId = computeChannelId(config);
    const result = await handleManagedEnrichSettlementPayload(server, {
      paymentPayload: voucherPayload(channelId),
      requirements: { network: NETWORK, amount: "1000" } as never,
    } as never);
    expect(result).toBeUndefined();
  });

  it("ignores afterSettle for facilitator claim payloads", async () => {
    const storage = new InMemoryChannelStorage();
    const server = buildManagedServer(storage);
    const config = buildConfig();
    const channelId = computeChannelId(config);
    await storage.updateChannel(channelId, () => ({
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: "1000",
      signature: "0xdeadbeef",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
    }));

    await handleManagedAfterSettle(server, {
      paymentPayload: {
        x402Version: 2,
        accepted: { scheme: "batch-settlement", network: NETWORK },
        payload: { type: "claim", claims: [], channelConfig: config },
      } as PaymentPayload,
      requirements: { network: NETWORK } as never,
      result: {
        success: true,
        transaction: "0xclaim",
        network: NETWORK,
        extra: {
          channelState: {
            channelId,
            balance: "9999",
            totalClaimed: "1",
            chargedCumulativeAmount: "1000",
          },
        },
      },
    } as never);

    expect(await storage.get(channelId)).toMatchObject({ balance: "10000" });
  });

  it("uses the verify snapshot when settle extra has no channelState block", async () => {
    const storage = new InMemoryChannelStorage();
    const server = buildManagedServer(storage);
    const config = buildConfig();
    const channelId = computeChannelId(config);
    const paymentPayload = voucherPayload(channelId, "3000");
    server.mergeRequestContext(paymentPayload, {
      channelSnapshot: {
        channelId,
        channelConfig: config,
        chargedCumulativeAmount: "1800",
        signedMaxClaimable: "2000",
        signature: "0xold",
        balance: "8000",
        totalClaimed: "500",
        withdrawRequestedAt: 0,
        refundNonce: 1,
        lastRequestTimestamp: Date.now(),
      },
    });

    await handleManagedAfterSettle(server, {
      paymentPayload,
      requirements: { network: NETWORK } as never,
      result: {
        success: true,
        transaction: "0xvoucher",
        network: NETWORK,
        extra: {},
      },
    } as never);

    expect(await storage.get(channelId)).toMatchObject({
      chargedCumulativeAmount: "1800",
      balance: "8000",
      totalClaimed: "500",
    });
  });

  it("falls back to the verify snapshot for charged cumulative when settle extra omits it", async () => {
    const storage = new InMemoryChannelStorage();
    const server = buildManagedServer(storage);
    const config = buildConfig();
    const channelId = computeChannelId(config);
    const paymentPayload = voucherPayload(channelId, "3000");
    server.mergeRequestContext(paymentPayload, {
      channelSnapshot: {
        channelId,
        channelConfig: config,
        chargedCumulativeAmount: "2500",
        signedMaxClaimable: "2000",
        signature: "0xold",
        balance: "8000",
        totalClaimed: "500",
        withdrawRequestedAt: 0,
        refundNonce: 1,
        lastRequestTimestamp: Date.now(),
      },
    });

    await handleManagedAfterSettle(server, {
      paymentPayload,
      requirements: { network: NETWORK } as never,
      result: {
        success: true,
        transaction: "0xvoucher",
        network: NETWORK,
        extra: {
          channelState: {
            channelId,
            balance: "7500",
            totalClaimed: "1000",
            withdrawRequestedAt: 0,
            refundNonce: "2",
          },
        },
      },
    } as never);

    expect(await storage.get(channelId)).toMatchObject({
      chargedCumulativeAmount: "2500",
      balance: "7500",
      totalClaimed: "1000",
      refundNonce: 2,
    });
  });

  it("skips the replica write when the incoming watermark is lower than stored", async () => {
    const storage = new InMemoryChannelStorage();
    const server = buildManagedServer(storage);
    const config = buildConfig();
    const channelId = computeChannelId(config);
    await storage.updateChannel(channelId, () => ({
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "5000",
      signedMaxClaimable: "5000",
      signature: "0xstored",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
    }));

    await handleManagedAfterSettle(server, {
      paymentPayload: voucherPayload(channelId, "1000"),
      requirements: { network: NETWORK } as never,
      result: {
        success: true,
        transaction: "0xvoucher",
        network: NETWORK,
        extra: {
          channelState: {
            channelId,
            balance: "9999",
            totalClaimed: "0",
            chargedCumulativeAmount: "1000",
            withdrawRequestedAt: 0,
            refundNonce: "0",
          },
        },
      },
    } as never);

    expect(await storage.get(channelId)).toMatchObject({
      chargedCumulativeAmount: "5000",
      balance: "10000",
    });
  });

  it("propagates a cleared withdrawRequestedAt on an equal watermark", async () => {
    const storage = new InMemoryChannelStorage();
    const server = buildManagedServer(storage);
    const config = buildConfig();
    const channelId = computeChannelId(config);
    await storage.updateChannel(channelId, () => ({
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: "1000",
      signature: "0xstored",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 456,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
    }));

    await handleManagedAfterSettle(server, {
      paymentPayload: voucherPayload(channelId, "1000"),
      requirements: { network: NETWORK } as never,
      result: {
        success: true,
        transaction: "0xvoucher",
        network: NETWORK,
        extra: {
          channelState: {
            channelId,
            balance: "10000",
            totalClaimed: "0",
            chargedCumulativeAmount: "1000",
            withdrawRequestedAt: 0,
            refundNonce: "0",
          },
        },
      },
    } as never);

    expect(await storage.get(channelId)).toMatchObject({
      chargedCumulativeAmount: "1000",
      withdrawRequestedAt: 0,
    });
  });

  it("does not stash corrective extras when mismatch facilitator extras are not objects", async () => {
    const server = buildManagedServer();
    const config = buildConfig();
    const channelId = computeChannelId(config);
    const paymentPayload = voucherPayload(channelId);

    await handleManagedAfterVerify(server, {
      paymentPayload,
      requirements: { network: NETWORK } as never,
      result: {
        isValid: false,
        invalidReason: Errors.ErrCumulativeAmountMismatch,
        extra: { channelState: "not-an-object", voucherState: null },
      } as VerifyResponse,
    } as never);

    expect(server.readRequestContext(paymentPayload)).toBeUndefined();
  });

  it("skips payment-required enrichment when no payment payload is attached", async () => {
    const server = buildManagedServer();
    const requirements = {
      scheme: "batch-settlement",
      network: NETWORK,
      amount: "1000",
      asset: TOKEN,
      payTo: RECEIVER,
      maxTimeoutSeconds: 3600,
      extra: { voucherManager: "facilitator" },
    };

    await handleManagedEnrichPaymentRequiredResponse(server, {
      requirements: [requirements],
      resourceInfo: { url: "https://example.com" },
      error: Errors.ErrCumulativeAmountMismatch,
      paymentRequiredResponse: {
        x402Version: 2,
        resource: { url: "https://example.com" },
        accepts: [requirements],
      },
    } as never);

    expect(requirements.extra?.voucherState).toBeUndefined();
  });

  it("skips payment-required enrichment for unrelated verify errors", async () => {
    const server = buildManagedServer();
    const requirements = {
      scheme: "batch-settlement",
      network: NETWORK,
      amount: "1000",
      asset: TOKEN,
      payTo: RECEIVER,
      maxTimeoutSeconds: 3600,
      extra: { voucherManager: "facilitator" },
    };
    await handleManagedEnrichPaymentRequiredResponse(server, {
      requirements: [requirements],
      paymentPayload: voucherPayload(computeChannelId(buildConfig())),
      resourceInfo: { url: "https://example.com" },
      error: Errors.ErrChannelBusy,
      paymentRequiredResponse: {
        x402Version: 2,
        resource: { url: "https://example.com" },
        accepts: [requirements],
      },
    } as never);
    expect(requirements.extra?.channelState).toBeUndefined();
  });

  it("skips payment-required enrichment when the error is not a cumulative mismatch", async () => {
    const server = buildManagedServer();
    const config = buildConfig();
    const channelId = computeChannelId(config);
    const requirements = {
      scheme: "batch-settlement",
      network: NETWORK,
      amount: "1000",
      asset: TOKEN,
      payTo: RECEIVER,
      maxTimeoutSeconds: 3600,
      extra: { voucherManager: "facilitator" },
    };
    const paymentPayload = voucherPayload(channelId);
    server.mergeRequestContext(paymentPayload, {
      correctiveChannelState: {
        channelId,
        balance: "10000",
        totalClaimed: "0",
        withdrawRequestedAt: 0,
        refundNonce: "0",
        chargedCumulativeAmount: "5000",
      },
      correctiveVoucherState: { signedMaxClaimable: "5000", signature: "0xstored" },
    });

    await handleManagedEnrichPaymentRequiredResponse(server, {
      requirements: [requirements],
      paymentPayload,
      resourceInfo: { url: "https://example.com" },
      error: Errors.ErrChannelBusy,
      paymentRequiredResponse: {
        x402Version: 2,
        resource: { url: "https://example.com" },
        accepts: [requirements],
      },
    } as never);

    expect(requirements.extra?.voucherState).toBeUndefined();
  });

  it("skips payment-required enrichment when no accept matches the payload network", async () => {
    const server = buildManagedServer();
    const config = buildConfig();
    const channelId = computeChannelId(config);
    const requirements = {
      scheme: "batch-settlement",
      network: "eip155:1",
      amount: "1000",
      asset: TOKEN,
      payTo: RECEIVER,
      maxTimeoutSeconds: 3600,
      extra: { voucherManager: "facilitator" },
    };
    const paymentPayload = voucherPayload(channelId);
    server.mergeRequestContext(paymentPayload, {
      correctiveChannelState: {
        channelId,
        balance: "10000",
        totalClaimed: "0",
        withdrawRequestedAt: 0,
        refundNonce: "0",
        chargedCumulativeAmount: "5000",
      },
      correctiveVoucherState: { signedMaxClaimable: "5000", signature: "0xstored" },
    });

    await handleManagedEnrichPaymentRequiredResponse(server, {
      requirements: [requirements],
      paymentPayload,
      resourceInfo: { url: "https://example.com" },
      error: Errors.ErrCumulativeAmountMismatch,
      paymentRequiredResponse: {
        x402Version: 2,
        resource: { url: "https://example.com" },
        accepts: [requirements],
      },
    } as never);

    expect(requirements.extra?.voucherState).toBeUndefined();
  });

  it("runs min-deposit and channel binding for managed refund beforeVerify", async () => {
    const server = buildManagedServer();
    const config = buildConfig();
    const channelId = computeChannelId(config);
    const result = await handleManagedBeforeVerify(server, {
      paymentPayload: {
        x402Version: 2,
        accepted: { scheme: "batch-settlement", network: NETWORK },
        payload: {
          type: "refund",
          channelConfig: config,
          voucher: { channelId, maxClaimableAmount: "1000", signature: "0xdeadbeef" },
        },
      } as PaymentPayload,
      requirements: {
        scheme: "batch-settlement",
        network: NETWORK,
        amount: "0",
        asset: TOKEN,
        payTo: RECEIVER,
        maxTimeoutSeconds: 3600,
        extra: { voucherManager: "facilitator", minDeposit: "0" },
      },
    } as never);
    expect(result).toBeUndefined();
  });

  it("updates replica storage after a partial managed refund leaves escrow open", async () => {
    const storage = new InMemoryChannelStorage();
    const server = buildManagedServer(storage);
    const config = buildConfig();
    const channelId = computeChannelId(config);
    await storage.updateChannel(channelId, () => ({
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "3000",
      signedMaxClaimable: "5000",
      signature: "0xdeadbeef",
      balance: "10000",
      totalClaimed: "2000",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
    }));

    await handleManagedAfterSettle(server, {
      paymentPayload: {
        x402Version: 2,
        accepted: { scheme: "batch-settlement", network: NETWORK },
        payload: {
          type: "refund",
          channelConfig: config,
          voucher: { channelId, maxClaimableAmount: "5000", signature: "0xdeadbeef" },
          amount: "1000",
        },
      } as PaymentPayload,
      requirements: { network: NETWORK } as never,
      result: {
        success: true,
        transaction: "0xrefundpartial",
        network: NETWORK,
        extra: {
          channelState: {
            channelId,
            balance: "9000",
            totalClaimed: "2000",
            chargedCumulativeAmount: "2000",
            withdrawRequestedAt: 1,
            refundNonce: "1",
          },
        },
      },
    } as never);

    expect(await storage.get(channelId)).toMatchObject({
      balance: "9000",
      chargedCumulativeAmount: "2000",
      withdrawRequestedAt: 1,
      refundNonce: 1,
    });
  });

  it("drops the replica row after a managed refund fully closes the channel", async () => {
    const storage = new InMemoryChannelStorage();
    const server = buildManagedServer(storage);
    const config = buildConfig();
    const channelId = computeChannelId(config);
    await storage.updateChannel(channelId, () => ({
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "5000",
      signedMaxClaimable: "5000",
      signature: "0xdeadbeef",
      balance: "10000",
      totalClaimed: "5000",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
    }));

    await handleManagedAfterSettle(server, {
      paymentPayload: {
        x402Version: 2,
        accepted: { scheme: "batch-settlement", network: NETWORK },
        payload: {
          type: "refund",
          channelConfig: config,
          voucher: { channelId, maxClaimableAmount: "5000", signature: "0xdeadbeef" },
          amount: "5000",
        },
      } as PaymentPayload,
      requirements: { network: NETWORK } as never,
      result: {
        success: true,
        transaction: "0xrefund",
        network: NETWORK,
        extra: {
          channelState: {
            channelId,
            balance: "5000",
            totalClaimed: "5000",
            chargedCumulativeAmount: "5000",
          },
        },
      },
    } as never);

    expect(await storage.get(channelId)).toBeUndefined();
  });

  it("falls back to verify snapshot charged cumulative for managed replica upsert", async () => {
    const storage = new InMemoryChannelStorage();
    const server = buildManagedServer(storage);
    const config = buildConfig();
    const channelId = computeChannelId(config);
    const paymentPayload = voucherPayload(channelId, "3000");
    server.mergeRequestContext(paymentPayload, {
      channelSnapshot: {
        channelId,
        channelConfig: config,
        chargedCumulativeAmount: "2500",
        signedMaxClaimable: "3000",
        signature: "0xdeadbeef",
        balance: "10000",
        totalClaimed: "0",
        withdrawRequestedAt: 0,
        refundNonce: 0,
        lastRequestTimestamp: 0,
      },
    });

    await handleManagedAfterSettle(server, {
      paymentPayload,
      requirements: { network: NETWORK } as never,
      result: {
        success: true,
        network: NETWORK,
        extra: {
          channelState: {
            channelId,
            balance: "10000",
            totalClaimed: "0",
            withdrawRequestedAt: 0,
            refundNonce: "0",
          },
        },
      },
    } as never);

    expect(await storage.get(channelId)).toMatchObject({ chargedCumulativeAmount: "2500" });
  });

  it("skips managed replica upsert when settle reports a regressed charged watermark", async () => {
    const storage = new InMemoryChannelStorage();
    const server = buildManagedServer(storage);
    const config = buildConfig();
    const channelId = computeChannelId(config);
    await storage.updateChannel(channelId, () => ({
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "5000",
      signedMaxClaimable: "5000",
      signature: "0xdeadbeef",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
    }));

    await handleManagedAfterSettle(server, {
      paymentPayload: voucherPayload(channelId, "5000"),
      requirements: { network: NETWORK } as never,
      result: {
        success: true,
        network: NETWORK,
        extra: {
          channelState: {
            channelId,
            balance: "10000",
            totalClaimed: "0",
            chargedCumulativeAmount: "1000",
            withdrawRequestedAt: 0,
            refundNonce: "0",
          },
        },
      },
    } as never);

    expect((await storage.get(channelId))?.chargedCumulativeAmount).toBe("5000");
  });

  it("upserts managed replica when stored watermark is non-numeric", async () => {
    const storage = new InMemoryChannelStorage();
    const server = buildManagedServer(storage);
    const config = buildConfig();
    const channelId = computeChannelId(config);
    await storage.updateChannel(channelId, () => ({
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "not-numeric",
      signedMaxClaimable: "5000",
      signature: "0xdeadbeef",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
    }));

    await handleManagedAfterSettle(server, {
      paymentPayload: voucherPayload(channelId, "5000"),
      requirements: { network: NETWORK } as never,
      result: {
        success: true,
        network: NETWORK,
        extra: {
          channelState: {
            channelId,
            balance: "9000",
            totalClaimed: "1000",
            chargedCumulativeAmount: "2000",
            withdrawRequestedAt: 0,
            refundNonce: "0",
          },
        },
      },
    } as never);

    expect(await storage.get(channelId)).toMatchObject({
      chargedCumulativeAmount: "2000",
      balance: "9000",
    });
  });

  it("ignores managed afterSettle for cancel-phase settlements", async () => {
    const storage = new InMemoryChannelStorage();
    const server = buildManagedServer(storage);
    const config = buildConfig();
    const channelId = computeChannelId(config);
    await storage.updateChannel(channelId, () => ({
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: "1000",
      signature: "0xdeadbeef",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
    }));

    await handleManagedAfterSettle(server, {
      paymentPayload: voucherPayload(channelId),
      requirements: { network: NETWORK } as never,
      phase: "cancel",
      result: {
        success: true,
        transaction: "",
        network: NETWORK,
        extra: { channelState: { channelId, balance: "0", totalClaimed: "0" } },
      },
    } as never);

    expect((await storage.get(channelId))?.chargedCumulativeAmount).toBe("1000");
  });

  it("ignores managed afterSettle when facilitator settlement failed", async () => {
    const storage = new InMemoryChannelStorage();
    const server = buildManagedServer(storage);
    const config = buildConfig();
    const channelId = computeChannelId(config);
    await storage.updateChannel(channelId, () => ({
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: "1000",
      signature: "0xdeadbeef",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
    }));

    await handleManagedAfterSettle(server, {
      paymentPayload: voucherPayload(channelId),
      requirements: { network: NETWORK } as never,
      result: { success: false, transaction: "", network: NETWORK },
    } as never);

    expect((await storage.get(channelId))?.chargedCumulativeAmount).toBe("1000");
  });

  it("no-ops managed refund replica delete when no replica row exists", async () => {
    const storage = new InMemoryChannelStorage();
    const server = buildManagedServer(storage);
    const config = buildConfig();
    const channelId = computeChannelId(config);

    await handleManagedAfterSettle(server, {
      paymentPayload: refundPayload(channelId),
      requirements: { network: NETWORK } as never,
      result: {
        success: true,
        transaction: "0xrefund",
        network: NETWORK,
        extra: {
          channelState: {
            channelId,
            balance: "1000",
            totalClaimed: "1000",
            chargedCumulativeAmount: "1000",
          },
        },
      },
    } as never);

    expect(await storage.get(channelId)).toBeUndefined();
  });

  describe("request context release", () => {
    const stashContext = (server: BatchSettlementEvmScheme, paymentPayload: PaymentPayload) =>
      server.mergeRequestContext(paymentPayload, { pendingId: "0xpending" });

    it("drops the context after a failed settle", async () => {
      const server = buildManagedServer();
      const paymentPayload = voucherPayload(computeChannelId(buildConfig()));
      stashContext(server, paymentPayload);

      await handleManagedSettleFailure(server, {
        paymentPayload,
        requirements: { network: NETWORK },
        error: new Error("facilitator down"),
      } as never);

      expect(server.readRequestContext(paymentPayload)).toBeUndefined();
    });

    it("drops the context after an unsuccessful settle result", async () => {
      const server = buildManagedServer();
      const paymentPayload = voucherPayload(computeChannelId(buildConfig()));
      stashContext(server, paymentPayload);

      await handleManagedAfterSettle(server, {
        paymentPayload,
        requirements: { network: NETWORK } as never,
        result: { success: false, network: NETWORK },
      } as never);

      expect(server.readRequestContext(paymentPayload)).toBeUndefined();
    });

    it("drops the context after a cancel settle", async () => {
      const server = buildManagedServer();
      const paymentPayload = voucherPayload(computeChannelId(buildConfig()));
      stashContext(server, paymentPayload);

      await handleManagedAfterSettle(server, {
        paymentPayload,
        requirements: { network: NETWORK } as never,
        phase: "cancel",
        result: { success: true, network: NETWORK },
      } as never);

      expect(server.readRequestContext(paymentPayload)).toBeUndefined();
    });

    it("drops the context when the replica upsert throws", async () => {
      const storage = new InMemoryChannelStorage();
      const server = buildManagedServer(storage);
      const paymentPayload = voucherPayload(computeChannelId(buildConfig()));
      stashContext(server, paymentPayload);
      vi.spyOn(storage, "updateChannel").mockRejectedValueOnce(new Error("storage down"));

      await expect(
        handleManagedAfterSettle(server, {
          paymentPayload,
          requirements: { network: NETWORK } as never,
          result: { success: true, network: NETWORK },
        } as never),
      ).rejects.toThrow("storage down");

      expect(server.readRequestContext(paymentPayload)).toBeUndefined();
    });

    it("drops the context when a managed refund cannot be enriched", async () => {
      const server = buildManagedServer();
      const config = buildConfig();
      const channelId = computeChannelId(config);
      const paymentPayload = refundPayload(channelId);
      server.mergeRequestContext(paymentPayload, {
        channelSnapshot: {
          channelId,
          channelConfig: config,
          chargedCumulativeAmount: "1000",
          signedMaxClaimable: "1000",
          signature: "0xdeadbeef",
          balance: "1000",
          totalClaimed: "0",
          withdrawRequestedAt: 0,
          refundNonce: 0,
          lastRequestTimestamp: Date.now(),
        },
      });

      await expect(
        handleManagedEnrichSettlementPayload(server, {
          paymentPayload,
          requirements: { network: NETWORK },
          phase: "settle",
        } as never),
      ).rejects.toThrow(Errors.ErrRefundNoBalance);

      expect(server.readRequestContext(paymentPayload)).toBeUndefined();
    });
  });

  it("writes corrective extras onto every matching accept", async () => {
    const server = buildManagedServer();
    const config = buildConfig();
    const channelId = computeChannelId(config);
    const paymentPayload = voucherPayload(channelId);
    const makeAccept = () => ({
      scheme: "batch-settlement",
      network: NETWORK,
      amount: "1000",
      asset: TOKEN,
      payTo: RECEIVER,
      maxTimeoutSeconds: 3600,
      extra: { voucherManager: "facilitator" } as Record<string, unknown>,
    });
    const accepts = [makeAccept(), makeAccept()];
    server.mergeRequestContext(paymentPayload, {
      correctiveChannelState: {
        channelId,
        balance: "10000",
        totalClaimed: "0",
        withdrawRequestedAt: 0,
        refundNonce: "0",
        chargedCumulativeAmount: "5000",
      },
      correctiveVoucherState: { signedMaxClaimable: "5000", signature: "0xstored" },
    });

    await handleManagedEnrichPaymentRequiredResponse(server, {
      requirements: accepts,
      paymentPayload,
      resourceInfo: { url: "https://example.com" },
      error: Errors.ErrCumulativeAmountMismatch,
      paymentRequiredResponse: {
        x402Version: 2,
        resource: { url: "https://example.com" },
        accepts,
      },
    } as never);

    for (const accept of accepts) {
      expect(accept.extra.voucherState).toEqual({
        signedMaxClaimable: "5000",
        signature: "0xstored",
      });
    }
  });
});
