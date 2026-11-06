import { describe, it, expect, beforeEach, vi } from "vitest";
import { ExactEvmScheme } from "../../../src/exact/facilitator/scheme";
import { ExactEvmScheme as ClientExactEvmScheme } from "../../../src/exact/client/scheme";
import type { ClientEvmSigner, FacilitatorEvmSigner } from "../../../src/signer";
import { PaymentRequirements, PaymentPayload, FacilitatorContext } from "@x402/core/types";
import {
  InMemoryPendingSettlementStore,
  type PendingSettlementStore,
} from "@x402/core/facilitator";
import { x402ExactPermit2ProxyAddress } from "../../../src/constants";
import { ERC20_APPROVAL_GAS_SPONSORING_KEY } from "../../../src/exact/extensions";
import * as Errors from "../../../src/exact/facilitator/errors";
import { resetAssetContractCache } from "../../../src/assetCache";

const MOCK_TX_HASH = ("0x" + "a1".repeat(32)) as `0x${string}`;

// Wraps a readContract mock so isValidSignature returns the ERC-1271 magic value while
// delegating other calls to `impl` — mirrors exact/facilitator.test.ts's `rcWithSig`.
const SIG_VALID = "0x1626ba7e";
function rcWithSig(impl: unknown) {
  return vi.fn().mockImplementation(async (args: { functionName?: string }) => {
    if (args?.functionName === "isValidSignature") return SIG_VALID;
    return impl;
  });
}

const REQUIREMENTS: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "1000000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x742D35CC6634c0532925A3b844BC9E7595F0BEb0",
  maxTimeoutSeconds: 300,
  extra: { name: "USDC", version: "2" },
};

const PERMIT2_REQUIREMENTS: PaymentRequirements = {
  ...REQUIREMENTS,
  extra: { ...REQUIREMENTS.extra, assetTransferMethod: "permit2" },
};

/**
 * Builds a valid Permit2 payload with the given signature, for tests that
 * need to control the pending-settlement-store key precisely.
 *
 * @param signature - The signature to embed in the payload
 * @returns A full permit2 PaymentPayload
 */
function buildPermit2Payload(signature: string): PaymentPayload {
  return {
    x402Version: 2,
    payload: {
      signature,
      permit2Authorization: {
        from: "0x1234567890123456789012345678901234567890",
        permitted: {
          token: PERMIT2_REQUIREMENTS.asset,
          amount: PERMIT2_REQUIREMENTS.amount,
        },
        spender: x402ExactPermit2ProxyAddress,
        nonce: "12345",
        deadline: "999999999999",
        witness: {
          to: PERMIT2_REQUIREMENTS.payTo,
          validAfter: "0",
        },
      },
    },
    accepted: PERMIT2_REQUIREMENTS,
    resource: { url: "", description: "", mimeType: "" },
  };
}

describe("ExactEvmScheme pending-settlement store integration", () => {
  let mockFacilitatorSigner: FacilitatorEvmSigner;
  let client: ClientExactEvmScheme;
  let mockClientSigner: ClientEvmSigner;
  let store: PendingSettlementStore;

  beforeEach(() => {
    resetAssetContractCache();

    mockClientSigner = {
      address: "0x1234567890123456789012345678901234567890",
      signTypedData: vi.fn().mockResolvedValue("0xmocksignature"),
      readContract: vi.fn().mockResolvedValue(BigInt(0)),
    };
    client = new ClientExactEvmScheme(mockClientSigner);

    mockFacilitatorSigner = {
      getAddresses: vi.fn().mockReturnValue(["0x742D35CC6634c0532925A3b844BC9E7595F0BEb0"]),
      readContract: vi.fn().mockImplementation(async (args: { functionName: string }) => {
        if (args?.functionName === "isValidSignature") return "0x1626ba7e";
        return 0n;
      }),
      verifyTypedData: vi.fn().mockResolvedValue(true),
      writeContract: vi.fn().mockResolvedValue(MOCK_TX_HASH),
      sendTransaction: vi.fn().mockResolvedValue(MOCK_TX_HASH),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success", logs: null }),
      getCode: vi.fn().mockResolvedValue("0x6080604052"),
    };
    store = new InMemoryPendingSettlementStore();
  });

  describe("EIP-3009", () => {
    it("cache-miss + broadcast success: deletes/leaves no pending entry", async () => {
      const facilitator = new ExactEvmScheme(mockFacilitatorSigner, {
        pendingSettlementStore: store,
      });
      const paymentPayload = await client.createPaymentPayload(2, REQUIREMENTS);
      const fullPayload: PaymentPayload = {
        ...paymentPayload,
        accepted: REQUIREMENTS,
        resource: { url: "", description: "", mimeType: "" },
      };
      const signature = (fullPayload.payload as { signature: string }).signature;

      const result = await facilitator.settle(fullPayload, REQUIREMENTS);

      expect(result.success).toBe(true);
      expect(await store.get(signature)).toBeUndefined();
    });

    it("cache-miss + broadcast-then-wait-fails: returns settlement_pending and populates the store keyed by the signature", async () => {
      const facilitator = new ExactEvmScheme(mockFacilitatorSigner, {
        pendingSettlementStore: store,
      });
      const paymentPayload = await client.createPaymentPayload(2, REQUIREMENTS);
      const fullPayload: PaymentPayload = {
        ...paymentPayload,
        accepted: REQUIREMENTS,
        resource: { url: "", description: "", mimeType: "" },
      };
      const signature = (fullPayload.payload as { signature: string }).signature;

      mockFacilitatorSigner.waitForTransactionReceipt = vi
        .fn()
        .mockRejectedValue(new Error("rpc: timeout waiting for receipt"));

      const result = await facilitator.settle(fullPayload, REQUIREMENTS);

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(Errors.ErrSettlementPending);
      expect(result.transaction).toBe(MOCK_TX_HASH);
      expect(await store.get(signature)).toBe(MOCK_TX_HASH);
    });

    it("cache-hit: skips verify/broadcast entirely and reconciles against the cached tx", async () => {
      const facilitator = new ExactEvmScheme(mockFacilitatorSigner, {
        pendingSettlementStore: store,
      });
      const paymentPayload = await client.createPaymentPayload(2, REQUIREMENTS);
      const fullPayload: PaymentPayload = {
        ...paymentPayload,
        accepted: REQUIREMENTS,
        resource: { url: "", description: "", mimeType: "" },
      };
      const signature = (fullPayload.payload as { signature: string }).signature;
      await store.set(signature, MOCK_TX_HASH);

      const result = await facilitator.settle(fullPayload, REQUIREMENTS);

      expect(result.success).toBe(true);
      expect(result.transaction).toBe(MOCK_TX_HASH);
      // Fast path never re-broadcasts.
      expect(mockFacilitatorSigner.writeContract).not.toHaveBeenCalled();
      expect(mockFacilitatorSigner.waitForTransactionReceipt).toHaveBeenCalledWith(
        expect.objectContaining({ hash: MOCK_TX_HASH }),
      );
      expect(await store.get(signature)).toBeUndefined();
    });

    it("cache-hit: still unconfirmed on retry returns settlement_pending again without re-broadcasting", async () => {
      const facilitator = new ExactEvmScheme(mockFacilitatorSigner, {
        pendingSettlementStore: store,
      });
      const paymentPayload = await client.createPaymentPayload(2, REQUIREMENTS);
      const fullPayload: PaymentPayload = {
        ...paymentPayload,
        accepted: REQUIREMENTS,
        resource: { url: "", description: "", mimeType: "" },
      };
      const signature = (fullPayload.payload as { signature: string }).signature;
      await store.set(signature, MOCK_TX_HASH);
      mockFacilitatorSigner.waitForTransactionReceipt = vi
        .fn()
        .mockRejectedValue(new Error("still pending"));

      const result = await facilitator.settle(fullPayload, REQUIREMENTS);

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(Errors.ErrSettlementPending);
      expect(result.transaction).toBe(MOCK_TX_HASH);
      expect(mockFacilitatorSigner.writeContract).not.toHaveBeenCalled();
      expect(await store.get(signature)).toBe(MOCK_TX_HASH);
    });

    it("verify-only failure (recipient mismatch) is terminal and never touches the store", async () => {
      const facilitator = new ExactEvmScheme(mockFacilitatorSigner, {
        pendingSettlementStore: store,
      });
      const paymentPayload = await client.createPaymentPayload(2, REQUIREMENTS);
      const fullPayload: PaymentPayload = {
        ...paymentPayload,
        accepted: REQUIREMENTS,
        resource: { url: "", description: "", mimeType: "" },
      };
      const signature = (fullPayload.payload as { signature: string }).signature;
      const badRequirements = {
        ...REQUIREMENTS,
        payTo: "0x0000000000000000000000000000000000000000",
      };

      const result = await facilitator.settle(fullPayload, badRequirements);

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(Errors.ErrRecipientMismatch);
      expect(mockFacilitatorSigner.writeContract).not.toHaveBeenCalled();
      expect(await store.get(signature)).toBeUndefined();
    });

    it("invalid broadcast hash is terminal and never populates the store", async () => {
      const facilitator = new ExactEvmScheme(mockFacilitatorSigner, {
        pendingSettlementStore: store,
      });
      const paymentPayload = await client.createPaymentPayload(2, REQUIREMENTS);
      const fullPayload: PaymentPayload = {
        ...paymentPayload,
        accepted: REQUIREMENTS,
        resource: { url: "", description: "", mimeType: "" },
      };
      const signature = (fullPayload.payload as { signature: string }).signature;
      mockFacilitatorSigner.writeContract = vi.fn().mockResolvedValue("0xnothash");

      const result = await facilitator.settle(fullPayload, REQUIREMENTS);

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(Errors.ErrTransactionFailed);
      expect(await store.get(signature)).toBeUndefined();
    });
  });

  describe("Permit2", () => {
    beforeEach(() => {
      // settle's re-verify has simulate=false by default, so no simulation
      // readContract is needed. The default getCode mock reports bytecode for
      // every address (including the payer), so signature verification routes
      // through the strict EIP-1271 path (isValidSignature) rather than real
      // ECDSA recovery against the mock's non-cryptographic signature string.
      mockFacilitatorSigner.readContract = rcWithSig(undefined);
    });

    it("cache-miss + broadcast success: leaves no pending entry", async () => {
      const facilitator = new ExactEvmScheme(mockFacilitatorSigner, {
        pendingSettlementStore: store,
      });
      const payload = buildPermit2Payload("0xmocksignature");

      const result = await facilitator.settle(payload, PERMIT2_REQUIREMENTS);

      expect(result.success).toBe(true);
      expect(await store.get("0xmocksignature")).toBeUndefined();
    });

    it("cache-miss + broadcast-then-wait-fails: returns settlement_pending and populates the store", async () => {
      mockFacilitatorSigner.waitForTransactionReceipt = vi
        .fn()
        .mockRejectedValue(new Error("rpc timeout"));
      const facilitator = new ExactEvmScheme(mockFacilitatorSigner, {
        pendingSettlementStore: store,
      });
      const payload = buildPermit2Payload("0xmocksignature");

      const result = await facilitator.settle(payload, PERMIT2_REQUIREMENTS);

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(Errors.ErrSettlementPending);
      expect(result.transaction).toBe(MOCK_TX_HASH);
      expect(await store.get("0xmocksignature")).toBe(MOCK_TX_HASH);
    });

    it("cache-hit: skips verify/broadcast and reconciles against the cached tx", async () => {
      const facilitator = new ExactEvmScheme(mockFacilitatorSigner, {
        pendingSettlementStore: store,
      });
      const payload = buildPermit2Payload("0xmocksignature");
      await store.set("0xmocksignature", MOCK_TX_HASH);

      const result = await facilitator.settle(payload, PERMIT2_REQUIREMENTS);

      expect(result.success).toBe(true);
      expect(result.transaction).toBe(MOCK_TX_HASH);
      expect(mockFacilitatorSigner.writeContract).not.toHaveBeenCalled();
      expect(await store.get("0xmocksignature")).toBeUndefined();
    });

    it("cache-hit: still unconfirmed returns settlement_pending again", async () => {
      mockFacilitatorSigner.waitForTransactionReceipt = vi
        .fn()
        .mockRejectedValue(new Error("still pending"));
      const facilitator = new ExactEvmScheme(mockFacilitatorSigner, {
        pendingSettlementStore: store,
      });
      const payload = buildPermit2Payload("0xmocksignature");
      await store.set("0xmocksignature", MOCK_TX_HASH);

      const result = await facilitator.settle(payload, PERMIT2_REQUIREMENTS);

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(Errors.ErrSettlementPending);
      expect(mockFacilitatorSigner.writeContract).not.toHaveBeenCalled();
      expect(await store.get("0xmocksignature")).toBe(MOCK_TX_HASH);
    });

    it("cache-hit with ERC-20-approval extension: reconciles via the extension signer, not the base signer", async () => {
      const facilitator = new ExactEvmScheme(mockFacilitatorSigner, {
        pendingSettlementStore: store,
      });
      const payload: PaymentPayload = {
        ...buildPermit2Payload("0xmocksignature"),
        extensions: {
          erc20ApprovalGasSponsoring: {
            info: {
              from: "0x1234567890123456789012345678901234567890",
              asset: PERMIT2_REQUIREMENTS.asset,
              spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
              amount: PERMIT2_REQUIREMENTS.amount,
              signedTransaction: "0x" + "aa".repeat(100),
              version: "1",
            },
            schema: {},
          },
        },
      };
      await store.set("0xmocksignature", MOCK_TX_HASH);

      const extensionWaitForReceipt = vi.fn().mockResolvedValue({ status: "success", logs: null });
      const baseSignerWaitForReceipt = vi.fn();
      mockFacilitatorSigner.waitForTransactionReceipt = baseSignerWaitForReceipt;
      const mockContext = {
        getExtension: vi.fn().mockImplementation((key: string) => {
          if (key === ERC20_APPROVAL_GAS_SPONSORING_KEY) {
            return {
              key: ERC20_APPROVAL_GAS_SPONSORING_KEY,
              signer: {
                ...mockFacilitatorSigner,
                waitForTransactionReceipt: extensionWaitForReceipt,
              },
            };
          }
          return undefined;
        }),
      };

      const result = await facilitator.settle(
        payload,
        PERMIT2_REQUIREMENTS,
        mockContext as unknown as FacilitatorContext,
      );

      expect(result.success).toBe(true);
      expect(result.transaction).toBe(MOCK_TX_HASH);
      expect(extensionWaitForReceipt).toHaveBeenCalledWith(
        expect.objectContaining({ hash: MOCK_TX_HASH }),
      );
      expect(baseSignerWaitForReceipt).not.toHaveBeenCalled();
      expect(mockFacilitatorSigner.writeContract).not.toHaveBeenCalled();
    });

    it("verify-only failure (spender mismatch) is terminal and never touches the store", async () => {
      const facilitator = new ExactEvmScheme(mockFacilitatorSigner, {
        pendingSettlementStore: store,
      });
      const payload = buildPermit2Payload("0xmocksignature");
      (
        payload.payload as { permit2Authorization: { spender: string } }
      ).permit2Authorization.spender = "0x0000000000000000000000000000000000000000";

      const result = await facilitator.settle(payload, PERMIT2_REQUIREMENTS);

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(Errors.ErrPermit2InvalidSpender);
      expect(mockFacilitatorSigner.writeContract).not.toHaveBeenCalled();
      expect(await store.get("0xmocksignature")).toBeUndefined();
    });
  });

  describe("default store", () => {
    it("uses a fresh in-memory store when none is provided, so settle still succeeds", async () => {
      const facilitator = new ExactEvmScheme(mockFacilitatorSigner);
      const paymentPayload = await client.createPaymentPayload(2, REQUIREMENTS);
      const fullPayload: PaymentPayload = {
        ...paymentPayload,
        accepted: REQUIREMENTS,
        resource: { url: "", description: "", mimeType: "" },
      };

      const result = await facilitator.settle(fullPayload, REQUIREMENTS);

      expect(result.success).toBe(true);
    });
  });
});
