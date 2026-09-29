import { describe, it, expect, vi } from "vitest";
import type { MockedFunction } from "vitest";
import { encodeAbiParameters, keccak256, padHex, toBytes, toHex } from "viem";
import type { TransactionReceipt } from "viem";

vi.mock("../../../src/multicall", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../src/multicall")>();
  return { ...actual, multicall: vi.fn() };
});

import { multicall } from "../../../src/multicall";
import {
  diagnoseEip3009SimulationFailure,
  parseEip3009TransferError,
  verifyEip3009TransferEvent,
} from "../../../src/exact/facilitator/eip3009-utils";
import {
  checkPermit2Prerequisites,
  diagnosePermit2SimulationFailure,
} from "../../../src/shared/permit2";
import { PERMIT2_ADDRESS, x402ExactPermit2ProxyAddress } from "../../../src/constants";
import * as Errors from "../../../src/exact/facilitator/errors";
import type { FacilitatorEvmSigner } from "../../../src/signer";
import type { ExactEIP3009Payload } from "../../../src/types";
import type { PaymentRequirements } from "@x402/core/types";

const mockedMulticall = multicall as unknown as MockedFunction<typeof multicall>;

const TRANSFER_TOPIC = keccak256(toBytes("Transfer(address,address,uint256)"));

function makeTransferLog(opts: {
  address: `0x${string}`;
  from: `0x${string}`;
  to: `0x${string}`;
  value: bigint;
}) {
  return {
    address: opts.address,
    topics: [TRANSFER_TOPIC, padHex(opts.from, { size: 32 }), padHex(opts.to, { size: 32 })] as [
      `0x${string}`,
      `0x${string}`,
      `0x${string}`,
    ],
    data: encodeAbiParameters([{ type: "uint256" }], [opts.value]),
    blockHash: padHex("0x1", { size: 32 }),
    blockNumber: 1n,
    transactionHash: padHex("0x2", { size: 32 }),
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
}

function makeReceipt(logs: ReturnType<typeof makeTransferLog>[]): TransactionReceipt {
  return {
    status: "success",
    logs,
    blockHash: padHex("0x1", { size: 32 }),
    blockNumber: 1n,
    transactionHash: padHex("0x2", { size: 32 }),
    transactionIndex: 0,
    cumulativeGasUsed: 0n,
    gasUsed: 0n,
    contractAddress: null,
    from: "0x0000000000000000000000000000000000000000",
    to: "0x0000000000000000000000000000000000000000",
    logsBloom: toHex(new Uint8Array(256)),
    type: "eip1559",
    effectiveGasPrice: 0n,
  } as unknown as TransactionReceipt;
}

const TOKEN: `0x${string}` = "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29";
const OTHER_TOKEN: `0x${string}` = "0x0000000000000000000000000000000000000bad";
const PAYER: `0x${string}` = "0x1111111111111111111111111111111111111111";
const RECEIVER: `0x${string}` = "0x2222222222222222222222222222222222222222";
const ATTACKER: `0x${string}` = "0x3333333333333333333333333333333333333333";

describe("verifyEip3009TransferEvent", () => {
  it("matches a canonical Transfer event", () => {
    const receipt = makeReceipt([
      makeTransferLog({ address: TOKEN, from: PAYER, to: RECEIVER, value: 1000n }),
    ]);
    expect(
      verifyEip3009TransferEvent(receipt.logs, TOKEN, {
        from: PAYER,
        to: RECEIVER,
        value: 1000n,
      }),
    ).toBe(true);
  });

  it("matches even when other unrelated logs are present", () => {
    const receipt = makeReceipt([
      makeTransferLog({ address: OTHER_TOKEN, from: ATTACKER, to: RECEIVER, value: 999n }),
      makeTransferLog({ address: TOKEN, from: PAYER, to: RECEIVER, value: 1000n }),
    ]);
    expect(
      verifyEip3009TransferEvent(receipt.logs, TOKEN, {
        from: PAYER,
        to: RECEIVER,
        value: 1000n,
      }),
    ).toBe(true);
  });

  it("rejects when value differs", () => {
    const receipt = makeReceipt([
      makeTransferLog({ address: TOKEN, from: PAYER, to: RECEIVER, value: 1n }),
    ]);
    expect(
      verifyEip3009TransferEvent(receipt.logs, TOKEN, {
        from: PAYER,
        to: RECEIVER,
        value: 1000n,
      }),
    ).toBe(false);
  });

  it("rejects when recipient differs", () => {
    const receipt = makeReceipt([
      makeTransferLog({ address: TOKEN, from: PAYER, to: ATTACKER, value: 1000n }),
    ]);
    expect(
      verifyEip3009TransferEvent(receipt.logs, TOKEN, {
        from: PAYER,
        to: RECEIVER,
        value: 1000n,
      }),
    ).toBe(false);
  });

  it("rejects when sender differs", () => {
    const receipt = makeReceipt([
      makeTransferLog({ address: TOKEN, from: ATTACKER, to: RECEIVER, value: 1000n }),
    ]);
    expect(
      verifyEip3009TransferEvent(receipt.logs, TOKEN, {
        from: PAYER,
        to: RECEIVER,
        value: 1000n,
      }),
    ).toBe(false);
  });

  it("rejects when the only Transfer log is from a different token contract", () => {
    const receipt = makeReceipt([
      makeTransferLog({ address: OTHER_TOKEN, from: PAYER, to: RECEIVER, value: 1000n }),
    ]);
    expect(
      verifyEip3009TransferEvent(receipt.logs, TOKEN, {
        from: PAYER,
        to: RECEIVER,
        value: 1000n,
      }),
    ).toBe(false);
  });

  it("rejects when receipt has no logs at all", () => {
    const receipt = makeReceipt([]);
    expect(
      verifyEip3009TransferEvent(receipt.logs, TOKEN, {
        from: PAYER,
        to: RECEIVER,
        value: 1000n,
      }),
    ).toBe(false);
  });

  it("address comparison is case-insensitive", () => {
    const receipt = makeReceipt([
      makeTransferLog({
        address: TOKEN.toLowerCase() as `0x${string}`,
        from: PAYER.toUpperCase().replace("0X", "0x") as `0x${string}`,
        to: RECEIVER,
        value: 1000n,
      }),
    ]);
    expect(
      verifyEip3009TransferEvent(receipt.logs, TOKEN, {
        from: PAYER,
        to: RECEIVER,
        value: 1000n,
      }),
    ).toBe(true);
  });
});

describe("parseEip3009TransferError", () => {
  it("maps known revert substrings to specific facilitator error codes", () => {
    expect(parseEip3009TransferError(new Error("authorization expired"))).toBe(
      Errors.ErrValidBeforeExpired,
    );
    expect(parseEip3009TransferError(new Error("AuthorizationExpired()"))).toBe(
      Errors.ErrValidBeforeExpired,
    );
    expect(parseEip3009TransferError(new Error("authorization is not yet valid"))).toBe(
      Errors.ErrValidAfterInFuture,
    );
    expect(parseEip3009TransferError(new Error("AuthorizationAlreadyUsed"))).toBe(
      Errors.ErrEip3009NonceAlreadyUsed,
    );
    expect(parseEip3009TransferError(new Error("ERC20InsufficientBalance"))).toBe(
      Errors.ErrEip3009InsufficientBalance,
    );
    expect(parseEip3009TransferError(new Error("transfer amount exceeds balance"))).toBe(
      Errors.ErrEip3009InsufficientBalance,
    );
    expect(parseEip3009TransferError(new Error("invalid signature"))).toBe(
      Errors.ErrInvalidSignature,
    );
    expect(parseEip3009TransferError(new Error("SignerMismatch"))).toBe(Errors.ErrInvalidSignature);
    expect(parseEip3009TransferError("unknown boom")).toBe(Errors.ErrTransactionFailed);
  });
});

describe("diagnoseEip3009SimulationFailure", () => {
  const payload: ExactEIP3009Payload = {
    authorization: {
      from: PAYER,
      to: RECEIVER,
      value: "1000",
      validAfter: "0",
      validBefore: "9999999999",
      nonce: ("0x" + "aa".repeat(32)) as `0x${string}`,
    },
    signature: "0xsig",
  };
  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: "eip155:84532",
    amount: "1000",
    asset: TOKEN,
    payTo: RECEIVER,
    maxTimeoutSeconds: 3600,
    extra: { name: "USDC", version: "2" },
  };
  const signer = { readContract: vi.fn() } as unknown as FacilitatorEvmSigner;

  it("reports nonce already used, name/version mismatch, and insufficient balance", async () => {
    mockedMulticall.mockResolvedValueOnce([
      { status: "success", result: 1000n },
      { status: "success", result: "USDC" },
      { status: "success", result: "2" },
      { status: "success", result: true },
    ]);
    expect(
      (await diagnoseEip3009SimulationFailure(signer, TOKEN, payload, requirements, "1000"))
        .invalidReason,
    ).toBe(Errors.ErrEip3009NonceAlreadyUsed);

    mockedMulticall.mockResolvedValueOnce([
      { status: "success", result: 1000n },
      { status: "success", result: "USD Coin" },
      { status: "success", result: "2" },
      { status: "success", result: false },
    ]);
    expect(
      (await diagnoseEip3009SimulationFailure(signer, TOKEN, payload, requirements, "1000"))
        .invalidReason,
    ).toBe(Errors.ErrEip3009TokenNameMismatch);

    mockedMulticall.mockResolvedValueOnce([
      { status: "success", result: 1000n },
      { status: "success", result: "USDC" },
      { status: "success", result: "1" },
      { status: "success", result: false },
    ]);
    expect(
      (await diagnoseEip3009SimulationFailure(signer, TOKEN, payload, requirements, "1000"))
        .invalidReason,
    ).toBe(Errors.ErrEip3009TokenVersionMismatch);

    mockedMulticall.mockResolvedValueOnce([
      { status: "success", result: 1n },
      { status: "success", result: "USDC" },
      { status: "success", result: "2" },
      { status: "success", result: false },
    ]);
    expect(
      (await diagnoseEip3009SimulationFailure(signer, TOKEN, payload, requirements, "1000"))
        .invalidReason,
    ).toBe(Errors.ErrEip3009InsufficientBalance);
  });

  it("reports EIP-3009 unsupported when authorizationState cannot be read", async () => {
    mockedMulticall.mockResolvedValueOnce([
      { status: "success", result: 1000n },
      { status: "success", result: "USDC" },
      { status: "success", result: "2" },
      { status: "failure", error: new Error("missing") },
    ]);
    expect(
      (await diagnoseEip3009SimulationFailure(signer, TOKEN, payload, requirements, "1000"))
        .invalidReason,
    ).toBe(Errors.ErrEip3009NotSupported);
  });

  it("falls back to simulation_failed when the diagnostic multicall itself throws", async () => {
    mockedMulticall.mockRejectedValueOnce(new Error("rpc down"));
    expect(
      (await diagnoseEip3009SimulationFailure(signer, TOKEN, payload, requirements, "1000"))
        .invalidReason,
    ).toBe(Errors.ErrEip3009SimulationFailed);
  });
});

describe("diagnosePermit2SimulationFailure / checkPermit2Prerequisites", () => {
  const payer = PAYER;
  const permit2Payload = {
    signature: "0xsig" as `0x${string}`,
    permit2Authorization: {
      from: payer,
      permitted: { token: TOKEN, amount: "1000" },
      spender: x402ExactPermit2ProxyAddress,
      nonce: "1",
      deadline: "9",
      witness: { to: RECEIVER, validAfter: "0" },
    },
  };
  const config = { proxyAddress: x402ExactPermit2ProxyAddress, proxyABI: [] };
  const signer = { readContract: vi.fn() } as unknown as FacilitatorEvmSigner;

  it("maps proxy, balance, and allowance failures", async () => {
    mockedMulticall.mockResolvedValueOnce([
      { status: "failure", error: new Error("missing") },
      { status: "success", result: 1000n },
      { status: "success", result: 1000n },
    ]);
    expect(
      (await diagnosePermit2SimulationFailure(config, signer, TOKEN, permit2Payload, "1000"))
        .invalidReason,
    ).toBe(Errors.ErrPermit2ProxyNotDeployed);

    mockedMulticall.mockResolvedValueOnce([
      { status: "success", result: PERMIT2_ADDRESS },
      { status: "success", result: 1n },
      { status: "success", result: 1000n },
    ]);
    expect(
      (await diagnosePermit2SimulationFailure(config, signer, TOKEN, permit2Payload, "1000"))
        .invalidReason,
    ).toBe(Errors.ErrPermit2InsufficientBalance);

    mockedMulticall.mockResolvedValueOnce([
      { status: "success", result: PERMIT2_ADDRESS },
      { status: "success", result: 1000n },
      { status: "success", result: 1n },
    ]);
    expect(
      (await diagnosePermit2SimulationFailure(config, signer, TOKEN, permit2Payload, "1000"))
        .invalidReason,
    ).toBe(Errors.ErrPermit2AllowanceRequired);

    mockedMulticall.mockResolvedValueOnce([
      { status: "failure", error: new Error("missing") },
      { status: "success", result: 1000n },
    ]);
    expect(
      (await checkPermit2Prerequisites(config, signer, TOKEN, payer, "1000")).invalidReason,
    ).toBe(Errors.ErrPermit2ProxyNotDeployed);

    mockedMulticall.mockResolvedValueOnce([
      { status: "success", result: PERMIT2_ADDRESS },
      { status: "success", result: 1n },
    ]);
    expect(
      (await checkPermit2Prerequisites(config, signer, TOKEN, payer, "1000")).invalidReason,
    ).toBe(Errors.ErrPermit2InsufficientBalance);
  });
});
