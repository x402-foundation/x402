import { describe, it, expect, vi } from "vitest";
import { zeroAddress } from "viem";
import { AuthCaptureSettlementHooks } from "../../../src/auth-capture/server/settlementHooks";
import { InMemoryAuthorizedPaymentStorage } from "../../../src/auth-capture/server/storage";
import {
  AUTH_CAPTURE_ESCROW_ADDRESS,
  EIP3009_TOKEN_COLLECTOR_ADDRESS,
  PERMIT2_TOKEN_COLLECTOR_ADDRESS,
} from "../../../src/auth-capture/constants";
import { computePaymentInfoHash } from "../../../src/auth-capture/nonce";
import type { PaymentInfoStruct } from "../../../src/auth-capture/types";

const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const FUTURE = Math.floor(Date.now() / 1000) + 86400;

function escrowExtra(overrides: Record<string, unknown> = {}) {
  return {
    captureAuthorizer: "0x1234567890123456789012345678901234567890",
    captureDeadline: FUTURE,
    refundDeadline: FUTURE + 86400,
    feeRecipient: "0x0000000000000000000000000000000000000000",
    minFeeBps: 0,
    maxFeeBps: 0,
    name: "USDC",
    version: "2",
    paymentFlow: "escrow" as const,
    captureMode: "sync" as const,
    receiverAuthorizer: "0x1111111111111111111111111111111111111111",
    ...overrides,
  };
}

function collectPayload() {
  return {
    authorization: {
      from: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      to: EIP3009_TOKEN_COLLECTOR_ADDRESS,
      value: "1000000",
      validAfter: "0",
      validBefore: String(FUTURE),
      nonce: "0x" + "33".repeat(32),
    },
    signature: "0xabcd",
    salt: "0x" + "44".repeat(32),
    saltNonce: "0x" + "22".repeat(32),
  };
}

describe("AuthCaptureSettlementHooks", () => {
  const authorizerSigner = {
    address: "0x1111111111111111111111111111111111111111" as `0x${string}`,
    signTypedData: vi.fn().mockResolvedValue("0xsig" as `0x${string}`),
  };

  it("does not enrich when no receiver-authorizer signer is configured", async () => {
    const hooks = new AuthCaptureSettlementHooks({
      storage: new InMemoryAuthorizedPaymentStorage(),
    });
    const requirements = {
      scheme: "auth-capture",
      network: "eip155:84532" as const,
      amount: "1000000",
      asset: BASE_SEPOLIA_USDC,
      payTo: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      maxTimeoutSeconds: 300,
      extra: escrowExtra(),
    };
    expect(
      await hooks.enrichSettlementPayload({
        phase: "after-handler",
        paymentPayload: { payload: collectPayload() },
        requirements,
        declaredExtensions: {},
      } as never),
    ).toBeUndefined();
  });

  it("does not enrich before-handler or when extra is invalid", async () => {
    const hooks = new AuthCaptureSettlementHooks({
      storage: new InMemoryAuthorizedPaymentStorage(),
      receiverAuthorizerSigner: authorizerSigner,
    });
    const requirements = {
      scheme: "auth-capture",
      network: "eip155:84532" as const,
      amount: "1",
      asset: BASE_SEPOLIA_USDC,
      payTo: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      maxTimeoutSeconds: 60,
      extra: { bad: true },
    };
    expect(
      await hooks.enrichSettlementPayload({
        phase: "before-handler",
        paymentPayload: { payload: collectPayload() },
        requirements,
        declaredExtensions: {},
      } as never),
    ).toBeUndefined();
    expect(
      await hooks.enrichSettlementPayload({
        phase: "after-handler",
        paymentPayload: { payload: collectPayload() },
        requirements,
        declaredExtensions: {},
      } as never),
    ).toBeUndefined();
  });

  it("returns void enrichment on cancel for escrow holds", async () => {
    const hooks = new AuthCaptureSettlementHooks({
      storage: new InMemoryAuthorizedPaymentStorage(),
      receiverAuthorizerSigner: authorizerSigner,
    });
    const extra = escrowExtra();
    const requirements = {
      scheme: "auth-capture",
      network: "eip155:84532" as const,
      amount: "1000000",
      asset: BASE_SEPOLIA_USDC,
      payTo: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      maxTimeoutSeconds: 300,
      extra,
    };
    const enrichment = await hooks.enrichSettlementPayload({
      phase: "cancel",
      paymentPayload: { payload: collectPayload() },
      requirements,
      declaredExtensions: {},
    } as never);
    expect(enrichment).toMatchObject({ type: "void", authorizerSignature: "0xsig" });
  });

  it("ignores cancel enrichment for authorization flow", async () => {
    const hooks = new AuthCaptureSettlementHooks({
      storage: new InMemoryAuthorizedPaymentStorage(),
      receiverAuthorizerSigner: authorizerSigner,
    });
    const requirements = {
      scheme: "auth-capture",
      network: "eip155:84532" as const,
      amount: "1000000",
      asset: BASE_SEPOLIA_USDC,
      payTo: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      maxTimeoutSeconds: 300,
      extra: escrowExtra({
        paymentFlow: "authorization",
        receiverAuthorizer: authorizerSigner.address,
      }),
    };
    expect(
      await hooks.enrichSettlementPayload({
        phase: "cancel",
        paymentPayload: { payload: collectPayload() },
        requirements,
        declaredExtensions: {},
      } as never),
    ).toBeUndefined();
  });

  it("does not enrich sync capture on deferred escrow after-handler", async () => {
    const hooks = new AuthCaptureSettlementHooks({
      storage: new InMemoryAuthorizedPaymentStorage(),
      receiverAuthorizerSigner: authorizerSigner,
    });
    const requirements = {
      scheme: "auth-capture",
      network: "eip155:84532" as const,
      amount: "1000000",
      asset: BASE_SEPOLIA_USDC,
      payTo: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      maxTimeoutSeconds: 300,
      extra: escrowExtra({
        captureMode: "deferred",
        receiverAuthorizer: "0x0000000000000000000000000000000000000000",
      }),
    };
    expect(
      await hooks.enrichSettlementPayload({
        phase: "after-handler",
        paymentPayload: { payload: collectPayload() },
        requirements,
        declaredExtensions: {},
      } as never),
    ).toBeUndefined();
  });

  it("enriches bound authorization routes with charge completion fields", async () => {
    const hooks = new AuthCaptureSettlementHooks({
      storage: new InMemoryAuthorizedPaymentStorage(),
      receiverAuthorizerSigner: authorizerSigner,
    });
    const requirements = {
      scheme: "auth-capture",
      network: "eip155:84532" as const,
      amount: "1000000",
      asset: BASE_SEPOLIA_USDC,
      payTo: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      maxTimeoutSeconds: 300,
      extra: escrowExtra({
        paymentFlow: "authorization",
        receiverAuthorizer: authorizerSigner.address,
      }),
    };
    const enrichment = await hooks.enrichSettlementPayload({
      phase: "after-handler",
      paymentPayload: { payload: collectPayload() },
      requirements,
      declaredExtensions: {},
    } as never);
    expect(enrichment).toMatchObject({
      amount: "1000000",
      authorizerSignature: "0xsig",
    });
  });

  it("settleOnCancel returns nothing when receiver authorizer is unset", async () => {
    const hooks = new AuthCaptureSettlementHooks({
      storage: new InMemoryAuthorizedPaymentStorage(),
      receiverAuthorizerSigner: authorizerSigner,
    });
    const requirements = {
      scheme: "auth-capture",
      network: "eip155:84532" as const,
      amount: "1",
      asset: BASE_SEPOLIA_USDC,
      payTo: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      maxTimeoutSeconds: 60,
      extra: escrowExtra({ receiverAuthorizer: zeroAddress }),
    };
    expect(
      await hooks.settleOnCancel({
        requirements,
        paymentPayload: { payload: collectPayload() },
      } as never),
    ).toBeUndefined();
  });

  it("settleOnCancel returns nothing without a configured signer", async () => {
    const hooks = new AuthCaptureSettlementHooks({
      storage: new InMemoryAuthorizedPaymentStorage(),
    });
    const requirements = {
      scheme: "auth-capture",
      network: "eip155:84532" as const,
      amount: "1",
      asset: BASE_SEPOLIA_USDC,
      payTo: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      maxTimeoutSeconds: 60,
      extra: escrowExtra(),
    };
    expect(
      await hooks.settleOnCancel({
        requirements,
        paymentPayload: { payload: collectPayload() },
      } as never),
    ).toBeUndefined();
  });

  it("settleOnCancel only returns requirements for escrow with receiver authorizer", async () => {
    const hooks = new AuthCaptureSettlementHooks({
      storage: new InMemoryAuthorizedPaymentStorage(),
      receiverAuthorizerSigner: authorizerSigner,
    });
    const requirements = {
      scheme: "auth-capture",
      network: "eip155:84532" as const,
      amount: "1",
      asset: BASE_SEPOLIA_USDC,
      payTo: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      maxTimeoutSeconds: 60,
      extra: escrowExtra(),
    };
    expect(
      await hooks.settleOnCancel({
        requirements,
        paymentPayload: { payload: collectPayload() },
      } as never),
    ).toEqual(requirements);
    expect(
      await hooks.settleOnCancel({
        requirements: {
          ...requirements,
          extra: escrowExtra({
            paymentFlow: "authorization",
            receiverAuthorizer: authorizerSigner.address,
          }),
        },
        paymentPayload: { payload: collectPayload() },
      } as never),
    ).toBeUndefined();
  });

  it("skips deferred after-handler settle when authorize receipt was stored", async () => {
    const storage = new InMemoryAuthorizedPaymentStorage();
    const hooks = new AuthCaptureSettlementHooks({
      storage,
      receiverAuthorizerSigner: authorizerSigner,
    });
    const extra = escrowExtra({
      captureMode: "deferred",
      receiverAuthorizer: "0x0000000000000000000000000000000000000000",
    });
    const requirements = {
      scheme: "auth-capture",
      network: "eip155:84532" as const,
      amount: "1000000",
      asset: BASE_SEPOLIA_USDC,
      payTo: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      maxTimeoutSeconds: 300,
      extra,
    };
    const paymentPayload = { payload: collectPayload() };
    const authorizeResult = {
      success: true,
      transaction: "0xauthorize",
      network: "eip155:84532",
      payer: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    await hooks.handleAfterSettle({
      phase: "before-handler",
      paymentPayload,
      requirements,
      declaredExtensions: {},
      result: authorizeResult,
    } as never);
    const skip = await hooks.handleBeforeSettle({
      phase: "after-handler",
      paymentPayload,
      requirements,
      declaredExtensions: {},
    } as never);
    expect(skip).toEqual({ skip: true, result: authorizeResult });
  });

  it("uses stored capturable balance when enriching sync capture", async () => {
    const storage = new InMemoryAuthorizedPaymentStorage();
    const hooks = new AuthCaptureSettlementHooks({
      storage,
      receiverAuthorizerSigner: authorizerSigner,
    });
    const extra = escrowExtra();
    const requirements = {
      scheme: "auth-capture",
      network: "eip155:84532" as const,
      amount: "500000",
      asset: BASE_SEPOLIA_USDC,
      payTo: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      maxTimeoutSeconds: 300,
      extra,
    };
    const collect = collectPayload();
    await hooks.handleAfterSettle({
      phase: "before-handler",
      paymentPayload: { payload: collect },
      requirements,
      declaredExtensions: {},
      result: {
        success: true,
        transaction: "0xauth",
        network: "eip155:84532",
        payer: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    } as never);
    const [stored] = await storage.list();
    await storage.update(stored!.paymentInfoHash, current => ({
      ...current!,
      capturableAmount: "750000",
      refundableAmount: "250000",
    }));

    const enrichment = await hooks.enrichSettlementPayload({
      phase: "after-handler",
      paymentPayload: { payload: collect },
      requirements,
      declaredExtensions: {},
    } as never);
    expect(enrichment).toMatchObject({
      type: "capture",
      amount: "500000",
      expectedCapturableAmount: "750000",
      expectedRefundableAmount: "250000",
    });
  });

  it("persists charge results with refundable balance for authorization flow", async () => {
    const storage = new InMemoryAuthorizedPaymentStorage();
    const hooks = new AuthCaptureSettlementHooks({
      storage,
      receiverAuthorizerSigner: authorizerSigner,
    });
    const requirements = {
      scheme: "auth-capture",
      network: "eip155:84532" as const,
      amount: "1000000",
      asset: BASE_SEPOLIA_USDC,
      payTo: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      maxTimeoutSeconds: 300,
      extra: escrowExtra({
        paymentFlow: "authorization",
        receiverAuthorizer: authorizerSigner.address,
        assetTransferMethod: "permit2",
      }),
    };
    const collect = {
      permit2Authorization: {
        from: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        permitted: { token: BASE_SEPOLIA_USDC, amount: "1000000" },
        spender: PERMIT2_TOKEN_COLLECTOR_ADDRESS,
        nonce: "99",
        deadline: String(FUTURE),
      },
      signature: "0xabcd",
      salt: "0x" + "44".repeat(32),
    };
    await hooks.handleAfterSettle({
      phase: "after-handler",
      paymentPayload: { payload: collect },
      requirements,
      declaredExtensions: {},
      result: {
        success: true,
        transaction: "0xcharge",
        network: "eip155:84532",
        payer: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        amount: "1000000",
      },
    } as never);
    const [stored] = await storage.list();
    expect(stored?.capturableAmount).toBe("0");
    expect(stored?.refundableAmount).toBe("1000000");
    expect(stored?.assetTransferMethod).toBe("permit2");
  });

  it("updates capturable balances after sync capture settle", async () => {
    const storage = new InMemoryAuthorizedPaymentStorage();
    const hooks = new AuthCaptureSettlementHooks({
      storage,
      receiverAuthorizerSigner: authorizerSigner,
    });
    const extra = escrowExtra();
    const requirements = {
      scheme: "auth-capture",
      network: "eip155:84532" as const,
      amount: "1000000",
      asset: BASE_SEPOLIA_USDC,
      payTo: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      maxTimeoutSeconds: 300,
      extra,
    };
    const collect = collectPayload();
    await hooks.handleAfterSettle({
      phase: "before-handler",
      paymentPayload: { payload: collect },
      requirements,
      declaredExtensions: {},
      result: {
        success: true,
        transaction: "0xauth",
        network: "eip155:84532",
        payer: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    } as never);

    const [stored] = await storage.list();
    const hash = stored!.paymentInfoHash;
    const paymentInfo = stored!.paymentInfo;
    await hooks.handleAfterSettle({
      phase: "after-handler",
      paymentPayload: {
        payload: {
          type: "capture",
          paymentInfo,
          amount: "400000",
        },
      },
      requirements,
      declaredExtensions: {},
      result: {
        success: true,
        transaction: "0xcapture",
        network: "eip155:84532",
        payer: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        amount: "400000",
      },
    } as never);

    const updated = await storage.get(hash);
    expect(updated?.capturableAmount).toBe("600000");
    expect(updated?.refundableAmount).toBe("400000");
  });

  it("does not persist storage when authorize settle fails", async () => {
    const storage = new InMemoryAuthorizedPaymentStorage();
    const hooks = new AuthCaptureSettlementHooks({
      storage,
      receiverAuthorizerSigner: authorizerSigner,
    });
    const extra = escrowExtra();
    const requirements = {
      scheme: "auth-capture",
      network: "eip155:84532" as const,
      amount: "1000000",
      asset: BASE_SEPOLIA_USDC,
      payTo: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      maxTimeoutSeconds: 300,
      extra,
    };
    await hooks.handleAfterSettle({
      phase: "before-handler",
      paymentPayload: { payload: collectPayload() },
      requirements,
      declaredExtensions: {},
      result: { success: false, transaction: "", network: "eip155:84532", payer: "0x0" },
    } as never);
    expect(await storage.list()).toHaveLength(0);
  });

  it("zeros capturable on successful cancel void settle", async () => {
    const storage = new InMemoryAuthorizedPaymentStorage();
    const hooks = new AuthCaptureSettlementHooks({
      storage,
      receiverAuthorizerSigner: authorizerSigner,
    });
    const extra = escrowExtra();
    const paymentInfo: PaymentInfoStruct = {
      operator: extra.captureAuthorizer,
      payer: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      receiver: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      token: BASE_SEPOLIA_USDC,
      maxAmount: "1000000",
      preApprovalExpiry: FUTURE - 60,
      authorizationExpiry: FUTURE,
      refundExpiry: FUTURE + 86400,
      minFeeBps: 0,
      maxFeeBps: 0,
      feeReceiver: extra.feeRecipient,
      salt: collectPayload().salt,
    };
    const hash = computePaymentInfoHash(84532, paymentInfo, AUTH_CAPTURE_ESCROW_ADDRESS);
    await storage.update(hash, () => ({
      paymentInfoHash: hash,
      paymentInfo,
      receiverAuthorizer: extra.receiverAuthorizer as `0x${string}`,
      policy: "0x0000000000000000000000000000000000000000",
      network: "eip155:84532",
      capturableAmount: "1000000",
      refundableAmount: "0",
      collectTransaction: "0xauth",
      createdAt: Date.now(),
      name: "USDC",
      version: "2",
      paymentFlow: "escrow",
      operatorType: "delegated",
      assetTransferMethod: "eip3009",
      authCaptureEscrow: AUTH_CAPTURE_ESCROW_ADDRESS,
    }));

    await hooks.handleAfterSettle({
      phase: "cancel",
      paymentPayload: { payload: { type: "void", paymentInfo } },
      requirements: {
        scheme: "auth-capture",
        network: "eip155:84532",
        amount: "1",
        asset: BASE_SEPOLIA_USDC,
        payTo: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        maxTimeoutSeconds: 60,
        extra,
      },
      declaredExtensions: {},
      result: {
        success: true,
        transaction: "0xvoid",
        network: "eip155:84532",
        payer: paymentInfo.payer,
      },
    } as never);

    expect((await storage.get(hash))?.capturableAmount).toBe("0");
  });
});
