import { Keypair, Networks as StellarNetworks } from "@stellar/stellar-sdk";
import { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import { describe, expect, it } from "vitest";
import { DEFAULT_TESTNET_RPC_URL, STELLAR_TESTNET_CAIP2 } from "../../src/constants";
import {
  createEd25519Signer,
  isClientStellarSigner,
  isFacilitatorStellarSigner,
} from "../../src/signer";

describe("Stellar Ed25519 Signer", () => {
  const validSecret = "SDV3OZOPGIO6GQAVI7T6ZJ7NSNFB26JX6QZYCI64TBC7BAZY6FQVAXXK";
  const validPublicKey = "GBBO4ZDDZTSM2IUKQYBAST3CFHNPFXECGEFTGWTA2WELR2BIWDK57UVE";

  describe("createEd25519Signer", () => {
    it("should create signer with all required methods", async () => {
      const signer = createEd25519Signer(validSecret, STELLAR_TESTNET_CAIP2);

      expect(signer.address).toBe(validPublicKey);
      expect(signer.signAuthEntry).toBeInstanceOf(Function);
      expect(signer.signTransaction).toBeInstanceOf(Function);
    });

    it("should create different signers for different keys", async () => {
      const secret1 = "SA6LFVPCYMDQILBRXQ2B2HRPK6DV2TX4FTQQQHWFPSCSY4H2RTCD3XAK";
      const secret2 = "SBFCBBFETW6U5HSOADUUXTQMUEXK7DIQLLATM6OVKKBQNG3I3EWIYJAW";

      const signer1 = createEd25519Signer(secret1, STELLAR_TESTNET_CAIP2);
      const signer2 = createEd25519Signer(secret2, STELLAR_TESTNET_CAIP2);

      expect(signer1.address).not.toBe(signer2.address);
    });

    it("should throw for invalid secret key format", () => {
      expect(() => createEd25519Signer("INVALID_SECRET_KEY", STELLAR_TESTNET_CAIP2)).toThrow();
    });

    it("should throw for empty string", () => {
      expect(() => createEd25519Signer("", STELLAR_TESTNET_CAIP2)).toThrow();
    });

    it("should throw for public key instead of secret", () => {
      expect(() => createEd25519Signer(validPublicKey, STELLAR_TESTNET_CAIP2)).toThrow();
    });

    it("should throw for invalid network", () => {
      expect(() => createEd25519Signer(validSecret, "invalid:network")).toThrow(
        "Unknown Stellar network: invalid:network",
      );
    });

    it("should create a signer that can sign auth entries", async () => {
      const unsignedTxXDR =
        "eyJtZXRob2QiOiJ0cmFuc2ZlciIsInR4IjoiQUFBQUFnQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQURsM0lBQUFBQUFBQUFBUUFBQUFFQUFBQUFBQUFBQUFBQUFBQnBGcEdGQUFBQUFBQUFBQUVBQUFBQUFBQUFHQUFBQUFBQUFBQUJVRVhOWHNCeW1uYVAxYTBDVUZoUzMwOENqYzZERGxyRklnbTZTRWc3THdFQUFBQUlkSEpoYm5ObVpYSUFBQUFEQUFBQUVnQUFBQUFBQUFBQVF1NWtZOHprelNLS2hnSUpUMklwMnZMY2dqRUxNMXBnMVlpNDZDaXcxZDhBQUFBU0FBQUFBQUFBQUFDT1JISHdJVkxnYSt4dVl2ZzFacVJsNVFKVy82L2FaRlRLTGljbGFyNEZkd0FBQUFvQUFBQUFBQUFBQUFBQUFBQUFBQ2NRQUFBQUFRQUFBQUVBQUFBQUFBQUFBRUx1WkdQTTVNMGlpb1lDQ1U5aUtkcnkzSUl4Q3pOYVlOV0l1T2dvc05YZlh4amsrOHlZOGhnQUFBQUFBQUFBQVFBQUFBQUFBQUFCVUVYTlhzQnltbmFQMWEwQ1VGaFMzMDhDamM2RERsckZJZ202U0VnN0x3RUFBQUFJZEhKaGJuTm1aWElBQUFBREFBQUFFZ0FBQUFBQUFBQUFRdTVrWTh6a3pTS0toZ0lKVDJJcDJ2TGNnakVMTTFwZzFZaTQ2Q2l3MWQ4QUFBQVNBQUFBQUFBQUFBQ09SSEh3SVZMZ2EreHVZdmcxWnFSbDVRSlcvNi9hWkZUS0xpY2xhcjRGZHdBQUFBb0FBQUFBQUFBQUFBQUFBQUFBQUNjUUFBQUFBQUFBQUFFQUFBQUFBQUFBQWdBQUFBQUFBQUFBUXU1a1k4emt6U0tLaGdJSlQySXAydkxjZ2pFTE0xcGcxWWk0NkNpdzFkOEFBQUFHQUFBQUFWQkZ6VjdBY3BwMmo5V3RBbEJZVXQ5UEFvM09ndzVheFNJSnVraElPeThCQUFBQUZBQUFBQUVBQUFBREFBQUFBUUFBQUFCQzdtUmp6T1ROSW9xR0FnbFBZaW5hOHR5Q01Rc3pXbURWaUxqb0tMRFYzd0FBQUFGVlUwUkRBQUFBQUVJK2ZRWHk3SysvN0JrcklWby9HK2xxN2JqWTV3SlVxK05CUGdJSDNsYXlBQUFBQVFBQUFBQ09SSEh3SVZMZ2EreHVZdmcxWnFSbDVRSlcvNi9hWkZUS0xpY2xhcjRGZHdBQUFBRlZVMFJEQUFBQUFFSStmUVh5N0srLzdCa3JJVm8vRytscTdialk1d0pVcStOQlBnSUgzbGF5QUFBQUJnQUFBQUFBQUFBQVF1NWtZOHprelNLS2hnSUpUMklwMnZMY2dqRUxNMXBnMVlpNDZDaXcxZDhBQUFBVlh4amsrOHlZOGhnQUFBQUFBQXZsTVFBQUFYZ0FBQUUwQUFBQUFBQURsdzRBQUFBQSIsInNpbXVsYXRpb25SZXN1bHQiOnsiYXV0aCI6WyJBQUFBQVFBQUFBQUFBQUFBUXU1a1k4emt6U0tLaGdJSlQySXAydkxjZ2pFTE0xcGcxWWk0NkNpdzFkOWZHT1Q3ekpqeUdBQUFBQUFBQUFBQkFBQUFBQUFBQUFGUVJjMWV3SEthZG8vVnJRSlFXRkxmVHdLTnpvTU9Xc1VpQ2JwSVNEc3ZBUUFBQUFoMGNtRnVjMlpsY2dBQUFBTUFBQUFTQUFBQUFBQUFBQUJDN21SanpPVE5Jb3FHQWdsUFlpbmE4dHlDTVFzeldtRFZpTGpvS0xEVjN3QUFBQklBQUFBQUFBQUFBSTVFY2ZBaFV1QnI3RzVpK0RWbXBHWGxBbGIvcjlwa1ZNb3VKeVZxdmdWM0FBQUFDZ0FBQUFBQUFBQUFBQUFBQUFBQUp4QUFBQUFBIl0sInJldHZhbCI6IkFBQUFBUT09In0sInNpbXVsYXRpb25UcmFuc2FjdGlvbkRhdGEiOiJBQUFBQUFBQUFBSUFBQUFBQUFBQUFFTHVaR1BNNU0waWlvWUNDVTlpS2RyeTNJSXhDek5hWU5XSXVPZ29zTlhmQUFBQUJnQUFBQUZRUmMxZXdIS2Fkby9WclFKUVdGTGZUd0tOem9NT1dzVWlDYnBJU0RzdkFRQUFBQlFBQUFBQkFBQUFBd0FBQUFFQUFBQUFRdTVrWTh6a3pTS0toZ0lKVDJJcDJ2TGNnakVMTTFwZzFZaTQ2Q2l3MWQ4QUFBQUJWVk5FUXdBQUFBQkNQbjBGOHV5dnYrd1pLeUZhUHh2cGF1MjQyT2NDVkt2alFUNENCOTVXc2dBQUFBRUFBQUFBamtSeDhDRlM0R3ZzYm1MNE5XYWtaZVVDVnYrdjJtUlV5aTRuSldxK0JYY0FBQUFCVlZORVF3QUFBQUJDUG4wRjh1eXZ2K3daS3lGYVB4dnBhdTI0Mk9jQ1ZLdmpRVDRDQjk1V3NnQUFBQVlBQUFBQUFBQUFBRUx1WkdQTTVNMGlpb1lDQ1U5aUtkcnkzSUl4Q3pOYVlOV0l1T2dvc05YZkFBQUFGVjhZNVB2TW1QSVlBQUFBQUFBTDVURUFBQUY0QUFBQk5BQUFBQUFBQTVjTyJ9";
      const expectedSignedTxXDR =
        "eyJtZXRob2QiOiJ0cmFuc2ZlciIsInR4IjoiQUFBQUFnQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQURsM0lBQUFBQUFBQUFBUUFBQUFFQUFBQUFBQUFBQUFBQUFBQnBGcEdGQUFBQUFBQUFBQUVBQUFBQUFBQUFHQUFBQUFBQUFBQUJVRVhOWHNCeW1uYVAxYTBDVUZoUzMwOENqYzZERGxyRklnbTZTRWc3THdFQUFBQUlkSEpoYm5ObVpYSUFBQUFEQUFBQUVnQUFBQUFBQUFBQVF1NWtZOHprelNLS2hnSUpUMklwMnZMY2dqRUxNMXBnMVlpNDZDaXcxZDhBQUFBU0FBQUFBQUFBQUFDT1JISHdJVkxnYSt4dVl2ZzFacVJsNVFKVy82L2FaRlRLTGljbGFyNEZkd0FBQUFvQUFBQUFBQUFBQUFBQUFBQUFBQ2NRQUFBQUFRQUFBQUVBQUFBQUFBQUFBRUx1WkdQTTVNMGlpb1lDQ1U5aUtkcnkzSUl4Q3pOYVlOV0l1T2dvc05YZlh4amsrOHlZOGhnQUk4ck9BQUFBRUFBQUFBRUFBQUFCQUFBQUVRQUFBQUVBQUFBQ0FBQUFEd0FBQUFwd2RXSnNhV05mYTJWNUFBQUFBQUFOQUFBQUlFTHVaR1BNNU0waWlvWUNDVTlpS2RyeTNJSXhDek5hWU5XSXVPZ29zTlhmQUFBQUR3QUFBQWx6YVdkdVlYUjFjbVVBQUFBQUFBQU5BQUFBUUl2bjJjU3VLbFl5TU96T0pTWnkwc0VaN3dkN1QwYmdSQ0ZxZjg1M3VXQXFVcjE1ZUpycXNqVjROUVpTQW05WXNWbHZEcEUrSFRLc3pUQUVBaTJBRkFnQUFBQUFBQUFBQVZCRnpWN0FjcHAyajlXdEFsQllVdDlQQW8zT2d3NWF4U0lKdWtoSU95OEJBQUFBQ0hSeVlXNXpabVZ5QUFBQUF3QUFBQklBQUFBQUFBQUFBRUx1WkdQTTVNMGlpb1lDQ1U5aUtkcnkzSUl4Q3pOYVlOV0l1T2dvc05YZkFBQUFFZ0FBQUFBQUFBQUFqa1J4OENGUzRHdnNibUw0Tldha1plVUNWdit2Mm1SVXlpNG5KV3ErQlhjQUFBQUtBQUFBQUFBQUFBQUFBQUFBQUFBbkVBQUFBQUFBQUFBQkFBQUFBQUFBQUFJQUFBQUFBQUFBQUVMdVpHUE01TTBpaW9ZQ0NVOWlLZHJ5M0lJeEN6TmFZTldJdU9nb3NOWGZBQUFBQmdBQUFBRlFSYzFld0hLYWRvL1ZyUUpRV0ZMZlR3S056b01PV3NVaUNicElTRHN2QVFBQUFCUUFBQUFCQUFBQUF3QUFBQUVBQUFBQVF1NWtZOHprelNLS2hnSUpUMklwMnZMY2dqRUxNMXBnMVlpNDZDaXcxZDhBQUFBQlZWTkVRd0FBQUFCQ1BuMEY4dXl2dit3Wkt5RmFQeHZwYXUyNDJPY0NWS3ZqUVQ0Q0I5NVdzZ0FBQUFFQUFBQUFqa1J4OENGUzRHdnNibUw0Tldha1plVUNWdit2Mm1SVXlpNG5KV3ErQlhjQUFBQUJWVk5FUXdBQUFBQkNQbjBGOHV5dnYrd1pLeUZhUHh2cGF1MjQyT2NDVkt2alFUNENCOTVXc2dBQUFBWUFBQUFBQUFBQUFFTHVaR1BNNU0waWlvWUNDVTlpS2RyeTNJSXhDek5hWU5XSXVPZ29zTlhmQUFBQUZWOFk1UHZNbVBJWUFBQUFBQUFMNVRFQUFBRjRBQUFCTkFBQUFBQUFBNWNPQUFBQUFBPT0iLCJzaW11bGF0aW9uUmVzdWx0Ijp7ImF1dGgiOlsiQUFBQUFRQUFBQUFBQUFBQVF1NWtZOHprelNLS2hnSUpUMklwMnZMY2dqRUxNMXBnMVlpNDZDaXcxZDlmR09UN3pKanlHQUFBQUFBQUFBQUJBQUFBQUFBQUFBRlFSYzFld0hLYWRvL1ZyUUpRV0ZMZlR3S056b01PV3NVaUNicElTRHN2QVFBQUFBaDBjbUZ1YzJabGNnQUFBQU1BQUFBU0FBQUFBQUFBQUFCQzdtUmp6T1ROSW9xR0FnbFBZaW5hOHR5Q01Rc3pXbURWaUxqb0tMRFYzd0FBQUJJQUFBQUFBQUFBQUk1RWNmQWhVdUJyN0c1aStEVm1wR1hsQWxiL3I5cGtWTW91SnlWcXZnVjNBQUFBQ2dBQUFBQUFBQUFBQUFBQUFBQUFKeEFBQUFBQSJdLCJyZXR2YWwiOiJBQUFBQVE9PSJ9LCJzaW11bGF0aW9uVHJhbnNhY3Rpb25EYXRhIjoiQUFBQUFBQUFBQUlBQUFBQUFBQUFBRUx1WkdQTTVNMGlpb1lDQ1U5aUtkcnkzSUl4Q3pOYVlOV0l1T2dvc05YZkFBQUFCZ0FBQUFGUVJjMWV3SEthZG8vVnJRSlFXRkxmVHdLTnpvTU9Xc1VpQ2JwSVNEc3ZBUUFBQUJRQUFBQUJBQUFBQXdBQUFBRUFBQUFBUXU1a1k4emt6U0tLaGdJSlQySXAydkxjZ2pFTE0xcGcxWWk0NkNpdzFkOEFBQUFCVlZORVF3QUFBQUJDUG4wRjh1eXZ2K3daS3lGYVB4dnBhdTI0Mk9jQ1ZLdmpRVDRDQjk1V3NnQUFBQUVBQUFBQWprUng4Q0ZTNEd2c2JtTDROV2FrWmVVQ1Z2K3YybVJVeWk0bkpXcStCWGNBQUFBQlZWTkVRd0FBQUFCQ1BuMEY4dXl2dit3Wkt5RmFQeHZwYXUyNDJPY0NWS3ZqUVQ0Q0I5NVdzZ0FBQUFZQUFBQUFBQUFBQUVMdVpHUE01TTBpaW9ZQ0NVOWlLZHJ5M0lJeEN6TmFZTldJdU9nb3NOWGZBQUFBRlY4WTVQdk1tUElZQUFBQUFBQUw1VEVBQUFGNEFBQUJOQUFBQUFBQUE1Y08ifQ==";

      const signer = createEd25519Signer(validSecret, STELLAR_TESTNET_CAIP2);
      expect(signer.address).toBe(validPublicKey);

      // parse the unsigned tx XDR into AssembledTransaction
      const { method, tx, simulationResult, simulationTransactionData } = JSON.parse(
        Buffer.from(unsignedTxXDR, "base64").toString("utf8"),
      );
      const recoveredTx = AssembledTransaction.fromJSON(
        {
          contractId: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          networkPassphrase: StellarNetworks.TESTNET,
          rpcUrl: DEFAULT_TESTNET_RPC_URL,
          method,
          parseResultXdr: result => result,
        },
        { tx, simulationResult, simulationTransactionData },
      );

      // ensure the tx is the same
      const recoveredTxXDR = Buffer.from(recoveredTx.toJSON()).toString("base64");
      expect(recoveredTxXDR).toBe(unsignedTxXDR);

      // ensure the Tx is missing the signer we have
      let missingSigners = recoveredTx.needsNonInvokerSigningBy();
      expect(missingSigners).toEqual([validPublicKey]);

      // ensure the tx is signed successfully
      await recoveredTx.signAuthEntries({
        address: validPublicKey,
        signAuthEntry: signer.signAuthEntry,
        expiration: 2345678,
      });
      missingSigners = recoveredTx.needsNonInvokerSigningBy();
      expect(missingSigners).toHaveLength(0);

      // ensure the result of the signed tx is the same as the expected signed tx
      const signedTxXDR = Buffer.from(recoveredTx.toJSON()).toString("base64");
      expect(signedTxXDR).toBe(expectedSignedTxXDR);
    });
  });

  describe("is*StellarSigner", () => {
    it("should return true for both when signer has all methods", () => {
      const signer = createEd25519Signer(validSecret, STELLAR_TESTNET_CAIP2);
      expect(isFacilitatorStellarSigner(signer)).toBe(true);
      expect(isClientStellarSigner(signer)).toBe(true);
    });

    it("should return true for client but false for facilitator when signTransaction missing", () => {
      const mockSigner = {
        address: validPublicKey,
        signAuthEntry: async () => ({ signedAuthEntry: "" }),
      };
      expect(isFacilitatorStellarSigner(mockSigner)).toBe(false);
      expect(isClientStellarSigner(mockSigner)).toBe(true);
    });

    it("should return false for invalid types", () => {
      // false for null
      expect(isFacilitatorStellarSigner(null)).toBe(false);
      expect(isClientStellarSigner(null)).toBe(false);
      // false for undefined
      expect(isFacilitatorStellarSigner(undefined)).toBe(false);
      expect(isClientStellarSigner(undefined)).toBe(false);
      // false for string
      expect(isFacilitatorStellarSigner("string")).toBe(false);
      expect(isClientStellarSigner("string")).toBe(false);
      // false for number
      expect(isFacilitatorStellarSigner(123)).toBe(false);
      expect(isClientStellarSigner(123)).toBe(false);
      // false for empty object
      expect(isFacilitatorStellarSigner({})).toBe(false);
      expect(isClientStellarSigner({})).toBe(false);
      // false for object incomplete object
      expect(isFacilitatorStellarSigner({ address: "" })).toBe(false);
      expect(isClientStellarSigner({ address: "" })).toBe(false);
      // false for similar object with non-string address
      const invalidSigner = {
        address: 123,
        signAuthEntry: () => {},
        signTransaction: () => {},
      };
      expect(isFacilitatorStellarSigner(invalidSigner)).toBe(false);
      expect(isClientStellarSigner(invalidSigner)).toBe(false);
      // false for Stellar keypair
      const keypair = Keypair.fromSecret(validSecret);
      expect(isFacilitatorStellarSigner(keypair)).toBe(false);
      expect(isClientStellarSigner(keypair)).toBe(false);
    });
  });
});
