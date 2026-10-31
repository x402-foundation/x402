import { describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyTypedData } from "viem";
import { x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { SettleError } from "@x402/core/types";
import { buildChannelConfig } from "../../../src/batch-settlement/client/channel";
import { BatchSettlementEvmScheme as Client } from "../../../src/batch-settlement/client/scheme";
import { InMemoryClientChannelStorage } from "../../../src/batch-settlement/client/storage";
import { BatchSettlementEvmScheme as Server } from "../../../src/batch-settlement/server/scheme";
import { InMemoryChannelStorage } from "../../../src/batch-settlement/server/storage";
import type {
  BatchSettlementRefundPayload,
  BatchSettlementVoucherPayload,
} from "../../../src/batch-settlement/types";
import {
  computeChannelId,
  getBatchSettlementEip712Domain,
  packRefundAuthorizerSalt,
} from "../../../src/batch-settlement/utils";
import { refundTypes } from "../../../src/batch-settlement/constants";
import * as Errors from "../../../src/batch-settlement/errors";

const payer = privateKeyToAccount(generatePrivateKey());
const refundKey = privateKeyToAccount(generatePrivateKey());
const receiver = "0x9876543210987654321098765432109876543210";
const authorizer = "0x1111111111111111111111111111111111111111";
const salt = `0x${"ab".repeat(32)}` as const;
const requirements: PaymentRequirements = {
  scheme: "batch-settlement",
  network: "eip155:84532",
  amount: "1000",
  asset: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
  payTo: receiver,
  maxTimeoutSeconds: 60,
  extra: { voucherManager: "facilitator", receiverAuthorizer: authorizer, withdrawDelay: 900 },
};
const supported = {
  x402Version: 2,
  scheme: requirements.scheme,
  network: requirements.network,
  extra: {
    voucherManager: ["server", "facilitator"],
    receiverAuthorizer: authorizer,
    withdrawDelay: 900,
    delegatedRefund: true,
  },
};

async function payment(
  charged = "1000",
  terms = requirements,
): Promise<PaymentPayload & { payload: BatchSettlementVoucherPayload }> {
  const storage = new InMemoryClientChannelStorage();
  const config = buildChannelConfig({ signer: payer, storage, salt }, terms);
  const channelId = computeChannelId(config, terms.network);
  await storage.set(channelId, {
    chargedCumulativeAmount: charged,
    balance: "10000",
    totalClaimed: "0",
  });
  const client = new Client(payer, { storage, salt });
  const result = await client.createPaymentPayload(2, terms);
  return {
    x402Version: 2,
    accepted: terms,
    payload: result.payload as BatchSettlementVoucherPayload,
  };
}
function verification(
  payload: PaymentPayload & {
    payload: BatchSettlementVoucherPayload | BatchSettlementRefundPayload;
  },
  overrides: Record<string, string | number> = {},
): VerifyResponse {
  return {
    isValid: true,
    payer: payer.address,
    extra: {
      pendingId: "managed-admission",
      balance: "10000",
      totalClaimed: "0",
      chargedCumulativeAmount: "1000",
      withdrawRequestedAt: 0,
      refundNonce: "0",
      ...overrides,
    },
  };
}
function receipt(
  payload: PaymentPayload & {
    payload: BatchSettlementVoucherPayload | BatchSettlementRefundPayload;
  },
  overrides: Record<string, string | number> = {},
): SettleResponse {
  return {
    success: true,
    network: requirements.network,
    payer: payer.address,
    transaction: "",
    amount: "",
    extra: {
      chargedAmount: "1000",
      chargeCount: 1,
      channelState: {
        channelId: payload.payload.voucher.channelId,
        balance: "10000",
        totalClaimed: "0",
        chargedCumulativeAmount: "2000",
        withdrawRequestedAt: 0,
        refundNonce: "0",
        ...overrides,
      },
    },
  };
}
async function runtime(
  payload: PaymentPayload & {
    payload: BatchSettlementVoucherPayload | BatchSettlementRefundPayload;
  },
  options: { storage?: InMemoryChannelStorage; refundSigner?: typeof refundKey } = {},
) {
  const verify = vi.fn(async () => verification(payload));
  const settle = vi.fn(async (_payload: PaymentPayload, _requirements: PaymentRequirements) =>
    receipt(payload),
  );
  const facilitator: FacilitatorClient = {
    verify,
    settle,
    getSupported: async () => ({ kinds: [supported], extensions: [], signers: {} }),
  };
  const storage = options.storage ?? new InMemoryChannelStorage();
  const scheme = new Server(receiver, {
    voucherManager: "facilitator",
    storage,
    refundAuthorizerSigner: options.refundSigner,
  });
  const server = new x402ResourceServer(facilitator).register(requirements.network, scheme);
  await server.initialize();
  return { server, scheme, storage, verify, settle };
}

describe("facilitator-managed EVM client and resource server", () => {
  it("cancels trusted admission when a manual afterVerify hook aborts before scheme hooks", async () => {
    const payload = await payment();
    const { server, scheme, settle } = await runtime(payload);
    server.onAfterVerify(async () => ({ abort: true, reason: "application_aborted" }));
    expect(await server.verifyPayment(payload, requirements)).toMatchObject({
      isValid: false,
      invalidReason: "application_aborted",
    });
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0][0].payload).toMatchObject({
      pendingId: "managed-admission",
      cancel: true,
    });
    expect(settle.mock.calls[0][1].amount).toBe("0");
    expect(scheme.readRequestContext(payload)).toBeUndefined();
  });

  it("releases admission after a local refund signer fails and preserves the original error", async () => {
    const paid = await payment();
    const payload: PaymentPayload & { payload: BatchSettlementRefundPayload } = {
      ...paid,
      payload: { ...paid.payload, type: "refund" },
    };
    const signer = {
      ...refundKey,
      signTypedData: vi.fn(async () => {
        throw new Error("signer offline");
      }),
    };
    const { server, scheme, settle } = await runtime(payload, { refundSigner: signer });
    await server.verifyPayment(payload, requirements);
    await expect(server.settlePayment(payload, requirements)).rejects.toThrow("signer offline");
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0][0].payload).toMatchObject({
      pendingId: "managed-admission",
      cancel: true,
    });
    expect(settle.mock.calls[0][1].amount).toBe("0");
    expect(scheme.readRequestContext(payload)).toBeUndefined();
  });

  it("cancels admission when a beforeSettle hook explicitly aborts", async () => {
    const payload = await payment();
    const { server, settle } = await runtime(payload);
    server.onBeforeSettle(async ctx =>
      ctx.phase === "cancel" ? undefined : { abort: true, reason: "application_aborted" },
    );
    await server.verifyPayment(payload, requirements);
    await expect(server.settlePayment(payload, requirements)).rejects.toMatchObject({
      errorReason: "application_aborted",
    });
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0][0].payload).toMatchObject({
      pendingId: "managed-admission",
      cancel: true,
    });
  });

  it.each(["unknown", "pending"])(
    "retains admission without canceling a %s settlement outcome",
    async outcome => {
      const payload = await payment();
      const { server, scheme, settle } = await runtime(payload);
      await server.verifyPayment(payload, requirements);
      if (outcome === "unknown") {
        settle.mockRejectedValueOnce(new Error("connection lost after dispatch"));
        await expect(server.settlePayment(payload, requirements)).rejects.toThrow(
          "connection lost",
        );
      } else {
        settle.mockResolvedValue({
          success: false,
          errorReason: "settlement_pending",
          transaction: "0xpending",
          network: requirements.network,
        });
        expect((await server.settlePayment(payload, requirements)).success).toBe(false);
      }
      expect(
        settle.mock.calls.every(call => !(call[0].payload as { cancel?: boolean }).cancel),
      ).toBe(true);
      expect(scheme.readRequestContext(payload)?.pendingId).toBe("managed-admission");
      settle.mockResolvedValue(receipt(payload));
      expect((await server.settlePayment(payload, requirements)).success).toBe(true);
      expect(scheme.readRequestContext(payload)).toBeUndefined();
    },
  );

  it("retains cleanup identity when cancel fails, allowing a later cancellation attempt", async () => {
    const payload = await payment();
    const { server, scheme, settle } = await runtime(payload);
    await server.verifyPayment(payload, requirements);
    settle.mockResolvedValueOnce({
      success: false,
      errorReason: "temporary_store_failure",
      transaction: "",
      network: requirements.network,
    });
    await server
      .createPaymentCancellationDispatcher(payload, requirements)
      .cancel({ reason: "handler_failed" });
    expect(scheme.readRequestContext(payload)?.pendingId).toBe("managed-admission");
    await server
      .createPaymentCancellationDispatcher(payload, requirements)
      .cancel({ reason: "handler_failed" });
    expect(settle).toHaveBeenCalledTimes(2);
    expect(scheme.readRequestContext(payload)).toBeUndefined();
  });

  it.each(["settlement_pending", "receipt_present"])(
    "does not cancel a beforeSettle error reporting %s",
    async reason => {
      const payload = await payment();
      const { server, scheme, settle } = await runtime(payload);
      const error = new SettleError(502, {
        success: false,
        errorReason: reason,
        transaction: reason === "receipt_present" ? "0xsubmitted" : "",
        network: requirements.network,
      });
      server.onBeforeSettle(async () => {
        throw error;
      });
      await server.verifyPayment(payload, requirements);
      await expect(server.settlePayment(payload, requirements)).rejects.toBe(error);
      expect(settle).not.toHaveBeenCalled();
      expect(scheme.readRequestContext(payload)?.pendingId).toBe("managed-admission");
    },
  );

  it("does not cancel after a recovery hook handles a pre-dispatch failure", async () => {
    const payload = await payment();
    const { server, scheme, settle } = await runtime(payload);
    vi.spyOn(scheme, "enrichSettlementPayload").mockRejectedValueOnce(new Error("local failure"));
    server.onSettleFailure(async () => ({ recovered: true, result: receipt(payload) }));
    await server.verifyPayment(payload, requirements);
    expect((await server.settlePayment(payload, requirements)).success).toBe(true);
    expect(settle).not.toHaveBeenCalled();
  });

  it("does not cancel a skip receipt when response enrichment fails", async () => {
    const payload = await payment();
    const { server, scheme, settle } = await runtime(payload);
    const error = new SettleError(502, {
      success: false,
      errorReason: "enrichment_failed",
      transaction: "",
      network: requirements.network,
    });
    server.onBeforeSettle(async () => ({ skip: true, result: receipt(payload) }));
    vi.spyOn(scheme, "enrichSettlementResponse").mockRejectedValueOnce(error);
    const canceled = vi.fn();
    server.onVerifiedPaymentCanceled(canceled);
    await server.verifyPayment(payload, requirements);
    expect((await server.settlePayment(payload, requirements)).success).toBe(true);
    expect(settle).not.toHaveBeenCalled();
    expect(canceled).not.toHaveBeenCalled();
  });

  it.each([
    "chargedCumulativeAmount",
    "balance",
    "totalClaimed",
    "refundNonce",
    "withdrawRequestedAt",
  ])("fails closed for malformed authoritative %s without canceling a commit", async field => {
    const payload = await payment();
    const { server, settle } = await runtime(payload);
    await server.verifyPayment(payload, requirements);
    settle.mockResolvedValueOnce(receipt(payload, { [field]: "invalid" }));
    expect(await server.settlePayment(payload, requirements)).toMatchObject({
      success: false,
      errorReason: Errors.ErrVoucherStoreUnavailable,
    });
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("does not settle a malformed admission response without its reservation identity", async () => {
    const payload = await payment();
    const { server, scheme, verify, settle } = await runtime(payload);
    verify.mockResolvedValueOnce({
      isValid: true,
      payer: payer.address,
      extra: {
        balance: "10000",
        chargedCumulativeAmount: "1000",
        totalClaimed: "0",
        refundNonce: "0",
      },
    });
    expect(await server.verifyPayment(payload, requirements)).toMatchObject({
      isValid: false,
      invalidReason: Errors.ErrVerificationStateUnavailable,
    });
    expect(settle).not.toHaveBeenCalled();
    expect(scheme.readRequestContext(payload)).toBeUndefined();
  });

  it("does not offer a server redemption worker for facilitator custody", async () => {
    const payload = await payment();
    const { scheme } = await runtime(payload);
    expect(() =>
      scheme.createChannelManager(
        {} as FacilitatorClient,
        requirements.network,
        requirements.asset as `0x${string}`,
      ),
    ).toThrow(/facilitator's redemption worker/);
  });

  it("forwards an initial deposit and copies its committed facilitator receipt", async () => {
    const terms = { ...requirements, extra: { ...requirements.extra, name: "USDC", version: "2" } };
    const client = new Client(payer, { salt });
    const created = await client.createPaymentPayload(2, terms);
    const payload: PaymentPayload = { x402Version: 2, accepted: terms, payload: created.payload };
    const verify = vi.fn(async () => ({
      isValid: true,
      payer: payer.address,
      extra: {
        pendingId: "deposit-admission",
        chargedCumulativeAmount: "0",
        balance: "0",
        totalClaimed: "0",
        refundNonce: "0",
      },
    }));
    const settle = vi.fn(async () => ({
      success: true,
      network: terms.network,
      payer: payer.address,
      transaction: `0x${"ab".repeat(32)}`,
      amount: "5000",
      extra: {
        chargedAmount: "1000",
        chargeCount: 1,
        channelState: {
          channelId: (created.payload as BatchSettlementVoucherPayload).voucher.channelId,
          balance: "5000",
          totalClaimed: "0",
          chargedCumulativeAmount: "1000",
          withdrawRequestedAt: 0,
          refundNonce: "0",
        },
      },
    }));
    const scheme = new Server(receiver, { voucherManager: "facilitator" });
    const server = new x402ResourceServer({
      verify,
      settle,
      getSupported: async () => ({ kinds: [supported], extensions: [], signers: {} }),
    }).register(terms.network, scheme);
    await server.initialize();
    expect((await server.verifyPayment(payload, terms)).isValid).toBe(true);
    const result = await server.settlePayment(payload, terms);
    expect(result).toMatchObject({ success: true, amount: "5000", extra: { chargeCount: 1 } });
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ type: "deposit", pendingId: "deposit-admission" }),
      }),
      expect.anything(),
    );
    expect((await scheme.getStorage().list())[0]).toMatchObject({
      balance: "5000",
      chargedCumulativeAmount: "1000",
    });
  });

  it("packs the refund key using Go-compatible raw and index entropy while preserving server mode", () => {
    const index = `0x${"0".repeat(63)}1` as const;
    expect(packRefundAuthorizerSalt(index, refundKey.address)).toBe(
      `0x${"0".repeat(23)}1${refundKey.address.slice(2)}`.toLowerCase(),
    );
    expect(packRefundAuthorizerSalt(salt, refundKey.address)).toBe(
      `0x${"ab".repeat(12)}${refundKey.address.slice(2)}`.toLowerCase(),
    );
    const storage = new InMemoryClientChannelStorage();
    const terms = {
      ...requirements,
      extra: { ...requirements.extra, refundAuthorizer: refundKey.address },
    };
    expect(buildChannelConfig({ signer: payer, storage, salt }, terms).salt).toBe(
      packRefundAuthorizerSalt(salt, refundKey.address),
    );
    expect(
      buildChannelConfig(
        { signer: payer, storage, salt },
        { ...terms, extra: { ...terms.extra, voucherManager: "server" } },
      ).salt,
    ).toBe(salt);
  });

  it("negotiates managed capability and a refund-consent path, copying the facilitator delay", async () => {
    const scheme = new Server(receiver, {
      voucherManager: "facilitator",
      withdrawDelay: 900,
      refundAuthorizerSigner: refundKey,
    });
    const kind = {
      ...supported,
      extra: { ...supported.extra, withdrawDelay: 1200, delegatedRefund: false },
    };
    const terms = await scheme.enhancePaymentRequirements(requirements, kind, []);
    expect(terms.extra).toMatchObject({
      voucherManager: "facilitator",
      receiverAuthorizer: authorizer,
      withdrawDelay: 1200,
      refundAuthorizer: refundKey.address,
    });
    await expect(
      scheme.enhancePaymentRequirements(
        requirements,
        { ...kind, extra: { ...kind.extra, voucherManager: ["server"] } },
        [],
      ),
    ).rejects.toThrow(/voucherManager/);
    const delegated = new Server(receiver, { voucherManager: "facilitator" });
    expect(delegated.validateFacilitatorSupport(requirements.network, kind, [])).toMatch(
      /refundAuthorizerSigner/,
    );
    const delegatedTerms = await delegated.enhancePaymentRequirements(
      { ...requirements, extra: { ...requirements.extra, refundAuthorizer: refundKey.address } },
      supported,
      [],
    );
    expect(delegatedTerms.extra).not.toHaveProperty("refundAuthorizer");
  });

  it("forwards every voucher despite a stale replica, and recreates a server without authoritative local storage", async () => {
    const payload = await payment();
    const first = await runtime(payload);
    await first.storage.updateChannel(payload.payload.voucher.channelId, () => ({
      channelId: payload.payload.voucher.channelId,
      channelConfig: payload.payload.channelConfig,
      chargedCumulativeAmount: "9000",
      signedMaxClaimable: "9000",
      signature: "0x",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: 0,
    }));
    expect((await first.server.verifyPayment(payload, requirements)).isValid).toBe(true);
    expect((await first.server.settlePayment(payload, requirements)).success).toBe(true);
    expect(first.verify).toHaveBeenCalledTimes(1);
    expect(first.settle).toHaveBeenCalledTimes(1);
    expect(first.settle.mock.calls[0][0].payload).toMatchObject({ pendingId: "managed-admission" });
    // The stale replica is never used to refuse admission or roll back newer state.
    expect(
      (await first.storage.get(payload.payload.voucher.channelId))?.chargedCumulativeAmount,
    ).toBe("9000");
    const restarted = await runtime(payload);
    expect((await restarted.server.verifyPayment(payload, requirements)).isValid).toBe(true);
    const result = await restarted.server.settlePayment(payload, requirements);
    expect(result.extra?.chargeCount).toBe(1);
    expect(
      (await restarted.storage.get(payload.payload.voucher.channelId))?.chargedCumulativeAmount,
    ).toBe("2000");
  });

  it.each(["pendingId", "cancel"])("rejects client-supplied %s before admission", async field => {
    const payload = await payment();
    Object.assign(payload.payload, { [field]: field === "cancel" ? true : "client-value" });
    const { server, verify } = await runtime(payload);
    expect((await server.verifyPayment(payload, requirements)).isValid).toBe(false);
    expect(verify).not.toHaveBeenCalled();
  });

  it("cancels verify-only admission once, without a paid charge or a replica write", async () => {
    const payload = await payment();
    const { server, storage, settle } = await runtime(payload);
    expect((await server.verifyPayment(payload, requirements)).isValid).toBe(true);
    const cancel = server.createPaymentCancellationDispatcher(payload, requirements);
    await Promise.all([
      cancel.cancel({ reason: "handler_threw" }),
      cancel.cancel({ reason: "handler_threw" }),
    ]);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0][0].payload).toMatchObject({
      pendingId: "managed-admission",
      cancel: true,
    });
    expect(settle.mock.calls[0][1].amount).toBe("0");
    expect(await storage.list()).toEqual([]);
  });

  it("preserves the same admission and receipt through settlement_pending retry", async () => {
    const payload = await payment();
    const { server, settle } = await runtime(payload);
    settle.mockResolvedValueOnce({
      success: false,
      errorReason: "settlement_pending",
      transaction: "0xconfirmed-later",
      network: requirements.network,
    });
    settle.mockResolvedValueOnce({ ...receipt(payload), transaction: "0xconfirmed-later" });
    await server.verifyPayment(payload, requirements);
    expect((await server.settlePayment(payload, requirements)).transaction).toBe(
      "0xconfirmed-later",
    );
    expect(settle).toHaveBeenCalledTimes(2);
    expect(
      settle.mock.calls.map(call => (call[0].payload as { pendingId: string }).pendingId),
    ).toEqual(["managed-admission", "managed-admission"]);
  });

  it("keeps the committed receipt and client watermark when the optional replica fails", async () => {
    const payload = await payment();
    const storage = new InMemoryChannelStorage();
    const { server } = await runtime(payload, { storage });
    await server.verifyPayment(payload, requirements);
    vi.spyOn(storage, "updateChannel").mockRejectedValueOnce(new Error("replica unavailable"));
    const result = await server.settlePayment(payload, requirements);
    expect(result).toMatchObject({
      success: true,
      extra: { chargeCount: 1, channelState: { chargedCumulativeAmount: "2000" } },
    });
    const clientStorage = new InMemoryClientChannelStorage();
    await clientStorage.set(payload.payload.voucher.channelId, {
      chargedCumulativeAmount: "1000",
      balance: "10000",
    });
    const client = new Client(payer, { storage: clientStorage, salt });
    await client.schemeHooks.onPaymentResponse!({
      paymentPayload: payload,
      requirements,
      settleResponse: result,
    });
    expect(
      (await clientStorage.get(payload.payload.voucher.channelId))?.chargedCumulativeAmount,
    ).toBe("2000");
  });

  it("uses the verify snapshot for a signed refund, preserving the exact nonce and omitting claim authority", async () => {
    const paid = await payment();
    const payload: PaymentPayload & { payload: BatchSettlementRefundPayload } = {
      ...paid,
      payload: {
        ...paid.payload,
        type: "refund",
        voucher: { ...paid.payload.voucher, maxClaimableAmount: "1000" },
      },
    };
    const { server, verify, settle } = await runtime(payload, { refundSigner: refundKey });
    verify.mockResolvedValueOnce(verification(payload, { refundNonce: "9007199254740993" }));
    settle.mockResolvedValueOnce(
      receipt(payload, {
        balance: "1000",
        chargedCumulativeAmount: "1000",
        refundNonce: "9007199254740994",
      }),
    );
    await server.verifyPayment(payload, { ...requirements, amount: "0" });
    await server.settlePayment(payload, { ...requirements, amount: "0" });
    const raw = settle.mock.calls[0][0].payload as Record<string, string | undefined>;
    expect(raw.refundNonce).toBe("9007199254740993");
    expect(raw.amount).toBe("9000");
    expect(raw.claimAuthorizerSignature).toBeUndefined();
    expect(
      await verifyTypedData({
        address: refundKey.address,
        domain: getBatchSettlementEip712Domain(84532),
        types: refundTypes,
        primaryType: "Refund",
        message: {
          channelId: paid.payload.voucher.channelId,
          nonce: 9007199254740993n,
          amount: 9000n,
        },
        signature: raw.refundAuthorizerSignature as `0x${string}`,
      }),
    ).toBe(true);
  });

  it("forwards facilitator corrective proofs for either mismatch reason without consulting a replica", async () => {
    const payload = await payment();
    const { server, scheme, verify } = await runtime(payload);
    for (const reason of [
      Errors.ErrCumulativeAmountMismatch,
      Errors.ErrCumulativeAmountBelowClaimed,
    ]) {
      const channelState = {
        channelId: payload.payload.voucher.channelId,
        balance: "10000",
        chargedCumulativeAmount: "2000",
        totalClaimed: "1000",
        refundNonce: "0",
        withdrawRequestedAt: 0,
      };
      const voucherState = {
        signedMaxClaimable: "2000",
        signature: payload.payload.voucher.signature,
      };
      verify.mockResolvedValueOnce({
        isValid: false,
        invalidReason: reason,
        extra: { channelState, voucherState },
      });
      expect((await server.verifyPayment(payload, requirements)).isValid).toBe(false);
      const accepts = [requirements];
      const result = await scheme.enrichPaymentRequiredResponse({
        requirements: accepts,
        paymentPayload: payload,
        error: reason,
        resourceInfo: { url: "https://example.test/resource" },
        paymentRequiredResponse: {
          x402Version: 2,
          resource: { url: "https://example.test/resource" },
          accepts,
        },
      });
      expect(result?.[0].extra).toMatchObject({ channelState, voucherState });
    }
  });
});
