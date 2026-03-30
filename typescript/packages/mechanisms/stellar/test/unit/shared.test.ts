import {
  SorobanDataBuilder,
  xdr,
  Networks as StellarNetworks,
  Transaction,
} from "@stellar/stellar-sdk";
import { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import { Api } from "@stellar/stellar-sdk/rpc";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { STELLAR_TESTNET_CAIP2 } from "../../src/constants";
import { ExactStellarScheme } from "../../src/exact/client/scheme";
import { gatherAuthEntrySignatureStatus, handleSimulationResult } from "../../src/shared";
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
  });
});
