import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  Account,
  AccountAuthenticatorEd25519,
  AccountAddress,
  ChainId,
  Ed25519PublicKey,
  Ed25519Signature,
  EntryFunction,
  Identifier,
  ModuleId,
  RawTransaction,
  SimpleTransaction,
  StructTag,
  TransactionPayloadEntryFunction,
  TypeTagStruct,
  U64,
} from "@aptos-labs/ts-sdk";
import { ExactAptosScheme as ExactAptosClient } from "../../src/exact/client/scheme";
import { ExactAptosScheme as ExactAptosFacilitator } from "../../src/exact/facilitator/scheme";
import { ExactAptosScheme as ExactAptosServer } from "../../src/exact/server/scheme";
import { ExactAptosScheme as ExactAptosClientExport } from "../../src/exact/client/index";
import { ExactAptosScheme as ExactAptosFacilitatorExport } from "../../src/exact/facilitator/index";
import { ExactAptosScheme as ExactAptosServerExport } from "../../src/exact/server/index";
import {
  APTOS_MAINNET_CAIP2,
  APTOS_TESTNET_CAIP2,
  APTOS_ADDRESS_REGEX,
  TRANSFER_FUNCTION,
  MAX_GAS_AMOUNT,
  MAX_GAS_UNIT_PRICE,
  getAptosNetwork,
  getAptosRpcUrl,
  getAptosChainId,
  USDC_TESTNET_FA,
} from "../../src/index";
import type { ClientAptosSigner } from "../../src/signer";
import type { PaymentRequirements } from "@x402/core/types";

const mockBuildSimple = vi.fn();

vi.mock("@aptos-labs/ts-sdk", async importOriginal => {
  const actual = await importOriginal<typeof import("@aptos-labs/ts-sdk")>();
  return {
    ...actual,
    Aptos: vi.fn().mockImplementation(() => ({
      transaction: {
        build: {
          simple: mockBuildSimple,
        },
      },
    })),
  };
});

describe("@x402/aptos", () => {
  describe("exports", () => {
    it("should export main scheme classes", () => {
      expect(ExactAptosClient).toBeDefined();
      expect(ExactAptosFacilitator).toBeDefined();
      expect(ExactAptosServer).toBeDefined();
      expect(ExactAptosClientExport).toBe(ExactAptosClient);
      expect(ExactAptosFacilitatorExport).toBe(ExactAptosFacilitator);
      expect(ExactAptosServerExport).toBe(ExactAptosServer);
    });

    it("should export constants", () => {
      expect(APTOS_MAINNET_CAIP2).toBe("aptos:1");
      expect(APTOS_TESTNET_CAIP2).toBe("aptos:2");
      expect(APTOS_ADDRESS_REGEX).toBeDefined();
      expect(TRANSFER_FUNCTION).toBe("0x1::primary_fungible_store::transfer");
      expect(MAX_GAS_AMOUNT).toBe(500000n);
      expect(MAX_GAS_UNIT_PRICE).toBe(1000n);
    });

    it("should export utility functions", () => {
      expect(getAptosNetwork).toBeDefined();
      expect(getAptosRpcUrl).toBeDefined();
      expect(getAptosChainId).toBeDefined();
    });
  });

  describe("ExactAptosServer", () => {
    it("should have scheme property set to exact", () => {
      const server = new ExactAptosServer();
      expect(server.scheme).toBe("exact");
    });

    describe("paymentFlows", () => {
      it("declares authorization and upfront with authorization as the default", () => {
        const server = new ExactAptosServer();
        expect(server.defaultAssetTransferMethod).toBe("default");
        expect(server.paymentFlows).toEqual({
          default: { supported: ["authorization", "upfront"], default: "authorization" },
        });
      });
    });
  });

  describe("ExactAptosFacilitator", () => {
    it("should return feePayer in getExtra for sponsored transactions", () => {
      const mockSigner = {
        getAddresses: () => ["0x123"],
        signAndSubmitAsFeePayer: vi.fn(),
        submitTransaction: vi.fn(),
        simulateTransaction: vi.fn(),
        waitForTransaction: vi.fn(),
      };
      const facilitator = new ExactAptosFacilitator(mockSigner);
      const extra = facilitator.getExtra("aptos:2");
      expect(extra).toBeDefined();
      expect(extra?.feePayer).toBe("0x123");
    });

    it("should return all signer addresses in getSigners", () => {
      const mockSigner = {
        getAddresses: () => ["0x123", "0x456"],
        signAndSubmitAsFeePayer: vi.fn(),
        submitTransaction: vi.fn(),
        simulateTransaction: vi.fn(),
        waitForTransaction: vi.fn(),
      };
      const facilitator = new ExactAptosFacilitator(mockSigner);
      const signers = facilitator.getSigners("aptos:2");
      expect(signers).toEqual(["0x123", "0x456"]);
    });

    it("should omit feePayer from getExtra when sponsorship is disabled", () => {
      const mockSigner = {
        getAddresses: () => ["0x123"],
        signAndSubmitAsFeePayer: vi.fn(),
        submitTransaction: vi.fn(),
        simulateTransaction: vi.fn(),
        waitForTransaction: vi.fn(),
      };
      const facilitator = new ExactAptosFacilitator(mockSigner, false);
      expect(facilitator.getExtra("aptos:2")).toBeUndefined();
    });
  });

  describe("ExactAptosServer enhancePaymentRequirements", () => {
    it("should add feePayer from supportedKind.extra when sponsored", async () => {
      const server = new ExactAptosServer();
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "aptos:2",
        asset: "0x123",
        amount: "1000",
        payTo: "0x456",
        maxTimeoutSeconds: 3600,
      };
      const supportedKind = {
        x402Version: 2,
        scheme: "exact",
        network: "aptos:2" as const,
        extra: { feePayer: "0x789" },
      };

      const enhanced = await server.enhancePaymentRequirements(requirements, supportedKind, []);
      expect(enhanced.extra?.feePayer).toBe("0x789");
    });

    it("should not add feePayer when supportedKind.extra has no feePayer (non-sponsored)", async () => {
      const server = new ExactAptosServer();
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "aptos:2",
        asset: "0x123",
        amount: "1000",
        payTo: "0x456",
        maxTimeoutSeconds: 3600,
      };
      const supportedKind = {
        x402Version: 2,
        scheme: "exact",
        network: "aptos:2" as const,
        extra: {},
      };

      const enhanced = await server.enhancePaymentRequirements(requirements, supportedKind, []);
      expect(enhanced.extra?.feePayer).toBeUndefined();
    });
  });

  describe("ExactAptosServer parsePrice", () => {
    it("returns AssetAmount when price is already an asset amount", async () => {
      const server = new ExactAptosServer();
      const result = await server.parsePrice(
        { amount: "1000", asset: USDC_TESTNET_FA, extra: { note: "test" } },
        APTOS_TESTNET_CAIP2,
      );
      expect(result).toEqual({ amount: "1000", asset: USDC_TESTNET_FA, extra: { note: "test" } });
    });

    it("throws when AssetAmount is missing asset address", async () => {
      const server = new ExactAptosServer();
      await expect(
        server.parsePrice({ amount: "1000", asset: "", extra: {} }, APTOS_TESTNET_CAIP2),
      ).rejects.toThrow(/Asset address must be specified/);
    });

    it("throws when AssetAmount has invalid asset address format", async () => {
      const server = new ExactAptosServer();
      await expect(
        server.parsePrice({ amount: "1000", asset: "bad-address", extra: {} }, APTOS_TESTNET_CAIP2),
      ).rejects.toThrow(/Invalid asset address format/);
    });

    it("uses a registered money parser before default conversion", async () => {
      const server = new ExactAptosServer().registerMoneyParser(async () => ({
        amount: "42",
        asset: USDC_TESTNET_FA,
        extra: {},
      }));
      const result = await server.parsePrice("$1.00", APTOS_TESTNET_CAIP2);
      expect(result.amount).toBe("42");
    });

    it("returns decimals for known default assets", () => {
      const server = new ExactAptosServer();
      expect(server.getAssetDecimals(USDC_TESTNET_FA, APTOS_TESTNET_CAIP2)).toBe(6);
      expect(server.getAssetDecimals("0xunknown", APTOS_TESTNET_CAIP2)).toBeUndefined();
    });

    it("converts dollar-string pricing to default USDC on testnet", async () => {
      const server = new ExactAptosServer();
      const result = await server.parsePrice("$1.00", APTOS_TESTNET_CAIP2);
      expect(result.asset).toBe(USDC_TESTNET_FA);
      expect(result.amount).toBe("1000000");
    });
  });

  describe("ExactAptosClient createPaymentPayload", () => {
    const payTo = "0x0000000000000000000000000000000000000000000000000000000000000001";
    let signer: ClientAptosSigner;

    beforeEach(() => {
      signer = Account.generate();
      mockBuildSimple.mockReset();
      vi.spyOn(signer, "signTransactionWithAuthenticator").mockReturnValue(
        new AccountAuthenticatorEd25519(
          signer.publicKey as Ed25519PublicKey,
          new Ed25519Signature(new Uint8Array(64)),
        ),
      );
    });

    function baseRequirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
      return {
        scheme: "exact",
        network: APTOS_TESTNET_CAIP2,
        asset: USDC_TESTNET_FA,
        amount: "1000",
        payTo,
        maxTimeoutSeconds: 3600,
        ...overrides,
      };
    }

    function mockBuiltTransaction(feePayer?: Account): SimpleTransaction {
      const entryFn = new EntryFunction(
        new ModuleId(AccountAddress.ONE, new Identifier("primary_fungible_store")),
        new Identifier("transfer"),
        [
          new TypeTagStruct(
            new StructTag(
              AccountAddress.ONE,
              new Identifier("fungible_asset"),
              new Identifier("Metadata"),
              [],
            ),
          ),
        ],
        [AccountAddress.from(USDC_TESTNET_FA), AccountAddress.from(payTo), new U64(1000n)],
      );
      const rawTx = new RawTransaction(
        signer.accountAddress,
        0n,
        new TransactionPayloadEntryFunction(entryFn),
        200_000n,
        100n,
        BigInt(Math.floor(Date.now() / 1000) + 3600),
        new ChainId(2),
      );
      return feePayer
        ? new SimpleTransaction(rawTx, feePayer.accountAddress)
        : new SimpleTransaction(rawTx);
    }

    it("throws when signer has no account address", async () => {
      const client = new ExactAptosClient({
        accountAddress: undefined,
        signTransactionWithAuthenticator: vi.fn(),
      } as unknown as ClientAptosSigner);
      await expect(client.createPaymentPayload(2, baseRequirements())).rejects.toThrow(
        "Aptos account address is required",
      );
    });

    it("validates required payment requirement fields", async () => {
      const client = new ExactAptosClient(signer);
      await expect(client.createPaymentPayload(2, baseRequirements({ asset: "" }))).rejects.toThrow(
        "Asset is required",
      );
      await expect(
        client.createPaymentPayload(2, baseRequirements({ asset: "not-an-address" })),
      ).rejects.toThrow("Invalid asset address");
      await expect(client.createPaymentPayload(2, baseRequirements({ payTo: "" }))).rejects.toThrow(
        "Pay-to address is required",
      );
      await expect(
        client.createPaymentPayload(2, baseRequirements({ payTo: "bad" })),
      ).rejects.toThrow("Invalid pay-to address");
      await expect(
        client.createPaymentPayload(2, baseRequirements({ amount: "" })),
      ).rejects.toThrow("Amount is required");
      await expect(
        client.createPaymentPayload(2, baseRequirements({ amount: "1.5" })),
      ).rejects.toThrow("Amount must be a number");
    });

    it("creates a non-sponsored payment payload", async () => {
      mockBuildSimple.mockResolvedValue(mockBuiltTransaction());
      const client = new ExactAptosClient(signer);

      const result = await client.createPaymentPayload(2, baseRequirements());

      expect(result.x402Version).toBe(2);
      expect(result.payload.transaction).toBeTypeOf("string");
      expect(mockBuildSimple).toHaveBeenCalledWith(
        expect.objectContaining({ withFeePayer: false }),
      );
    });

    it("creates a sponsored payment payload with fee payer address", async () => {
      const feePayer = Account.generate();
      mockBuildSimple.mockResolvedValue(mockBuiltTransaction());
      const client = new ExactAptosClient(signer);

      const result = await client.createPaymentPayload(
        2,
        baseRequirements({ extra: { feePayer: feePayer.accountAddress.toStringLong() } }),
      );

      expect(result.payload.transaction).toBeTypeOf("string");
      expect(mockBuildSimple).toHaveBeenCalledWith(expect.objectContaining({ withFeePayer: true }));
    });
  });
});
