import { generateKeyPairSigner } from "@solana/kit";
import type { PaymentRequirements } from "@x402/core/types";
import { beforeAll, describe, expect, it } from "vitest";

import {
  encodeBatchAuthorizationMessage,
  signBatchAuthorization,
} from "../../src/batch-settlement/authorization";
import { buildDepositPayload } from "../../src/batch-settlement/client/channel";
import { BatchError } from "../../src/batch-settlement/errors";
import {
  assertServerModeProof,
  assertServerModeRefundProof,
  voucherSignerFor,
} from "../../src/batch-settlement/facilitator/voucherMode";
import type { BatchChannelConfig, BatchRefundPayload } from "../../src/batch-settlement/types";
import { SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS } from "../../src/constants";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";

let payer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let operator: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let feePayer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let receiverAuthorizer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let channelId: string;
let clientConfig: BatchChannelConfig;
let serverConfig: BatchChannelConfig;

beforeAll(async () => {
  payer = await generateKeyPairSigner();
  operator = await generateKeyPairSigner();
  feePayer = await generateKeyPairSigner();
  receiverAuthorizer = await generateKeyPairSigner();
  const built = await buildDepositPayload({
    blockhash: { blockhash: USDC_MAINNET_ADDRESS, lastValidBlockHeight: 1n },
    depositAmount: 10_000n,
    feePayer: feePayer.address,
    firstCharge: 1_000n,
    mint: USDC_DEVNET_ADDRESS,
    openSlot: 77n,
    payer,
    receiver: USDC_MAINNET_ADDRESS,
    receiverAuthorizer: receiverAuthorizer.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    withdrawDelay: 900,
  });
  channelId = built.channelId;
  clientConfig = built.payload.channelConfig;
  serverConfig = {
    ...clientConfig,
    payerAuthorizer: operator.address,
    voucherSigner: "server",
  };
});

function requirements(extra: Record<string, unknown> = {}): PaymentRequirements {
  return {
    amount: "1000",
    asset: USDC_DEVNET_ADDRESS,
    extra: {
      feePayer: feePayer.address,
      receiverAuthorizer: receiverAuthorizer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      withdrawDelay: 900,
      ...extra,
    },
    maxTimeoutSeconds: 300,
    network: SOLANA_DEVNET_CAIP2,
    payTo: USDC_MAINNET_ADDRESS,
    scheme: "batch-settlement",
  };
}

describe("batch facilitator voucher mode", () => {
  it("follows channel config when terms are payload-bound", () => {
    expect(voucherSignerFor(clientConfig, {}, "payload")).toBe("client");
    expect(voucherSignerFor(serverConfig, { operator: operator.address }, "payload")).toBe(
      "server",
    );
    expect(() => voucherSignerFor(serverConfig, {}, "payload")).toThrow(BatchError.CHANNEL_STATE);
    expect(() =>
      voucherSignerFor({ ...clientConfig, voucherSigner: "bogus" as "client" }, {}, "payload"),
    ).toThrow(BatchError.CHANNEL_STATE);
  });

  it("matches requirements extra to channel config when requirements-bound", () => {
    expect(voucherSignerFor(clientConfig, { voucherSigner: "client" }, "requirements")).toBe(
      "client",
    );
    expect(
      voucherSignerFor(
        serverConfig,
        { operator: operator.address, voucherSigner: "server" },
        "requirements",
      ),
    ).toBe("server");
    expect(() =>
      voucherSignerFor(
        serverConfig,
        { operator: feePayer.address, voucherSigner: "server" },
        "requirements",
      ),
    ).toThrow(BatchError.CHANNEL_STATE);
    expect(() =>
      voucherSignerFor(
        clientConfig,
        { operator: operator.address, voucherSigner: "client" },
        "requirements",
      ),
    ).toThrow(BatchError.CHANNEL_STATE);
    expect(() =>
      voucherSignerFor(
        serverConfig,
        { operator: operator.address, voucherSigner: "client" },
        "requirements",
      ),
    ).toThrow(BatchError.CHANNEL_STATE);
    expect(() =>
      voucherSignerFor(clientConfig, { voucherSigner: "bogus" }, "requirements"),
    ).toThrow(BatchError.CHANNEL_STATE);
  });

  it("accepts a valid server-mode payer proof at verify and settle ceilings", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 600;
    const authorization = await signBatchAuthorization(
      payer,
      channelId,
      operator.address,
      "request-1",
      1_000n,
      expiresAt,
    );
    const deposit = {
      authorization,
      channelConfig: serverConfig,
      deposit: { amount: "10000", transaction: "setup" },
      type: "deposit" as const,
    };
    const req = requirements({ operator: operator.address, voucherSigner: "server" });

    await expect(assertServerModeProof(deposit, channelId, req, "exact")).resolves.toBeUndefined();
    await expect(
      assertServerModeProof(deposit, channelId, { ...req, amount: "500" }, "ceiling"),
    ).resolves.toBeUndefined();
    await expect(
      assertServerModeProof(deposit, channelId, { ...req, amount: "500" }, "exact"),
    ).rejects.toThrow(/invalid payer proof/);
    await expect(
      assertServerModeProof(
        { ...deposit, authorization: { ...authorization, requestId: "" } },
        channelId,
        req,
      ),
    ).rejects.toThrow(/invalid payer proof/);
    await expect(
      assertServerModeProof({ ...deposit, authorization: undefined }, channelId, req),
    ).rejects.toThrow(/payer proof missing/);
  });

  it("accepts only a zero-amount authorization for server-mode cooperative refund", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 600;
    const closeProof = await signBatchAuthorization(
      payer,
      channelId,
      operator.address,
      "close-1",
      0n,
      expiresAt,
    );
    const refund: BatchRefundPayload = {
      authorization: closeProof,
      channelConfig: serverConfig,
      type: "refund",
    };
    await expect(assertServerModeRefundProof(refund, channelId)).resolves.toBeUndefined();

    const withVoucher = {
      ...refund,
      voucher: {
        channelId,
        expiresAt: 0,
        maxClaimableAmount: "0",
        signature: "sig",
      },
    };
    await expect(assertServerModeRefundProof(withVoucher, channelId)).rejects.toThrow(
      /invalid payer proof/,
    );
    const charged = await signBatchAuthorization(
      payer,
      channelId,
      operator.address,
      "close-2",
      1n,
      expiresAt,
    );
    await expect(
      assertServerModeRefundProof({ ...refund, authorization: charged }, channelId),
    ).rejects.toThrow(/invalid payer proof/);
    await expect(
      assertServerModeRefundProof({ ...refund, authorization: undefined }, channelId),
    ).rejects.toThrow(/payer proof missing/);
  });

  it("rejects malformed batch authorization message inputs", () => {
    const base = {
      channelId,
      requestId: "request",
      authorizedAmount: 1_000n,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      operator: operator.address,
      payer: payer.address,
    };
    expect(() => encodeBatchAuthorizationMessage({ ...base, expiresAt: 0 })).toThrow(
      /positive safe integer/,
    );
    expect(() => encodeBatchAuthorizationMessage({ ...base, requestId: "" })).toThrow(
      /1 through 256 bytes/,
    );
    expect(() => encodeBatchAuthorizationMessage({ ...base, authorizedAmount: -1n })).toThrow(
      /u64/,
    );
  });
});
