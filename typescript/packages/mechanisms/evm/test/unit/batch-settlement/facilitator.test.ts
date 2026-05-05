import { describe, it, expect, beforeEach, vi } from "vitest";
import type { MockedFunction } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { encodeAbiParameters, encodeEventTopics, getAddress, isAddress } from "viem";
import type { Log } from "viem";

vi.mock("../../../src/multicall", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../src/multicall")>();
  return { ...actual, multicall: vi.fn() };
});

import { multicall } from "../../../src/multicall";
import { BatchSettlementEvmScheme } from "../../../src/batch-settlement/facilitator/scheme";
import { computeChannelId as computeChannelIdForNetwork } from "../../../src/batch-settlement/utils";
import {
  BATCH_SETTLEMENT_ADDRESS,
  ERC3009_DEPOSIT_COLLECTOR_ADDRESS,
  PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
} from "../../../src/batch-settlement/constants";
import { batchSettlementABI } from "../../../src/batch-settlement/abi";
import * as Errors from "../../../src/batch-settlement/errors";
import type {
  ChannelConfig,
  AuthorizerSigner,
  BatchSettlementDepositPayload,
  BatchSettlementVoucherPayload,
  BatchSettlementRefundPayload,
  BatchSettlementClaimPayload,
  BatchSettlementSettlePayload,
  BatchSettlementEnrichedRefundPayload,
} from "../../../src/batch-settlement/types";
import type { FacilitatorEvmSigner } from "../../../src/signer";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

const mockedMulticall = multicall as unknown as MockedFunction<typeof multicall>;

const PAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as `0x${string}`;
const RECEIVER = "0x9876543210987654321098765432109876543210" as `0x${string}`;
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`;
const FACILITATOR_ADDRESS = "0xFAC11174700123456789012345678901234aBCDe" as `0x${string}`;
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

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as `0x${string}`;
const RECEIVER_AUTHORIZER = "0x1111111111111111111111111111111111111111" as `0x${string}`;

function buildChannelConfig(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    payer: PAYER,
    payerAuthorizer: ZERO_ADDR,
    receiver: RECEIVER,
    receiverAuthorizer: RECEIVER_AUTHORIZER,
    token: ASSET,
    withdrawDelay: 900,
    salt: "0x0000000000000000000000000000000000000000000000000000000000000000",
    ...overrides,
  };
}

function makeRequirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "batch-settlement",
    network: NETWORK,
    amount: "1000",
    asset: ASSET,
    payTo: RECEIVER,
    maxTimeoutSeconds: 3600,
    extra: {
      name: "USDC",
      version: "2",
      receiverAuthorizer: RECEIVER_AUTHORIZER,
      assetTransferMethod: "eip3009",
      withdrawDelay: 900,
    },
    ...overrides,
  };
}

function buildSigner(overrides: Partial<FacilitatorEvmSigner> = {}): FacilitatorEvmSigner {
  return {
    getAddresses: () => [FACILITATOR_ADDRESS],
    readContract: vi.fn().mockResolvedValue(undefined),
    verifyTypedData: vi.fn().mockResolvedValue(true),
    writeContract: vi.fn().mockResolvedValue("0xtxhash" as `0x${string}`),
    sendTransaction: vi.fn(),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success" }),
    getCode: vi.fn(),
    ...overrides,
  };
}

function buildSettledLog(
  overrides: {
    receiver?: `0x${string}`;
    token?: `0x${string}`;
    sender?: `0x${string}`;
    amount?: string;
    address?: `0x${string}`;
  } = {},
): Log {
  const receiver = overrides.receiver ?? RECEIVER;
  const token = overrides.token ?? ASSET;
  const sender = overrides.sender ?? FACILITATOR_ADDRESS;

  return {
    address: overrides.address ?? BATCH_SETTLEMENT_ADDRESS,
    topics: encodeEventTopics({
      abi: batchSettlementABI,
      eventName: "Settled",
      args: { receiver, token, sender },
    }),
    data: encodeAbiParameters([{ type: "uint128" }], [BigInt(overrides.amount ?? "2500")]),
    blockHash: null,
    blockNumber: null,
    logIndex: null,
    transactionHash: null,
    transactionIndex: null,
    removed: false,
  } as Log;
}

function envelopeVoucher(payload: BatchSettlementVoucherPayload): PaymentPayload {
  return {
    x402Version: 2,
    accepted: { scheme: "batch-settlement", network: NETWORK },
    payload: payload as unknown as Record<string, unknown>,
  } as unknown as PaymentPayload;
}

function envelopeRefund(payload: BatchSettlementRefundPayload): PaymentPayload {
  return {
    x402Version: 2,
    accepted: { scheme: "batch-settlement", network: NETWORK },
    payload: payload as unknown as Record<string, unknown>,
  } as unknown as PaymentPayload;
}

function envelopeDeposit(payload: BatchSettlementDepositPayload): PaymentPayload {
  return {
    x402Version: 2,
    accepted: { scheme: "batch-settlement", network: NETWORK },
    payload: payload as unknown as Record<string, unknown>,
  } as unknown as PaymentPayload;
}

function envelopeSettle(payload: Record<string, unknown>): PaymentPayload {
  return {
    x402Version: 2,
    accepted: { scheme: "batch-settlement", network: NETWORK },
    payload,
  } as unknown as PaymentPayload;
}

beforeEach(() => {
  mockedMulticall.mockReset();
});

describe("BatchSettlementEvmScheme (Facilitator) — construction & metadata", () => {
  const authorizer = buildAuthorizerSigner();

  it("exposes scheme id and CAIP family", () => {
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer);
    expect(scheme.scheme).toBe("batch-settlement");
    expect(scheme.caipFamily).toBe("eip155:*");
  });

  it("getExtra returns the receiver-authorizer address from authorizerSigner", () => {
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer);
    expect(scheme.getExtra(NETWORK)).toEqual({ receiverAuthorizer: authorizer.address });
  });

  it("getSigners returns the facilitator addresses", () => {
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer);
    expect(scheme.getSigners(NETWORK)).toEqual([FACILITATOR_ADDRESS]);
  });
});

describe("BatchSettlementEvmScheme (Facilitator) — verify routing", () => {
  const authorizer = buildAuthorizerSigner();

  it("rejects with InvalidScheme when accepted.scheme mismatches", async () => {
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer);
    const config = buildChannelConfig();
    const result = await scheme.verify(
      {
        x402Version: 2,
        accepted: { scheme: "exact", network: NETWORK },
        payload: { type: "voucher", channelConfig: config } as Record<string, unknown>,
      } as unknown as PaymentPayload,
      makeRequirements(),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrInvalidScheme);
  });

  it("rejects with NetworkMismatch when accepted.network mismatches requirements", async () => {
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer);
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const voucher: BatchSettlementVoucherPayload = {
      type: "voucher",
      channelConfig: config,
      voucher: {
        channelId,
        maxClaimableAmount: "1000",
        signature: "0xdead",
      },
    };
    const result = await scheme.verify(
      {
        x402Version: 2,
        accepted: { scheme: "batch-settlement", network: "eip155:1" },
        payload: voucher as unknown as Record<string, unknown>,
      } as unknown as PaymentPayload,
      makeRequirements(),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrNetworkMismatch);
  });

  it("rejects with InvalidPayloadType for an unknown payload shape", async () => {
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer);
    const result = await scheme.verify(
      {
        x402Version: 2,
        accepted: { scheme: "batch-settlement", network: NETWORK },
        payload: { foo: "bar" } as Record<string, unknown>,
      } as unknown as PaymentPayload,
      makeRequirements(),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrInvalidPayloadType);
  });
});

describe("BatchSettlementEvmScheme (Facilitator) — verifyVoucher", () => {
  const authorizer = buildAuthorizerSigner();

  function makeVoucherPayload(
    overrides: {
      config?: ChannelConfig;
      voucher?: Partial<BatchSettlementVoucherPayload["voucher"]>;
    } = {},
  ): { payload: PaymentPayload; channelId: `0x${string}`; config: ChannelConfig } {
    const config = overrides.config ?? buildChannelConfig();
    const channelId = computeChannelId(config);
    const voucher: BatchSettlementVoucherPayload = {
      type: "voucher",
      channelConfig: config,
      voucher: {
        channelId,
        maxClaimableAmount: overrides.voucher?.maxClaimableAmount ?? "1000",
        signature: overrides.voucher?.signature ?? ("0xdead" as `0x${string}`),
      },
    };
    return { payload: envelopeVoucher(voucher), channelId, config };
  }

  it("returns isValid=true with channel state in extra on happy path", async () => {
    const signer = buildSigner();
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [10000n, 0n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const { payload, channelId } = makeVoucherPayload();

    const result = await scheme.verify(payload, makeRequirements());
    expect(result.isValid).toBe(true);
    expect(result.payer).toBe(PAYER);
    expect(result.extra?.channelId).toBe(channelId);
    expect(result.extra?.balance).toBe("10000");
    expect(result.extra?.totalClaimed).toBe("0");
  });

  it("returns InvalidVoucherSignature when verifyTypedData fails", async () => {
    const signer = buildSigner({ verifyTypedData: vi.fn().mockResolvedValue(false) });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const config = buildChannelConfig({
      payerAuthorizer: "0x0000000000000000000000000000000000000000",
    });
    const channelId = computeChannelId(config);
    const payload = envelopeVoucher({
      type: "voucher",
      channelConfig: config,
      voucher: {
        channelId,
        maxClaimableAmount: "1000",
        signature: "0xdead",
      },
    });

    const result = await scheme.verify(payload, makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrInvalidVoucherSignature);
  });

  it("uses ECDSA path (not ERC-1271) when payerAuthorizer is non-zero", async () => {
    const signer = buildSigner();
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const account = privateKeyToAccount(
      "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    );
    const config = buildChannelConfig({ payerAuthorizer: account.address });
    const channelId = computeChannelId(config);
    const sig = await account.signTypedData({
      domain: {
        name: "x402 Batch Settlement",
        version: "1",
        chainId: 84532,
        verifyingContract: getAddress(BATCH_SETTLEMENT_ADDRESS),
      },
      types: {
        Voucher: [
          { name: "channelId", type: "bytes32" },
          { name: "maxClaimableAmount", type: "uint128" },
        ],
      },
      primaryType: "Voucher",
      message: { channelId, maxClaimableAmount: 1000n },
    });

    mockedMulticall.mockResolvedValue([
      { status: "success", result: [10000n, 0n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);

    const payload = envelopeVoucher({
      type: "voucher",
      channelConfig: config,
      voucher: {
        channelId,
        maxClaimableAmount: "1000",
        signature: sig,
      },
    });

    const result = await scheme.verify(payload, makeRequirements());
    expect(result.isValid).toBe(true);
    expect(signer.verifyTypedData).not.toHaveBeenCalled();
  });

  it("propagates ErrRpcReadFailed when multicall reads fail", async () => {
    const signer = buildSigner();
    mockedMulticall.mockResolvedValue([
      { status: "failure", error: new Error("revert") },
      { status: "failure", error: new Error("revert") },
      { status: "failure", error: new Error("revert") },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const { payload } = makeVoucherPayload();

    await expect(scheme.verify(payload, makeRequirements())).rejects.toThrow(
      Errors.ErrRpcReadFailed,
    );
  });

  it("returns ChannelNotFound when balance is zero", async () => {
    const signer = buildSigner();
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [0n, 0n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const { payload } = makeVoucherPayload();

    const result = await scheme.verify(payload, makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrChannelNotFound);
  });

  it("returns CumulativeExceedsBalance when maxClaimable > balance", async () => {
    const signer = buildSigner();
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [500n, 0n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const { payload } = makeVoucherPayload({ voucher: { maxClaimableAmount: "1000" } });

    const result = await scheme.verify(payload, makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrCumulativeExceedsBalance);
  });

  it("returns CumulativeAmountBelowClaimed when maxClaimable <= totalClaimed", async () => {
    const signer = buildSigner();
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [10000n, 1000n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const { payload } = makeVoucherPayload({ voucher: { maxClaimableAmount: "1000" } });

    const result = await scheme.verify(payload, makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrCumulativeAmountBelowClaimed);
  });

  it("accepts a refund payload whose maxClaimable equals totalClaimed", async () => {
    const signer = buildSigner();
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [10000n, 1000n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const refundVoucher: BatchSettlementRefundPayload = {
      type: "refund",
      channelConfig: config,
      voucher: {
        channelId,
        maxClaimableAmount: "1000",
        signature: "0xdead",
      },
    };

    const result = await scheme.verify(envelopeRefund(refundVoucher), makeRequirements());
    expect(result.isValid).toBe(true);
  });

  it("still rejects a refund payload whose maxClaimable is below totalClaimed", async () => {
    const signer = buildSigner();
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [10000n, 1000n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const refundVoucher: BatchSettlementRefundPayload = {
      type: "refund",
      channelConfig: config,
      voucher: {
        channelId,
        maxClaimableAmount: "500",
        signature: "0xdead",
      },
    };

    const result = await scheme.verify(envelopeRefund(refundVoucher), makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrCumulativeAmountBelowClaimed);
  });

  it("returns ChannelIdMismatch when payload channelId does not match config", async () => {
    const signer = buildSigner();
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const config = buildChannelConfig();
    const payload = envelopeVoucher({
      type: "voucher",
      channelConfig: config,
      voucher: {
        channelId:
          "0x0000000000000000000000000000000000000000000000000000000000000099" as `0x${string}`,
        maxClaimableAmount: "1000",
        signature: "0xdead",
      },
    });

    const result = await scheme.verify(payload, makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrChannelIdMismatch);
  });
});

describe("BatchSettlementEvmScheme (Facilitator) — verifyDeposit", () => {
  const authorizer = buildAuthorizerSigner();

  function buildDeposit(overrides: Partial<BatchSettlementDepositPayload["deposit"]> = {}): {
    payload: PaymentPayload;
    channelId: `0x${string}`;
  } {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const now = Math.floor(Date.now() / 1000);
    const dp: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: {
        channelId,
        maxClaimableAmount: "1000",
        signature: "0xcafebabe",
      },
      deposit: {
        amount: "10000",
        authorization: {
          erc3009Authorization: {
            validAfter: String(now - 600),
            validBefore: String(now + 3600),
            salt: "0x0000000000000000000000000000000000000000000000000000000000000001",
            signature: "0xfeedface",
          },
        },
        ...overrides,
      },
    };
    return { payload: envelopeDeposit(dp), channelId };
  }

  it("returns isValid=true on the happy path", async () => {
    const signer = buildSigner();
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 1_000_000n },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const { payload, channelId } = buildDeposit();

    const result = await scheme.verify(payload, makeRequirements());
    expect(result.isValid).toBe(true);
    expect(result.payer).toBe(PAYER);
    expect(result.extra?.channelId).toBe(channelId);
  });

  it("returns InsufficientBalance when payer balance < deposit amount", async () => {
    const signer = buildSigner();
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 1n },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const { payload } = buildDeposit();

    const result = await scheme.verify(payload, makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrInsufficientBalance);
  });

  it("returns InvalidReceiveAuthorizationSignature when verifyTypedData fails", async () => {
    const signer = buildSigner({ verifyTypedData: vi.fn().mockResolvedValue(false) });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const { payload } = buildDeposit();

    const result = await scheme.verify(payload, makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrInvalidReceiveAuthorizationSignature);
  });

  it("returns ErrErc3009AuthorizationRequired when authorization is absent", async () => {
    const signer = buildSigner();
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const dp: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "1000", signature: "0xcafebabe" },
      deposit: {
        amount: "10000",
        authorization: {} as BatchSettlementDepositPayload["deposit"]["authorization"],
      },
    };
    const result = await scheme.verify(envelopeDeposit(dp), makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrErc3009AuthorizationRequired);
  });

  it("returns ErrMissingEip712Domain when extra lacks name/version", async () => {
    const signer = buildSigner();
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const { payload } = buildDeposit();
    const reqs = makeRequirements({
      extra: { receiverAuthorizer: RECEIVER_AUTHORIZER, assetTransferMethod: "eip3009" },
    });
    const result = await scheme.verify(payload, reqs);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrMissingEip712Domain);
  });

  it("returns ErrInvalidPayloadType when assetTransferMethod is not eip3009", async () => {
    const signer = buildSigner();
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const { payload } = buildDeposit();
    const reqs = makeRequirements({
      extra: {
        name: "USDC",
        version: "2",
        receiverAuthorizer: RECEIVER_AUTHORIZER,
        assetTransferMethod: "permit2",
      },
    });
    const result = await scheme.verify(payload, reqs);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrInvalidPayloadType);
  });

  it("returns ErrValidBeforeExpired when validBefore is in the past", async () => {
    const signer = buildSigner();
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const { payload } = buildDeposit({
      authorization: {
        erc3009Authorization: {
          validAfter: "0",
          validBefore: "1",
          salt: "0x0000000000000000000000000000000000000000000000000000000000000001",
          signature: "0xfeedface",
        },
      },
    });
    const result = await scheme.verify(payload, makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrValidBeforeExpired);
  });

  function buildPermit2Deposit(
    overrides: Partial<
      NonNullable<BatchSettlementDepositPayload["deposit"]["authorization"]["permit2Authorization"]>
    > = {},
  ): { payload: PaymentPayload; channelId: `0x${string}` } {
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const now = Math.floor(Date.now() / 1000);
    const authorization = {
      from: PAYER,
      permitted: { token: ASSET, amount: "10000" },
      spender: PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
      nonce: "123",
      deadline: String(now + 3600),
      witness: { channelId },
      signature: "0xfeedface" as `0x${string}`,
      ...overrides,
    };
    const dp: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "1000", signature: "0xcafebabe" },
      deposit: {
        amount: "10000",
        authorization: { permit2Authorization: authorization },
      },
    };
    return { payload: envelopeDeposit(dp), channelId };
  }

  it("accepts a Permit2 deposit and simulates with the Permit2 collector", async () => {
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "allowance") return 1_000_000n;
      return undefined;
    });
    const signer = buildSigner({ readContract });
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 1_000_000n },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const { payload } = buildPermit2Deposit();

    const result = await scheme.verify(
      payload,
      makeRequirements({
        extra: {
          assetTransferMethod: "permit2",
          name: "USDC",
          version: "2",
          receiverAuthorizer: RECEIVER_AUTHORIZER,
        },
      }),
    );

    expect(result.isValid).toBe(true);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "deposit",
        args: expect.arrayContaining([getAddress(PERMIT2_DEPOSIT_COLLECTOR_ADDRESS)]),
      }),
    );
  });

  it("rejects Permit2 deposits with a wrong spender", async () => {
    const signer = buildSigner();
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const { payload } = buildPermit2Deposit({
      spender: "0x0000000000000000000000000000000000000001",
    });

    const result = await scheme.verify(
      payload,
      makeRequirements({
        extra: {
          assetTransferMethod: "permit2",
          name: "USDC",
          version: "2",
          receiverAuthorizer: RECEIVER_AUTHORIZER,
        },
      }),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrPermit2InvalidSpender);
  });

  it("rejects Permit2 deposits whose amount differs from deposit.amount", async () => {
    const signer = buildSigner();
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const { payload } = buildPermit2Deposit({
      permitted: { token: ASSET, amount: "9999" },
    });

    const result = await scheme.verify(
      payload,
      makeRequirements({
        extra: {
          assetTransferMethod: "permit2",
          name: "USDC",
          version: "2",
          receiverAuthorizer: RECEIVER_AUTHORIZER,
        },
      }),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrPermit2AmountMismatch);
  });

  it("rejects Permit2 deposits without Permit2 allowance or sponsoring data", async () => {
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "allowance") return 1n;
      return undefined;
    });
    const signer = buildSigner({ readContract });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const { payload } = buildPermit2Deposit();

    const result = await scheme.verify(
      payload,
      makeRequirements({
        extra: {
          assetTransferMethod: "permit2",
          name: "USDC",
          version: "2",
          receiverAuthorizer: RECEIVER_AUTHORIZER,
        },
      }),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrPermit2AllowanceRequired);
  });
});

describe("BatchSettlementEvmScheme (Facilitator) — settle routing", () => {
  const authorizer = buildAuthorizerSigner();

  it("returns InvalidPayloadType for an unknown settle payload", async () => {
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer);
    const result = await scheme.settle(envelopeSettle({ unknown: true }), makeRequirements());
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrInvalidPayloadType);
  });

  it("dispatches deposit settle payloads via settleDeposit", async () => {
    const signer = buildSigner();
    // verifyDeposit uses a 4-call batch; post-tx readChannelState uses 3 calls with a
    // different shape — reusing the 4-tuple for the second batch mis-associates
    // token balance with pendingWithdrawals and throws.
    mockedMulticall
      .mockResolvedValueOnce([
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 1_000_000n },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 0n },
      ])
      .mockResolvedValue([
        { status: "success", result: [10_000n, 0n] },
        { status: "success", result: [0n, 0n] },
        { status: "success", result: 0n },
      ]);
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const config = buildChannelConfig();
    const channelId = computeChannelId(config);
    const now = Math.floor(Date.now() / 1000);

    const dp: BatchSettlementDepositPayload = {
      type: "deposit",
      channelConfig: config,
      voucher: { channelId, maxClaimableAmount: "1000", signature: "0xcafebabe" },
      deposit: {
        amount: "10000",
        authorization: {
          erc3009Authorization: {
            validAfter: String(now - 600),
            validBefore: String(now + 3600),
            salt: "0x0000000000000000000000000000000000000000000000000000000000000001",
            signature: "0xfeedface",
          },
        },
      },
    };

    const result = await scheme.settle(envelopeDeposit(dp), makeRequirements());
    expect(result.success).toBe(true);
    expect(result.amount).toBe("10000");
    expect(result.extra).toMatchObject({
      channelState: {
        channelId,
        balance: "10000",
        totalClaimed: "0",
        withdrawRequestedAt: 0,
        refundNonce: "0",
      },
    });
    expect(signer.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: getAddress(BATCH_SETTLEMENT_ADDRESS),
        functionName: "deposit",
      }),
    );
  });

  it('rejects voucher-less type:"deposit" envelopes as unknown payload type', async () => {
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer);
    const config = buildChannelConfig();
    const now = Math.floor(Date.now() / 1000);

    const voucherLessDeposit = {
      type: "deposit",
      channelConfig: config,
      deposit: {
        amount: "10000",
        authorization: {
          erc3009Authorization: {
            validAfter: String(now - 600),
            validBefore: String(now + 3600),
            salt: "0x0000000000000000000000000000000000000000000000000000000000000002",
            signature: "0xfeedface",
          },
        },
      },
    };

    const result = await scheme.settle(
      envelopeSettle(voucherLessDeposit as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrInvalidPayloadType);
  });

  it("dispatches settle payloads via executeSettle", async () => {
    const signer = buildSigner({
      waitForTransactionReceipt: vi.fn().mockResolvedValue({
        status: "success",
        logs: [buildSettledLog({ amount: "4321" })],
      }),
    });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const sp: BatchSettlementSettlePayload = {
      type: "settle",
      receiver: RECEIVER,
      token: ASSET,
    };
    const result = await scheme.settle(
      envelopeSettle(sp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(true);
    expect(result.amount).toBe("4321");
    expect(signer.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "settle",
      }),
    );
  });

  it("returns zero amount for no-op settle receipts without a Settled event", async () => {
    const signer = buildSigner({
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success", logs: [] }),
    });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const sp: BatchSettlementSettlePayload = {
      type: "settle",
      receiver: RECEIVER,
      token: ASSET,
    };
    const result = await scheme.settle(
      envelopeSettle(sp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(true);
    expect(result.amount).toBe("0");
  });

  it("returns empty amount when settle receipt logs are unavailable", async () => {
    const signer = buildSigner();
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const sp: BatchSettlementSettlePayload = {
      type: "settle",
      receiver: RECEIVER,
      token: ASSET,
    };
    const result = await scheme.settle(
      envelopeSettle(sp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(true);
    expect(result.amount).toBe("");
  });

  it("dispatches claim payloads via executeClaimWithSignature", async () => {
    const signer = buildSigner();
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const config = buildChannelConfig({ receiverAuthorizer: authorizer.address });
    const cp: BatchSettlementClaimPayload = {
      type: "claim",
      claims: [
        {
          voucher: { channel: config, maxClaimableAmount: "1000" },
          signature: "0xcafe",
          totalClaimed: "1000",
        },
      ],
    };
    const result = await scheme.settle(
      envelopeSettle(cp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(true);
    expect(result.amount).toBe("");
    expect(signer.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "claimWithSignature" }),
    );
  });

  it("returns AuthorizerAddressMismatch when claim authorizer doesn't match config", async () => {
    const signer = buildSigner();
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const config = buildChannelConfig({
      receiverAuthorizer: "0x1111111111111111111111111111111111111111",
    });
    const cp: BatchSettlementClaimPayload = {
      type: "claim",
      claims: [
        {
          voucher: { channel: config, maxClaimableAmount: "1000" },
          signature: "0xcafe",
          totalClaimed: "1000",
        },
      ],
    };
    const result = await scheme.settle(
      envelopeSettle(cp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrAuthorizerAddressMismatch);
  });

  it("dispatches enriched refund payloads via executeRefundWithSignature", async () => {
    const signer = buildSigner();
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [10000n, 0n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const config = buildChannelConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config);
    const rp: BatchSettlementEnrichedRefundPayload = {
      type: "refund",
      channelConfig: config,
      voucher: {
        channelId,
        maxClaimableAmount: "0",
        signature: "0xdead",
      },
      amount: "9000",
      refundNonce: "0",
      claims: [],
    };
    const result = await scheme.settle(
      envelopeSettle(rp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(true);
    expect(result.amount).toBe("9000");
    expect(result.extra).toMatchObject({
      channelState: {
        channelId,
        balance: "1000",
        totalClaimed: "0",
        withdrawRequestedAt: 0,
        refundNonce: "1",
      },
    });
    expect(mockedMulticall).toHaveBeenCalledTimes(1);
    expect(signer.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "refundWithSignature" }),
    );
  });

  it("polls post-refund state when a withdrawal is pending", async () => {
    const signer = buildSigner();
    mockedMulticall
      .mockResolvedValueOnce([
        { status: "success", result: [10000n, 0n] },
        { status: "success", result: [5000n, 1234n] },
        { status: "success", result: 7n },
      ])
      .mockResolvedValueOnce([
        { status: "success", result: [8000n, 0n] },
        { status: "success", result: [3000n, 1234n] },
        { status: "success", result: 8n },
      ]);
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const config = buildChannelConfig({ receiverAuthorizer: authorizer.address });
    const channelId = computeChannelId(config);
    const rp: BatchSettlementEnrichedRefundPayload = {
      type: "refund",
      channelConfig: config,
      voucher: {
        channelId,
        maxClaimableAmount: "0",
        signature: "0xdead",
      },
      amount: "2000",
      refundNonce: "7",
      claims: [],
    };

    const result = await scheme.settle(
      envelopeSettle(rp as unknown as Record<string, unknown>),
      makeRequirements(),
    );

    expect(result.success).toBe(true);
    expect(result.amount).toBe("2000");
    expect(result.extra).toMatchObject({
      channelState: {
        channelId,
        balance: "8000",
        withdrawRequestedAt: 1234,
        refundNonce: "8",
      },
    });
    expect(mockedMulticall).toHaveBeenCalledTimes(2);
  });

  it("returns ErrSettleSimulationFailed when settle simulation reverts", async () => {
    const signer = buildSigner({
      readContract: vi.fn().mockRejectedValue(new Error("revert")),
    });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const sp: BatchSettlementSettlePayload = {
      type: "settle",
      receiver: RECEIVER,
      token: ASSET,
    };
    const result = await scheme.settle(
      envelopeSettle(sp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrSettleSimulationFailed);
  });

  it("returns ErrSettleTransactionFailed when settle receipt is not success", async () => {
    const signer = buildSigner({
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "reverted" }),
    });
    const scheme = new BatchSettlementEvmScheme(signer, authorizer);
    const sp: BatchSettlementSettlePayload = {
      type: "settle",
      receiver: RECEIVER,
      token: ASSET,
    };
    const result = await scheme.settle(
      envelopeSettle(sp as unknown as Record<string, unknown>),
      makeRequirements(),
    );
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrSettleTransactionFailed);
  });
});

describe("BatchSettlementEvmScheme (Facilitator) — handler contract constants", () => {
  it("exposes well-formed distinct contract addresses", () => {
    const addrs = [
      BATCH_SETTLEMENT_ADDRESS,
      ERC3009_DEPOSIT_COLLECTOR_ADDRESS,
      PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
    ];
    for (const a of addrs) {
      expect(isAddress(a)).toBe(true);
    }
    expect(new Set(addrs.map(a => getAddress(a))).size).toBe(3);
  });
});
