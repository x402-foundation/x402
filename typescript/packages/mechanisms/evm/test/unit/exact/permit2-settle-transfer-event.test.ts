/**
 * Regression tests: the Permit2 exact settle path must verify the ERC-20
 * Transfer event in the settlement receipt, not just receipt.status.
 *
 * The proxy's settle() does not revert when a non-conforming token underpays
 * (fee-on-transfer) or moves nothing at all, so status alone cannot prove the
 * recipient was paid in full. This mirrors the EIP-3009 settle path, which
 * rejects the same receipts via verifyEip3009TransferEvent.
 */
import { describe, it, expect } from "vitest";
import { encodeAbiParameters, keccak256, padHex, toBytes, toHex, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { TransactionReceipt } from "viem";
import { settlePermit2 } from "../../../src/exact/facilitator/permit2";
import {
  ErrInvalidTransactionState,
  ErrTransferEventMismatch,
} from "../../../src/exact/facilitator/errors";
import {
  PERMIT2_ADDRESS,
  permit2WitnessTypes,
  x402ExactPermit2ProxyAddress,
} from "../../../src/constants";
import type { ExactPermit2Payload } from "../../../src/types";
import type { FacilitatorEvmSigner } from "../../../src/signer";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

const TRANSFER_TOPIC = keccak256(toBytes("Transfer(address,address,uint256)"));
const MOCK_TX = padHex("0xabc", { size: 32 });

// Real keypair so the EIP-712 signature is genuinely valid (ecrecover path).
const payerAccount = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const PAYER = payerAccount.address;
const RECEIVER = getAddress("0x2222222222222222222222222222222222222222");
const TOKEN = getAddress("0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29");
const NETWORK = "eip155:8453" as const;
const AMOUNT = "1000";

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
    transactionHash: MOCK_TX,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
}

function makeReceipt(
  logs: ReturnType<typeof makeTransferLog>[],
  status: "success" | "reverted" = "success",
): TransactionReceipt {
  return {
    status,
    logs,
    blockHash: padHex("0x1", { size: 32 }),
    blockNumber: 1n,
    transactionHash: MOCK_TX,
    transactionIndex: 0,
    cumulativeGasUsed: 0n,
    gasUsed: 0n,
    contractAddress: null,
    from: PAYER,
    to: x402ExactPermit2ProxyAddress,
    logsBloom: toHex(new Uint8Array(256)),
    type: "eip1559",
    effectiveGasPrice: 0n,
  } as unknown as TransactionReceipt;
}

async function makeSignedPayload(): Promise<ExactPermit2Payload> {
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: PAYER,
    permitted: { token: TOKEN, amount: AMOUNT },
    spender: x402ExactPermit2ProxyAddress as `0x${string}`,
    nonce: "123456789",
    deadline: String(now + 3600),
    witness: { to: RECEIVER, validAfter: "0" },
  };

  const signature = await payerAccount.signTypedData({
    domain: { name: "Permit2", chainId: 8453, verifyingContract: PERMIT2_ADDRESS },
    types: permit2WitnessTypes,
    primaryType: "PermitWitnessTransferFrom",
    message: {
      permitted: { token: TOKEN, amount: BigInt(AMOUNT) },
      spender: x402ExactPermit2ProxyAddress,
      nonce: BigInt(authorization.nonce),
      deadline: BigInt(authorization.deadline),
      witness: { to: RECEIVER, validAfter: 0n },
    },
  });

  return { signature, permit2Authorization: authorization };
}

function makeMockSigner(receipt: TransactionReceipt): FacilitatorEvmSigner {
  return {
    getCode: async ({ address }: { address: string }) =>
      getAddress(address) === TOKEN ? "0x6080604052" : "0x",
    writeContract: async () => MOCK_TX,
    waitForTransactionReceipt: async () => receipt,
    getAddresses: () => [],
    readContract: async () => {
      throw new Error("unexpected readContract in settle test (simulation disabled)");
    },
  } as unknown as FacilitatorEvmSigner;
}

function makeRequirements(): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    asset: TOKEN,
    amount: AMOUNT,
    payTo: RECEIVER,
    maxTimeoutSeconds: 3600,
    extra: {},
  } as unknown as PaymentRequirements;
}

function makePaymentPayload(requirements: PaymentRequirements): PaymentPayload {
  return {
    x402Version: 2,
    accepted: requirements,
    payload: undefined,
  } as unknown as PaymentPayload;
}

async function settleWithReceipt(receipt: TransactionReceipt) {
  const permit2Payload = await makeSignedPayload();
  const requirements = makeRequirements();
  const payload = makePaymentPayload(requirements);
  payload.payload = permit2Payload as unknown as Record<string, unknown>;
  return settlePermit2(makeMockSigner(receipt), payload, requirements, permit2Payload);
}

describe("settlePermit2 Transfer event verification", () => {
  it("rejects a receipt whose Transfer delivers less than the permitted amount (fee-on-transfer)", async () => {
    const receipt = makeReceipt([
      makeTransferLog({ address: TOKEN, from: PAYER, to: RECEIVER, value: 900n }),
    ]);

    const result = await settleWithReceipt(receipt);

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(ErrTransferEventMismatch);
    expect(result.transaction).toBe(MOCK_TX);
  });

  it("rejects a receipt with no Transfer event at all (silent no-op token)", async () => {
    const result = await settleWithReceipt(makeReceipt([]));

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(ErrTransferEventMismatch);
    expect(result.transaction).toBe(MOCK_TX);
  });

  it("rejects a receipt whose only Transfer moves the full amount to a different recipient", async () => {
    const receipt = makeReceipt([
      makeTransferLog({
        address: TOKEN,
        from: PAYER,
        to: getAddress("0x3333333333333333333333333333333333333333"),
        value: 1000n,
      }),
    ]);

    const result = await settleWithReceipt(receipt);

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(ErrTransferEventMismatch);
  });

  it("accepts a receipt with the full-payment Transfer event", async () => {
    const receipt = makeReceipt([
      makeTransferLog({ address: TOKEN, from: PAYER, to: RECEIVER, value: 1000n }),
    ]);

    const result = await settleWithReceipt(receipt);

    expect(result.success).toBe(true);
    expect(result.transaction).toBe(MOCK_TX);
    expect(result.payer).toBe(PAYER);
  });

  it("still reports invalid_transaction_state for a reverted receipt", async () => {
    const result = await settleWithReceipt(makeReceipt([], "reverted"));

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(ErrInvalidTransactionState);
  });
});
