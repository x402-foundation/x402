import { describe, it, expect } from "vitest";
import { ExactAvmScheme as ExactAvmClientScheme } from "../../src/exact/client/scheme";
import { ExactAvmScheme as ExactAvmServerScheme } from "../../src/exact/server/scheme";
import { ExactAvmScheme as ExactAvmFacilitatorScheme } from "../../src/exact/facilitator/scheme";
import { Errors as FacilitatorErrors } from "../../src/exact/facilitator";
import { ExactAvmScheme as ExactAvmClientBarrel } from "../../src/exact/client";
import { ExactAvmScheme as ExactAvmServerBarrel } from "../../src/exact/server";
import {
  ALGORAND_MAINNET_CAIP2,
  ALGORAND_MAINNET_GENESIS_HASH,
  ALGORAND_TESTNET_CAIP2,
  ALGORAND_TESTNET_GENESIS_HASH,
  USDC_MAINNET_ASA_ID,
  USDC_TESTNET_ASA_ID,
  isValidAlgorandAddress,
  isAlgorandNetwork,
  isTestnetNetwork,
  normalizeAlgorandNetwork,
  convertToTokenAmount,
  convertFromTokenAmount,
  isExactAvmPayload,
  encodeTransaction,
  decodeTransaction,
  decodeSignedTransaction,
  decodeUnsignedTransaction,
  getNetworkFromCaip2,
  getSenderFromTransaction,
  getGenesisHashFromTransaction,
  validateGroupId,
  getTransactionId,
  hasSignature,
  toClientAvmSigner,
} from "../../src";
import type { PaymentRequirements } from "@x402/core/types";
import { decodeAddress } from "@algorandfoundation/algokit-utils/common";
import {
  Transaction,
  groupTransactions,
  encodeTransactionRaw,
  encodeSignedTransaction,
} from "@algorandfoundation/algokit-utils/transact";
import { AlgorandClient } from "@algorandfoundation/algokit-utils/algorand-client";

const CLIENT_KEY =
  "mZHHvLfOqJrIxIMTYPFdGWxfZy1MtaT3J6aJny+4yW1jkF6o6oKpKU7m5JfNdghc26oLTvRnEEBkDjY14WU3Cw==";
const FACIL_KEY =
  "4f3r4kJFn4a1l7ZdHdKQ6S9NSfXs2-8TRIKRwFiBLU4TPTtroT7kFdGQlQ0QryHbYq3AlGpDx6NlNnZOFg8yGw==";
const PAY_TO = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ";

describe("@x402/avm", () => {
  describe("ExactAvmScheme paymentFlows", () => {
    it("declares authorization and upfront with authorization as the default", () => {
      const server = new ExactAvmServerScheme();
      expect(server.defaultAssetTransferMethod).toBe("default");
      expect(server.paymentFlows).toEqual({
        default: { supported: ["authorization", "upfront"], default: "authorization" },
      });
    });
  });

  describe("constants", () => {
    it("should export correct CAIP-2 network identifiers", () => {
      expect(ALGORAND_MAINNET_CAIP2).toBe("algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k");
      expect(ALGORAND_TESTNET_CAIP2).toBe("algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe");
    });

    it("should export correct USDC ASA IDs", () => {
      expect(USDC_MAINNET_ASA_ID).toBe("31566704");
      expect(USDC_TESTNET_ASA_ID).toBe("10458941");
    });
  });

  describe("normalizeAlgorandNetwork", () => {
    it("should return canonical IDs unchanged", () => {
      expect(normalizeAlgorandNetwork(ALGORAND_MAINNET_CAIP2)).toBe(ALGORAND_MAINNET_CAIP2);
      expect(normalizeAlgorandNetwork(ALGORAND_TESTNET_CAIP2)).toBe(ALGORAND_TESTNET_CAIP2);
    });

    it("should map legacy full-hash IDs to canonical form", () => {
      expect(normalizeAlgorandNetwork(`algorand:${ALGORAND_MAINNET_GENESIS_HASH}`)).toBe(
        ALGORAND_MAINNET_CAIP2,
      );
      expect(normalizeAlgorandNetwork(`algorand:${ALGORAND_TESTNET_GENESIS_HASH}`)).toBe(
        ALGORAND_TESTNET_CAIP2,
      );
    });

    it("should throw for unsupported networks", () => {
      expect(() => normalizeAlgorandNetwork("algorand:unknown")).toThrow(
        "Unsupported Algorand network",
      );
      expect(() => normalizeAlgorandNetwork("eip155:1")).toThrow("Unsupported Algorand network");
    });
  });

  describe("isValidAlgorandAddress", () => {
    it("should return true for valid Algorand addresses", () => {
      // Valid Algorand address (58 characters base32)
      const validAddress = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ";
      expect(isValidAlgorandAddress(validAddress)).toBe(true);
    });

    it("should return false for invalid Algorand addresses", () => {
      expect(isValidAlgorandAddress("invalid")).toBe(false);
      expect(isValidAlgorandAddress("0x1234")).toBe(false);
      expect(isValidAlgorandAddress("")).toBe(false);
    });
  });

  describe("isAlgorandNetwork", () => {
    it("should return true for CAIP-2 Algorand networks", () => {
      expect(isAlgorandNetwork(ALGORAND_MAINNET_CAIP2)).toBe(true);
      expect(isAlgorandNetwork(ALGORAND_TESTNET_CAIP2)).toBe(true);
      expect(isAlgorandNetwork("algorand:some-hash")).toBe(true);
    });

    it("should return false for non-Algorand networks", () => {
      expect(isAlgorandNetwork("eip155:1")).toBe(false);
      expect(isAlgorandNetwork("solana:mainnet")).toBe(false);
    });
  });

  describe("isTestnetNetwork", () => {
    it("should return true for testnet networks", () => {
      expect(isTestnetNetwork(ALGORAND_TESTNET_CAIP2)).toBe(true);
      expect(isTestnetNetwork(`algorand:${ALGORAND_TESTNET_GENESIS_HASH}`)).toBe(true);
    });

    it("should return false for mainnet networks", () => {
      expect(isTestnetNetwork(ALGORAND_MAINNET_CAIP2)).toBe(false);
      expect(isTestnetNetwork(`algorand:${ALGORAND_MAINNET_GENESIS_HASH}`)).toBe(false);
    });
  });

  describe("token amount conversion", () => {
    it("should convert decimal to token amount", () => {
      expect(convertToTokenAmount("1.50", 6)).toBe("1500000");
      expect(convertToTokenAmount("0.10", 6)).toBe("100000");
      expect(convertToTokenAmount("100", 6)).toBe("100000000");
      expect(convertToTokenAmount("0.000001", 6)).toBe("1");
    });

    it("should convert token amount to decimal", () => {
      expect(convertFromTokenAmount("1500000", 6)).toBe("1.5");
      expect(convertFromTokenAmount("100000", 6)).toBe("0.1");
      expect(convertFromTokenAmount("100000000", 6)).toBe("100");
      expect(convertFromTokenAmount("1", 6)).toBe("0.000001");
    });
  });

  describe("isExactAvmPayload", () => {
    it("should return true for valid payloads", () => {
      const validPayload = {
        paymentGroup: ["base64encoded1", "base64encoded2"],
        paymentIndex: 1,
      };
      expect(isExactAvmPayload(validPayload)).toBe(true);
    });

    it("should return false for invalid payloads", () => {
      expect(isExactAvmPayload(null)).toBe(false);
      expect(isExactAvmPayload(undefined)).toBe(false);
      expect(isExactAvmPayload({})).toBe(false);
      expect(isExactAvmPayload({ paymentGroup: [] })).toBe(false);
      expect(isExactAvmPayload({ paymentIndex: 0 })).toBe(false);
      expect(isExactAvmPayload({ paymentGroup: "not-array", paymentIndex: 0 })).toBe(false);
      expect(isExactAvmPayload({ paymentGroup: [], paymentIndex: "0" })).toBe(false);
    });
  });

  describe("barrel exports", () => {
    it("re-exports scheme classes and facilitator errors from subpath indexes", () => {
      expect(new ExactAvmClientScheme(toClientAvmSigner(CLIENT_KEY)).scheme).toBe("exact");
      expect(new ExactAvmClientBarrel(toClientAvmSigner(CLIENT_KEY)).scheme).toBe("exact");
      expect(new ExactAvmServerBarrel().scheme).toBe("exact");
      expect(new ExactAvmFacilitatorScheme({ getAddresses: () => [] } as never).scheme).toBe(
        "exact",
      );
      expect(FacilitatorErrors.ErrInvalidVersion).toBe("invalid_exact_avm_invalid_version");
    });
  });

  describe("ExactAvm server scheme", () => {
    it("parses AssetAmount pass-through and rejects missing asset", async () => {
      const server = new ExactAvmServerScheme();
      const parsed = await server.parsePrice(
        { amount: "1000", asset: USDC_TESTNET_ASA_ID, extra: { tier: "vip" } },
        ALGORAND_TESTNET_CAIP2,
      );
      expect(parsed.amount).toBe("1000");
      expect(parsed.asset).toBe(USDC_TESTNET_ASA_ID);
      expect(parsed.extra?.tier).toBe("vip");

      await expect(
        server.parsePrice({ amount: "1000", asset: "", extra: {} }, ALGORAND_TESTNET_CAIP2),
      ).rejects.toThrow("Asset ID must be specified");
    });

    it("parses money via custom parser chain and default USDC conversion", async () => {
      const server = new ExactAvmServerScheme();
      server.registerMoneyParser(async amount => {
        if (Number(amount) > 10) {
          return { amount: convertToTokenAmount(amount, 6), asset: "99999999" };
        }
        return null;
      });

      const custom = await server.parsePrice(50, ALGORAND_TESTNET_CAIP2);
      expect(custom.asset).toBe("99999999");

      const defaultUsdc = await server.parsePrice("$1.00", ALGORAND_TESTNET_CAIP2);
      expect(defaultUsdc.amount).toBe("1000000");
      expect(defaultUsdc.asset).toBe(USDC_TESTNET_ASA_ID);
    });

    it("returns asset decimals for known defaults", () => {
      const server = new ExactAvmServerScheme();
      expect(server.getAssetDecimals(USDC_TESTNET_ASA_ID, ALGORAND_TESTNET_CAIP2)).toBe(6);
      expect(server.getAssetDecimals("unknown", ALGORAND_TESTNET_CAIP2)).toBeUndefined();
    });

    it("enhances payment requirements with feePayer when provided", async () => {
      const server = new ExactAvmServerScheme();
      const base: PaymentRequirements = {
        scheme: "exact",
        network: ALGORAND_TESTNET_CAIP2,
        asset: USDC_TESTNET_ASA_ID,
        amount: "1000",
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
        extra: { custom: "value" },
      };

      const unchanged = await server.enhancePaymentRequirements(
        base,
        { x402Version: 2, scheme: "exact", network: ALGORAND_TESTNET_CAIP2 },
        [],
      );
      expect(unchanged.extra?.custom).toBe("value");
      expect(unchanged.extra?.feePayer).toBeUndefined();

      const enhanced = await server.enhancePaymentRequirements(
        base,
        {
          x402Version: 2,
          scheme: "exact",
          network: ALGORAND_TESTNET_CAIP2,
          extra: { feePayer: "FEEPAYERADDRESS" },
        },
        [],
      );
      expect(enhanced.extra?.feePayer).toBe("FEEPAYERADDRESS");
      expect(enhanced.extra?.custom).toBe("value");
    });
  });

  describe("ExactAvm client scheme", () => {
    it("creates a sponsored payment payload with fee payer", { timeout: 20000 }, async () => {
      const clientSigner = toClientAvmSigner(CLIENT_KEY);
      const facilitator = toClientAvmSigner(FACIL_KEY);
      const scheme = new ExactAvmClientScheme(clientSigner);
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: ALGORAND_TESTNET_CAIP2,
        asset: USDC_TESTNET_ASA_ID,
        amount: "1000",
        payTo: PAY_TO,
        maxTimeoutSeconds: 3600,
        extra: { feePayer: facilitator.address },
      };

      const result = await scheme.createPaymentPayload(2, requirements);
      const payload = result.payload as { paymentGroup: string[]; paymentIndex: number };
      expect(result.x402Version).toBe(2);
      expect(payload.paymentGroup).toHaveLength(2);
      expect(payload.paymentIndex).toBe(1);
    });

    it(
      "creates a non-sponsored payment payload and resolves numeric asset ids",
      { timeout: 20000 },
      async () => {
        const clientSigner = toClientAvmSigner(CLIENT_KEY);
        const scheme = new ExactAvmClientScheme(clientSigner, {
          algodUrl: "https://testnet-api.algonode.cloud",
        });
        const requirements: PaymentRequirements = {
          scheme: "exact",
          network: ALGORAND_TESTNET_CAIP2,
          asset: USDC_TESTNET_ASA_ID,
          amount: "1000",
          payTo: PAY_TO,
          maxTimeoutSeconds: 3600,
          extra: {},
        };

        const result = await scheme.createPaymentPayload(2, requirements);
        const payload = result.payload as { paymentGroup: string[]; paymentIndex: number };
        expect(payload.paymentGroup).toHaveLength(1);
        expect(payload.paymentIndex).toBe(0);
      },
    );

    it("uses injected AlgorandClient and falls back unknown asset symbols", async () => {
      const clientSigner = toClientAvmSigner(CLIENT_KEY);
      const algorandClient = AlgorandClient.testNet();
      const scheme = new ExactAvmClientScheme(clientSigner, { algorandClient });
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: ALGORAND_MAINNET_CAIP2,
        asset: "CUSTOM_ASA",
        amount: "1000",
        payTo: PAY_TO,
        maxTimeoutSeconds: 3600,
        extra: {},
      };

      const result = await scheme.createPaymentPayload(2, requirements);
      expect(result.x402Version).toBe(2);
    });
  });

  describe("transaction utilities", () => {
    it("round-trips encode/decode and reads sender, genesis hash, and tx id", async () => {
      const client = toClientAvmSigner(CLIENT_KEY);
      const genesisHash = Buffer.from(ALGORAND_TESTNET_GENESIS_HASH, "base64");
      const txn = new Transaction({
        type: "axfer",
        sender: decodeAddress(client.address),
        fee: 1000n,
        firstValid: 1000n,
        lastValid: 2000n,
        genesisHash,
        genesisId: "testnet-v1.0",
        assetTransfer: {
          assetId: BigInt(USDC_TESTNET_ASA_ID),
          amount: 1000n,
          receiver: decodeAddress(PAY_TO),
        },
      });
      const raw = encodeTransactionRaw(txn);
      const encoded = encodeTransaction(raw);
      expect(decodeTransaction(encoded)).toEqual(raw);

      const signed = await client.signTransactions([raw], [0]);
      const signedEncoded = encodeTransaction(signed[0]!);
      expect(getSenderFromTransaction(raw, false)).toBe(client.address);
      expect(getSenderFromTransaction(signed[0]!, true)).toBe(client.address);
      expect(getGenesisHashFromTransaction(decodeUnsignedTransaction(encoded))).toBe(
        ALGORAND_TESTNET_GENESIS_HASH,
      );
      expect(getTransactionId(signed[0]!)).toBeDefined();
      expect(hasSignature(signed[0]!)).toBe(true);
      expect(decodeSignedTransaction(signedEncoded).txn.sender.toString()).toBe(client.address);
    });

    it("validates group ids and maps CAIP-2 to network type", async () => {
      const client = toClientAvmSigner(CLIENT_KEY);
      const facilitator = toClientAvmSigner(FACIL_KEY);
      const genesisHash = Buffer.from(ALGORAND_TESTNET_GENESIS_HASH, "base64");
      const grouped = groupTransactions([
        new Transaction({
          type: "pay",
          sender: decodeAddress(facilitator.address),
          fee: 2000n,
          firstValid: 1000n,
          lastValid: 2000n,
          genesisHash,
          genesisId: "testnet-v1.0",
          payment: { amount: 0n, receiver: decodeAddress(facilitator.address) },
        }),
        new Transaction({
          type: "axfer",
          sender: decodeAddress(client.address),
          fee: 0n,
          firstValid: 1000n,
          lastValid: 2000n,
          genesisHash,
          genesisId: "testnet-v1.0",
          assetTransfer: {
            assetId: BigInt(USDC_TESTNET_ASA_ID),
            amount: 1000n,
            receiver: decodeAddress(PAY_TO),
          },
        }),
      ]);

      const bytes = grouped.map(t => encodeTransactionRaw(t));
      expect(validateGroupId(bytes)).toBe(true);
      expect(validateGroupId([bytes[0]!])).toBe(true);

      expect(getNetworkFromCaip2(ALGORAND_TESTNET_CAIP2)).toBe("testnet");
      expect(getNetworkFromCaip2(ALGORAND_MAINNET_CAIP2)).toBe("mainnet");
      expect(getNetworkFromCaip2("eip155:1")).toBeNull();
      expect(getNetworkFromCaip2("algorand:unknown")).toBeNull();

      expect(() => getGenesisHashFromTransaction({})).toThrow("does not have a genesis hash");

      const emptySig = encodeSignedTransaction({
        txn: new Transaction({
          type: "pay",
          sender: decodeAddress(client.address),
          fee: 1000n,
          firstValid: 1n,
          lastValid: 2n,
          payment: { amount: 0n, receiver: decodeAddress(client.address) },
        }),
      });
      expect(hasSignature(emptySig)).toBe(false);
    });
  });
});
