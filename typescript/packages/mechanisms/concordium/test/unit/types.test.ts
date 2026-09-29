import { describe, it, expect } from "vitest";
import type {
  SignableV1Transaction,
  ExactConcordiumPayloadV2,
  TransactionInfo,
  TokenUpdatePayload,
} from "../../src/types";

describe("Concordium Types", () => {
  describe("SignableV1Transaction", () => {
    it("should accept a valid CCD transfer transaction", () => {
      const tx: SignableV1Transaction = {
        version: 1,
        header: {
          sender: "3kBx2h5Y2veb4hZvAE2c1Zr6DYJwWbPr9xQJJBPWyFnXHF9UuN",
          nonce: 42,
          expiry: 1700000300,
          numSignatures: 1,
          sponsor: {
            account: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
            numSignatures: 1,
          },
        },
        payload: {
          type: "transfer",
          toAddress: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
          amount: "1000000",
        },
        signatures: {
          sender: { "0": { "0": "a1b2c3d4e5f6" } },
          sponsor: {},
        },
      };

      expect(tx.version).toBe(1);
      expect(tx.header.sponsor.account).toBeDefined();
      expect(tx.signatures.sender).toBeDefined();
      expect(Object.keys(tx.signatures.sponsor)).toHaveLength(0);
    });

    it("should accept a valid PLT token update transaction", () => {
      const tx: SignableV1Transaction = {
        version: 1,
        header: {
          sender: "3kBx2h5Y2veb4hZvAE2c1Zr6DYJwWbPr9xQJJBPWyFnXHF9UuN",
          nonce: 43,
          expiry: 1700000600,
          numSignatures: 1,
          sponsor: {
            account: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
            numSignatures: 1,
          },
        },
        payload: {
          type: "tokenUpdate",
          tokenId: "EURR",
          operations: "cbor-encoded-hex",
        },
        signatures: {
          sender: { "0": { "0": "d4e5f6a7b8c9" } },
          sponsor: {},
        },
      };

      expect(tx.payload.type).toBe("tokenUpdate");
      expect((tx.payload as TokenUpdatePayload).tokenId).toBe("EURR");
    });
  });

  describe("ExactConcordiumPayloadV2", () => {
    it("should accept valid payload structure", () => {
      const payload: ExactConcordiumPayloadV2 = {
        signedTransaction: {
          version: 1,
          header: {
            sender: "3kBx2h5Y2veb4hZvAE2c1Zr6DYJwWbPr9xQJJBPWyFnXHF9UuN",
            nonce: 1,
            expiry: 1700000300,
            numSignatures: 1,
            sponsor: {
              account: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
              numSignatures: 1,
            },
          },
          payload: {
            type: "transfer",
            toAddress: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
            amount: "5000000",
          },
          signatures: {
            sender: { "0": { "0": "signature-hex" } },
            sponsor: {},
          },
        },
      };

      expect(payload.signedTransaction.header.sender).toBe(
        "3kBx2h5Y2veb4hZvAE2c1Zr6DYJwWbPr9xQJJBPWyFnXHF9UuN",
      );
      expect(payload.signedTransaction.version).toBe(1);
    });
  });

  describe("TransactionInfo", () => {
    it("should represent a finalized CCD transfer", () => {
      const info: TransactionInfo = {
        txHash: "abc123def456",
        status: "finalized",
        sender: "3kBx2h5Y2veb4hZvAE2c1Zr6DYJwWbPr9xQJJBPWyFnXHF9UuN",
        recipient: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
        amount: "1000000",
        asset: "CCD",
      };

      expect(info.status).toBe("finalized");
      expect(info.asset).toBe("CCD");
    });

    it("should represent a PLT transfer", () => {
      const info: TransactionInfo = {
        txHash: "def789",
        status: "finalized",
        sender: "3kBx2h5Y2veb4hZvAE2c1Zr6DYJwWbPr9xQJJBPWyFnXHF9UuN",
        recipient: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
        amount: "5000000",
        asset: "EURR",
      };

      expect(info.asset).toBe("EURR");
    });

    it("should represent a minimal pending transaction", () => {
      const info: TransactionInfo = {
        txHash: "pending123",
        status: "pending",
        sender: "",
      };

      expect(info.recipient).toBeUndefined();
      expect(info.amount).toBeUndefined();
      expect(info.asset).toBeUndefined();
    });
  });
});
