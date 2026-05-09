import { describe, it, expect, beforeEach, vi } from "vitest";
import { BatchSettlementEvmScheme } from "../../../src/batch-settlement/server/scheme";
import { BatchSettlementChannelManager } from "../../../src/batch-settlement/server/channelManager";
import { InMemoryChannelStorage, type Channel } from "../../../src/batch-settlement/server/storage";
import { computeChannelId as computeChannelIdForNetwork } from "../../../src/batch-settlement/utils";
import { signVoucher } from "../../../src/batch-settlement/client/voucher";
import type {
  ChannelConfig,
  AuthorizerSigner,
  BatchSettlementVoucherPayload,
  BatchSettlementDepositPayload,
  BatchSettlementRefundPayload,
} from "../../../src/batch-settlement/types";
import type {
  PaymentRequirements,
  PaymentPayload,
  VerifyResponse,
  SettleResponse,
} from "@x402/core/types";
import type { FacilitatorClient } from "@x402/core/server";
import { privateKeyToAccount } from "viem/accounts";
import * as Errors from "../../../src/batch-settlement/errors";

function buildManager(scheme: BatchSettlementEvmScheme): BatchSettlementChannelManager {
  return new BatchSettlementChannelManager({
    scheme,
    facilitator: {} as FacilitatorClient,
    receiver: RECEIVER,
    token: ASSET_BASE_SEPOLIA,
    network: NETWORK,
  });
}

async function storeChannel(
  storage: InMemoryChannelStorage,
  channelId: string,
  channel: Channel,
): Promise<void> {
  await storage.updateChannel(channelId, () => channel);
}

async function deleteChannel(storage: InMemoryChannelStorage, channelId: string): Promise<void> {
  await storage.updateChannel(channelId, () => undefined);
}

async function reservePending(
  server: BatchSettlementEvmScheme,
  paymentPayload: PaymentPayload,
  requirements: PaymentRequirements,
): Promise<void> {
  const result = await server.schemeHooks.onBeforeVerify!({
    paymentPayload,
    requirements,
  } as never);
  expect(result).toBeUndefined();
}

const PAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as `0x${string}`;
const RECEIVER = "0x9876543210987654321098765432109876543210" as `0x${string}`;
const RECEIVER_AUTHORIZER = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const ASSET_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`;
const NETWORK = "eip155:84532";

function computeChannelId(config: ChannelConfig): `0x${string}` {
  return computeChannelIdForNetwork(config, NETWORK);
}

function buildAuthorizerSigner(): AuthorizerSigner {
  const account = privateKeyToAccount(
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  );
  return {
    address: account.address,
    signTypedData: msg =>
      account.signTypedData({
        domain: msg.domain,
        types: msg.types,
        primaryType: msg.primaryType,
        message: msg.message,
      } as Parameters<typeof account.signTypedData>[0]),
  };
}

function buildChannelConfig(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    payer: PAYER,
    payerAuthorizer: PAYER,
    receiver: RECEIVER,
    receiverAuthorizer: RECEIVER_AUTHORIZER,
    token: ASSET_BASE_SEPOLIA,
    withdrawDelay: 900,
    salt: "0x0000000000000000000000000000000000000000000000000000000000000000",
    ...overrides,
  };
}

function buildVoucherPayload(
  channelId: string,
  maxClaimableAmount: string,
  config: ChannelConfig,
  signature: `0x${string}` = "0xdeadbeef",
): PaymentPayload {
  const payload: BatchSettlementVoucherPayload = {
    type: "voucher",
    channelConfig: config,
    voucher: {
      channelId: channelId as `0x${string}`,
      maxClaimableAmount,
      signature,
    },
  };
  return {
    x402Version: 2,
    accepted: makeRequirements(),
    payload: payload as unknown as Record<string, unknown>,
  };
}

async function buildSignedVoucherPayload(
  channelId: `0x${string}`,
  maxClaimableAmount: string,
  config: ChannelConfig,
): Promise<PaymentPayload> {
  const voucher = await signVoucher(
    buildAuthorizerSigner(),
    channelId,
    maxClaimableAmount,
    NETWORK,
  );
  return buildVoucherPayload(channelId, maxClaimableAmount, config, voucher.signature);
}

function buildRefundPayload(
  channelId: string,
  maxClaimableAmount: string,
  config: ChannelConfig,
  amount?: string,
): PaymentPayload {
  const payload: BatchSettlementRefundPayload = {
    type: "refund",
    channelConfig: config,
    voucher: {
      channelId: channelId as `0x${string}`,
      maxClaimableAmount,
      signature: "0xdeadbeef",
    },
    ...(amount !== undefined ? { amount } : {}),
  };
  return {
    x402Version: 2,
    accepted: makeRequirements(),
    payload: payload as unknown as Record<string, unknown>,
  };
}

function buildDepositPayload(
  channelId: string,
  config: ChannelConfig,
  amount: string,
  maxClaimable: string,
): PaymentPayload {
  const payload: BatchSettlementDepositPayload = {
    type: "deposit",
    channelConfig: config,
    voucher: {
      channelId: channelId as `0x${string}`,
      maxClaimableAmount: maxClaimable,
      signature: "0xcafebabe",
    },
    deposit: {
      amount,
      authorization: {
        erc3009Authorization: {
          validAfter: "0",
          validBefore: "9999999999",
          salt: "0x0000000000000000000000000000000000000000000000000000000000000001",
          signature: "0xfeedbeef",
        },
      },
    },
  };
  return {
    x402Version: 2,
    accepted: makeRequirements(),
    payload: payload as unknown as Record<string, unknown>,
  };
}

function makeRequirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "batch-settlement",
    network: NETWORK,
    amount: "1000",
    asset: ASSET_BASE_SEPOLIA,
    payTo: RECEIVER,
    maxTimeoutSeconds: 3600,
    extra: { receiverAuthorizer: RECEIVER_AUTHORIZER },
    ...overrides,
  };
}

class CountingChannelStorage extends InMemoryChannelStorage {
  readonly getCalls: string[] = [];

  override async get(channelId: string): Promise<Channel | undefined> {
    this.getCalls.push(channelId);
    return super.get(channelId);
  }
}

describe("BatchSettlementEvmScheme — construction", () => {
  it("uses an in-memory channel storage by default", () => {
    const server = new BatchSettlementEvmScheme(RECEIVER);
    expect(server.scheme).toBe("batch-settlement");
    expect(server.getStorage()).toBeInstanceOf(InMemoryChannelStorage);
    expect(server.getReceiverAddress()).toBe(RECEIVER);
    expect(server.getWithdrawDelay()).toBe(900);
    expect(server.getOnchainStateTtlMs()).toBe(300_000);
    expect(server.getReceiverAuthorizerSigner()).toBeUndefined();
  });

  it("allows custom storage, withdrawDelay, and onchain state TTL", () => {
    const storage = new InMemoryChannelStorage();
    const signer = buildAuthorizerSigner();
    const server = new BatchSettlementEvmScheme(RECEIVER, {
      storage,
      withdrawDelay: 1800,
      onchainStateTtlMs: 45_000,
      receiverAuthorizerSigner: signer,
    });
    expect(server.getStorage()).toBe(storage);
    expect(server.getWithdrawDelay()).toBe(1800);
    expect(server.getOnchainStateTtlMs()).toBe(45_000);
    expect(server.getReceiverAuthorizerSigner()).toBe(signer);
  });
});

describe("BatchSettlementEvmScheme — parsePrice", () => {
  const server = new BatchSettlementEvmScheme(RECEIVER);

  it("converts $ strings to USDC base units on Base Sepolia", async () => {
    const result = await server.parsePrice("$0.10", NETWORK);
    expect(result.amount).toBe("100000");
    expect(result.asset).toBe(ASSET_BASE_SEPOLIA);
  });

  it("converts plain decimal strings", async () => {
    const result = await server.parsePrice("0.50", NETWORK);
    expect(result.amount).toBe("500000");
  });

  it("converts numeric prices", async () => {
    const result = await server.parsePrice(1, NETWORK);
    expect(result.amount).toBe("1000000");
  });

  it("returns AssetAmount as-is when an explicit asset is provided", async () => {
    const result = await server.parsePrice(
      {
        amount: "12345",
        asset: "0x1111111111111111111111111111111111111111",
        extra: { foo: "bar" },
      },
      NETWORK,
    );
    expect(result.amount).toBe("12345");
    expect(result.asset).toBe("0x1111111111111111111111111111111111111111");
    expect(result.extra).toEqual({ foo: "bar" });
  });

  it("throws when AssetAmount is missing the asset address", async () => {
    await expect(server.parsePrice({ amount: "100" } as never, NETWORK)).rejects.toThrow(
      /Asset address must be specified/,
    );
  });

  it("throws on invalid money strings", async () => {
    await expect(server.parsePrice("not-a-price!", NETWORK)).rejects.toThrow(
      /Invalid money format/,
    );
  });

  it("uses a registered custom money parser when it returns a result", async () => {
    const server2 = new BatchSettlementEvmScheme(RECEIVER);
    server2.registerMoneyParser(async (amount, network) => {
      if (network === NETWORK) {
        return {
          amount: (amount * 1_000_000_000_000_000_000).toString(),
          asset: "0x2222222222222222222222222222222222222222",
          extra: {},
        };
      }
      return null;
    });
    const result = await server2.parsePrice("1", NETWORK);
    expect(result.amount).toBe("1000000000000000000");
    expect(result.asset).toBe("0x2222222222222222222222222222222222222222");
  });

  it("falls back to default conversion when custom parser returns null", async () => {
    const server2 = new BatchSettlementEvmScheme(RECEIVER);
    server2.registerMoneyParser(async () => null);
    const result = await server2.parsePrice("1", NETWORK);
    expect(result.amount).toBe("1000000");
  });
});

describe("BatchSettlementEvmScheme — enhancePaymentRequirements", () => {
  const baseReqs = makeRequirements();

  it("injects withdrawDelay, facilitator receiverAuthorizer, name, version", async () => {
    const server = new BatchSettlementEvmScheme(RECEIVER, { withdrawDelay: 1800 });
    const enhanced = await server.enhancePaymentRequirements(
      baseReqs,
      {
        x402Version: 2,
        scheme: "batch-settlement",
        network: NETWORK,
        extra: { receiverAuthorizer: RECEIVER_AUTHORIZER },
      },
      [],
    );

    expect(enhanced.extra?.withdrawDelay).toBe(1800);
    expect(enhanced.extra?.receiverAuthorizer).toBe(RECEIVER_AUTHORIZER);
    expect(enhanced.extra?.name).toBe("USDC");
    expect(enhanced.extra?.version).toBe("2");
  });

  it("throws when neither server nor facilitator provides receiverAuthorizer", async () => {
    const server = new BatchSettlementEvmScheme(RECEIVER);
    await expect(
      server.enhancePaymentRequirements(
        baseReqs,
        { x402Version: 2, scheme: "batch-settlement", network: NETWORK },
        [],
      ),
    ).rejects.toThrow(/receiverAuthorizer/);
  });

  it("propagates receiver-authorizer from configured signer", async () => {
    const signer = buildAuthorizerSigner();
    const server = new BatchSettlementEvmScheme(RECEIVER, { receiverAuthorizerSigner: signer });
    const enhanced = await server.enhancePaymentRequirements(
      baseReqs,
      { x402Version: 2, scheme: "batch-settlement", network: NETWORK },
      [],
    );
    expect(enhanced.extra?.receiverAuthorizer).toBe(signer.address);
  });

  it("falls back to receiverAuthorizer from supportedKind.extra when no signer is configured", async () => {
    const server = new BatchSettlementEvmScheme(RECEIVER);
    const enhanced = await server.enhancePaymentRequirements(
      baseReqs,
      {
        x402Version: 2,
        scheme: "batch-settlement",
        network: NETWORK,
        extra: { receiverAuthorizer: "0xabcdefABCDef0000000000000000000000000001" },
      },
      [],
    );
    expect(enhanced.extra?.receiverAuthorizer).toBe("0xaBCDEFABcdEf0000000000000000000000000001");
  });

  it("preserves existing extra entries", async () => {
    const server = new BatchSettlementEvmScheme(RECEIVER);
    const enhanced = await server.enhancePaymentRequirements(
      makeRequirements({ extra: { custom: "yes" } }),
      {
        x402Version: 2,
        scheme: "batch-settlement",
        network: NETWORK,
        extra: { receiverAuthorizer: RECEIVER_AUTHORIZER },
      },
      [],
    );
    expect(enhanced.extra?.custom).toBe("yes");
  });

  it("preserves explicit assetTransferMethod from payment requirements", async () => {
    const server = new BatchSettlementEvmScheme(RECEIVER);
    const enhanced = await server.enhancePaymentRequirements(
      makeRequirements({ extra: { assetTransferMethod: "permit2" } }),
      {
        x402Version: 2,
        scheme: "batch-settlement",
        network: NETWORK,
        extra: { receiverAuthorizer: RECEIVER_AUTHORIZER },
      },
      [],
    );

    expect(enhanced.extra?.assetTransferMethod).toBe("permit2");
  });
});

describe("BatchSettlementEvmScheme — onBeforeVerify", () => {
  let server: BatchSettlementEvmScheme;
  let storage: InMemoryChannelStorage;

  beforeEach(() => {
    storage = new InMemoryChannelStorage();
    server = new BatchSettlementEvmScheme(RECEIVER, { storage });
  });

  it("does nothing when payload is not a batch-settlement cumulative payload", async () => {
    const result = await server.schemeHooks.onBeforeVerify!({
      paymentPayload: {
        x402Version: 2,
        accepted: makeRequirements(),
        payload: { type: "other" },
      },
      requirements: makeRequirements(),
    } as never);
    expect(result).toBeUndefined();
  });

  it("does nothing when no channel record is stored yet", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const result = await server.schemeHooks.onBeforeVerify!({
      paymentPayload: buildVoucherPayload(channelId, "1000", config),
      requirements: makeRequirements(),
    } as never);
    expect(result).toBeUndefined();
  });

  it("does nothing when client cumulative matches expected", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await storeChannel(storage, channelId, {
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: "1000",
      signature: "0x",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      onchainSyncedAt: 123,
      lastRequestTimestamp: 0,
    });

    const result = await server.schemeHooks.onBeforeVerify!({
      paymentPayload: buildVoucherPayload(channelId, "2000", config),
      requirements: makeRequirements({ amount: "1000" }),
    } as never);
    expect(result).toBeUndefined();
  });

  it("locally verifies a fresh EOA-authorized voucher", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await storeChannel(storage, channelId, {
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: "1000",
      signature: "0x",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 2,
      onchainSyncedAt: Date.now(),
      lastRequestTimestamp: 0,
    });

    const result = (await server.schemeHooks.onBeforeVerify!({
      paymentPayload: await buildSignedVoucherPayload(channelId, "2000", config),
      requirements: makeRequirements({ amount: "1000" }),
    } as never)) as unknown as { skip: true; result: VerifyResponse };

    expect(result?.skip).toBe(true);
    expect(result.result).toMatchObject({
      isValid: true,
      payer: PAYER,
      extra: {
        channelId,
        balance: "10000",
        totalClaimed: "0",
        withdrawRequestedAt: 0,
        refundNonce: "2",
      },
    });
    expect((await storage.get(channelId))?.pendingRequest).toBeDefined();
  });

  it("does not refresh onchain sync time after a local voucher verify", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const onchainSyncedAt = Date.now() - 1_000;
    await storeChannel(storage, channelId, {
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: "1000",
      signature: "0x",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      onchainSyncedAt,
      lastRequestTimestamp: 0,
    });

    const paymentPayload = await buildSignedVoucherPayload(channelId, "2000", config);
    const verifyResult = (await server.schemeHooks.onBeforeVerify!({
      paymentPayload,
      requirements: makeRequirements({ amount: "1000" }),
    } as never)) as unknown as { skip: true; result: VerifyResponse };

    await server.schemeHooks.onAfterVerify!({
      paymentPayload,
      requirements: makeRequirements({ amount: "1000" }),
      result: verifyResult.result,
    } as never);

    expect((await storage.get(channelId))?.onchainSyncedAt).toBe(onchainSyncedAt);
  });

  it("falls through to facilitator verification when mirrored onchain state is stale", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await storeChannel(storage, channelId, {
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: "1000",
      signature: "0x",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      onchainSyncedAt: Date.now() - server.getOnchainStateTtlMs() - 1,
      lastRequestTimestamp: 0,
    });

    const result = await server.schemeHooks.onBeforeVerify!({
      paymentPayload: await buildSignedVoucherPayload(channelId, "2000", config),
      requirements: makeRequirements({ amount: "1000" }),
    } as never);

    expect(result).toBeUndefined();
    expect((await storage.get(channelId))?.pendingRequest).toBeDefined();
  });

  it("falls through to facilitator verification for EIP-1271 vouchers", async () => {
    const config = buildChannelConfig({
      payerAuthorizer: "0x0000000000000000000000000000000000000000",
    });
    const channelId = computeChannelId(config);
    await storeChannel(storage, channelId, {
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: "1000",
      signature: "0x",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      onchainSyncedAt: Date.now(),
      lastRequestTimestamp: 0,
    });

    const result = await server.schemeHooks.onBeforeVerify!({
      paymentPayload: buildVoucherPayload(channelId, "2000", config),
      requirements: makeRequirements({ amount: "1000" }),
    } as never);

    expect(result).toBeUndefined();
  });

  it("rejects a locally invalid voucher signature without facilitator verification", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await storeChannel(storage, channelId, {
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: "1000",
      signature: "0x",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      onchainSyncedAt: Date.now(),
      lastRequestTimestamp: 0,
    });

    const result = (await server.schemeHooks.onBeforeVerify!({
      paymentPayload: buildVoucherPayload(channelId, "2000", config),
      requirements: makeRequirements({ amount: "1000" }),
    } as never)) as unknown as { skip: true; result: VerifyResponse };

    expect(result?.skip).toBe(true);
    expect(result.result).toMatchObject({
      isValid: false,
      invalidReason: Errors.ErrInvalidVoucherSignature,
    });
  });

  it("rejects locally when the voucher cumulative amount exceeds balance", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await storeChannel(storage, channelId, {
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: "1000",
      signature: "0x",
      balance: "1500",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      onchainSyncedAt: Date.now(),
      lastRequestTimestamp: 0,
    });

    const result = (await server.schemeHooks.onBeforeVerify!({
      paymentPayload: await buildSignedVoucherPayload(channelId, "2000", config),
      requirements: makeRequirements({ amount: "1000" }),
    } as never)) as unknown as { skip: true; result: VerifyResponse };

    expect(result?.skip).toBe(true);
    expect(result.result.invalidReason).toBe(Errors.ErrCumulativeExceedsBalance);
  });

  it("rejects locally when the voucher cumulative amount is already claimed", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await storeChannel(storage, channelId, {
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: "1000",
      signature: "0x",
      balance: "10000",
      totalClaimed: "2000",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      onchainSyncedAt: Date.now(),
      lastRequestTimestamp: 0,
    });

    const result = (await server.schemeHooks.onBeforeVerify!({
      paymentPayload: await buildSignedVoucherPayload(channelId, "2000", config),
      requirements: makeRequirements({ amount: "1000" }),
    } as never)) as unknown as { skip: true; result: VerifyResponse };

    expect(result?.skip).toBe(true);
    expect(result.result.invalidReason).toBe(Errors.ErrCumulativeAmountBelowClaimed);
  });

  it("does not abort initial deposit payloads with no server channel state", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const result = await server.schemeHooks.onBeforeVerify!({
      paymentPayload: buildDepositPayload(channelId, config, "10000", "1500"),
      requirements: makeRequirements({ amount: "1000" }),
    } as never);

    expect(result).toBeUndefined();
  });

  it("accepts a deposit payload whose maxClaimable equals chargedCumulativeAmount plus amount", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await storeChannel(storage, channelId, {
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: "1000",
      signature: "0xabcd",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      onchainSyncedAt: 123,
      lastRequestTimestamp: 0,
    });

    const result = await server.schemeHooks.onBeforeVerify!({
      paymentPayload: buildDepositPayload(channelId, config, "10000", "2000"),
      requirements: makeRequirements({ amount: "1000" }),
    } as never);

    expect(result).toBeUndefined();
  });

  it("aborts a deposit payload whose maxClaimable does not match chargedCumulativeAmount plus amount", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await storeChannel(storage, channelId, {
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: "1000",
      signature: "0xabcd",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      onchainSyncedAt: 123,
      lastRequestTimestamp: 0,
    });

    const result = (await server.schemeHooks.onBeforeVerify!({
      paymentPayload: buildDepositPayload(channelId, config, "10000", "1500"),
      requirements: makeRequirements({ amount: "1000" }),
    } as never)) as { abort: true; reason: string };

    expect(result?.abort).toBe(true);
    expect(result?.reason).toBe(Errors.ErrCumulativeAmountMismatch);
  });

  it("does nothing for a refund voucher when no channel record exists (defers to facilitator for on-chain recovery)", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const result = await server.schemeHooks.onBeforeVerify!({
      paymentPayload: buildRefundPayload(channelId, "0", config),
      requirements: makeRequirements({ amount: "0" }),
    } as never);

    expect(result).toBeUndefined();
  });

  it("accepts a zero-charge refund voucher whose maxClaimable equals chargedCumulativeAmount", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await storeChannel(storage, channelId, {
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "1500",
      signedMaxClaimable: "1500",
      signature: "0xabcd",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: 0,
    });

    const result = await server.schemeHooks.onBeforeVerify!({
      paymentPayload: buildRefundPayload(channelId, "1500", config),
      requirements: makeRequirements({ amount: "1000" }),
    } as never);

    expect(result).toBeUndefined();
  });

  it("aborts a refund voucher whose maxClaimable does not match chargedCumulativeAmount", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await storeChannel(storage, channelId, {
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "1500",
      signedMaxClaimable: "1500",
      signature: "0xabcd",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: 0,
    });

    const result = (await server.schemeHooks.onBeforeVerify!({
      paymentPayload: buildRefundPayload(channelId, "2500", config),
      requirements: makeRequirements({ amount: "0" }),
    } as never)) as { abort: true; reason: string };

    expect(result?.abort).toBe(true);
    expect(result?.reason).toBe(Errors.ErrCumulativeAmountMismatch);
  });

  it("aborts with cumulative_amount_mismatch when client cumulative is wrong", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await storeChannel(storage, channelId, {
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: "1000",
      signature: "0xabcd",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: 0,
    });

    const reqs = makeRequirements({ amount: "1000" });
    const result = (await server.schemeHooks.onBeforeVerify!({
      paymentPayload: buildVoucherPayload(channelId, "500", config),
      requirements: reqs,
    } as never)) as {
      abort: true;
      reason: string;
    };

    expect(result?.abort).toBe(true);
    expect(result?.reason).toBe(Errors.ErrCumulativeAmountMismatch);
    expect(reqs.extra?.chargedCumulativeAmount).toBeUndefined();
  });

  it("adds channel state to corrective payment-required accepts via fallback storage read", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await storeChannel(storage, channelId, {
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: "1000",
      signature: "0xabcd",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: 0,
    });

    const requirements = [makeRequirements({ amount: "1000" })];
    await server.enrichPaymentRequiredResponse({
      requirements,
      paymentPayload: buildVoucherPayload(channelId, "500", config),
      resourceInfo: { url: "https://example.com" },
      error: Errors.ErrCumulativeAmountMismatch,
      paymentRequiredResponse: {
        x402Version: 2,
        resource: { url: "https://example.com" },
        accepts: requirements,
      },
    });

    expect(requirements[0].extra.channelState).toMatchObject({
      channelId,
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: "0",
      chargedCumulativeAmount: "1000",
    });
    expect(requirements[0].extra.voucherState).toMatchObject({
      signedMaxClaimable: "1000",
      signature: "0xabcd",
    });
  });

  it("adds channel state to corrective payment-required accepts for deposit mismatches", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await storeChannel(storage, channelId, {
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: "1000",
      signature: "0xabcd",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: 0,
    });

    const requirements = [makeRequirements({ amount: "1000" })];
    await server.enrichPaymentRequiredResponse({
      requirements,
      paymentPayload: buildDepositPayload(channelId, config, "10000", "1500"),
      resourceInfo: { url: "https://example.com" },
      error: Errors.ErrCumulativeAmountMismatch,
      paymentRequiredResponse: {
        x402Version: 2,
        resource: { url: "https://example.com" },
        accepts: requirements,
      },
    });

    expect(requirements[0].extra.channelState).toMatchObject({
      channelId,
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: "0",
      chargedCumulativeAmount: "1000",
    });
    expect(requirements[0].extra.voucherState).toMatchObject({
      signedMaxClaimable: "1000",
      signature: "0xabcd",
    });
  });

  it("reuses the mismatch channel snapshot for corrective payment-required accepts", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const countingStorage = new CountingChannelStorage();
    const snapshotServer = new BatchSettlementEvmScheme(RECEIVER, { storage: countingStorage });
    const channel: Channel = {
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: "1000",
      signature: "0xabcd",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: 0,
    };
    await storeChannel(countingStorage, channelId, channel);

    const paymentPayload = buildVoucherPayload(channelId, "500", config);
    const result = (await snapshotServer.schemeHooks.onBeforeVerify!({
      paymentPayload,
      requirements: makeRequirements({ amount: "1000" }),
    } as never)) as {
      abort: true;
      reason: string;
    };

    expect(result?.abort).toBe(true);
    expect(result?.reason).toBe(Errors.ErrCumulativeAmountMismatch);
    expect(countingStorage.getCalls).toHaveLength(0);

    await deleteChannel(countingStorage, channelId);
    const requirements = [makeRequirements({ amount: "1000" })];
    await snapshotServer.enrichPaymentRequiredResponse({
      requirements,
      paymentPayload,
      resourceInfo: { url: "https://example.com" },
      error: Errors.ErrCumulativeAmountMismatch,
      paymentRequiredResponse: {
        x402Version: 2,
        resource: { url: "https://example.com" },
        accepts: requirements,
      },
    });

    expect(requirements[0].extra.channelState).toMatchObject({
      channelId,
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: "0",
      chargedCumulativeAmount: "1000",
    });
    expect(requirements[0].extra.voucherState).toMatchObject({
      signedMaxClaimable: "1000",
      signature: "0xabcd",
    });
    expect(countingStorage.getCalls).toHaveLength(0);

    const laterRequirements = [makeRequirements({ amount: "1000" })];
    await snapshotServer.enrichPaymentRequiredResponse({
      requirements: laterRequirements,
      paymentPayload,
      resourceInfo: { url: "https://example.com" },
      error: Errors.ErrCumulativeAmountMismatch,
      paymentRequiredResponse: {
        x402Version: 2,
        resource: { url: "https://example.com" },
        accepts: laterRequirements,
      },
    });

    expect(laterRequirements[0].extra.channelState).toBeUndefined();
    expect(countingStorage.getCalls).toHaveLength(1);
  });

  it("rejects a live same-channel reservation as busy", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await storeChannel(storage, channelId, {
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "0",
      signedMaxClaimable: "0",
      signature: "0x",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: 0,
    });

    await reservePending(
      server,
      buildVoucherPayload(channelId, "1000", config),
      makeRequirements({ amount: "1000" }),
    );

    const result = (await server.schemeHooks.onBeforeVerify!({
      paymentPayload: buildVoucherPayload(channelId, "1000", config),
      requirements: makeRequirements({ amount: "1000" }),
    } as never)) as { abort: true; reason: string };

    expect(result?.abort).toBe(true);
    expect(result?.reason).toBe(Errors.ErrChannelBusy);
  });

  it("replaces an expired pending reservation", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await storeChannel(storage, channelId, {
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "0",
      signedMaxClaimable: "0",
      signature: "0x",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: 0,
      pendingRequest: {
        pendingId: "expired",
        signedMaxClaimable: "1000",
        expiresAt: Date.now() - 1,
      },
    });

    await reservePending(
      server,
      buildVoucherPayload(channelId, "1000", config),
      makeRequirements({ amount: "1000" }),
    );

    const updated = await storage.get(channelId);
    expect(updated?.pendingRequest?.pendingId).not.toBe("expired");
  });
});

describe("BatchSettlementEvmScheme — pending cleanup hooks", () => {
  let server: BatchSettlementEvmScheme;
  let storage: InMemoryChannelStorage;

  beforeEach(() => {
    storage = new InMemoryChannelStorage();
    server = new BatchSettlementEvmScheme(RECEIVER, { storage });
  });

  it("clears a pending marker when facilitator verification returns invalid", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const payload = buildDepositPayload(channelId, config, "10000", "1000");
    await reservePending(server, payload, makeRequirements({ amount: "1000" }));

    await server.schemeHooks.onAfterVerify!({
      paymentPayload: payload,
      requirements: makeRequirements({ amount: "1000" }),
      result: { isValid: false } as VerifyResponse,
    } as never);

    expect(await storage.get(channelId)).toBeUndefined();
  });

  it("clears only its matching pending marker on verified-payment cancellation", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await storeChannel(storage, channelId, {
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "0",
      signedMaxClaimable: "0",
      signature: "0x",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: 0,
    });
    const payload = buildVoucherPayload(channelId, "1000", config);
    await reservePending(server, payload, makeRequirements({ amount: "1000" }));
    const firstPendingId = (await storage.get(channelId))?.pendingRequest?.pendingId;

    await storage.updateChannel(channelId, current =>
      current
        ? {
            ...current,
            pendingRequest: {
              pendingId: "newer",
              signedMaxClaimable: "1000",
              expiresAt: Date.now() + 60_000,
            },
          }
        : current,
    );

    await server.schemeHooks.onVerifiedPaymentCanceled!({
      paymentPayload: payload,
      requirements: makeRequirements({ amount: "1000" }),
      declaredExtensions: {},
      reason: "handler_failed",
      responseStatus: 500,
    } as never);

    const updated = await storage.get(channelId);
    expect(firstPendingId).toBeDefined();
    expect(updated?.pendingRequest?.pendingId).toBe("newer");
  });

  it("clears a pending marker on verify and settle failures", async () => {
    const config = buildChannelConfig();
    const verifyChannelId = computeChannelId(config);
    const verifyPayload = buildVoucherPayload(verifyChannelId, "1000", config);
    await reservePending(server, verifyPayload, makeRequirements({ amount: "1000" }));

    await server.schemeHooks.onVerifyFailure!({
      paymentPayload: verifyPayload,
      requirements: makeRequirements({ amount: "1000" }),
      declaredExtensions: {},
      error: new Error("verify failed"),
    } as never);
    expect((await storage.get(verifyChannelId))?.pendingRequest).toBeUndefined();

    const settleConfig = buildChannelConfig({
      salt: "0x00000000000000000000000000000000000000000000000000000000000000aa",
    });
    const settleChannelId = computeChannelId(settleConfig);
    const settlePayload = buildVoucherPayload(settleChannelId, "1000", settleConfig);
    await storeChannel(storage, settleChannelId, {
      channelId: settleChannelId,
      channelConfig: settleConfig,
      chargedCumulativeAmount: "0",
      signedMaxClaimable: "0",
      signature: "0x",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: 0,
    });
    await reservePending(server, settlePayload, makeRequirements({ amount: "1000" }));

    await server.schemeHooks.onSettleFailure!({
      paymentPayload: settlePayload,
      requirements: makeRequirements({ amount: "1000" }),
      declaredExtensions: {},
      error: new Error("settle failed"),
    } as never);
    expect((await storage.get(settleChannelId))?.pendingRequest).toBeUndefined();
  });
});

describe("BatchSettlementEvmScheme — onAfterVerify", () => {
  let server: BatchSettlementEvmScheme;
  let storage: InMemoryChannelStorage;

  beforeEach(() => {
    storage = new InMemoryChannelStorage();
    server = new BatchSettlementEvmScheme(RECEIVER, { storage });
  });

  it("creates a channel record from a deposit payload after a successful verify", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const paymentPayload = buildDepositPayload(channelId, config, "10000", "1000");
    const requirements = makeRequirements({ amount: "1000" });
    await reservePending(server, paymentPayload, requirements);
    const result: VerifyResponse = {
      isValid: true,
      payer: PAYER,
      extra: { balance: "10000", totalClaimed: "0", refundNonce: "0" },
    } as VerifyResponse;

    await server.schemeHooks.onAfterVerify!({
      paymentPayload,
      requirements,
      result,
    } as never);

    const channel = await storage.get(channelId);
    expect(channel?.balance).toBe("10000");
    expect(channel?.signedMaxClaimable).toBe("1000");
    expect(channel?.signature).toBe("0xcafebabe");
    expect(channel?.onchainSyncedAt).toBeGreaterThan(0);
  });

  it("does not create channel record when result.isValid is false", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await server.schemeHooks.onAfterVerify!({
      paymentPayload: buildVoucherPayload(channelId, "1000", config),
      requirements: makeRequirements(),
      result: { isValid: false } as VerifyResponse,
    } as never);
    expect(await storage.get(channelId)).toBeUndefined();
  });

  it("returns a skipHandler directive for a refund voucher", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const paymentPayload = buildRefundPayload(channelId, "0", config);
    const requirements = makeRequirements({ amount: "0" });
    await reservePending(server, paymentPayload, requirements);
    const result: VerifyResponse = {
      isValid: true,
      payer: PAYER,
      extra: { balance: "10000", totalClaimed: "0", refundNonce: "0" },
    } as VerifyResponse;

    const directive = await server.schemeHooks.onAfterVerify!({
      paymentPayload,
      requirements,
      result,
    } as never);

    expect(directive).toBeDefined();
    expect(directive!.skipHandler).toBe(true);
    expect(directive!.response?.contentType).toBe("application/json");
    expect((directive!.response?.body as { message: string }).message).toBe("Refund acknowledged");
    expect((directive!.response?.body as { channelId: string }).channelId).toBe(channelId);
  });

  it("does not return a skipHandler directive for a non-refund voucher", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const paymentPayload = buildVoucherPayload(channelId, "1000", config);
    const requirements = makeRequirements({ amount: "1000" });
    await reservePending(server, paymentPayload, requirements);
    const result: VerifyResponse = {
      isValid: true,
      payer: PAYER,
      extra: { balance: "10000", totalClaimed: "1000", refundNonce: "0" },
    } as VerifyResponse;

    const directive = await server.schemeHooks.onAfterVerify!({
      paymentPayload,
      requirements,
      result,
    } as never);

    expect(directive).toBeUndefined();
  });
});

describe("BatchSettlementEvmScheme — onBeforeSettle", () => {
  let server: BatchSettlementEvmScheme;
  let storage: InMemoryChannelStorage;

  beforeEach(() => {
    storage = new InMemoryChannelStorage();
    server = new BatchSettlementEvmScheme(RECEIVER, { storage });
  });

  it("aborts a voucher payload when no channel record exists", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const result = (await server.schemeHooks.onBeforeSettle!({
      paymentPayload: buildVoucherPayload(channelId, "1000", config),
      requirements: makeRequirements({ amount: "1000" }),
    } as never)) as { abort: true; reason: string };
    expect(result?.abort).toBe(true);
    expect(result?.reason).toBe(Errors.ErrMissingChannel);
  });

  it("aborts when charged exceeds the signed cap", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await storeChannel(storage, channelId, {
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "900",
      signedMaxClaimable: "1000",
      signature: "0xabcd",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: 0,
    });
    const paymentPayload = buildVoucherPayload(channelId, "950", config);
    await reservePending(server, paymentPayload, makeRequirements({ amount: "50" }));

    const result = (await server.schemeHooks.onBeforeSettle!({
      paymentPayload,
      requirements: makeRequirements({ amount: "500" }),
    } as never)) as { abort: true; reason: string };
    expect(result?.abort).toBe(true);
    expect(result?.reason).toBe(Errors.ErrChargeExceedsSignedCumulative);
  });

  it("returns skip+result for a normal voucher and updates channel record", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await storeChannel(storage, channelId, {
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "0",
      signedMaxClaimable: "0",
      signature: "0x",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      onchainSyncedAt: 123,
      lastRequestTimestamp: 0,
    });

    const paymentPayload = buildVoucherPayload(channelId, "1000", config);
    await reservePending(server, paymentPayload, makeRequirements({ amount: "1000" }));

    const result = (await server.schemeHooks.onBeforeSettle!({
      paymentPayload,
      requirements: makeRequirements({ amount: "1000" }),
    } as never)) as { skip: true; result: SettleResponse };

    expect(result?.skip).toBe(true);
    expect(result?.result.success).toBe(true);
    expect(Object.keys(result?.result ?? {}).slice(0, 5)).toEqual([
      "success",
      "payer",
      "transaction",
      "network",
      "amount",
    ]);
    expect(result?.result.amount).toBe("");
    expect(result?.result.extra?.chargedAmount).toBe("1000");
    expect(result?.result.extra?.channelState).toMatchObject({
      channelId,
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: "0",
      chargedCumulativeAmount: "1000",
    });

    const updated = await storage.get(channelId);
    expect(updated?.chargedCumulativeAmount).toBe("1000");
    expect(updated?.signedMaxClaimable).toBe("1000");
    expect(updated?.onchainSyncedAt).toBe(123);
  });

  it("enriches a zero-charge refund voucher into a full refundWithSignature payload", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await storeChannel(storage, channelId, {
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "500",
      signedMaxClaimable: "500",
      signature: "0xdeadbeef",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 1,
      lastRequestTimestamp: 0,
    });

    // Zero-charge voucher: maxClaimableAmount equals the existing chargedCumulativeAmount.
    const payload = buildRefundPayload(channelId, "500", config);
    await reservePending(server, payload, makeRequirements({ amount: "0" }));
    const ret = await server.schemeHooks.onBeforeSettle!({
      paymentPayload: payload,
      requirements: makeRequirements({ amount: "0" }),
    } as never);
    expect(ret).toBeUndefined();

    const enrichment = await server.enrichSettlementPayload({
      paymentPayload: payload,
      requirements: makeRequirements({ amount: "0" }),
    } as never);
    expect(enrichment?.amount).toBe("9500");
    expect(enrichment?.refundNonce).toBe("1");
  });

  it("recovers a refund voucher channel record from facilitator extras when local state was lost", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);

    // Local server state is empty (channel record loss scenario).
    expect(await storage.get(channelId)).toBeUndefined();

    // 1. handleBeforeVerify must not abort — it should defer to the facilitator.
    const refundPayload = buildRefundPayload(channelId, "1500", config);
    await reservePending(server, refundPayload, makeRequirements({ amount: "0" }));

    // 2. handleAfterVerify rebuilds the channel record from on-chain snapshot returned by the facilitator.
    const verifyResult: VerifyResponse = {
      isValid: true,
      payer: PAYER,
      extra: { balance: "10000", totalClaimed: "1500", refundNonce: "3" },
    } as VerifyResponse;
    await server.schemeHooks.onAfterVerify!({
      paymentPayload: refundPayload,
      requirements: makeRequirements({ amount: "0" }),
      result: verifyResult,
    } as never);
    const recovered = await storage.get(channelId);
    expect(recovered).toBeDefined();
    expect(recovered?.balance).toBe("10000");
    expect(recovered?.totalClaimed).toBe("1500");
    expect(recovered?.chargedCumulativeAmount).toBe("1500");
    expect(recovered?.refundNonce).toBe(3);

    // 3. Settlement enrichment builds a refundWithSignature payload with amount = balance - totalClaimed.
    const settleRet = await server.schemeHooks.onBeforeSettle!({
      paymentPayload: refundPayload,
      requirements: makeRequirements({ amount: "0" }),
    } as never);
    expect(settleRet).toBeUndefined();

    const enrichment = await server.enrichSettlementPayload({
      paymentPayload: refundPayload,
      requirements: makeRequirements({ amount: "0" }),
    } as never);
    expect(enrichment?.amount).toBe("8500");
    expect(enrichment?.refundNonce).toBe("3");
  });

  it("aborts a recovered refund voucher with refund_no_balance when channel is fully drained", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);

    // Local state is empty; on-chain shows the channel was already drained (balance == totalClaimed).
    const verifyResult: VerifyResponse = {
      isValid: true,
      payer: PAYER,
      extra: { balance: "61800", totalClaimed: "61800", refundNonce: "1" },
    } as VerifyResponse;
    const settlePayload = buildRefundPayload(channelId, "61800", config);
    await reservePending(server, settlePayload, makeRequirements({ amount: "0" }));
    await server.schemeHooks.onAfterVerify!({
      paymentPayload: settlePayload,
      requirements: makeRequirements({ amount: "0" }),
      result: verifyResult,
    } as never);

    const ret = await server.schemeHooks.onBeforeSettle!({
      paymentPayload: settlePayload,
      requirements: makeRequirements({ amount: "0" }),
    } as never);
    expect(ret).toBeUndefined();

    await expect(
      server.enrichSettlementPayload({
        paymentPayload: settlePayload,
        requirements: makeRequirements({ amount: "0" }),
      } as never),
    ).rejects.toThrow(Errors.ErrRefundNoBalance);
  });

  it("honors refund amount on a partial refund payload", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await storeChannel(storage, channelId, {
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "500",
      signedMaxClaimable: "500",
      signature: "0xdeadbeef",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: 0,
    });

    const payload = buildRefundPayload(channelId, "500", config, "1000");
    await reservePending(server, payload, makeRequirements({ amount: "0" }));

    const ret = await server.schemeHooks.onBeforeSettle!({
      paymentPayload: payload,
      requirements: makeRequirements({ amount: "0" }),
    } as never);
    expect(ret).toBeUndefined();

    const enrichment = await server.enrichSettlementPayload({
      paymentPayload: payload,
      requirements: makeRequirements({ amount: "0" }),
    } as never);
    expect(enrichment?.amount).toBeUndefined();
    expect(enrichment?.refundNonce).toBe("0");
  });
});

describe("BatchSettlementEvmScheme — onAfterSettle", () => {
  let server: BatchSettlementEvmScheme;
  let storage: InMemoryChannelStorage;

  beforeEach(() => {
    storage = new InMemoryChannelStorage();
    server = new BatchSettlementEvmScheme(RECEIVER, { storage });
  });

  it("updates channel record and exposes deposit response enrichment", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const payload = buildDepositPayload(channelId, config, "10000", "1000");
    await reservePending(server, payload, makeRequirements({ amount: "1000" }));
    const result: SettleResponse = {
      success: true,
      transaction: "0xtx",
      network: NETWORK,
      payer: PAYER,
      extra: {
        channelState: {
          channelId,
          balance: "10000",
          totalClaimed: "0",
          withdrawRequestedAt: 0,
          refundNonce: "0",
        },
      },
    } as SettleResponse;

    await server.schemeHooks.onAfterSettle!({
      paymentPayload: payload,
      requirements: makeRequirements({ amount: "1000" }),
      result,
    } as never);

    const channel = await storage.get(channelId);
    expect(channel?.chargedCumulativeAmount).toBe("1000");
    expect(channel?.balance).toBe("10000");
    expect(channel?.onchainSyncedAt).toBeGreaterThan(0);
    expect((result.extra as Record<string, string>).chargedCumulativeAmount).toBeUndefined();

    const enrichment = await server.enrichSettlementResponse({
      paymentPayload: payload,
      requirements: makeRequirements({ amount: "1000" }),
      result,
    } as never);
    expect(enrichment).toEqual({
      channelState: {
        chargedCumulativeAmount: "1000",
      },
      chargedAmount: "1000",
    });
  });

  it("deletes channel record and exposes refund response enrichment after a full refund", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const channel: Channel = {
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: "1000",
      signature: "0xabcd",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: 0,
    };
    await storeChannel(storage, channelId, channel);

    const refundPayload = {
      x402Version: 2,
      scheme: "batch-settlement",
      network: NETWORK,
      payload: {
        type: "refund",
        channelConfig: config,
        voucher: {
          channelId: channelId as `0x${string}`,
          maxClaimableAmount: "1000",
          signature: "0xabcd",
        },
        amount: "9000",
        refundNonce: "0",
        claims: [
          {
            voucher: { channel: config, maxClaimableAmount: "1000" },
            signature: "0xabcd" as `0x${string}`,
            totalClaimed: "1000",
          },
        ],
      } as unknown as Record<string, unknown>,
    } as unknown as PaymentPayload;
    await reservePending(server, refundPayload, makeRequirements({ amount: "0" }));
    server.rememberChannelSnapshot(refundPayload, channel);

    const result: SettleResponse = {
      success: true,
      transaction: "0xref",
      network: NETWORK,
      payer: PAYER,
      extra: {
        channelState: {
          channelId,
          balance: "1000",
          totalClaimed: "1000",
          withdrawRequestedAt: 0,
          refundNonce: "1",
        },
      },
    } as SettleResponse;

    await server.schemeHooks.onAfterSettle!({
      paymentPayload: refundPayload,
      requirements: makeRequirements(),
      result,
    } as never);

    expect(await storage.get(channelId)).toBeUndefined();
    expect((result.extra as Record<string, unknown>).refund).toBeUndefined();

    const enrichment = await server.enrichSettlementResponse({
      paymentPayload: refundPayload,
      requirements: makeRequirements(),
      result,
    } as never);
    expect(enrichment).toEqual({
      channelState: {
        chargedCumulativeAmount: "1000",
      },
    });
  });

  it("retains channel record and increments refundNonce on a partial refundWithSignature", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const channel: Channel = {
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: "1000",
      signature: "0xabcd",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 2,
      lastRequestTimestamp: 0,
    };
    await storeChannel(storage, channelId, channel);

    const refundPayload = {
      x402Version: 2,
      scheme: "batch-settlement",
      network: NETWORK,
      payload: {
        type: "refund",
        channelConfig: config,
        voucher: {
          channelId: channelId as `0x${string}`,
          maxClaimableAmount: "1000",
          signature: "0xabcd",
        },
        amount: "2000",
        refundNonce: "2",
        claims: [
          {
            voucher: { channel: config, maxClaimableAmount: "1000" },
            signature: "0xabcd" as `0x${string}`,
            totalClaimed: "1000",
          },
        ],
      } as unknown as Record<string, unknown>,
    } as unknown as PaymentPayload;
    await reservePending(server, refundPayload, makeRequirements({ amount: "0" }));
    server.rememberChannelSnapshot(refundPayload, channel);

    const result: SettleResponse = {
      success: true,
      transaction: "0xref",
      network: NETWORK,
      payer: PAYER,
      extra: {
        channelState: {
          channelId,
          balance: "8000",
          totalClaimed: "1000",
          withdrawRequestedAt: 0,
          refundNonce: "3",
        },
        refundedAmount: "2000",
      },
    } as SettleResponse;

    await server.schemeHooks.onAfterSettle!({
      paymentPayload: refundPayload,
      requirements: makeRequirements(),
      result,
    } as never);

    const updated = await storage.get(channelId);
    expect(updated).toBeDefined();
    expect(updated?.balance).toBe("8000");
    expect(updated?.refundNonce).toBe(3);
    expect(updated?.onchainSyncedAt).toBeGreaterThan(0);
    expect((result.extra as Record<string, unknown>).refundedAmount).toBe("2000");

    const enrichment = await server.enrichSettlementResponse({
      paymentPayload: refundPayload,
      requirements: makeRequirements(),
      result,
    } as never);
    expect(enrichment).toEqual({
      channelState: {
        chargedCumulativeAmount: "1000",
      },
    });
  });

  it("does not modify state when result.success is false", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await server.schemeHooks.onAfterSettle!({
      paymentPayload: buildDepositPayload(channelId, config, "10000", "1000"),
      requirements: makeRequirements(),
      result: { success: false } as SettleResponse,
    } as never);
    expect(await storage.get(channelId)).toBeUndefined();
  });
});

describe("BatchSettlementChannelManager — getClaimableVouchers", () => {
  let server: BatchSettlementEvmScheme;
  let manager: BatchSettlementChannelManager;
  let storage: InMemoryChannelStorage;

  beforeEach(() => {
    storage = new InMemoryChannelStorage();
    server = new BatchSettlementEvmScheme(RECEIVER, { storage });
    manager = buildManager(server);
  });

  it("returns [] when no channel records exist", async () => {
    expect(await manager.getClaimableVouchers()).toEqual([]);
  });

  it("filters out channel records that have nothing to claim", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await storeChannel(storage, channelId, {
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: "1000",
      signature: "0xabcd",
      balance: "10000",
      totalClaimed: "1000",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
    });
    expect(await manager.getClaimableVouchers()).toEqual([]);
  });

  it("returns claimable vouchers when charged > totalClaimed", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await storeChannel(storage, channelId, {
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "5000",
      signedMaxClaimable: "5000",
      signature: "0xabcd",
      balance: "10000",
      totalClaimed: "1000",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
    });

    const claims = await manager.getClaimableVouchers();
    expect(claims).toHaveLength(1);
    expect(claims[0].voucher.maxClaimableAmount).toBe("5000");
    expect(claims[0].totalClaimed).toBe("5000");
    expect(claims[0].signature).toBe("0xabcd");
    expect(claims[0].voucher.channel).toEqual(config);
  });

  it("respects idleSecs filter", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await storeChannel(storage, channelId, {
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "5000",
      signedMaxClaimable: "5000",
      signature: "0xabcd",
      balance: "10000",
      totalClaimed: "1000",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
    });

    expect(await manager.getClaimableVouchers({ idleSecs: 60 })).toEqual([]);
  });

  it("claims an older voucher while preserving newer pending request state", async () => {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await storeChannel(storage, channelId, {
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "5000",
      signedMaxClaimable: "5000",
      signature: "0xabcd",
      balance: "10000",
      totalClaimed: "1000",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: Date.now(),
      pendingRequest: {
        pendingId: "pending",
        signedMaxClaimable: "6000",
        expiresAt: Date.now() + 60_000,
      },
    });
    const facilitator = {
      settle: vi.fn(async () => ({
        success: true,
        transaction: "0xclaim",
      })),
    } as unknown as FacilitatorClient;
    const claimManager = new BatchSettlementChannelManager({
      scheme: server,
      facilitator,
      receiver: RECEIVER,
      token: ASSET_BASE_SEPOLIA,
      network: NETWORK,
    });

    const results = await claimManager.claim();

    expect(results).toEqual([{ vouchers: 1, transaction: "0xclaim" }]);
    const updated = await storage.get(channelId);
    expect(updated?.totalClaimed).toBe("5000");
    expect(updated?.pendingRequest?.pendingId).toBe("pending");
  });
});

describe("BatchSettlementChannelManager — refund pending channels", () => {
  it("skips channels with live pending requests", async () => {
    const storage = new InMemoryChannelStorage();
    const server = new BatchSettlementEvmScheme(RECEIVER, { storage });
    const facilitator = {
      settle: vi.fn(async () => ({
        success: true,
        transaction: "0xref",
      })),
    } as unknown as FacilitatorClient;
    const manager = new BatchSettlementChannelManager({
      scheme: server,
      facilitator,
      receiver: RECEIVER,
      token: ASSET_BASE_SEPOLIA,
      network: NETWORK,
    });

    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    await storeChannel(storage, channelId, {
      channelId,
      channelConfig: config,
      chargedCumulativeAmount: "1000",
      signedMaxClaimable: "1000",
      signature: "0xabcd",
      balance: "10000",
      totalClaimed: "1000",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: 0,
      pendingRequest: {
        pendingId: "pending",
        signedMaxClaimable: "1000",
        expiresAt: Date.now() + 60_000,
      },
    });

    const result = await manager.refund();

    expect(result).toEqual([]);
    expect(facilitator.settle).not.toHaveBeenCalled();
    expect(await storage.get(channelId)).toBeDefined();
  });
});

describe("BatchSettlementChannelManager — getWithdrawalPendingSessions", () => {
  it("returns channel records with withdrawRequestedAt > 0", async () => {
    const storage = new InMemoryChannelStorage();
    const server = new BatchSettlementEvmScheme(RECEIVER, { storage });
    const manager = buildManager(server);

    const config1 = buildChannelConfig();
    const id1 = computeChannelId(config1);
    const config2 = buildChannelConfig({
      salt: "0x0000000000000000000000000000000000000000000000000000000000000099",
    });
    const id2 = computeChannelId(config2);

    await storeChannel(storage, id1, {
      channelId: id1,
      channelConfig: config1,
      chargedCumulativeAmount: "0",
      signedMaxClaimable: "0",
      signature: "0x",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: 0,
    });
    await storeChannel(storage, id2, {
      channelId: id2,
      channelConfig: config2,
      chargedCumulativeAmount: "0",
      signedMaxClaimable: "0",
      signature: "0x",
      balance: "10000",
      totalClaimed: "0",
      withdrawRequestedAt: 12345,
      refundNonce: 0,
      lastRequestTimestamp: 0,
    });

    const result = await manager.getWithdrawalPendingSessions();
    expect(result).toHaveLength(1);
    expect(result[0].channelId).toBe(id2);
  });
});
