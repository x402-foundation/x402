import { describe, it, expect, beforeEach, vi } from "vitest";
import { encodeAbiParameters } from "viem";
import { UptoEvmScheme } from "../../../src/upto/facilitator/scheme";
import type { FacilitatorEvmSigner } from "../../../src/signer";
import { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { x402UptoPermit2ProxyAddress, PERMIT2_ADDRESS } from "../../../src/constants";
import { ERC20_APPROVAL_GAS_SPONSORING_KEY } from "../../../src/upto/extensions";
import type { UptoPermit2Payload } from "../../../src/types";
import { resetAssetContractCache } from "../../../src/assetCache";

vi.mock("viem", async importOriginal => {
  const actual = await importOriginal<typeof import("viem")>();
  return { ...actual, parseTransaction: vi.fn(), recoverTransactionAddress: vi.fn() };
});

const FACILITATOR = "0xFAC11174700123456789012345678901234aBCDe" as `0x${string}`;
const TX_HASH = ("0x" + "12".repeat(32)) as `0x${string}`;
const now = () => Math.floor(Date.now() / 1000);

const CEILING = 1_000_000n;
const METERED = 300_000n;
// Payer can cover the metered charge but no longer the full ceiling
// (e.g. another upto session from the same payer settled in between).
const PAYER_BALANCE = 400_000n;

const permit2: UptoPermit2Payload = {
  signature: "0xmocksig" as `0x${string}`,
  permit2Authorization: {
    from: "0x1234567890123456789012345678901234567890",
    permitted: { token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: CEILING.toString() },
    spender: x402UptoPermit2ProxyAddress,
    nonce: "12345",
    deadline: (now() + 3600).toString(),
    witness: {
      to: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
      facilitator: FACILITATOR,
      validAfter: (now() - 600).toString(),
    },
  },
};

const payload = {
  x402Version: 2,
  accepted: { scheme: "upto", network: "eip155:8453" },
  payload: permit2,
} as PaymentPayload;

const requirements = (amount: bigint): PaymentRequirements => ({
  scheme: "upto",
  network: "eip155:8453",
  amount: amount.toString(),
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
  maxTimeoutSeconds: 300,
  extra: { assetTransferMethod: "permit2", facilitatorAddress: FACILITATOR },
});

describe("upto settle-time simulation amount", () => {
  let signer: FacilitatorEvmSigner;

  beforeEach(() => {
    resetAssetContractCache();
    signer = {
      getAddresses: () => [FACILITATOR],
      // eth_call of x402UptoPermit2Proxy.settle reverts when the charged amount exceeds the
      // payer's balance, like the real token transfer inside Permit2 would.
      readContract: vi
        .fn()
        .mockImplementation(async (args: { functionName?: string; args?: unknown[] }) => {
          if (args.functionName === "isValidSignature") return "0x1626ba7e";
          if (args.functionName === "settle") {
            if ((args.args![1] as bigint) > PAYER_BALANCE) {
              throw new Error("execution reverted: TRANSFER_FROM_FAILED");
            }
            return undefined;
          }
          return PAYER_BALANCE;
        }),
      verifyTypedData: vi.fn().mockResolvedValue(true),
      writeContract: vi.fn().mockResolvedValue(TX_HASH),
      sendTransaction: vi.fn(),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success" }),
      getCode: vi.fn().mockResolvedValue("0x6080604052"),
    };
  });

  it("settles a metered amount the payer can cover even if the ceiling is no longer covered", async () => {
    const result = await new UptoEvmScheme(signer).settle(payload, requirements(METERED));

    expect(result.errorReason).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.amount).toBe(METERED.toString());
    const write = (signer.writeContract as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(write.args[1]).toBe(METERED);
  });

  it("still rejects a metered amount the payer cannot cover", async () => {
    const result = await new UptoEvmScheme(signer).settle(
      payload,
      requirements(PAYER_BALANCE + 1n),
    );

    expect(result.success).toBe(false);
    expect(signer.writeContract).not.toHaveBeenCalled();
  });

  it("checks the payer's balance against the metered amount on the ERC-20 approval sponsoring path", async () => {
    const payer = permit2.permit2Authorization.from as `0x${string}`;
    const token = permit2.permit2Authorization.permitted.token as `0x${string}`;
    const { parseTransaction, recoverTransactionAddress } = await import("viem");
    vi.mocked(parseTransaction).mockReturnValue({
      to: token,
      data: ("0x095ea7b3000000000000000000000000000000000022d473030f116ddee9f6b43ac78ba3" +
        "f".repeat(64)) as `0x${string}`,
    } as never);
    vi.mocked(recoverTransactionAddress).mockResolvedValue(payer);

    // Without simulateTransactions this path only runs the prerequisite checks: PERMIT2(),
    // balanceOf(payer) and allowance(payer, PERMIT2) through one multicall.
    (signer.readContract as ReturnType<typeof vi.fn>).mockImplementation(
      async (args: { functionName?: string; args?: unknown[] }) => {
        if (args.functionName === "isValidSignature") return "0x1626ba7e";
        if (args.functionName === "tryAggregate") {
          return [
            {
              success: true,
              returnData: encodeAbiParameters([{ type: "address" }], [PERMIT2_ADDRESS]),
            },
            {
              success: true,
              returnData: encodeAbiParameters([{ type: "uint256" }], [PAYER_BALANCE]),
            },
            { success: true, returnData: encodeAbiParameters([{ type: "uint256" }], [0n]) },
          ].slice(0, (args.args![1] as unknown[]).length);
        }
        return PAYER_BALANCE;
      },
    );
    const sendTransactions = vi
      .fn()
      .mockResolvedValue(["0x" + "11".repeat(32), "0x" + "22".repeat(32)]);
    const context = {
      getExtension: vi.fn().mockImplementation((key: string) =>
        key === ERC20_APPROVAL_GAS_SPONSORING_KEY
          ? {
              key,
              signer: {
                ...signer,
                getCode: vi.fn().mockResolvedValue("0x"),
                sendTransactions,
                waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success" }),
              },
            }
          : undefined,
      ),
    };
    const sponsoredPayload = {
      ...payload,
      extensions: {
        erc20ApprovalGasSponsoring: {
          info: {
            from: payer,
            asset: token,
            spender: PERMIT2_ADDRESS,
            amount: (2n ** 256n - 1n).toString(),
            signedTransaction: "0x02f8ab0102030405060708",
            version: "1",
          },
          schema: {},
        },
      },
    } as PaymentPayload;

    const result = await new UptoEvmScheme(signer).settle(
      sponsoredPayload,
      requirements(METERED),
      context as never,
    );

    expect(result.errorReason).toBeUndefined();
    expect(result.success).toBe(true);
    expect(sendTransactions).toHaveBeenCalledTimes(1);
  });
});
