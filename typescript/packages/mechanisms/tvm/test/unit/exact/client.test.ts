import { describe, it, expect, beforeEach, vi } from "vitest";
import { beginCell, Cell } from "@ton/core";
import type { PaymentRequirements } from "@x402/core/types";
import { ExactTvmScheme } from "../../../src/exact/client/scheme";
import type { ClientTvmSigner } from "../../../src/signer";
import {
  DEFAULT_TVM_INNER_GAS_BUFFER,
  TVM_MAINNET,
  TVM_PROVIDER_TONAPI,
  USDT_MASTER,
  W5R1_CODE_HEX,
} from "../../../src/constants";

const SOURCE_JETTON_WALLET = "0:aabbccdd1234567890abcdef1234567890abcdef1234567890abcdef12345678";

const { mockCreateTvmProviderClient, mockProvider } = vi.hoisted(() => {
  const provider = {
    getAccountState: vi.fn(),
    close: vi.fn(),
    getJettonWallet: vi.fn(),
    getJettonWalletData: vi.fn(),
    sendMessage: vi.fn(),
    emulateTrace: vi.fn(),
    getTraceByMessageHash: vi.fn(),
    runGetMethod: vi.fn(),
  };
  return {
    mockProvider: provider,
    mockCreateTvmProviderClient: vi.fn(() => provider),
  };
});

vi.mock("../../../src/provider", () => ({
  createTvmProviderClient: mockCreateTvmProviderClient,
}));

describe("ExactTvmScheme (Client)", () => {
  let client: ExactTvmScheme;
  let mockSigner: ClientTvmSigner;

  const mockRequirements: PaymentRequirements = {
    scheme: "exact",
    network: TVM_MAINNET,
    amount: "10000",
    asset: USDT_MASTER,
    payTo: "0:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    maxTimeoutSeconds: 300,
    extra: { areFeesSponsored: true },
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockSigner = {
      address: "0:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      network: TVM_MAINNET,
      walletId: 1,
      stateInit: { code: beginCell().endCell(), data: beginCell().endCell() },
      publicKey: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      signMessage: vi.fn().mockReturnValue(Buffer.alloc(64)),
      signTransfer: vi.fn().mockResolvedValue("te6cckEBAgEA...base64boc"),
    };
    mockProvider.getJettonWallet.mockResolvedValue(SOURCE_JETTON_WALLET);
    mockProvider.getAccountState.mockResolvedValue(activeW5Account(mockSigner, 5));
    mockProvider.emulateTrace.mockResolvedValue(
      emulationTrace(mockSigner.address, SOURCE_JETTON_WALLET),
    );
    client = new ExactTvmScheme(mockSigner);
  });

  describe("Construction", () => {
    it("should create instance with signer", () => {
      expect(client).toBeDefined();
      expect(client.scheme).toBe("exact");
    });

    it("should accept provider config", async () => {
      const customClient = new ExactTvmScheme(mockSigner, {
        provider: TVM_PROVIDER_TONAPI,
        providerBaseUrl: "https://tonapi.example.com",
        apiKey: "test-key",
        providerTimeoutSeconds: 7,
      });

      await customClient.createPaymentPayload(2, mockRequirements);

      expect(mockCreateTvmProviderClient).toHaveBeenCalledWith(
        TVM_MAINNET,
        expect.objectContaining({
          provider: TVM_PROVIDER_TONAPI,
          baseUrl: "https://tonapi.example.com",
          apiKey: "test-key",
          timeout: 7,
        }),
      );
    });
  });

  describe("createPaymentPayload", () => {
    it("should resolve jetton wallet through the provider", async () => {
      await client.createPaymentPayload(2, mockRequirements);
      expect(mockProvider.getJettonWallet).toHaveBeenCalledWith(
        mockRequirements.asset,
        mockSigner.address,
      );
    });

    it("should get wallet seqno from provider account state", async () => {
      await client.createPaymentPayload(2, mockRequirements);
      const signCall = (mockSigner.signTransfer as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(signCall[0]).toBe(5);
    });

    it("should estimate the required inner TON amount by emulating the relay", async () => {
      await client.createPaymentPayload(2, mockRequirements);
      expect(mockProvider.emulateTrace).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({ ignoreChksig: true, timeout: 10 }),
      );
      const signCall = (mockSigner.signTransfer as ReturnType<typeof vi.fn>).mock.calls[0];
      const messages = signCall[2];
      expect(messages[0].amount).toBe(DEFAULT_TVM_INNER_GAS_BUFFER + 6400n);
    });

    it("should include only the minimal TVM payload fields", async () => {
      const result = await client.createPaymentPayload(2, mockRequirements);
      expect(result.payload).toEqual({
        settlementBoc: "te6cckEBAgEA...base64boc",
        asset: mockRequirements.asset,
      });
    });

    it("should set x402Version from argument", async () => {
      const result = await client.createPaymentPayload(2, mockRequirements);
      expect(result.x402Version).toBe(2);
    });

    it("should pass exactly 1 message to signTransfer", async () => {
      await client.createPaymentPayload(2, mockRequirements);
      const signCall = (mockSigner.signTransfer as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(signCall[2]).toHaveLength(1);
    });

    it("should reject unsupported networks", async () => {
      await expect(
        client.createPaymentPayload(2, {
          ...mockRequirements,
          network: "tvm:999" as `${string}:${string}`,
        }),
      ).rejects.toThrow("Unsupported TVM network");
    });

    it("should reject signer network mismatches", async () => {
      await expect(
        client.createPaymentPayload(2, { ...mockRequirements, network: "tvm:-3" }),
      ).rejects.toThrow("Signer network");
    });

    it("should require sponsored fees", async () => {
      await expect(
        client.createPaymentPayload(2, { ...mockRequirements, extra: {} }),
      ).rejects.toThrow("areFeesSponsored");
    });

    it("should reject relay emulation traces without a jetton transfer", async () => {
      mockProvider.emulateTrace.mockResolvedValue({ transactions: {} });

      await expect(client.createPaymentPayload(2, mockRequirements)).rejects.toThrow(
        "expected source jetton wallet transaction",
      );
    });
  });
});

function activeW5Account(signer: ClientTvmSigner, seqno: number) {
  return {
    address: signer.address,
    balance: 0n,
    isActive: true,
    isUninitialized: false,
    isFrozen: false,
    stateInit: {
      code: Cell.fromBoc(Buffer.from(W5R1_CODE_HEX, "hex"))[0],
      data: beginCell()
        .storeUint(1, 1)
        .storeUint(seqno, 32)
        .storeUint(signer.walletId, 32)
        .storeBuffer(Buffer.from(signer.publicKey, "hex"), 32)
        .storeBit(false)
        .endCell(),
    },
  };
}

function emulationTrace(payer: string, sourceWallet: string): Record<string, unknown> {
  return {
    transactions: {
      sourceWallet: {
        account: sourceWallet,
        hash: "a".repeat(64),
        description: successDescription("2000", "400"),
        in_msg: {
          decoded_opcode: "jetton_transfer",
          source: payer,
        },
        out_msgs: [{ fwd_fee: "1000" }],
      },
      receiverWallet: {
        account: "0:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        hash: "b".repeat(64),
        description: successDescription("3000", "0"),
        in_msg: {
          decoded_opcode: "jetton_internal_transfer",
          source: sourceWallet,
        },
        out_msgs: [],
      },
    },
    is_incomplete: false,
  };
}

function successDescription(gasFees: string, storageFees: string) {
  return {
    aborted: false,
    compute_ph: { skipped: false, success: true, gas_fees: gasFees },
    action: { success: true, total_fwd_fees: "0" },
    storage_ph: { storage_fees_collected: storageFees, storage_fees_due: "0" },
  };
}
