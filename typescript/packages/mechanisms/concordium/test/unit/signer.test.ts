import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Network } from "@x402/core/types";
import type { FacilitatorConcordiumSigner, GrpcConfig } from "../../src/signer";
import type { SignableV1Transaction } from "../../src/types";
import { CONCORDIUM_TESTNET_CAIP2 } from "../../src/constants";

const mockGrpcClient = vi.hoisted(() => ({
  getAccountInfo: vi.fn(),
  sendTransaction: vi.fn(),
  waitForTransactionFinalization: vi.fn(),
  getBlockItemStatus: vi.fn(),
}));

const mockTransaction = vi.hoisted(() => ({
  signableFromJSON: vi.fn(),
  sponsor: vi.fn(),
  toJSON: vi.fn(),
  finalize: vi.fn(),
}));

const mockBuildBasicAccountSigner = vi.hoisted(() => vi.fn(() => ({ kind: "account-signer" })));

const mockTokenFromId = vi.hoisted(() => vi.fn());
const mockTokenBalanceOf = vi.hoisted(() => vi.fn());

vi.mock("@concordium/web-sdk/nodejs", () => ({
  ConcordiumGRPCNodeClient: vi.fn(function ConcordiumGRPCNodeClient() {
    return mockGrpcClient;
  }),
  credentials: {
    createSsl: vi.fn(() => "ssl-creds"),
    createInsecure: vi.fn(() => "insecure-creds"),
  },
}));

vi.mock("@concordium/web-sdk/transactions", () => ({
  Transaction: mockTransaction,
}));

vi.mock("@concordium/web-sdk", async importOriginal => {
  const actual = await importOriginal<typeof import("@concordium/web-sdk")>();
  return {
    ...actual,
    buildBasicAccountSigner: mockBuildBasicAccountSigner,
    AccountAddress: {
      fromBase58: vi.fn((address: string) => ({
        toString: () => address,
      })),
    },
    TransactionHash: {
      fromHexString: vi.fn((hash: string) => hash),
    },
    CcdAmount: {
      toMicroCcd: vi.fn((amount: unknown) => {
        if (typeof amount === "bigint") return amount;
        if (typeof amount === "object" && amount !== null && "microCcd" in amount) {
          return (amount as { microCcd: bigint }).microCcd;
        }
        return 2_500_000n;
      }),
    },
    Token: {
      fromId: mockTokenFromId,
      balanceOf: mockTokenBalanceOf,
    },
    TokenId: {
      fromString: vi.fn((tokenId: string) => tokenId),
    },
  };
});

import { ConcordiumGRPCNodeClient, credentials } from "@concordium/web-sdk/nodejs";
import { buildBasicAccountSigner } from "@concordium/web-sdk";
import { toConcordiumFacilitatorSigner } from "../../src/signer";

const SPONSOR_ADDRESS = "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW";
const SENDER_ADDRESS = "3UrcxPQeYywasrPcYUcqhvFu3SB2vBBDjj7TsaRQ431vGiczYp";
const TX_HASH = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

function createGrpcConfig(overrides: Partial<GrpcConfig & { network?: Network }> = {}) {
  return {
    host: "grpc.testnet.concordium.com",
    port: 20000,
    ...overrides,
  };
}

function createSampleTx(): SignableV1Transaction {
  return {
    version: 1,
    header: {
      sender: SENDER_ADDRESS,
      expiry: Math.floor(Date.now() / 1000) + 60,
      sponsor: { account: SPONSOR_ADDRESS, numSignatures: 1 },
      numSignatures: 1,
      nonce: 1,
    },
    payload: {
      type: "transfer",
      toAddress: SPONSOR_ADDRESS,
      amount: "1000000",
    },
    signatures: { sender: { "0": { "0": "sig" } }, sponsor: {} },
  };
}

describe("Concordium Signer", () => {
  describe("GrpcConfig", () => {
    it("should accept minimal config", () => {
      const config: GrpcConfig = { host: "grpc.testnet.concordium.com", port: 20000 };
      expect(config.host).toBeDefined();
      expect(config.port).toBe(20000);
      expect(config.useTls).toBeUndefined();
    });

    it("should accept config with TLS flag", () => {
      const config: GrpcConfig = { host: "localhost", port: 20000, useTls: false };
      expect(config.useTls).toBe(false);
    });
  });

  describe("FacilitatorConcordiumSigner interface", () => {
    function createMockSigner(sponsorAddress: string): FacilitatorConcordiumSigner {
      return {
        getAddress: () => sponsorAddress,
        getNetwork: () => "ccd:*",
        getAccountInfo: vi.fn().mockResolvedValue({
          accountAddress: sponsorAddress,
          accountThreshold: 1,
          accountCredentials: {},
        }),
        getTokenBalance: vi.fn().mockResolvedValue(1_000_000n),
        getTokenDecimals: vi.fn().mockResolvedValue(6),
        addSponsorSignature: vi.fn().mockResolvedValue({
          version: 1,
          header: {},
          payload: {},
          signatures: { sender: {}, sponsor: { "0": { "0": "sponsor-sig" } } },
        }),
        submitTransaction: vi.fn().mockResolvedValue("abcdef1234567890"),
        waitForFinalization: vi.fn().mockResolvedValue({
          txHash: "abcdef1234567890",
          status: "finalized",
          sender: "3kBx2h5Y2veb4hZvAE2c1Zr6DYJwWbPr9xQJJBPWyFnXHF9UuN",
          recipient: sponsorAddress,
          amount: "1000000",
          asset: "CCD",
        }),
      };
    }

    it("should return sponsor address", () => {
      const address = "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW";
      const signer = createMockSigner(address);
      expect(signer.getAddress()).toBe(address);
    });

    it("should implement all required methods", () => {
      const signer = createMockSigner("4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW");
      expect(signer.getAddress).toBeDefined();
      expect(signer.getAccountInfo).toBeDefined();
      expect(signer.getTokenBalance).toBeDefined();
      expect(signer.addSponsorSignature).toBeDefined();
      expect(signer.submitTransaction).toBeDefined();
      expect(signer.waitForFinalization).toBeDefined();
    });

    it("should return finalized transaction info from waitForFinalization", async () => {
      const signer = createMockSigner("4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW");
      const info = await signer.waitForFinalization("abcdef1234567890");

      expect(info.status).toBe("finalized");
      expect(info.txHash).toBe("abcdef1234567890");
      expect(info.amount).toBe("1000000");
      expect(info.asset).toBe("CCD");
    });

    it("should return tx hash from submitTransaction", async () => {
      const signer = createMockSigner("4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW");
      const hash = await signer.submitTransaction({} as any);
      expect(hash).toBe("abcdef1234567890");
    });
  });

  describe("toConcordiumFacilitatorSigner", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mockGrpcClient.getAccountInfo.mockResolvedValue({ accountNonce: 1n });
      mockGrpcClient.sendTransaction.mockResolvedValue({ toString: () => TX_HASH });
      mockGrpcClient.waitForTransactionFinalization.mockResolvedValue(undefined);
      mockTransaction.signableFromJSON.mockReturnValue({ version: 1 });
      mockTransaction.sponsor.mockResolvedValue({ sponsored: true });
      mockTransaction.toJSON.mockReturnValue({ version: 1, sponsored: true });
      mockTransaction.finalize.mockReturnValue({ finalized: true });
      mockTokenFromId.mockResolvedValue({ info: { state: { decimals: 6 } } });
      mockTokenBalanceOf.mockResolvedValue({ value: 5_000_000n });
    });

    it("builds a signer from a hex private key and uses TLS by default", async () => {
      const signer = toConcordiumFacilitatorSigner(
        SPONSOR_ADDRESS,
        "deadbeef".repeat(8),
        createGrpcConfig(),
      );

      expect(buildBasicAccountSigner).toHaveBeenCalledWith("deadbeef".repeat(8));
      expect(credentials.createSsl).toHaveBeenCalled();
      expect(ConcordiumGRPCNodeClient).toHaveBeenCalledWith(
        "grpc.testnet.concordium.com",
        20000,
        "ssl-creds",
      );
      expect(signer.getAddress()).toBe(SPONSOR_ADDRESS);
      expect(signer.getNetwork()).toBe("ccd:*");
    });

    it("accepts a pre-built AccountSigner and insecure gRPC credentials", async () => {
      const accountSigner = { kind: "provided-signer" } as any;
      const signer = toConcordiumFacilitatorSigner(
        SPONSOR_ADDRESS,
        accountSigner,
        createGrpcConfig({ useTls: false, network: CONCORDIUM_TESTNET_CAIP2 }),
      );

      expect(buildBasicAccountSigner).not.toHaveBeenCalled();
      expect(credentials.createInsecure).toHaveBeenCalled();
      expect(signer.getNetwork()).toBe(CONCORDIUM_TESTNET_CAIP2);
    });

    it("fetches account info through the gRPC client", async () => {
      const signer = toConcordiumFacilitatorSigner(
        SPONSOR_ADDRESS,
        { kind: "signer" } as any,
        createGrpcConfig(),
      );

      await signer.getAccountInfo(SENDER_ADDRESS);
      expect(mockGrpcClient.getAccountInfo).toHaveBeenCalled();
    });

    it("adds sponsor signature and submits the finalized transaction", async () => {
      const signer = toConcordiumFacilitatorSigner(
        SPONSOR_ADDRESS,
        { kind: "signer" } as any,
        createGrpcConfig(),
      );
      const tx = createSampleTx();

      const sponsored = await signer.addSponsorSignature(tx);
      const hash = await signer.submitTransaction(sponsored as any);

      expect(mockTransaction.signableFromJSON).toHaveBeenCalledWith(tx);
      expect(mockTransaction.sponsor).toHaveBeenCalled();
      expect(mockTransaction.toJSON).toHaveBeenCalled();
      expect(mockTransaction.finalize).toHaveBeenCalled();
      expect(mockGrpcClient.sendTransaction).toHaveBeenCalledWith({ finalized: true });
      expect(hash).toBe(TX_HASH);
    });

    it("throws when finalization status is missing", async () => {
      mockGrpcClient.getBlockItemStatus.mockResolvedValue(undefined);
      const signer = toConcordiumFacilitatorSigner(
        SPONSOR_ADDRESS,
        { kind: "signer" } as any,
        createGrpcConfig(),
      );

      await expect(signer.waitForFinalization(TX_HASH)).rejects.toThrow(
        `Transaction ${TX_HASH} not found after finalization`,
      );
    });

    it("returns minimal info when the block item has no outcome summary", async () => {
      mockGrpcClient.getBlockItemStatus.mockResolvedValue({ status: "committed" });
      const signer = toConcordiumFacilitatorSigner(
        SPONSOR_ADDRESS,
        { kind: "signer" } as any,
        createGrpcConfig(),
      );

      const info = await signer.waitForFinalization(TX_HASH);
      expect(info).toEqual({ txHash: TX_HASH, status: "committed", sender: "" });
    });

    it("throws when the on-chain transaction failed", async () => {
      mockGrpcClient.getBlockItemStatus.mockResolvedValue({
        status: "finalized",
        outcome: {
          summary: {
            transactionType: "failed",
            sender: { address: SENDER_ADDRESS },
          },
        },
      });
      const signer = toConcordiumFacilitatorSigner(
        SPONSOR_ADDRESS,
        { kind: "signer" } as any,
        createGrpcConfig(),
      );

      await expect(signer.waitForFinalization(TX_HASH)).rejects.toThrow(
        `Transaction ${TX_HASH} failed on-chain`,
      );
    });

    it("parses native CCD transfer outcomes", async () => {
      mockGrpcClient.getBlockItemStatus.mockResolvedValue({
        status: "finalized",
        outcome: {
          summary: {
            transactionType: "transfer",
            sender: { address: SENDER_ADDRESS },
            transfer: {
              to: { address: SPONSOR_ADDRESS },
              amount: { microCcd: 1_000_000n },
            },
          },
        },
      });
      const signer = toConcordiumFacilitatorSigner(
        SPONSOR_ADDRESS,
        { kind: "signer" } as any,
        createGrpcConfig(),
      );

      const info = await signer.waitForFinalization(TX_HASH);
      expect(info).toEqual({
        txHash: TX_HASH,
        status: "finalized",
        sender: SENDER_ADDRESS,
        recipient: SPONSOR_ADDRESS,
        amount: "1000000",
        asset: "CCD",
      });
    });

    it("parses transferWithMemo outcomes", async () => {
      mockGrpcClient.getBlockItemStatus.mockResolvedValue({
        status: "finalized",
        outcome: {
          summary: {
            transactionType: "transferWithMemo",
            sender: { address: SENDER_ADDRESS },
            transfer: {
              to: { address: SPONSOR_ADDRESS },
              amount: { microCcd: 500n },
            },
          },
        },
      });
      const signer = toConcordiumFacilitatorSigner(
        SPONSOR_ADDRESS,
        { kind: "signer" } as any,
        createGrpcConfig(),
      );

      const info = await signer.waitForFinalization(TX_HASH);
      expect(info.asset).toBe("CCD");
      expect(info.amount).toBe("500");
    });

    it("parses PLT token transfer outcomes", async () => {
      mockGrpcClient.getBlockItemStatus.mockResolvedValue({
        status: "finalized",
        outcome: {
          summary: {
            transactionType: "tokenUpdate",
            sender: { address: SENDER_ADDRESS },
            events: [
              {
                tag: "TokenTransfer",
                to: { address: { address: SPONSOR_ADDRESS } },
                amount: { value: { toString: () => "2500000" } },
                tokenId: { value: "USDR" },
              },
            ],
          },
        },
      });
      const signer = toConcordiumFacilitatorSigner(
        SPONSOR_ADDRESS,
        { kind: "signer" } as any,
        createGrpcConfig(),
      );

      const info = await signer.waitForFinalization(TX_HASH);
      expect(info).toEqual({
        txHash: TX_HASH,
        status: "finalized",
        sender: SENDER_ADDRESS,
        recipient: SPONSOR_ADDRESS,
        amount: "2500000",
        asset: "USDR",
      });
    });

    it("returns sender-only info for unrecognized token update outcomes", async () => {
      mockGrpcClient.getBlockItemStatus.mockResolvedValue({
        status: "finalized",
        outcome: {
          summary: {
            transactionType: "tokenUpdate",
            sender: { address: SENDER_ADDRESS },
            events: [{ tag: "Mint", amount: "1" }],
          },
        },
      });
      const signer = toConcordiumFacilitatorSigner(
        SPONSOR_ADDRESS,
        { kind: "signer" } as any,
        createGrpcConfig(),
      );

      const info = await signer.waitForFinalization(TX_HASH);
      expect(info).toEqual({ txHash: TX_HASH, status: "finalized", sender: SENDER_ADDRESS });
    });

    it("reads token balances and decimals from chain", async () => {
      const signer = toConcordiumFacilitatorSigner(
        SPONSOR_ADDRESS,
        { kind: "signer" } as any,
        createGrpcConfig(),
      );

      await expect(signer.getTokenBalance(SENDER_ADDRESS, "USDR")).resolves.toBe(5_000_000n);
      await expect(signer.getTokenDecimals("USDR")).resolves.toBe(6);
      expect(mockTokenFromId).toHaveBeenCalled();
      expect(mockTokenBalanceOf).toHaveBeenCalled();
    });
  });
});
