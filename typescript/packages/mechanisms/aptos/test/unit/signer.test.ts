import { describe, it, expect, vi, beforeEach } from "vitest";
import { Account, AccountAuthenticator, SimpleTransaction } from "@aptos-labs/ts-sdk";
import { createClientSigner, toFacilitatorAptosSigner } from "../../src/signer";

const mockSubmitSimple = vi.fn();
const mockSignAsFeePayer = vi.fn();
const mockSimulateSimple = vi.fn();
const mockWaitForTransaction = vi.fn();

vi.mock("@aptos-labs/ts-sdk", async importOriginal => {
  const actual = await importOriginal<typeof import("@aptos-labs/ts-sdk")>();
  return {
    ...actual,
    Aptos: vi.fn().mockImplementation(() => ({
      transaction: {
        signAsFeePayer: mockSignAsFeePayer,
        submit: { simple: mockSubmitSimple },
        simulate: { simple: mockSimulateSimple },
      },
      waitForTransaction: mockWaitForTransaction,
    })),
  };
});

describe("Aptos Signer", () => {
  describe("createClientSigner", () => {
    it("should create a client signer from a valid private key", async () => {
      // Generate a test account to get a valid private key
      const testAccount = Account.generate();
      const privateKey = testAccount.privateKey.toString();

      const signer = await createClientSigner(privateKey);

      expect(signer).toBeDefined();
      expect(signer.accountAddress).toBeDefined();
      expect(signer.accountAddress.toString()).toBe(testAccount.accountAddress.toString());
    });

    it("should handle AIP-80 formatted private keys", async () => {
      // Generate a test account
      const testAccount = Account.generate();
      // AIP-80 format includes the key type prefix
      const privateKey = testAccount.privateKey.toString();

      const signer = await createClientSigner(privateKey);

      expect(signer).toBeDefined();
      expect(signer.signTransactionWithAuthenticator).toBeDefined();
    });

    it("should throw for invalid private keys", async () => {
      await expect(createClientSigner("invalid-key")).rejects.toThrow();
    });
  });

  describe("toFacilitatorAptosSigner", () => {
    it("should return signer addresses", () => {
      const testAccount = Account.generate();
      const facilitatorSigner = toFacilitatorAptosSigner(testAccount);

      const addresses = facilitatorSigner.getAddresses();

      expect(addresses).toHaveLength(1);
      expect(addresses[0]).toBe(testAccount.accountAddress.toStringLong());
    });

    it("should implement all required methods", () => {
      const testAccount = Account.generate();
      const facilitatorSigner = toFacilitatorAptosSigner(testAccount);

      expect(facilitatorSigner.getAddresses).toBeDefined();
      expect(facilitatorSigner.signAndSubmitAsFeePayer).toBeDefined();
      expect(facilitatorSigner.submitTransaction).toBeDefined();
      expect(facilitatorSigner.simulateTransaction).toBeDefined();
      expect(facilitatorSigner.waitForTransaction).toBeDefined();
    });

    it("should use custom RPC URL when provided", () => {
      const testAccount = Account.generate();
      const customRpcUrl = "https://custom-rpc.example.com";
      const facilitatorSigner = toFacilitatorAptosSigner(testAccount, {
        defaultRpcUrl: customRpcUrl,
      });

      // The signer should be created successfully with custom config
      expect(facilitatorSigner).toBeDefined();
      expect(facilitatorSigner.getAddresses()).toHaveLength(1);
    });

    it("should support network-specific RPC URLs", () => {
      const testAccount = Account.generate();
      const rpcConfig = {
        "aptos:1": "https://mainnet-rpc.example.com",
        "aptos:2": "https://testnet-rpc.example.com",
      };
      const facilitatorSigner = toFacilitatorAptosSigner(testAccount, rpcConfig);

      expect(facilitatorSigner).toBeDefined();
      expect(facilitatorSigner.getAddresses()).toHaveLength(1);
    });
  });

  describe("facilitator signer operations", () => {
    let account: Account;
    let transaction: SimpleTransaction;
    let senderAuthenticator: AccountAuthenticator;

    beforeEach(() => {
      account = Account.generate();
      mockSubmitSimple.mockReset();
      mockSignAsFeePayer.mockReset();
      mockSimulateSimple.mockReset();
      mockWaitForTransaction.mockReset();

      transaction = { feePayerAddress: undefined } as SimpleTransaction;
      senderAuthenticator = {
        bcsToBytes: () => new Uint8Array([1, 2, 3]),
      } as AccountAuthenticator;
      mockSignAsFeePayer.mockReturnValue({ bcsToBytes: () => new Uint8Array([1]) });
      mockSubmitSimple.mockResolvedValue({ hash: "0xabc123" });
      mockSimulateSimple.mockResolvedValue([{ success: true }]);
      mockWaitForTransaction.mockResolvedValue(undefined);
    });

    it("signAndSubmitAsFeePayer submits with fee payer authenticator", async () => {
      const facilitatorSigner = toFacilitatorAptosSigner(account);
      const pending = await facilitatorSigner.signAndSubmitAsFeePayer(
        transaction,
        senderAuthenticator,
        "aptos:2",
      );

      expect(mockSignAsFeePayer).toHaveBeenCalledOnce();
      expect(mockSubmitSimple).toHaveBeenCalledOnce();
      expect(pending.hash).toBe("0xabc123");
    });

    it("submitTransaction submits without fee payer", async () => {
      const facilitatorSigner = toFacilitatorAptosSigner(account);
      const pending = await facilitatorSigner.submitTransaction(
        transaction,
        senderAuthenticator,
        "aptos:2",
      );

      expect(mockSubmitSimple).toHaveBeenCalledOnce();
      expect(pending.hash).toBe("0xabc123");
    });

    it("simulateTransaction throws when simulation fails", async () => {
      mockSimulateSimple.mockResolvedValueOnce([{ success: false, vm_status: "OUT_OF_GAS" }]);
      const facilitatorSigner = toFacilitatorAptosSigner(account);

      await expect(facilitatorSigner.simulateTransaction(transaction, "aptos:2")).rejects.toThrow(
        "Simulation failed: OUT_OF_GAS",
      );
    });

    it("simulateTransaction throws when simulation returns no results", async () => {
      mockSimulateSimple.mockResolvedValueOnce([]);
      const facilitatorSigner = toFacilitatorAptosSigner(account);

      await expect(facilitatorSigner.simulateTransaction(transaction, "aptos:2")).rejects.toThrow(
        "Simulation failed: unknown error",
      );
    });

    it("waitForTransaction delegates to Aptos client", async () => {
      const facilitatorSigner = toFacilitatorAptosSigner(account);
      await facilitatorSigner.waitForTransaction("0xabc123", "aptos:2");
      expect(mockWaitForTransaction).toHaveBeenCalledWith({ transactionHash: "0xabc123" });
    });
  });
});
