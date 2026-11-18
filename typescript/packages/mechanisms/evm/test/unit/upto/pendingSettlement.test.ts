import { describe, it, expect, beforeEach, vi } from "vitest";
import { UptoEvmScheme } from "../../../src/upto/facilitator/scheme";
import type { FacilitatorEvmSigner } from "../../../src/signer";
import { PaymentPayload, PaymentRequirements, FacilitatorContext } from "@x402/core/types";
import {
  InMemoryPendingSettlementStore,
  type PendingSettlementStore,
} from "@x402/core/facilitator";
import { x402UptoPermit2ProxyAddress } from "../../../src/constants";
import { ErrSettlementPending } from "../../../src/exact/facilitator/errors";
import { ERC20_APPROVAL_GAS_SPONSORING_KEY } from "../../../src/exact/extensions";
import type { UptoPermit2Payload } from "../../../src/types";
import { resetAssetContractCache } from "../../../src/assetCache";

vi.mock("viem", async importOriginal => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    parseTransaction: vi.fn(),
    recoverTransactionAddress: vi.fn(),
  };
});

const FACILITATOR_ADDRESS = "0xFAC11174700123456789012345678901234aBCDe" as `0x${string}`;
const MOCK_TX_HASH = ("0x" + "12".repeat(32)) as `0x${string}`;

const now = () => Math.floor(Date.now() / 1000);

/**
 * Wraps a readContract mock so isValidSignature returns the ERC-1271 magic
 * value while delegating other calls to `impl` — mirrors
 * upto/facilitator.test.ts's `rcWithSig`.
 *
 * @param impl - Value returned for any call other than isValidSignature
 * @returns A mocked readContract implementation
 */
function rcWithSig(impl: unknown) {
  return vi.fn().mockImplementation(async (args: { functionName?: string }) => {
    if (args?.functionName === "isValidSignature") return "0x1626ba7e";
    return impl;
  });
}

function makePermit2Payload(overrides?: Partial<UptoPermit2Payload>): UptoPermit2Payload {
  const base: UptoPermit2Payload = {
    signature: "0xmocksig" as `0x${string}`,
    permit2Authorization: {
      from: "0x1234567890123456789012345678901234567890",
      permitted: {
        token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount: "1000000",
      },
      spender: x402UptoPermit2ProxyAddress,
      nonce: "12345",
      deadline: (now() + 3600).toString(),
      witness: {
        to: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
        facilitator: FACILITATOR_ADDRESS,
        validAfter: (now() - 600).toString(),
      },
    },
  };
  return { ...base, ...overrides };
}

function makePayload(permit2?: UptoPermit2Payload): PaymentPayload {
  return {
    x402Version: 2,
    accepted: { scheme: "upto", network: "eip155:8453" },
    payload: permit2 ?? makePermit2Payload(),
  } as PaymentPayload;
}

function makeRequirements(overrides?: Partial<PaymentRequirements>): PaymentRequirements {
  return {
    scheme: "upto",
    network: "eip155:8453",
    amount: "1000000",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
    maxTimeoutSeconds: 300,
    extra: { assetTransferMethod: "permit2", facilitatorAddress: FACILITATOR_ADDRESS },
    ...overrides,
  };
}

describe("UptoEvmScheme pending-settlement store integration", () => {
  let mockSigner: FacilitatorEvmSigner;
  let store: PendingSettlementStore;

  beforeEach(() => {
    resetAssetContractCache();

    mockSigner = {
      getAddresses: () => [FACILITATOR_ADDRESS],
      readContract: rcWithSig(BigInt("999999999999999999")),
      verifyTypedData: vi.fn().mockResolvedValue(true),
      writeContract: vi.fn().mockResolvedValue(MOCK_TX_HASH),
      sendTransaction: vi.fn(),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success" }),
      getCode: vi.fn().mockResolvedValue("0x6080604052"),
    };
    store = new InMemoryPendingSettlementStore();
  });

  it("cache-miss + broadcast success: leaves no pending entry", async () => {
    const scheme = new UptoEvmScheme(mockSigner, { pendingSettlementStore: store });
    const payload = makePayload();

    const result = await scheme.settle(payload, makeRequirements());

    expect(result.success).toBe(true);
    expect(await store.get("0xmocksig")).toBeUndefined();
  });

  it("cache-miss + broadcast-then-wait-fails: returns settlement_pending and populates the store", async () => {
    mockSigner.waitForTransactionReceipt = vi.fn().mockRejectedValue(new Error("rpc timeout"));
    const scheme = new UptoEvmScheme(mockSigner, { pendingSettlementStore: store });
    const payload = makePayload();

    const result = await scheme.settle(payload, makeRequirements());

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(ErrSettlementPending);
    expect(result.transaction).toBe(MOCK_TX_HASH);
    expect(await store.get("0xmocksig")).toBe(MOCK_TX_HASH);
  });

  it("cache-hit: skips verify/broadcast and reconciles against the cached tx", async () => {
    const scheme = new UptoEvmScheme(mockSigner, { pendingSettlementStore: store });
    const payload = makePayload();
    await store.set("0xmocksig", MOCK_TX_HASH);

    const result = await scheme.settle(payload, makeRequirements());

    expect(result.success).toBe(true);
    expect(result.transaction).toBe(MOCK_TX_HASH);
    expect(mockSigner.writeContract).not.toHaveBeenCalled();
    expect(await store.get("0xmocksig")).toBeUndefined();
  });

  it("cache-hit: still unconfirmed returns settlement_pending again without re-broadcasting", async () => {
    mockSigner.waitForTransactionReceipt = vi.fn().mockRejectedValue(new Error("still pending"));
    const scheme = new UptoEvmScheme(mockSigner, { pendingSettlementStore: store });
    const payload = makePayload();
    await store.set("0xmocksig", MOCK_TX_HASH);

    const result = await scheme.settle(payload, makeRequirements());

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(ErrSettlementPending);
    expect(mockSigner.writeContract).not.toHaveBeenCalled();
    expect(await store.get("0xmocksig")).toBe(MOCK_TX_HASH);
  });

  it("cache-hit with ERC-20-approval extension: reconciles via the extension signer, not the base signer", async () => {
    const scheme = new UptoEvmScheme(mockSigner, { pendingSettlementStore: store });
    const payload: PaymentPayload = {
      ...makePayload(),
      extensions: {
        erc20ApprovalGasSponsoring: {
          info: {
            from: "0x1234567890123456789012345678901234567890",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
            amount: "1000000",
            signedTransaction: "0x" + "aa".repeat(100),
            version: "1",
          },
          schema: {},
        },
      },
    };
    await store.set("0xmocksig", MOCK_TX_HASH);

    const extensionWaitForReceipt = vi.fn().mockResolvedValue({ status: "success" });
    const baseSignerWaitForReceipt = vi.fn();
    mockSigner.waitForTransactionReceipt = baseSignerWaitForReceipt;
    const mockContext = {
      getExtension: vi.fn().mockImplementation((key: string) => {
        if (key === ERC20_APPROVAL_GAS_SPONSORING_KEY) {
          return {
            key: ERC20_APPROVAL_GAS_SPONSORING_KEY,
            signer: {
              ...mockSigner,
              waitForTransactionReceipt: extensionWaitForReceipt,
            },
          };
        }
        return undefined;
      }),
    };

    const result = await scheme.settle(
      payload,
      makeRequirements(),
      mockContext as unknown as FacilitatorContext,
    );

    expect(result.success).toBe(true);
    expect(result.transaction).toBe(MOCK_TX_HASH);
    expect(extensionWaitForReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ hash: MOCK_TX_HASH }),
    );
    expect(baseSignerWaitForReceipt).not.toHaveBeenCalled();
    expect(mockSigner.writeContract).not.toHaveBeenCalled();
  });

  it("verify-only failure (spender mismatch) is terminal and never touches the store", async () => {
    const scheme = new UptoEvmScheme(mockSigner, { pendingSettlementStore: store });
    const p2 = makePermit2Payload();
    p2.permit2Authorization.spender = "0x0000000000000000000000000000000000000001";
    const payload = makePayload(p2);

    const result = await scheme.settle(payload, makeRequirements());

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("invalid_permit2_spender");
    expect(mockSigner.writeContract).not.toHaveBeenCalled();
    expect(await store.get("0xmocksig")).toBeUndefined();
  });

  it("uses a fresh in-memory store by default when none is provided", async () => {
    const scheme = new UptoEvmScheme(mockSigner);
    const result = await scheme.settle(makePayload(), makeRequirements());
    expect(result.success).toBe(true);
  });
});
