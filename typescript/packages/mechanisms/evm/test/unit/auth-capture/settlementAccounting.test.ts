import { describe, it, expect, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { zeroAddress } from "viem";
import { x402ResourceServer, type FacilitatorClient, type SettlePhase } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { AuthCaptureEvmScheme as ClientScheme } from "../../../src/auth-capture/client/scheme";
import { AuthCaptureEvmScheme as ServerScheme } from "../../../src/auth-capture/server/scheme";
import { AuthCaptureEvmScheme as FacilitatorScheme } from "../../../src/auth-capture/facilitator/scheme";
import { InMemoryAuthorizedPaymentStorage } from "../../../src/auth-capture/server/storage";
import type { FacilitatorEvmSigner } from "../../../src/signer";

const payer = privateKeyToAccount(`0x${"11".repeat(32)}`);
const authorizer = privateKeyToAccount(`0x${"22".repeat(32)}`);
const operator = "0x1234567890123456789012345678901234567890";
const asset = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const tx = `0x${"ab".repeat(32)}` as const;

async function createScenario(
  assetTransferMethod: "eip3009" | "permit2" = "eip3009",
  captureMode: "sync" | "deferred" = "sync",
) {
  const now = Math.floor(Date.now() / 1000);
  const requirements: PaymentRequirements = {
    scheme: "auth-capture",
    network: "eip155:84532",
    amount: "1000000",
    asset,
    payTo: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    maxTimeoutSeconds: 300,
    extra: {
      name: "USDC",
      version: "2",
      assetTransferMethod,
      paymentFlow: "escrow",
      captureMode,
      captureAuthorizer: operator,
      receiverAuthorizer: authorizer.address,
      captureDeadline: now + 86400,
      refundDeadline: now + 172800,
      feeRecipient: zeroAddress,
      minFeeBps: 0,
      maxFeeBps: 0,
    },
  };
  const created = await new ClientScheme(payer).createPaymentPayload(2, requirements);
  const payment: PaymentPayload = { ...created, accepted: requirements };
  const storage = new InMemoryAuthorizedPaymentStorage();
  const scheme = new ServerScheme({ storage, receiverAuthorizerSigner: authorizer });
  const chain = { hasCollectedPayment: true, capturableAmount: 1000000n, refundableAmount: 0n };
  const calls: string[] = [];
  const rpcSigner = {
    getAddresses: () => [operator],
    getCode: vi.fn(async () => "0x"),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "paymentState") return { ...chain };
      if (["capture", "void", "refund"].includes(functionName)) return;
      throw new Error(`Unexpected read: ${functionName}`);
    }),
    writeContract: vi.fn(
      async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
        calls.push(functionName);
        if (functionName === "capture") {
          const captured = BigInt(args[1] as bigint);
          chain.capturableAmount -= captured;
          chain.refundableAmount += captured;
        } else if (functionName === "void") {
          chain.capturableAmount = 0n;
        } else if (functionName === "refund") {
          chain.refundableAmount -= BigInt(args[1] as bigint);
        }
        return tx;
      },
    ),
    waitForTransactionReceipt: vi.fn(async () => ({ status: "success", logs: [] })),
  } as unknown as FacilitatorEvmSigner;
  const actualFacilitator = new FacilitatorScheme(rpcSigner, { refundFunding: true });
  const settle = vi.fn<FacilitatorClient["settle"]>((payload, req) => {
    // The initial authorization is a fixture; lifecycle calls use the real facilitator.
    if (!("type" in payload.payload)) {
      return Promise.resolve({
        success: true,
        transaction: tx,
        network: req.network,
        payer: payer.address,
        amount: "1000000",
      });
    }
    return actualFacilitator.settle(payload, req);
  });
  const facilitator: FacilitatorClient = {
    getSupported: async () => ({ kinds: [], extensions: [], signers: {} }),
    verify: (payload, req) => actualFacilitator.verify(payload, req),
    settle,
  };
  const server = new x402ResourceServer(facilitator).register(requirements.network, scheme);
  const authorized = await server.settlePayment(
    payment,
    requirements,
    {},
    undefined,
    undefined,
    "before-handler",
  );
  expect(authorized.success).toBe(true);
  const record = async () => (await storage.list())[0]!;
  const finalize = (phase: SettlePhase, amount?: string) =>
    server.settlePayment(
      payment,
      requirements,
      {},
      undefined,
      amount === undefined ? undefined : { amount },
      phase,
    );
  return {
    payment,
    chain,
    calls,
    settle,
    record,
    finalize,
    lifecycle: scheme.createLifecycleManager(facilitator),
  };
}

describe.each(["eip3009", "permit2"] as const)("%s escrow settlement accounting", method => {
  it.each(["1000000", "400000"])("records a synchronous capture of %s", async amount => {
    const scenario = await createScenario(method);
    const result = await scenario.finalize("after-handler", amount);

    expect(result).toMatchObject({ success: true, amount });
    expect(scenario.chain).toMatchObject({
      capturableAmount: 0n,
      refundableAmount: BigInt(amount),
    });
    expect(await scenario.record()).toMatchObject({
      capturableAmount: "0",
      refundableAmount: amount,
    });
    expect(scenario.payment.payload).not.toHaveProperty("type");
    expect(scenario.payment.payload).not.toHaveProperty("paymentInfo");
    expect(scenario.calls).toEqual(amount === "1000000" ? ["capture"] : ["capture", "void"]);
  });

  it("refunds a completed synchronous capture from the stored payment", async () => {
    const scenario = await createScenario(method);
    expect(await scenario.finalize("after-handler")).toMatchObject({ success: true });

    const { paymentInfoHash } = await scenario.record();
    const refund = await scenario.lifecycle.refund(paymentInfoHash, { amount: "100000" });

    expect(refund).toMatchObject({ success: true, amount: "100000" });
    expect(scenario.chain.refundableAmount).toBe(900000n);
    expect(await scenario.record()).toMatchObject({
      capturableAmount: "0",
      refundableAmount: "900000",
    });
    expect(scenario.calls).toEqual(["capture", "refund"]);
  });

  it("records a cancel-phase void using the original collect payload", async () => {
    const scenario = await createScenario(method);
    expect(await scenario.finalize("cancel")).toMatchObject({ success: true });

    expect(scenario.chain.capturableAmount).toBe(0n);
    expect(await scenario.record()).toMatchObject({ capturableAmount: "0", refundableAmount: "0" });
    expect(scenario.calls).toEqual(["void"]);
  });
});

it.each(["after-handler", "cancel"] as const)(
  "does not account for a failed %s settle",
  async phase => {
    const scenario = await createScenario();
    scenario.settle.mockResolvedValueOnce({
      success: false,
      transaction: "",
      network: "eip155:84532",
      errorReason: "settlement_failed",
    });

    expect(await scenario.finalize(phase)).toMatchObject({ success: false });
    expect(await scenario.record()).toMatchObject({
      capturableAmount: "1000000",
      refundableAmount: "0",
    });
  },
);

it("leaves a deferred hold available to the lifecycle manager", async () => {
  const scenario = await createScenario("eip3009", "deferred");
  expect(await scenario.finalize("after-handler")).toMatchObject({ success: true });
  expect(scenario.calls).toEqual([]);
  expect(await scenario.record()).toMatchObject({
    capturableAmount: "1000000",
    refundableAmount: "0",
  });

  const { paymentInfoHash } = await scenario.record();
  expect(await scenario.lifecycle.capture(paymentInfoHash)).toMatchObject({ success: true });
  expect(await scenario.record()).toMatchObject({
    capturableAmount: "0",
    refundableAmount: "1000000",
  });
});
