import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ExactSvmScheme } from "../../src/exact/facilitator/scheme";
import * as Errors from "../../src/exact/facilitator/errors";
const { ErrSettlementPending } = Errors;
import {
  InMemoryPendingSettlementStore,
  type PendingSettlementStore,
} from "@x402/core/facilitator";
import type { FacilitatorSvmSigner } from "../../src/signer";
import type { PaymentRequirements, PaymentPayload } from "@x402/core/types";
import { SOLANA_DEVNET_CAIP2 } from "../../src/constants";
import { USDC_DEVNET_ADDRESS } from "../../src/defaultAssets";
import * as svmUtils from "../../src/utils";
import { TransactionOnchainFailureError } from "../../src/utils";

/**
 * Pins the exact SVM facilitator's non-terminal confirm-timeout reason to the
 * generic, cross-SDK `settlement_pending` wire literal (mirrors the EVM
 * equivalent in `evm/test/unit/settlement-pending-reason.test.ts`). This
 * reason used to be unreported entirely (a confirm-timeout simply rejected
 * `settle()`'s promise); it is now unified with EVM/SVM upto so the resource
 * server's automatic single retry recognizes it uniformly across
 * schemes/networks.
 */
describe("ErrSettlementPending wire contract (SVM exact)", () => {
  it("equals the settlement_pending wire literal the transport layers mirror", () => {
    expect(ErrSettlementPending).toBe("settlement_pending");
  });
});

describe("ExactSvmScheme pending-settlement store integration", () => {
  let mockSigner: FacilitatorSvmSigner;
  let store: PendingSettlementStore;

  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: SOLANA_DEVNET_CAIP2,
    asset: USDC_DEVNET_ADDRESS,
    amount: "100000",
    payTo: "PayToAddress11111111111111111111111111",
    maxTimeoutSeconds: 3600,
    extra: { feePayer: "FeePayer1111111111111111111111111111" },
  };

  function makePayload(transaction: string): PaymentPayload {
    return {
      x402Version: 2,
      resource: {
        url: "http://example.com/protected",
        description: "Test resource",
        mimeType: "application/json",
      },
      accepted: {
        scheme: "exact",
        network: SOLANA_DEVNET_CAIP2,
        asset: USDC_DEVNET_ADDRESS,
        amount: "100000",
        payTo: "PayToAddress11111111111111111111111111",
        maxTimeoutSeconds: 3600,
        extra: { feePayer: "FeePayer1111111111111111111111111111" },
      },
      payload: { transaction },
    };
  }

  /**
   * Wires a facilitator instance so `settle()`'s duplicate-cache/pending-store
   * plumbing can be exercised without real transaction decoding: `_verify` is
   * stubbed to succeed, and `decodeTransactionFromPayload` is stubbed to
   * derive deterministic (but non-real) messageBytes from the transaction
   * string — mirrors the pattern in `duplicateTx.test.ts` /
   * `facilitator.test.ts`'s `setupSettleMocks`.
   */
  function setupFacilitator(): ExactSvmScheme {
    const facilitator = new ExactSvmScheme(mockSigner, undefined, {
      pendingSettlementStore: store,
    });
    vi.spyOn(
      facilitator as unknown as { _verify: (...args: unknown[]) => Promise<unknown> },
      "_verify",
    ).mockResolvedValue({
      response: { isValid: true, payer: "PayerAddress" },
      verificationPath: "static",
    });
    return facilitator;
  }

  beforeEach(() => {
    mockSigner = {
      address: "FacilitatorAddress1111111111111111111" as never,
      getAddresses: vi
        .fn()
        .mockReturnValue([
          "FeePayer1111111111111111111111111111",
          "FacilitatorAddress1111111111111111111",
        ]) as never,
      getSigner: vi.fn() as never,
      signTransaction: vi.fn().mockResolvedValue("signedTx") as never,
      signTransactions: vi.fn() as never,
      signMessages: vi.fn() as never,
      sendTransaction: vi.fn().mockResolvedValue("txSignature123") as never,
      confirmTransaction: vi.fn().mockResolvedValue(undefined) as never,
      getRpcForNetwork: vi.fn() as never,
    };
    store = new InMemoryPendingSettlementStore();

    vi.spyOn(svmUtils, "decodeTransactionFromPayload").mockImplementation(
      (payload: { transaction: string }) =>
        ({ messageBytes: new TextEncoder().encode(payload.transaction) }) as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("cache-miss + broadcast success: leaves no pending entry", async () => {
    const facilitator = setupFacilitator();
    const payload = makePayload("cacheMissSuccessTx==");
    const txKey = svmUtils.transactionMessageHash(
      svmUtils.decodeTransactionFromPayload(payload.payload as never),
    );

    const result = await facilitator.settle(payload, requirements);

    expect(result.success).toBe(true);
    expect(result.transaction).toBe("txSignature123");
    expect(await store.get(txKey)).toBeUndefined();
  });

  it("cache-miss + confirmTransaction fails: returns settlement_pending and populates the store keyed by the message hash", async () => {
    mockSigner.confirmTransaction = vi
      .fn()
      .mockRejectedValue(new Error("rpc: confirmation timeout")) as never;
    const facilitator = setupFacilitator();
    const payload = makePayload("cacheMissPendingTx==");
    const txKey = svmUtils.transactionMessageHash(
      svmUtils.decodeTransactionFromPayload(payload.payload as never),
    );

    const result = await facilitator.settle(payload, requirements);

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(ErrSettlementPending);
    expect(result.errorReason).toBe("settlement_pending");
    expect(result.transaction).toBe("txSignature123");
    expect(await store.get(txKey)).toBe("txSignature123");
  });

  it("cache-miss + confirmTransaction fails onchain (terminal): returns transaction_failed and releases the dedup lock", async () => {
    mockSigner.confirmTransaction = vi
      .fn()
      .mockRejectedValue(
        new TransactionOnchainFailureError("Transaction failed onchain: {}"),
      ) as never;
    const facilitator = setupFacilitator();
    const payload = makePayload("terminalOnchainTx==");
    const txKey = svmUtils.transactionMessageHash(
      svmUtils.decodeTransactionFromPayload(payload.payload as never),
    );

    const result = await facilitator.settle(payload, requirements);

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrTransactionFailed);
    expect(result.transaction).toBe("txSignature123");
    // Terminal: no pending entry recorded, and the settlementCache dedup lock is
    // released so a fresh broadcast for this payload isn't blocked.
    expect(await store.get(txKey)).toBeUndefined();
    const retried = await facilitator.settle(makePayload("terminalOnchainTx=="), requirements);
    expect(retried.success).toBe(false);
    expect(retried.errorReason).toBe(Errors.ErrTransactionFailed);
  });

  it("cache-hit + confirmTransaction fails onchain during reconciliation (terminal): returns transaction_failed", async () => {
    mockSigner.confirmTransaction = vi
      .fn()
      .mockRejectedValue(
        new TransactionOnchainFailureError("Transaction failed onchain: {}"),
      ) as never;
    const facilitator = setupFacilitator();
    const payload = makePayload("cacheHitTerminalTx==");
    const txKey = svmUtils.transactionMessageHash(
      svmUtils.decodeTransactionFromPayload(payload.payload as never),
    );
    await store.set(txKey, "cachedSignature789");

    const result = await facilitator.settle(payload, requirements);

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrTransactionFailed);
    expect(result.transaction).toBe("cachedSignature789");
    expect(mockSigner.signTransaction).not.toHaveBeenCalled();
    expect(mockSigner.sendTransaction).not.toHaveBeenCalled();
    expect(await store.get(txKey)).toBeUndefined();
  });

  it("cache-hit: skips verify/sign/send entirely and reconciles against the cached signature", async () => {
    const facilitator = setupFacilitator();
    const payload = makePayload("cacheHitSuccessTx==");
    const txKey = svmUtils.transactionMessageHash(
      svmUtils.decodeTransactionFromPayload(payload.payload as never),
    );
    await store.set(txKey, "cachedSignature123");

    const result = await facilitator.settle(payload, requirements);

    expect(result.success).toBe(true);
    expect(result.transaction).toBe("cachedSignature123");
    expect(mockSigner.signTransaction).not.toHaveBeenCalled();
    expect(mockSigner.sendTransaction).not.toHaveBeenCalled();
    expect(mockSigner.confirmTransaction).toHaveBeenCalledWith(
      "cachedSignature123",
      requirements.network,
    );
    expect(await store.get(txKey)).toBeUndefined();
  });

  it("cache-hit: still-unconfirmed reconciliation returns settlement_pending again and preserves the store entry", async () => {
    mockSigner.confirmTransaction = vi
      .fn()
      .mockRejectedValue(new Error("still not confirmed")) as never;
    const facilitator = setupFacilitator();
    const payload = makePayload("cacheHitPendingTx==");
    const txKey = svmUtils.transactionMessageHash(
      svmUtils.decodeTransactionFromPayload(payload.payload as never),
    );
    await store.set(txKey, "cachedSignature456");

    const result = await facilitator.settle(payload, requirements);

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(ErrSettlementPending);
    expect(result.transaction).toBe("cachedSignature456");
    expect(mockSigner.signTransaction).not.toHaveBeenCalled();
    expect(mockSigner.sendTransaction).not.toHaveBeenCalled();
    expect(await store.get(txKey)).toBe("cachedSignature456");
  });

  it("terminal verify failure never touches the store", async () => {
    const facilitator = new ExactSvmScheme(mockSigner, undefined, {
      pendingSettlementStore: store,
    });
    vi.spyOn(
      facilitator as unknown as { _verify: (...args: unknown[]) => Promise<unknown> },
      "_verify",
    ).mockResolvedValue({
      response: {
        isValid: false,
        invalidReason: "invalid_exact_svm_payload_amount_mismatch",
        payer: "PayerAddress",
      },
      verificationPath: null,
    });
    const payload = makePayload("terminalFailureTx==");
    const txKey = svmUtils.transactionMessageHash(
      svmUtils.decodeTransactionFromPayload(payload.payload as never),
    );

    const result = await facilitator.settle(payload, requirements);

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("invalid_exact_svm_payload_amount_mismatch");
    expect(mockSigner.signTransaction).not.toHaveBeenCalled();
    expect(mockSigner.sendTransaction).not.toHaveBeenCalled();
    expect(await store.get(txKey)).toBeUndefined();
  });

  it("send failure (never broadcast) never touches the store", async () => {
    mockSigner.sendTransaction = vi.fn().mockRejectedValue(new Error("rpc send failed")) as never;
    const facilitator = setupFacilitator();
    const payload = makePayload("sendFailureTx==");
    const txKey = svmUtils.transactionMessageHash(
      svmUtils.decodeTransactionFromPayload(payload.payload as never),
    );

    const result = await facilitator.settle(payload, requirements);

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrTransactionFailed);
    expect(mockSigner.confirmTransaction).not.toHaveBeenCalled();
    expect(await store.get(txKey)).toBeUndefined();
  });

  it("uses a fresh in-memory store by default when none is provided", async () => {
    const facilitator = new ExactSvmScheme(mockSigner);
    vi.spyOn(
      facilitator as unknown as { _verify: (...args: unknown[]) => Promise<unknown> },
      "_verify",
    ).mockResolvedValue({
      response: { isValid: true, payer: "PayerAddress" },
      verificationPath: "static",
    });
    const payload = makePayload("defaultStoreTx==");

    const result = await facilitator.settle(payload, requirements);

    expect(result.success).toBe(true);
  });
});
