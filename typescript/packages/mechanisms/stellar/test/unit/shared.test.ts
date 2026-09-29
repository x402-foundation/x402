import {
  Account,
  Address,
  Keypair,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  authorizeEntry,
  buildAuthorizationEntryPreimage,
  hash,
  nativeToScVal,
  xdr,
  Networks as StellarNetworks,
  Transaction,
} from "@stellar/stellar-sdk";
import { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import { Api } from "@stellar/stellar-sdk/rpc";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { STELLAR_TESTNET_CAIP2 } from "../../src/constants";
import { ExactStellarScheme } from "../../src/exact/client/scheme";
import {
  gatherAuthEntrySignatureStatus,
  getAddressCredentials,
  handleSimulationResult,
} from "../../src/shared";
import { createEd25519Signer } from "../../src/signer";
import * as stellarUtils from "../../src/utils";
import type { PaymentRequirements } from "@x402/core/types";

vi.mock("../../src/utils", async () => {
  const actual = await vi.importActual<typeof stellarUtils>("../../src/utils");
  return {
    ...actual,
    getEstimatedLedgerCloseTimeSeconds: vi.fn().mockResolvedValue(5),
    getRpcClient: vi.fn(),
  };
});

describe("Stellar Shared Utilities", () => {
  describe("handleSimulationResult", () => {
    it("should throw error when simulation is undefined", () => {
      expect(() => handleSimulationResult(undefined)).toThrow("Simulation result is undefined");
    });

    it("should throw error when simulation has type RESTORE", () => {
      const mockRestoreSimulation: Api.SimulateTransactionResponse = {
        id: "test-id",
        latestLedger: 12345,
        events: [],
        _parsed: true,
        result: {
          auth: [],
          retval: xdr.ScVal.scvVoid(),
        },
        restorePreamble: {
          minResourceFee: "100",
          transactionData: new SorobanDataBuilder(),
        },
        transactionData: new SorobanDataBuilder(),
        minResourceFee: "100",
      } as Api.SimulateTransactionRestoreResponse;

      expect(() => handleSimulationResult(mockRestoreSimulation)).toThrow(
        /Stellar simulation result has type "RESTORE"/,
      );
    });

    it("should throw error when simulation has type ERROR", () => {
      const mockErrorSimulation: Api.SimulateTransactionResponse = {
        id: "test-id",
        latestLedger: 12345,
        _parsed: true,
        error: "Transaction simulation failed: insufficient balance",
      } as Api.SimulateTransactionErrorResponse;

      expect(() => handleSimulationResult(mockErrorSimulation)).toThrow(
        /Stellar simulation failed with error message: Transaction simulation failed: insufficient balance/,
      );
    });

    it("should handle simulation with empty error message", () => {
      const mockErrorSimulation: Api.SimulateTransactionResponse = {
        id: "test-id",
        latestLedger: 12345,
        _parsed: true,
        error: "",
      } as Api.SimulateTransactionErrorResponse;

      expect(() => handleSimulationResult(mockErrorSimulation)).toThrow(
        /Stellar simulation failed/,
      );
    });

    it("should not throw error when simulation is successful", () => {
      const mockSuccessSimulation: Api.SimulateTransactionResponse = {
        id: "test-id",
        latestLedger: 12345,
        events: [],
        _parsed: true,
        transactionData: new SorobanDataBuilder(),
        minResourceFee: "100",
      } as Api.SimulateTransactionSuccessResponse;

      expect(() => handleSimulationResult(mockSuccessSimulation)).not.toThrow();
    });
  });

  describe("getAddressCredentials", () => {
    const addressCredentials = new xdr.SorobanAddressCredentials({
      address: xdr.ScAddress.scAddressTypeAccount(
        xdr.PublicKey.publicKeyTypeEd25519(Keypair.random().rawPublicKey()),
      ),
      nonce: new xdr.Int64(1),
      signatureExpirationLedger: 100,
      signature: xdr.ScVal.scvVoid(),
    });

    it("returns the credentials for the legacy V1 address arm", () => {
      const credentials = xdr.SorobanCredentials.sorobanCredentialsAddress(addressCredentials);
      expect(getAddressCredentials(credentials)).toBe(addressCredentials);
    });

    it("returns the credentials for the CAP-71 V2 address arm", () => {
      const credentials = xdr.SorobanCredentials.sorobanCredentialsAddressV2(addressCredentials);
      expect(getAddressCredentials(credentials)).toBe(addressCredentials);
    });

    it("returns undefined for source-account credentials", () => {
      const credentials = xdr.SorobanCredentials.sorobanCredentialsSourceAccount();
      expect(getAddressCredentials(credentials)).toBeUndefined();
    });

    it("returns undefined for delegated credentials", () => {
      const credentials = xdr.SorobanCredentials.sorobanCredentialsAddressWithDelegates(
        new xdr.SorobanAddressCredentialsWithDelegates({
          addressCredentials,
          delegates: [],
        }),
      );
      expect(getAddressCredentials(credentials)).toBeUndefined();
    });
  });

  describe("gatherAuthEntrySignatureStatus", () => {
    const CLIENT_SECRET = "SDV3OZOPGIO6GQAVI7T6ZJ7NSNFB26JX6QZYCI64TBC7BAZY6FQVAXXK";
    const CLIENT_PUBLIC = "GBBO4ZDDZTSM2IUKQYBAST3CFHNPFXECGEFTGWTA2WELR2BIWDK57UVE";

    const mockRpcServer = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 100000 }),
    };

    beforeEach(() => {
      vi.mocked(stellarUtils.getRpcClient).mockReturnValue(mockRpcServer as never);
    });

    // paymenrRequirements is used to create a valid payload for the test
    const paymentRequirements: PaymentRequirements = {
      scheme: "exact",
      network: STELLAR_TESTNET_CAIP2,
      asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      amount: "1000000",
      payTo: "GCHEI4PQEFJOA27MNZRPQNLGURS6KASW76X5UZCUZIXCOJLKXYCXOR2W",
      maxTimeoutSeconds: 60,
      extra: {
        areFeesSponsored: true,
      },
    };

    it("should identify signed accounts and no pending signatures", async () => {
      const signer = createEd25519Signer(CLIENT_SECRET, STELLAR_TESTNET_CAIP2);
      const signedTxJson =
        "eyJtZXRob2QiOiJ0cmFuc2ZlciIsInR4IjoiQUFBQUFnQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQURsM0lBQUFBQUFBQUFBUUFBQUFFQUFBQUFBQUFBQUFBQUFBQnBGcEdGQUFBQUFBQUFBQUVBQUFBQUFBQUFHQUFBQUFBQUFBQUJVRVhOWHNCeW1uYVAxYTBDVUZoUzMwOENqYzZERGxyRklnbTZTRWc3THdFQUFBQUlkSEpoYm5ObVpYSUFBQUFEQUFBQUVnQUFBQUFBQUFBQVF1NWtZOHprelNLS2hnSUpUMklwMnZMY2dqRUxNMXBnMVlpNDZDaXcxZDhBQUFBU0FBQUFBQUFBQUFDT1JISHdJVkxnYSt4dVl2ZzFacVJsNVFKVy82L2FaRlRLTGljbGFyNEZkd0FBQUFvQUFBQUFBQUFBQUFBQUFBQUFBQ2NRQUFBQUFRQUFBQUVBQUFBQUFBQUFBRUx1WkdQTTVNMGlpb1lDQ1U5aUtkcnkzSUl4Q3pOYVlOV0l1T2dvc05YZlh4amsrOHlZOGhnQUk4ck9BQUFBRUFBQUFBRUFBQUFCQUFBQUVRQUFBQUVBQUFBQ0FBQUFEd0FBQUFwd2RXSnNhV05mYTJWNUFBQUFBQUFOQUFBQUlFTHVaR1BNNU0waWlvWUNDVTlpS2RyeTNJSXhDek5hWU5XSXVPZ29zTlhmQUFBQUR3QUFBQWx6YVdkdVlYUjFjbVVBQUFBQUFBQU5BQUFBUUl2bjJjU3VLbFl5TU96T0pTWnkwc0VaN3dkN1QwYmdSQ0ZxZjg1M3VXQXFVcjE1ZUpycXNqVjROUVpTQW05WXNWbHZEcEUrSFRLc3pUQUVBaTJBRkFnQUFBQUFBQUFBQVZCRnpWN0FjcHAyajlXdEFsQllVdDlQQW8zT2d3NWF4U0lKdWtoSU95OEJBQUFBQ0hSeVlXNXpabVZ5QUFBQUF3QUFBQklBQUFBQUFBQUFBRUx1WkdQTTVNMGlpb1lDQ1U5aUtkcnkzSUl4Q3pOYVlOV0l1T2dvc05YZkFBQUFFZ0FBQUFBQUFBQUFqa1J4OENGUzRHdnNibUw0Tldha1plVUNWdit2Mm1SVXlpNG5KV3ErQlhjQUFBQUtBQUFBQUFBQUFBQUFBQUFBQUFBbkVBQUFBQUFBQUFBQkFBQUFBQUFBQUFJQUFBQUFBQUFBQUVMdVpHUE01TTBpaW9ZQ0NVOWlLZHJ5M0lJeEN6TmFZTldJdU9nb3NOWGZBQUFBQmdBQUFBRlFSYzFld0hLYWRvL1ZyUUpRV0ZMZlR3S056b01PV3NVaUNicElTRHN2QVFBQUFCUUFBQUFCQUFBQUF3QUFBQUVBQUFBQVF1NWtZOHprelNLS2hnSUpUMklwMnZMY2dqRUxNMXBnMVlpNDZDaXcxZDhBQUFBQlZWTkVRd0FBQUFCQ1BuMEY4dXl2dit3Wkt5RmFQeHZwYXUyNDJPY0NWS3ZqUVQ0Q0I5NVdzZ0FBQUFFQUFBQUFqa1J4OENGUzRHdnNibUw0Tldha1plVUNWdit2Mm1SVXlpNG5KV3ErQlhjQUFBQUJWVk5FUXdBQUFBQkNQbjBGOHV5dnYrd1pLeUZhUHh2cGF1MjQyT2NDVkt2alFUNENCOTVXc2dBQUFBWUFBQUFBQUFBQUFFTHVaR1BNNU0waWlvWUNDVTlpS2RyeTNJSXhDek5hWU5XSXVPZ29zTlhmQUFBQUZWOFk1UHZNbVBJWUFBQUFBQUFMNVRFQUFBRjRBQUFCTkFBQUFBQUFBNWNPQUFBQUFBPT0iLCJzaW11bGF0aW9uUmVzdWx0Ijp7ImF1dGgiOlsiQUFBQUFRQUFBQUFBQUFBQVF1NWtZOHprelNLS2hnSUpUMklwMnZMY2dqRUxNMXBnMVlpNDZDaXcxZDlmR09UN3pKanlHQUFBQUFBQUFBQUJBQUFBQUFBQUFBRlFSYzFld0hLYWRvL1ZyUUpRV0ZMZlR3S056b01PV3NVaUNicElTRHN2QVFBQUFBaDBjbUZ1YzJabGNnQUFBQU1BQUFBU0FBQUFBQUFBQUFCQzdtUmp6T1ROSW9xR0FnbFBZaW5hOHR5Q01Rc3pXbURWaUxqb0tMRFYzd0FBQUJJQUFBQUFBQUFBQUk1RWNmQWhVdUJyN0c1aStEVm1wR1hsQWxiL3I5cGtWTW91SnlWcXZnVjNBQUFBQ2dBQUFBQUFBQUFBQUFBQUFBQUFKeEFBQUFBQSJdLCJyZXR2YWwiOiJBQUFBQVE9PSJ9LCJzaW11bGF0aW9uVHJhbnNhY3Rpb25EYXRhIjoiQUFBQUFBQUFBQUlBQUFBQUFBQUFBRUx1WkdQTTVNMGlpb1lDQ1U5aUtkcnkzSUl4Q3pOYVlOV0l1T2dvc05YZkFBQUFCZ0FBQUFGUVJjMWV3SEthZG8vVnJRSlFXRkxmVHdLTnpvTU9Xc1VpQ2JwSVNEc3ZBUUFBQUJRQUFBQUJBQUFBQXdBQUFBRUFBQUFBUXU1a1k4emt6U0tLaGdJSlQySXAydkxjZ2pFTE0xcGcxWWk0NkNpdzFkOEFBQUFCVlZORVF3QUFBQUJDUG4wRjh1eXZ2K3daS3lGYVB4dnBhdTI0Mk9jQ1ZLdmpRVDRDQjk1V3NnQUFBQUVBQUFBQWprUng4Q0ZTNEd2c2JtTDROV2FrWmVVQ1Z2K3YybVJVeWk0bkpXcStCWGNBQUFBQlZWTkVRd0FBQUFCQ1BuMEY4dXl2dit3Wkt5RmFQeHZwYXUyNDJPY0NWS3ZqUVQ0Q0I5NVdzZ0FBQUFZQUFBQUFBQUFBQUVMdVpHUE01TTBpaW9ZQ0NVOWlLZHJ5M0lJeEN6TmFZTldJdU9nb3NOWGZBQUFBRlY4WTVQdk1tUElZQUFBQUFBQUw1VEVBQUFGNEFBQUJOQUFBQUFBQUE1Y08ifQ==";
      const { tx: transactionXDR } = JSON.parse(
        Buffer.from(signedTxJson, "base64").toString("utf8"),
      );

      let needsSigning: string[] = [CLIENT_PUBLIC];
      vi.spyOn(AssembledTransaction, "build").mockResolvedValue({
        simulation: {} as Api.SimulateTransactionSuccessResponse,
        needsNonInvokerSigningBy: vi.fn(() => {
          const result = needsSigning;
          needsSigning = [];
          return result;
        }),
        signAuthEntries: vi.fn().mockResolvedValue(undefined),
        simulate: vi.fn().mockResolvedValue(undefined),
        built: { toXDR: () => transactionXDR },
      } as unknown as AssembledTransaction<any>);

      const scheme = new ExactStellarScheme(signer);
      const payload = await scheme.createPaymentPayload(1, paymentRequirements);

      if (!("transaction" in payload.payload)) {
        throw new Error("Expected Stellar payload with transaction property");
      }

      const tx = new Transaction(payload.payload.transaction as string, StellarNetworks.TESTNET);
      const status = gatherAuthEntrySignatureStatus({ transaction: tx });

      expect(status.alreadySigned).toContain(CLIENT_PUBLIC);
      expect(status.pendingSignature).toHaveLength(0);
    });

    describe("CAP-71 V2 address credentials", () => {
      const PAY_TO = "GCHEI4PQEFJOA27MNZRPQNLGURS6KASW76X5UZCUZIXCOJLKXYCXOR2W";
      const ASSET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
      const EXPIRATION_LEDGER = 100_500;

      const transferArgs = new xdr.InvokeContractArgs({
        contractAddress: new Address(ASSET).toScAddress(),
        functionName: "transfer",
        args: [
          nativeToScVal(CLIENT_PUBLIC, { type: "address" }),
          nativeToScVal(PAY_TO, { type: "address" }),
          nativeToScVal("10000", { type: "i128" }),
        ],
      });

      const rootInvocation = new xdr.SorobanAuthorizedInvocation({
        function:
          xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(transferArgs),
        subInvocations: [],
      });

      /**
       * Builds an unsigned authorization entry on either credential arm.
       *
       * @param arm - "v1" for `sorobanCredentialsAddress`, "v2" for `sorobanCredentialsAddressV2`
       * @param signerAddress - The address recorded in the credentials
       * @param nonce - The credential nonce (must differ per entry within a transaction)
       * @returns An unsigned authorization entry with an `scvVoid` signature
       */
      function buildUnsignedEntry(
        arm: "v1" | "v2",
        signerAddress: string,
        nonce: number,
      ): xdr.SorobanAuthorizationEntry {
        const addressCredentials = new xdr.SorobanAddressCredentials({
          address: new Address(signerAddress).toScAddress(),
          nonce: new xdr.Int64(nonce),
          signatureExpirationLedger: 0,
          signature: xdr.ScVal.scvVoid(),
        });

        return new xdr.SorobanAuthorizationEntry({
          credentials:
            arm === "v2"
              ? xdr.SorobanCredentials.sorobanCredentialsAddressV2(addressCredentials)
              : xdr.SorobanCredentials.sorobanCredentialsAddress(addressCredentials),
          rootInvocation,
        });
      }

      /**
       * Wraps authorization entries in a transaction with a single
       * InvokeHostFunction operation, as gatherAuthEntrySignatureStatus expects.
       *
       * @param auth - The authorization entries to attach to the operation
       * @returns A built transaction carrying the entries
       */
      function wrapInTransaction(auth: xdr.SorobanAuthorizationEntry[]): Transaction {
        const operation = Operation.invokeHostFunction({
          func: xdr.HostFunction.hostFunctionTypeInvokeContract(transferArgs),
          auth,
        });

        return new TransactionBuilder(new Account(CLIENT_PUBLIC, "100"), {
          fee: "100",
          networkPassphrase: StellarNetworks.TESTNET,
        })
          .addOperation(operation)
          .setTimeout(60)
          .build();
      }

      /**
       * Extracts the raw Ed25519 signature bytes written by authorizeEntry, which
       * stores them as a vector of `{ public_key, signature }` maps.
       *
       * @param signature - The signature ScVal from address credentials
       * @returns The raw signature bytes
       */
      function extractSignatureBytes(signature: xdr.ScVal): Buffer {
        const signatureEntry = signature
          .vec()![0]
          .map()!
          .find(entry => entry.key().sym().toString() === "signature");

        if (!signatureEntry) {
          throw new Error("Signature ScVal has no `signature` member");
        }
        return signatureEntry.val().bytes();
      }

      it("should count a genuinely signed V2 entry as signed", async () => {
        const signedEntry = await authorizeEntry(
          buildUnsignedEntry("v2", CLIENT_PUBLIC, 4242),
          Keypair.fromSecret(CLIENT_SECRET),
          EXPIRATION_LEDGER,
          StellarNetworks.TESTNET,
        );

        // Guards against a relabelled V1 fixture silently passing as V2
        expect(signedEntry.credentials().switch()).toBe(
          xdr.SorobanCredentialsType.sorobanCredentialsAddressV2(),
        );

        const status = gatherAuthEntrySignatureStatus({
          transaction: wrapInTransaction([signedEntry]),
        });

        expect(status.alreadySigned).toEqual([CLIENT_PUBLIC]);
        expect(status.pendingSignature).toHaveLength(0);
      });

      it("should report an unsigned V2 entry as pending signature", () => {
        const status = gatherAuthEntrySignatureStatus({
          transaction: wrapInTransaction([buildUnsignedEntry("v2", CLIENT_PUBLIC, 4242)]),
        });

        expect(status.alreadySigned).toHaveLength(0);
        expect(status.pendingSignature).toEqual([CLIENT_PUBLIC]);
      });

      it("should sign the address-bound V2 preimage rather than the legacy V1 preimage", async () => {
        const signedEntry = await authorizeEntry(
          buildUnsignedEntry("v2", CLIENT_PUBLIC, 4242),
          Keypair.fromSecret(CLIENT_SECRET),
          EXPIRATION_LEDGER,
          StellarNetworks.TESTNET,
        );

        const credentials = getAddressCredentials(signedEntry.credentials());
        if (!credentials) {
          throw new Error("Expected address credentials on the signed V2 entry");
        }
        expect(credentials.signatureExpirationLedger()).toBe(EXPIRATION_LEDGER);

        const signatureBytes = extractSignatureBytes(credentials.signature());
        const clientKey = Keypair.fromPublicKey(CLIENT_PUBLIC);

        // V2 commits to ENVELOPE_TYPE_SOROBAN_AUTHORIZATION_WITH_ADDRESS (CAP-71)
        const v2Preimage = buildAuthorizationEntryPreimage(
          signedEntry,
          EXPIRATION_LEDGER,
          StellarNetworks.TESTNET,
        );
        expect(v2Preimage.switch().name).toBe("envelopeTypeSorobanAuthorizationWithAddress");
        expect(clientKey.verify(hash(v2Preimage.toXDR()), signatureBytes)).toBe(true);

        // The same signature must NOT satisfy the legacy, non-address-bound
        // preimage over an otherwise identical invocation and nonce - the two
        // arms are not interchangeable, so V1-only handling really does break V2.
        const v1Preimage = buildAuthorizationEntryPreimage(
          buildUnsignedEntry("v1", CLIENT_PUBLIC, 4242),
          EXPIRATION_LEDGER,
          StellarNetworks.TESTNET,
        );
        expect(v1Preimage.switch().name).toBe("envelopeTypeSorobanAuthorization");
        expect(clientKey.verify(hash(v1Preimage.toXDR()), signatureBytes)).toBe(false);
      });

      it("should count signed V1 and V2 entries in the same transaction", async () => {
        const otherKeypair = Keypair.random();

        const signedV1 = await authorizeEntry(
          buildUnsignedEntry("v1", CLIENT_PUBLIC, 1),
          Keypair.fromSecret(CLIENT_SECRET),
          EXPIRATION_LEDGER,
          StellarNetworks.TESTNET,
        );
        const signedV2 = await authorizeEntry(
          buildUnsignedEntry("v2", otherKeypair.publicKey(), 2),
          otherKeypair,
          EXPIRATION_LEDGER,
          StellarNetworks.TESTNET,
        );

        const status = gatherAuthEntrySignatureStatus({
          transaction: wrapInTransaction([signedV1, signedV2]),
        });

        expect(status.alreadySigned.sort()).toEqual(
          [CLIENT_PUBLIC, otherKeypair.publicKey()].sort(),
        );
        expect(status.pendingSignature).toHaveLength(0);
      });

      it("should skip source-account credentials while counting a V2 entry", async () => {
        const signedV2 = await authorizeEntry(
          buildUnsignedEntry("v2", CLIENT_PUBLIC, 4242),
          Keypair.fromSecret(CLIENT_SECRET),
          EXPIRATION_LEDGER,
          StellarNetworks.TESTNET,
        );
        const sourceAccountEntry = new xdr.SorobanAuthorizationEntry({
          credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
          rootInvocation,
        });

        const status = gatherAuthEntrySignatureStatus({
          transaction: wrapInTransaction([sourceAccountEntry, signedV2]),
        });

        expect(status.alreadySigned).toEqual([CLIENT_PUBLIC]);
        expect(status.pendingSignature).toHaveLength(0);
      });
    });
  });
});
