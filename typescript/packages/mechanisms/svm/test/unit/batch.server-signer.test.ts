import { generateKeyPairSigner, getBase58Decoder } from "@solana/kit";
import { x402ResourceServer } from "@x402/core/server";
import type { Network, PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  encodeBatchAuthorizationMessage,
  signBatchAuthorization,
  verifyBatchAuthorization,
} from "../../src/batch-settlement/authorization";
import {
  BatchChannelTracker,
  buildDepositPayload,
  buildRefundPayload,
  signBatchVoucher,
} from "../../src/batch-settlement/client/channel";
import { BatchError } from "../../src/batch-settlement/errors";
import { BatchSvmScheme as BatchServerScheme } from "../../src/batch-settlement/server/scheme";
import { MemoryChannelStore } from "../../src/batch-settlement/server/storage";
import { MemoryBatchOperationStore } from "../../src/batch-settlement/server/operationStore";
import {
  isBatchChannelConfig,
  isBatchFacilitatorPayload,
  isBatchPayload,
  isBatchVoucher,
  type BatchChannelConfig,
  type BatchDepositPayload,
  type BatchVoucher,
} from "../../src/batch-settlement/types";
import { TOKEN_PROGRAM_ADDRESS } from "../../src/constants";
import { SOLANA_DEVNET_CAIP2 } from "../../src/constants";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";
import {
  encodeVoucherMessageBytes,
  verifyVoucherSignature,
} from "../../src/payment-channels/voucher";

let payer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let operator: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let feePayer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let receiverAuthorizer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let serverDeposit: BatchDepositPayload;

beforeAll(async () => {
  payer = await generateKeyPairSigner();
  operator = await generateKeyPairSigner();
  feePayer = await generateKeyPairSigner();
  receiverAuthorizer = await generateKeyPairSigner();
  serverDeposit = (
    await buildDepositPayload({
      blockhash: { blockhash: USDC_MAINNET_ADDRESS, lastValidBlockHeight: 1n },
      depositAmount: 10_000n,
      feePayer: feePayer.address,
      firstCharge: 1_000n,
      mint: USDC_DEVNET_ADDRESS,
      openSlot: 123n,
      operator: operator.address,
      payer,
      receiver: USDC_MAINNET_ADDRESS,
      receiverAuthorizer: receiverAuthorizer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      voucherSigner: "server",
      withdrawDelay: 900,
      authorizationExpiresAt: Math.floor(Date.now() / 1000) + 3_600,
    })
  ).payload;
});

function requirements(): PaymentRequirements {
  return {
    amount: "1000",
    asset: USDC_DEVNET_ADDRESS,
    extra: {
      feePayer: feePayer.address,
      operator: operator.address,
      receiverAuthorizer: receiverAuthorizer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      voucherSigner: "server",
      withdrawDelay: 900,
    },
    maxTimeoutSeconds: 300,
    network: SOLANA_DEVNET_CAIP2,
    payTo: USDC_MAINNET_ADDRESS,
    scheme: "batch-settlement",
  };
}

async function authorizationFor(requestId: string, authorizedAmount = 1_000n) {
  return signBatchAuthorization(
    payer,
    serverDeposit.authorization!.channelId,
    operator.address,
    requestId,
    authorizedAmount,
    Math.floor(Date.now() / 1000) + 3_600,
  );
}

describe("batch server voucher signer boundaries", () => {
  it("covers malformed top-level wire guards", () => {
    expect(isBatchVoucher(null)).toBe(false);
    expect(isBatchFacilitatorPayload(null)).toBe(false);
    expect(isBatchChannelConfig({ ...serverDeposit.channelConfig, receiverAuthorizer: 1 })).toBe(
      false,
    );
  });

  it("rejects malformed server and client wire combinations", async () => {
    expect(isBatchPayload(serverDeposit)).toBe(true);
    const clientDeposit = (
      await buildDepositPayload({
        blockhash: { blockhash: USDC_MAINNET_ADDRESS, lastValidBlockHeight: 1n },
        depositAmount: 10_000n,
        feePayer: feePayer.address,
        firstCharge: 1_000n,
        mint: USDC_DEVNET_ADDRESS,
        openSlot: 123n,
        payer,
        receiver: USDC_MAINNET_ADDRESS,
        receiverAuthorizer: receiverAuthorizer.address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        withdrawDelay: 900,
      })
    ).payload;
    expect(isBatchPayload(clientDeposit)).toBe(true);

    const invalid = [
      { ...serverDeposit, deposit: null },
      { ...serverDeposit, deposit: { ...serverDeposit.deposit, amount: 1 } },
      { ...serverDeposit, deposit: { ...serverDeposit.deposit, transaction: 1 } },
      { ...serverDeposit, voucher: clientDeposit.voucher },
      { ...serverDeposit, authorization: null },
      { ...serverDeposit, authorization: { ...serverDeposit.authorization, type: "other" } },
      { ...serverDeposit, authorization: { ...serverDeposit.authorization, channelId: 1 } },
      { ...serverDeposit, authorization: { ...serverDeposit.authorization, payer: 1 } },
      { ...serverDeposit, authorization: { ...serverDeposit.authorization, expiresAt: 0 } },
      { ...serverDeposit, authorization: { ...serverDeposit.authorization, signature: 1 } },
      { ...serverDeposit, requestId: "" },
      { ...serverDeposit, maxClaimableAmount: 1 },
      { ...clientDeposit, authorization: serverDeposit.authorization },
      { ...clientDeposit, requestId: "key" },
      { ...clientDeposit, maxClaimableAmount: "1000" },
      {
        channelConfig: serverDeposit.channelConfig,
        type: "voucher",
        voucher: clientDeposit.voucher,
      },
      {
        authorization: serverDeposit.authorization,
        channelConfig: clientDeposit.channelConfig,
        requestId: "key",
        maxClaimableAmount: "1000",
        type: "authorization",
      },
      {
        authorization: null,
        channelConfig: serverDeposit.channelConfig,
        requestId: "key",
        maxClaimableAmount: "1000",
        type: "authorization",
      },
      {
        authorization: serverDeposit.authorization,
        channelConfig: serverDeposit.channelConfig,
        requestId: "",
        maxClaimableAmount: "1000",
        type: "authorization",
      },
      {
        authorization: serverDeposit.authorization,
        channelConfig: serverDeposit.channelConfig,
        requestId: "key",
        maxClaimableAmount: 1,
        type: "authorization",
      },
    ];
    for (const payload of invalid) expect(isBatchPayload(payload)).toBe(false);

    expect(isBatchChannelConfig({ ...serverDeposit.channelConfig, voucherSigner: "unknown" })).toBe(
      false,
    );
    expect(isBatchChannelConfig({ ...serverDeposit.channelConfig, voucherSigner: "client" })).toBe(
      true,
    );
  });

  it("prevents using the wrong credential API for either signer mode", async () => {
    const serverTracker = new BatchChannelTracker(
      serverDeposit.authorization!.channelId,
      serverDeposit.channelConfig,
      payer,
    );
    await expect(serverTracker.previewVoucher(1n)).rejects.toThrow(/do not use client vouchers/);

    const clientConfig: BatchChannelConfig = {
      ...serverDeposit.channelConfig,
      payerAuthorizer: payer.address,
      voucherSigner: "client",
    };
    const clientTracker = new BatchChannelTracker(
      serverDeposit.authorization!.channelId,
      clientConfig,
      payer,
    );
    await expect(
      clientTracker.authorization("request", 1n, Math.floor(Date.now() / 1000) + 60),
    ).rejects.toThrow(/do not use server authorization/);
    await expect(
      buildDepositPayload({
        blockhash: { blockhash: USDC_MAINNET_ADDRESS, lastValidBlockHeight: 1n },
        depositAmount: 10_000n,
        feePayer: feePayer.address,
        firstCharge: 1_000n,
        mint: USDC_DEVNET_ADDRESS,
        openSlot: 123n,
        payer,
        receiver: USDC_MAINNET_ADDRESS,
        receiverAuthorizer: receiverAuthorizer.address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        voucherSigner: "server",
        withdrawDelay: 900,
      }),
    ).rejects.toThrow(/operator is required/);
  });

  it("enforces tracker and deposit-builder boundaries in both modes", async () => {
    const clientConfig: BatchChannelConfig = {
      ...serverDeposit.channelConfig,
      payerAuthorizer: payer.address,
      voucherSigner: "client",
    };
    const tracker = new BatchChannelTracker(
      serverDeposit.authorization!.channelId,
      clientConfig,
      payer,
      2n,
    );
    await expect(tracker.previewVoucher(0n)).rejects.toThrow(/positive/);
    expect(() => tracker.commit(1n)).toThrow(/backwards/);
    await expect(
      signBatchVoucher({ address: payer.address, signMessages: async () => [{}] } as never, {
        channelId: serverDeposit.authorization!.channelId,
        expiresAt: 0,
        maxClaimableAmount: 3n,
      }),
    ).rejects.toThrow(/did not return/);

    const base = {
      blockhash: { blockhash: USDC_MAINNET_ADDRESS, lastValidBlockHeight: 1n },
      depositAmount: 10_000n,
      feePayer: feePayer.address,
      firstCharge: 1_000n,
      mint: USDC_DEVNET_ADDRESS,
      openSlot: 123n,
      payer,
      receiver: USDC_MAINNET_ADDRESS,
      receiverAuthorizer: receiverAuthorizer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      withdrawDelay: 900,
    };
    await expect(buildDepositPayload({ ...base, firstCharge: 0n })).rejects.toThrow(/positive/);
    await expect(buildDepositPayload({ ...base, firstCharge: 10_001n })).rejects.toThrow(
      /positive/,
    );
    await expect(
      buildDepositPayload({ ...base, openSlot: BigInt(Number.MAX_SAFE_INTEGER) + 1n }),
    ).rejects.toThrow(/safe integer/);
    await expect(
      buildDepositPayload({ ...base, receiverAuthorizer: operator.address }),
    ).resolves.toMatchObject({
      payload: { channelConfig: { receiverAuthorizer: operator.address } },
    });
  });

  it("rejects malformed keys and a signer that returns no proof", async () => {
    const shortKey = getBase58Decoder().decode(new Uint8Array(31));
    expect(() =>
      encodeBatchAuthorizationMessage({
        channelId: shortKey,
        requestId: "request",
        authorizedAmount: 1_000n,
        expiresAt: Math.floor(Date.now() / 1000) + 60,
        operator: operator.address,
        payer: payer.address,
      }),
    ).toThrow(/decode to 32 bytes/);
    await expect(
      signBatchAuthorization(
        { address: payer.address, signMessages: async () => [{}] } as never,
        serverDeposit.authorization!.channelId,
        operator.address,
        "request",
        1_000n,
        Math.floor(Date.now() / 1000) + 60,
      ),
    ).rejects.toThrow(/did not return/);
  });

  it("binds authorization to both the channel and operator", async () => {
    const authorization = serverDeposit.authorization!;
    await expect(verifyBatchAuthorization(authorization, operator.address)).resolves.toBe(true);
    await expect(verifyBatchAuthorization(authorization, feePayer.address)).resolves.toBe(false);
    await expect(
      verifyBatchAuthorization({ ...authorization, expiresAt: 1 }, operator.address),
    ).resolves.toBe(false);
    await expect(
      verifyBatchAuthorization({ ...authorization, channelId: feePayer.address }, operator.address),
    ).resolves.toBe(false);
  });

  it("rejects every server-mode term and proof mismatch", async () => {
    type Internals = {
      signOperatorVoucher(channelId: string, cumulative: bigint): Promise<unknown>;
      validatePayload(raw: BatchDepositPayload, requirements: PaymentRequirements): Promise<string>;
      validateRequestProof(
        raw: BatchDepositPayload,
        channelId: string,
        mode: "client" | "server",
        authorizedAmount: string,
      ): Promise<void>;
    };
    const api = new BatchServerScheme({ receiverAuthorizer, operator }) as unknown as Internals;
    const channelId = serverDeposit.authorization!.channelId;
    const req = requirements();
    const withExtra = (extra: Record<string, unknown>) => ({
      ...req,
      extra: { ...req.extra, ...extra },
    });

    await expect(
      api.validatePayload(serverDeposit, withExtra({ voucherSigner: "other" })),
    ).rejects.toThrow(BatchError.CHANNEL_STATE);
    await expect(
      api.validatePayload(
        {
          ...serverDeposit,
          channelConfig: { ...serverDeposit.channelConfig, voucherSigner: "client" },
        },
        req,
      ),
    ).rejects.toThrow(BatchError.CHANNEL_STATE);
    await expect(
      api.validatePayload(serverDeposit, withExtra({ operator: feePayer.address })),
    ).rejects.toThrow(BatchError.CHANNEL_STATE);
    await expect(
      api.validatePayload(
        {
          ...serverDeposit,
          channelConfig: { ...serverDeposit.channelConfig, voucherSigner: undefined },
        },
        withExtra({ operator: operator.address, voucherSigner: "client" }),
      ),
    ).rejects.toThrow(BatchError.CHANNEL_STATE);

    await expect(
      api.validateRequestProof(
        { ...serverDeposit, authorization: undefined } as never,
        channelId,
        "server",
        "1000",
      ),
    ).rejects.toThrow(BatchError.VOUCHER_SIGNATURE);
    await expect(
      api.validateRequestProof(
        { ...serverDeposit, voucher: undefined } as never,
        channelId,
        "client",
        "1000",
      ),
    ).rejects.toThrow(BatchError.VOUCHER_SIGNATURE);

    const authorizationCases = [
      { authorization: { ...serverDeposit.authorization!, channelId: feePayer.address } },
      { authorization: { ...serverDeposit.authorization!, payer: feePayer.address } },
      { authorization: { ...serverDeposit.authorization!, requestId: "" } },
      { authorization: { ...serverDeposit.authorization!, authorizedAmount: "999" } },
      { authorization: { ...serverDeposit.authorization!, signature: "bad" } },
    ];
    for (const overrides of authorizationCases) {
      await expect(
        api.validateRequestProof(
          { ...serverDeposit, ...overrides } as never,
          channelId,
          "server",
          "1000",
        ),
      ).rejects.toThrow(BatchError.VOUCHER_SIGNATURE);
    }

    const unsigned = new BatchServerScheme({ receiverAuthorizer }) as unknown as Internals;
    await expect(unsigned.signOperatorVoucher(channelId, 1n)).rejects.toThrow(
      BatchError.VOUCHER_SIGNATURE,
    );
  });

  it("opens and advances a server-signed channel through the server hook lifecycle", async () => {
    const store = new MemoryChannelStore();
    const operationStore = new MemoryBatchOperationStore();
    const server = new BatchServerScheme({
      receiverAuthorizer,
      operator,
      operationStore,
      store,
    });
    const depositPayment: PaymentPayload = {
      accepted: requirements(),
      payload: serverDeposit,
      x402Version: 2,
    };
    const depositContext = {
      declaredExtensions: {},
      paymentPayload: depositPayment,
      requirements: requirements(),
    };
    const verified = await server.schemeHooks.onBeforeVerify!(depositContext);
    expect(verified).toBeUndefined();
    await expect(
      server.schemeHooks.onAfterVerify!({
        ...depositContext,
        result: { isValid: true, payer: payer.address },
      }),
    ).resolves.toBeUndefined();
    await server.schemeHooks.onAfterSettle!({
      ...depositContext,
      phase: "after-handler",
      result: {
        extra: { channelState: { balance: "10000", totalClaimed: "0", withdrawRequestedAt: 0 } },
        network: SOLANA_DEVNET_CAIP2,
        success: true,
        transaction: "open-signature",
      },
    });
    const channelId = serverDeposit.authorization!.channelId;
    expect(await store.get(channelId)).toMatchObject({
      chargedCumulativeAmount: 1_000n,
      signedMaxClaimable: 1_000n,
    });

    const authorizationPayment: PaymentPayload = {
      accepted: requirements(),
      payload: {
        authorization: await authorizationFor("request-2"),
        channelConfig: serverDeposit.channelConfig,
        type: "authorization",
      },
      x402Version: 2,
    };
    const authorizationContext = {
      declaredExtensions: {},
      paymentPayload: authorizationPayment,
      requirements: requirements(),
    };
    const authorizationVerified = await server.schemeHooks.onBeforeVerify!(authorizationContext);
    expect(authorizationVerified).toMatchObject({ skip: true, result: { isValid: true } });
    await server.schemeHooks.onAfterVerify!({
      ...authorizationContext,
      result: (authorizationVerified as { result: { isValid: true; payer: string } }).result,
    });
    const actualSettlement = await server.schemeHooks.onBeforeSettle!({
      ...authorizationContext,
      requirements: { ...authorizationContext.requirements, amount: "400" },
      phase: "after-handler",
    });
    expect(actualSettlement).toMatchObject({
      skip: true,
      result: {
        extra: { chargedAmount: "400", commitmentId: `${channelId}:1400` },
        success: true,
      },
    });
    const receipt = (actualSettlement as { result: { extra: { voucher: BatchVoucher } } }).result
      .extra.voucher;
    expect(
      await verifyVoucherSignature({
        message: encodeVoucherMessageBytes({
          channelId,
          cumulativeAmount: 1_400n,
          expiresAt: 0n,
        }),
        signatureBase58: receipt.signature,
        signerBase58: operator.address,
      }),
    ).toBe(true);
    expect(await store.get(channelId)).toMatchObject({
      chargedCumulativeAmount: 1_400n,
      signedMaxClaimable: 1_400n,
    });
    await expect(operationStore.get(channelId, "request-2")).resolves.toMatchObject({
      actual: 400n,
      cumulative: 1_400n,
      status: "completed",
    });

    const zeroPayment = {
      ...authorizationPayment,
      payload: {
        ...authorizationPayment.payload,
        authorization: await authorizationFor("request-3"),
      },
    } as PaymentPayload;
    const zeroContext = { ...authorizationContext, paymentPayload: zeroPayment };
    const zeroVerified = await server.schemeHooks.onBeforeVerify!(zeroContext);
    await server.schemeHooks.onAfterVerify!({
      ...zeroContext,
      result: (zeroVerified as { result: { isValid: true; payer: string } }).result,
    });
    await expect(
      server.schemeHooks.onBeforeSettle!({
        ...zeroContext,
        requirements: { ...zeroContext.requirements, amount: "0" },
        phase: "after-handler",
      }),
    ).resolves.toMatchObject({
      result: {
        extra: { commitmentId: `${channelId}:1400` },
        success: true,
      },
    });
    expect(await store.get(channelId)).toMatchObject({ chargedCumulativeAmount: 1_400n });
    await expect(operationStore.get(channelId, "request-3")).resolves.toMatchObject({
      actual: 0n,
      cumulative: 1_400n,
      status: "completed",
    });

    const replayPayment = {
      ...authorizationPayment,
      payload: { ...authorizationPayment.payload },
    } as PaymentPayload;
    const replayContext = { ...authorizationContext, paymentPayload: replayPayment };
    await expect(server.schemeHooks.onBeforeVerify!(replayContext)).resolves.toMatchObject({
      skip: true,
    });
    const replayVerified = await server.schemeHooks.onAfterVerify!({
      ...replayContext,
      result: { isValid: true, payer: payer.address },
    });
    expect(replayVerified).toMatchObject({ abort: true, reason: "duplicate_settlement" });
  });

  it("fails verify closed when the store fails before the request is fenced", async () => {
    const channelId = serverDeposit.authorization!.channelId;
    const setup = () => {
      const store = new MemoryChannelStore();
      const operationStore = new MemoryBatchOperationStore();
      const resourceServer = new x402ResourceServer({
        getSupported: async () => ({ kinds: [] }),
        settle: async () => {
          throw new Error("settle must not run");
        },
        verify: async () => ({
          extra: { balance: "10000", channelId, totalClaimed: "0", withdrawRequestedAt: 0 },
          isValid: true,
          payer: payer.address,
        }),
      } as never);
      resourceServer.register(
        SOLANA_DEVNET_CAIP2,
        new BatchServerScheme({ operator, operationStore, receiverAuthorizer, store }),
      );
      const verify = async () =>
        resourceServer.verifyPayment(
          {
            accepted: requirements(),
            payload: {
              authorization: await authorizationFor("request"),
              channelConfig: serverDeposit.channelConfig,
              type: "authorization",
            },
            x402Version: 2,
          },
          requirements(),
        );
      return { operationStore, store, verify };
    };

    // The snapshot write fails before anything is reserved.
    const snapshot = setup();
    vi.spyOn(snapshot.store, "update").mockRejectedValueOnce(new Error("store unavailable"));
    await expect(snapshot.verify()).resolves.toMatchObject({
      invalidMessage: "store unavailable",
      invalidReason: "transaction_failed",
      isValid: false,
    });
    expect(await snapshot.store.get(channelId)).toBeUndefined();
    expect(await snapshot.operationStore.get(channelId, "request")).toBeUndefined();

    // The reservation write fails after the operation is recorded, and its
    // release then rejects or throws synchronously.
    const releaseFailures = [
      () => Promise.reject(new Error("release unavailable")),
      () => {
        throw new Error("release unavailable");
      },
    ];
    for (const failRelease of releaseFailures) {
      const { operationStore, store, verify } = setup();
      const update = store.update.bind(store);
      vi.spyOn(store, "update")
        .mockImplementationOnce(update)
        .mockRejectedValueOnce(new Error("store unavailable"));
      const release = vi.spyOn(operationStore, "release").mockImplementationOnce(failRelease);
      await expect(verify()).resolves.toMatchObject({
        invalidReason: "transaction_failed",
        isValid: false,
      });
      expect(release).toHaveBeenCalledWith(channelId, "request");
      expect((await store.get(channelId))?.reservations ?? {}).toEqual({});
      await expect(operationStore.get(channelId, "request")).resolves.toMatchObject({
        status: "reserved",
      });
    }
  });

  it("reserves concurrent ceilings, completes out of order, and rejects reused ids", async () => {
    const store = new MemoryChannelStore();
    const operationStore = new MemoryBatchOperationStore();
    const server = new BatchServerScheme({ receiverAuthorizer, operator, operationStore, store });
    const openPayment: PaymentPayload = {
      accepted: requirements(),
      payload: serverDeposit,
      x402Version: 2,
    };
    const openContext = {
      declaredExtensions: {},
      paymentPayload: openPayment,
      requirements: requirements(),
    };
    const openVerified = await server.schemeHooks.onBeforeVerify!(openContext);
    expect(openVerified).toBeUndefined();
    await server.schemeHooks.onAfterVerify!({
      ...openContext,
      result: { isValid: true, payer: payer.address },
    });
    await server.schemeHooks.onAfterSettle!({
      ...openContext,
      phase: "after-handler",
      result: {
        extra: { channelState: { balance: "10000", totalClaimed: "0", withdrawRequestedAt: 0 } },
        network: SOLANA_DEVNET_CAIP2,
        success: true,
        transaction: "open-signature",
      },
    });
    const channelId = serverDeposit.authorization!.channelId;
    const ceiling = { ...requirements(), amount: "4000" };
    const payment = async (requestId: string, accepted = ceiling): Promise<PaymentPayload> => ({
      accepted,
      payload: {
        authorization: await authorizationFor(requestId, BigInt(accepted.amount)),
        channelConfig: serverDeposit.channelConfig,
        type: "authorization",
      },
      x402Version: 2,
    });
    const reserve = async (value: PaymentPayload, accepted = ceiling) => {
      const context = { declaredExtensions: {}, paymentPayload: value, requirements: accepted };
      const verified = await server.schemeHooks.onBeforeVerify!(context);
      expect(verified).toMatchObject({ skip: true });
      const result = await server.schemeHooks.onAfterVerify!({
        ...context,
        result: (verified as { result: { isValid: true; payer: string } }).result,
      });
      return { context, result };
    };

    const first = await reserve(await payment("concurrent-1"));
    const second = await reserve(await payment("concurrent-2"));
    expect(Object.values((await store.get(channelId))?.reservations ?? {})).toHaveLength(2);

    const repricedRequirements = { ...requirements(), amount: "100" };
    const repriced = await reserve(
      await payment("concurrent-2", repricedRequirements),
      repricedRequirements,
    );
    expect(repriced.result).toMatchObject({
      abort: true,
      reason: BatchError.OPERATION_CEILING_CHANGED,
    });
    expect(Object.values((await store.get(channelId))?.reservations ?? {})).toHaveLength(2);

    const exhaustedRequirements = { ...requirements(), amount: "2000" };
    const exhaustedPayment = await payment("concurrent-3", exhaustedRequirements);
    const exhausted = await reserve(exhaustedPayment, exhaustedRequirements);
    expect(exhausted.result).toMatchObject({
      abort: true,
      reason: BatchError.CUMULATIVE_EXCEEDS_DEPOSIT,
    });

    const refundPayment: PaymentPayload = {
      accepted: requirements(),
      payload: await buildRefundPayload({
        authorization: await authorizationFor("refund-close", 0n),
        channelConfig: serverDeposit.channelConfig,
        channelId,
        feePayer: feePayer.address,
        payer,
      }),
      x402Version: 2,
    };
    const refundContext = {
      declaredExtensions: {},
      paymentPayload: refundPayment,
      requirements: requirements(),
    };
    const refundVerified = await server.schemeHooks.onBeforeVerify!(refundContext);
    expect(refundVerified).toBeUndefined();
    await expect(
      server.schemeHooks.onAfterVerify!({
        ...refundContext,
        result: {
          extra: {
            balance: "10000",
            channelId,
            totalClaimed: "0",
            withdrawRequestedAt: 0,
          },
          isValid: true,
          payer: payer.address,
        },
      }),
    ).resolves.toMatchObject({ abort: true, reason: "duplicate_settlement" });

    await server.schemeHooks.onVerifiedPaymentCanceled!({
      ...first.context,
      reason: "handler_error",
      settledPhases: [],
    });
    const replacementPayment = await payment("concurrent-4", exhaustedRequirements);
    const third = await reserve(replacementPayment, exhaustedRequirements);
    expect(third.result).toBeUndefined();

    const thirdSettled = await server.schemeHooks.onBeforeSettle!({
      ...third.context,
      requirements: { ...exhaustedRequirements, amount: "500" },
      phase: "after-handler",
    });
    expect(thirdSettled).toMatchObject({
      result: {
        extra: {
          voucher: { maxClaimableAmount: "1500" },
        },
      },
    });
    const secondSettled = await server.schemeHooks.onBeforeSettle!({
      ...second.context,
      requirements: { ...ceiling, amount: "250" },
      phase: "after-handler",
    });
    expect(secondSettled).toMatchObject({
      result: {
        extra: {
          voucher: { maxClaimableAmount: "1750" },
        },
      },
    });
    expect(await store.get(channelId)).toMatchObject({
      chargedCumulativeAmount: 1_750n,
      reservations: {},
    });

    const replay = await reserve(replacementPayment, exhaustedRequirements);
    expect(replay.result).toMatchObject({ abort: true, reason: "duplicate_settlement" });
    const repricedReplay = await reserve(await payment("concurrent-4"));
    expect(repricedReplay.result).toMatchObject({
      abort: true,
      reason: BatchError.OPERATION_CEILING_CHANGED,
    });
  });

  describe("failed charge cleanup", () => {
    for (const scenario of [
      { name: "successful charge control", fault: "none", sibling: false },
      { name: "handler cancellation control", fault: "cancel", sibling: false },
      {
        name: "signer failure releases capacity and permits close verification",
        fault: "signer",
        sibling: false,
      },
      {
        name: "signer failure preserves another request's reservation",
        fault: "signer",
        sibling: true,
      },
      { name: "over-ceiling charge releases its reservation", fault: "limit", sibling: false },
      {
        name: "channel cleanup failure preserves the abort and can be retried",
        fault: "cleanup-update",
        sibling: true,
      },
      {
        name: "operation release failure preserves the abort and can be retried",
        fault: "cleanup-release",
        sibling: true,
      },
      {
        name: "lost write acknowledgement preserves the committed charge and voucher",
        fault: "ambiguous",
        sibling: true,
      },
    ]) {
      it(scenario.name, async () => {
        const network = SOLANA_DEVNET_CAIP2 as Network;
        const channelId = serverDeposit.authorization!.channelId;
        const store = new MemoryChannelStore();
        const operations = new MemoryBatchOperationStore();
        let failSigning = false;
        const signing = {
          address: operator.address,
          signMessages: (...args: Parameters<typeof operator.signMessages>) => {
            if (failSigning) throw new Error("synthetic operator unavailable");
            return operator.signMessages(...args);
          },
        };
        const scheme = new BatchServerScheme({
          operator: signing,
          operationStore: operations,
          receiverAuthorizer,
          store,
        });
        const open = {
          declaredExtensions: {},
          paymentPayload: { accepted: requirements(), payload: serverDeposit, x402Version: 2 },
          requirements: requirements(),
        };
        await scheme.schemeHooks.onBeforeVerify!(open);
        await scheme.schemeHooks.onAfterVerify!({
          ...open,
          result: { isValid: true, payer: payer.address },
        });
        await scheme.schemeHooks.onAfterSettle!({
          ...open,
          phase: "after-handler",
          result: {
            success: true,
            transaction: "synthetic-open",
            network: SOLANA_DEVNET_CAIP2,
            extra: {
              channelState: { balance: "10000", totalClaimed: "0", withdrawRequestedAt: 0 },
            },
          },
        });
        const initial = (await store.get(channelId))!;
        expect(initial.chargedCumulativeAmount).toBe(1000n);
        const facade = {
          getSupported: async () => ({
            extensions: [],
            signers: {},
            kinds: [
              {
                x402Version: 2,
                scheme: "batch-settlement",
                network,
                extra: { feePayer: feePayer.address },
              },
            ],
          }),
          verify: async () => ({
            isValid: true,
            payer: payer.address,
            extra: { channelId, balance: "10000", totalClaimed: "0", withdrawRequestedAt: 0 },
          }),
          settle: vi.fn(async () => {
            throw new Error("unexpected facilitator settlement");
          }),
        };
        const resource = new x402ResourceServer(facade).register(SOLANA_DEVNET_CAIP2, scheme);
        await resource.initialize();
        const recovery = vi.fn(async () => ({
          recovered: true as const,
          result: {
            success: true,
            transaction: "unexpected-recovery",
            network,
          },
        }));
        const cancellations = vi.fn(async () => {});
        resource.onSettleFailure(recovery).onVerifiedPaymentCanceled(cancellations);
        const ceiling = { ...requirements(), amount: "4000" };
        const payment: PaymentPayload = {
          accepted: ceiling,
          x402Version: 2,
          payload: {
            authorization: await authorizationFor("cleanup-paid", 4000n),
            channelConfig: serverDeposit.channelConfig,
            type: "authorization",
          },
        };
        expect((await resource.verifyPayment(payment, ceiling)).isValid).toBe(true);
        const targetId = Object.keys((await store.get(channelId))!.reservations!)[0];
        expect(targetId).toBeDefined();
        let sibling: PaymentPayload | undefined;
        const siblingRequirements = { ...requirements(), amount: "1000" };
        if (scenario.sibling) {
          sibling = {
            accepted: siblingRequirements,
            x402Version: 2,
            payload: {
              authorization: await authorizationFor("cleanup-sibling", 1000n),
              channelConfig: serverDeposit.channelConfig,
              type: "authorization",
            },
          };
          expect((await resource.verifyPayment(sibling, siblingRequirements)).isValid).toBe(true);
        }
        const siblingReservations = Object.fromEntries(
          Object.entries((await store.get(channelId))!.reservations!).filter(
            ([id]) => id !== targetId,
          ),
        );
        const write = store.update.bind(store);
        let committed: Awaited<ReturnType<typeof write>> | undefined;
        let updates = 0;
        const cleanupMessage = `${BatchError.CHANNEL_STATE}: synthetic cleanup unavailable`;
        const update = vi.spyOn(store, "update").mockImplementation(async (...args) => {
          updates++;
          if (scenario.fault === "cleanup-update" && updates === 2) throw new Error(cleanupMessage);
          const next = await write(...args);
          if (scenario.fault === "ambiguous" && updates === 1) {
            committed = structuredClone(next);
            throw new Error("synthetic channel write acknowledgement lost");
          }
          return next;
        });
        if (scenario.fault === "cleanup-release")
          vi.spyOn(operations, "release").mockRejectedValueOnce(new Error(cleanupMessage));
        failSigning = ["signer", "cleanup-update", "cleanup-release"].includes(scenario.fault);
        if (scenario.fault === "cancel") {
          await resource
            .createPaymentCancellationDispatcher(payment, ceiling)
            .cancel({ reason: "handler_failed", responseStatus: 500 });
        } else if (scenario.fault === "none") {
          expect(
            (await resource.settlePayment(payment, { ...ceiling, amount: "400" })).success,
          ).toBe(true);
        } else {
          const message =
            scenario.fault === "limit"
              ? BatchError.CUMULATIVE_AMOUNT_MISMATCH
              : scenario.fault === "ambiguous"
                ? "synthetic channel write acknowledgement lost"
                : "synthetic operator unavailable";
          const settlement = resource.settlePayment(payment, {
            ...ceiling,
            amount: scenario.fault === "limit" ? "5000" : "400",
          });
          await expect(settlement).rejects.toMatchObject({
            errorReason:
              scenario.fault === "limit"
                ? BatchError.CUMULATIVE_AMOUNT_MISMATCH
                : "transaction_failed",
            errorMessage: expect.stringContaining(message),
          });
          if (scenario.fault.startsWith("cleanup-")) {
            await expect(settlement).rejects.toMatchObject({
              errorMessage: `${message}; reservation cleanup failed: ${cleanupMessage}`,
            });
            const afterFailure = (await store.get(channelId))!;
            expect(Boolean(afterFailure.reservations![targetId])).toBe(
              scenario.fault === "cleanup-update",
            );
            const cancellation = {
              declaredExtensions: {},
              paymentPayload: payment,
              requirements: ceiling,
              phase: "cancel" as const,
              reason: "handler_failed" as const,
              settledPhases: [],
            };
            await scheme.schemeHooks.onVerifiedPaymentCanceled!(cancellation);
            const calls = update.mock.calls.length;
            await scheme.schemeHooks.onVerifiedPaymentCanceled!(cancellation);
            expect(update).toHaveBeenCalledTimes(calls);
          }
        }
        const state = (await store.get(channelId))!;
        expect(state.reservations).toEqual(siblingReservations);
        const charged = scenario.fault === "none" || scenario.fault === "ambiguous";
        expect(state.chargedCumulativeAmount).toBe(charged ? 1400n : 1000n);
        if (scenario.fault === "ambiguous") {
          expect(committed).toBeDefined();
          expect(state).toEqual(committed);
        } else if (!charged) {
          expect(state.signedMaxClaimable).toBe(initial.signedMaxClaimable);
          expect(state.highestVoucherSignature).toBe(initial.highestVoucherSignature);
        }
        expect((await operations.get(channelId, "cleanup-paid"))!.status).toBe(
          charged ? "completed" : "reserved",
        );
        expect(recovery).not.toHaveBeenCalled();
        expect(facade.settle).not.toHaveBeenCalled();
        expect(cancellations).toHaveBeenCalledTimes(scenario.fault === "cancel" ? 1 : 0);
        expect(
          await resource.verifyPayment({ ...payment, payload: { ...payment.payload } }, ceiling),
        ).toMatchObject({ isValid: false, invalidReason: "duplicate_settlement" });
        const close: PaymentPayload = {
          accepted: requirements(),
          x402Version: 2,
          payload: await buildRefundPayload({
            authorization: await authorizationFor("cleanup-close", 0n),
            channelConfig: serverDeposit.channelConfig,
            channelId,
            feePayer: feePayer.address,
            payer,
          }),
        };
        if (sibling) {
          const busyClose = {
            ...close,
            payload: {
              ...close.payload,
              authorization: await authorizationFor("cleanup-close-busy", 0n),
            },
          };
          expect((await resource.verifyPayment(busyClose, requirements())).isValid).toBe(false);
          await resource
            .createPaymentCancellationDispatcher(sibling, siblingRequirements)
            .cancel({ reason: "handler_failed" });
        }
        expect((await resource.verifyPayment(close, requirements())).isValid).toBe(true);
      });
    }
  });

  it("enriches server-mode refunds with the stored operator voucher", async () => {
    const store = new MemoryChannelStore();
    const server = new BatchServerScheme({ operator, receiverAuthorizer, store });
    const channelId = serverDeposit.authorization!.channelId;
    await store.put({
      channelConfig: serverDeposit.channelConfig,
      channelId,
      chargedCumulativeAmount: 2_000n,
      deposit: 10_000n,
      feePayer: feePayer.address,
      highestVoucherExpiresAt: 0,
      highestVoucherSignature: "stored-operator-sig",
      mint: USDC_DEVNET_ADDRESS,
      onchainSyncedAt: Date.now(),
      openSlot: BigInt(serverDeposit.channelConfig.openSlot),
      payer: payer.address,
      payerAuthorizer: operator.address,
      payoutWatermark: 0n,
      receiver: serverDeposit.channelConfig.receiver,
      reservations: {},
      salt: BigInt(serverDeposit.channelConfig.salt),
      settled: 0n,
      signedMaxClaimable: 2_000n,
      status: "open",
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      withdrawDelay: serverDeposit.channelConfig.withdrawDelay,
    });
    const refund = await buildRefundPayload({
      authorization: await authorizationFor("refund-enrich", 0n),
      channelConfig: serverDeposit.channelConfig,
      channelId,
      feePayer: feePayer.address,
      payer,
    });
    const payment: PaymentPayload = {
      accepted: requirements(),
      payload: refund,
      x402Version: 2,
    };
    const ctx = { declaredExtensions: {}, paymentPayload: payment, requirements: requirements() };
    await server.schemeHooks.onBeforeVerify!(ctx);
    await server.schemeHooks.onAfterVerify!({
      ...ctx,
      result: { isValid: true, payer: payer.address },
    });
    const enriched = await server.enrichSettlementPayload(ctx as never);
    expect(enriched).toMatchObject({
      closeAuthorization: expect.anything(),
      voucher: {
        channelId,
        maxClaimableAmount: "2000",
        signature: "stored-operator-sig",
      },
    });
  });
});
