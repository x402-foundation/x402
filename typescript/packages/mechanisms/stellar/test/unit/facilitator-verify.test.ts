import { Buffer } from "buffer";
import {
  Address,
  Networks as StellarNetworks,
  SorobanDataBuilder,
  rpc,
  Transaction,
  TransactionBuilder,
  Operation,
  Account,
  xdr,
  Keypair,
  Asset,
} from "@stellar/stellar-sdk";
import { Api } from "@stellar/stellar-sdk/rpc";
import { beforeEach, beforeAll, describe, expect, it, vi } from "vitest";
import { STELLAR_TESTNET_CAIP2 } from "../../src/constants";
import {
  ExactStellarScheme,
  invalidVerifyResponse,
  validVerifyResponse,
} from "../../src/exact/facilitator/scheme";
import { createEd25519Signer } from "../../src/signer";
import * as stellarUtils from "../../src/utils";
import type { FacilitatorStellarSigner } from "../../src/signer";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

/**
 * Creates a mock transfer event for testing event validation.
 * Follows CAP-46-06 format: Topic: ["transfer", from, to, ...], Data: amount
 * @see https://github.com/stellar/stellar-protocol/blob/master/core/cap-0046-06.md
 *
 * @param params - The parameters object
 * @param params.from - The sender address
 * @param params.to - The recipient address
 * @param params.amount - The transfer amount as bigint
 * @param params.fnName - The function name (defaults to "transfer")
 * @returns A DiagnosticEvent XDR object
 */
function createMockContractEvent({
  from,
  to,
  amount,
  fnName = "transfer",
  contractId,
}: {
  from: string;
  to: string;
  amount: bigint;
  fnName?: string;
  contractId?: xdr.Hash | null;
}): xdr.DiagnosticEvent {
  // symbol for the function name
  const transferSymbol = xdr.ScVal.scvSymbol(fnName);

  const fromKeypair = Keypair.fromPublicKey(from);
  const fromScAddress = xdr.ScVal.scvAddress(
    xdr.ScAddress.scAddressTypeAccount(
      xdr.PublicKey.publicKeyTypeEd25519(fromKeypair.rawPublicKey()),
    ),
  );

  const toKeypair = Keypair.fromPublicKey(to);
  const toScAddress = xdr.ScVal.scvAddress(
    xdr.ScAddress.scAddressTypeAccount(
      xdr.PublicKey.publicKeyTypeEd25519(toKeypair.rawPublicKey()),
    ),
  );

  const amountScVal = xdr.ScVal.scvI128(
    new xdr.Int128Parts({
      lo: xdr.Uint64.fromString(amount.toString()),
      hi: xdr.Int64.fromString("0"),
    }),
  );

  const contractEventV0 = new xdr.ContractEventV0({
    topics: [transferSymbol, fromScAddress, toScAddress],
    data: amountScVal,
  });
  return createMockDiagnosticEvent(
    contractEventV0,
    xdr.ContractEventType.contract(),
    contractId ?? null,
  );
}

/**
 * Creates a mock system diagnostic event (should be ignored by event validator).
 */
function createMockSystemEvent(): xdr.DiagnosticEvent {
  return createMockDiagnosticEvent(
    new xdr.ContractEventV0({ topics: [], data: xdr.ScVal.scvVoid() }),
    xdr.ContractEventType.system(),
  );
}

/**
 * Creates a mock diagnostic event from a ContractEventV0 and event type.
 * This helper function constructs the proper XDR structure for testing
 * contract event validation in the facilitator verification process.
 *
 * @param v0 - The ContractEventV0 containing the event data
 * @param eventType - The contract event type (contract or system)
 * @param contractId - Optional contract ID (null = event has no contract; omit for backward compat)
 * @returns A properly formatted DiagnosticEvent for testing
 */
function createMockDiagnosticEvent(
  v0: xdr.ContractEventV0,
  eventType: ReturnType<typeof xdr.ContractEventType.contract> = xdr.ContractEventType.contract(),
  contractId: xdr.Hash | null = null,
): xdr.DiagnosticEvent {
  const eventBodyXdr = xdr.ContractEventBody.toXDR(
    xdr.ContractEventBody.fromXDR(
      Buffer.concat([Buffer.from([0, 0, 0, 0]), xdr.ContractEventV0.toXDR(v0)]),
    ),
  );
  const contractEvent = new xdr.ContractEvent({
    ext: xdr.ExtensionPoint.fromXDR(Buffer.from([0, 0, 0, 0])),
    contractId,
    type: eventType,
    body: xdr.ContractEventBody.fromXDR(eventBodyXdr),
  });
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: true,
    event: contractEvent,
  });
}

vi.mock("../../src/utils", async () => {
  const actual = await vi.importActual<typeof stellarUtils>("../../src/utils");
  return {
    ...actual,
    getEstimatedLedgerCloseTimeSeconds: vi.fn().mockResolvedValue(5),
    getNetworkPassphrase: vi.fn(),
    getRpcClient: vi.fn(),
  };
});

describe("ExactStellarScheme#Verify (randomly using 1-2 facilitator signers)", () => {
  const mockServer = {
    simulateTransaction: vi.fn(),
    getLatestLedger: vi.fn(),
  } as unknown as rpc.Server;

  const CLIENT_PUBLIC = "GBBO4ZDDZTSM2IUKQYBAST3CFHNPFXECGEFTGWTA2WELR2BIWDK57UVE";
  const FACILITATOR_PUBLIC = "GCQAXB2D77Y4C66CTGVH25H2RMUKMQJGOWUPK7UXGG5MAQBONUEKFQ4P";
  const TRANSACTION_RECIPIENT = "GCHEI4PQEFJOA27MNZRPQNLGURS6KASW76X5UZCUZIXCOJLKXYCXOR2W";
  const ASSET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
  const networkPassphrase = StellarNetworks.TESTNET;
  const account = new Account(CLIENT_PUBLIC, "100");

  const facilitatorSigner1 = createEd25519Signer(
    "SCKB3ECHCPVM4HJPNCQWTQWJJ5XRL6UNKLTTCIH4B7TB22NKJ5GUFMIV",
    STELLAR_TESTNET_CAIP2,
  );
  const facilitatorSigner2 = createEd25519Signer(
    "SA6LFVPCYMDQILBRXQ2B2HRPK6DV2TX4FTQQQHWFPSCSY4H2RTCD3XAK",
    STELLAR_TESTNET_CAIP2,
  );

  let stellarPayload: { transaction: string };
  let baseTransaction: Transaction;
  let baseSorobanData: xdr.SorobanTransactionData | undefined;
  let baseOperation: Operation.InvokeHostFunction;
  let baseFunc: xdr.HostFunction;
  let baseInvokeContractArgs: xdr.InvokeContractArgs;
  let facilitatorSigners: FacilitatorStellarSigner[];
  let facilitator: ExactStellarScheme;
  let validPayload: PaymentPayload;
  let validRequirements: PaymentRequirements;

  // Use a real transaction XDR from shared test (base64 encoded JSON with tx field)
  const signedTxJson =
    "eyJtZXRob2QiOiJ0cmFuc2ZlciIsInR4IjoiQUFBQUFnQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQURsM0lBQUFBQUFBQUFBUUFBQUFFQUFBQUFBQUFBQUFBQUFBQnBGcEdGQUFBQUFBQUFBQUVBQUFBQUFBQUFHQUFBQUFBQUFBQUJVRVhOWHNCeW1uYVAxYTBDVUZoUzMwOENqYzZERGxyRklnbTZTRWc3THdFQUFBQUlkSEpoYm5ObVpYSUFBQUFEQUFBQUVnQUFBQUFBQUFBQVF1NWtZOHprelNLS2hnSUpUMklwMnZMY2dqRUxNMXBnMVlpNDZDaXcxZDhBQUFBU0FBQUFBQUFBQUFDT1JISHdJVkxnYSt4dVl2ZzFacVJsNVFKVy82L2FaRlRLTGljbGFyNEZkd0FBQUFvQUFBQUFBQUFBQUFBQUFBQUFBQ2NRQUFBQUFRQUFBQUVBQUFBQUFBQUFBRUx1WkdQTTVNMGlpb1lDQ1U5aUtkcnkzSUl4Q3pOYVlOV0l1T2dvc05YZlh4amsrOHlZOGhnQUk4ck9BQUFBRUFBQUFBRUFBQUFCQUFBQUVRQUFBQUVBQUFBQ0FBQUFEd0FBQUFwd2RXSnNhV05mYTJWNUFBQUFBQUFOQUFBQUlFTHVaR1BNNU0waWlvWUNDVTlpS2RyeTNJSXhDek5hWU5XSXVPZ29zTlhmQUFBQUR3QUFBQWx6YVdkdVlYUjFjbVVBQUFBQUFBQU5BQUFBUUl2bjJjU3VLbFl5TU96T0pTWnkwc0VaN3dkN1QwYmdSQ0ZxZjg1M3VXQXFVcjE1ZUpycXNqVjROUVpTQW05WXNWbHZEcEUrSFRLc3pUQUVBaTJBRkFnQUFBQUFBQUFBQVZCRnpWN0FjcHAyajlXdEFsQllVdDlQQW8zT2d3NWF4U0lKdWtoSU95OEJBQUFBQ0hSeVlXNXpabVZ5QUFBQUF3QUFBQklBQUFBQUFBQUFBRUx1WkdQTTVNMGlpb1lDQ1U5aUtkcnkzSUl4Q3pOYVlOV0l1T2dvc05YZkFBQUFFZ0FBQUFBQUFBQUFqa1J4OENGUzRHdnNibUw0Tldha1plVUNWdit2Mm1SVXlpNG5KV3ErQlhjQUFBQUtBQUFBQUFBQUFBQUFBQUFBQUFBbkVBQUFBQUFBQUFBQkFBQUFBQUFBQUFJQUFBQUFBQUFBQUVMdVpHUE01TTBpaW9ZQ0NVOWlLZHJ5M0lJeEN6TmFZTldJdU9nb3NOWGZBQUFBQmdBQUFBRlFSYzFld0hLYWRvL1ZyUUpRV0ZMZlR3S056b01PV3NVaUNicElTRHN2QVFBQUFCUUFBQUFCQUFBQUF3QUFBQUVBQUFBQVF1NWtZOHprelNLS2hnSUpUMklwMnZMY2dqRUxNMXBnMVlpNDZDaXcxZDhBQUFBQlZWTkVRd0FBQUFCQ1BuMEY4dXl2dit3Wkt5RmFQeHZwYXUyNDJPY0NWS3ZqUVQ0Q0I5NVdzZ0FBQUFFQUFBQUFqa1J4OENGUzRHdnNibUw0Tldha1plVUNWdit2Mm1SVXlpNG5KV3ErQlhjQUFBQUJWVk5FUXdBQUFBQkNQbjBGOHV5dnYrd1pLeUZhUHh2cGF1MjQyT2NDVkt2alFUNENCOTVXc2dBQUFBWUFBQUFBQUFBQUFFTHVaR1BNNU0waWlvWUNDVTlpS2RyeTNJSXhDek5hWU5XSXVPZ29zTlhmQUFBQUZWOFk1UHZNbVBJWUFBQUFBQUFMNVRFQUFBRjRBQUFCTkFBQUFBQUFBNWNPQUFBQUFBPT0iLCJzaW11bGF0aW9uUmVzdWx0Ijp7ImF1dGgiOlsiQUFBQUFRQUFBQUFBQUFBQVF1NWtZOHprelNLS2hnSUpUMklwMnZMY2dqRUxNMXBnMVlpNDZDaXcxZDlmR09UN3pKanlHQUFBQUFBQUFBQUJBQUFBQUFBQUFBRlFSYzFld0hLYWRvL1ZyUUpRV0ZMZlR3S056b01PV3NVaUNicElTRHN2QVFBQUFBaDBjbUZ1YzJabGNnQUFBQU1BQUFBU0FBQUFBQUFBQUFCQzdtUmp6T1ROSW9xR0FnbFBZaW5hOHR5Q01Rc3pXbURWaUxqb0tMRFYzd0FBQUJJQUFBQUFBQUFBQUk1RWNmQWhVdUJyN0c1aStEVm1wR1hsQWxiL3I5cGtWTW91SnlWcXZnVjNBQUFBQ2dBQUFBQUFBQUFBQUFBQUFBQUFKeEFBQUFBQSJdLCJyZXR2YWwiOiJBQUFBQVE9PSJ9LCJzaW11bGF0aW9uVHJhbnNhY3Rpb25EYXRhIjoiQUFBQUFBQUFBQUlBQUFBQUFBQUFBRUx1WkdQTTVNMGlpb1lDQ1U5aUtkcnkzSUl4Q3pOYVlOV0l1T2dvc05YZkFBQUFCZ0FBQUFGUVJjMWV3SEthZG8vVnJRSlFXRkxmVHdLTnpvTU9Xc1VpQ2JwSVNEc3ZBUUFBQUJRQUFBQUJBQUFBQXdBQUFBRUFBQUFBUXU1a1k4emt6U0tLaGdJSlQySXAydkxjZ2pFTE0xcGcxWWk0NkNpdzFkOEFBQUFCVlZORVF3QUFBQUJDUG4wRjh1eXZ2K3daS3lGYVB4dnBhdTI0Mk9jQ1ZLdmpRVDRDQjk1V3NnQUFBQUVBQUFBQWprUng4Q0ZTNEd2c2JtTDROV2FrWmVVQ1Z2K3YybVJVeWk0bkpXcStCWGNBQUFBQlZWTkVRd0FBQUFCQ1BuMEY4dXl2dit3Wkt5RmFQeHZwYXUyNDJPY0NWS3ZqUVQ0Q0I5NVdzZ0FBQUFZQUFBQUFBQUFBQUVMdVpHUE01TTBpaW9ZQ0NVOWlLZHJ5M0lJeEN6TmFZTldJdU9nb3NOWGZBQUFBRlY4WTVQdk1tUElZQUFBQUFBQUw1VEVBQUFGNEFBQUJOQUFBQUFBQUE1Y08ifQ==";
  const txSignatureExpiration = 2345678;
  const { tx: baseTransactionXDR } = JSON.parse(
    Buffer.from(signedTxJson, "base64").toString("utf8"),
  );

  beforeAll(async () => {
    // Set up mocks
    vi.mocked(stellarUtils.getNetworkPassphrase).mockReturnValue(StellarNetworks.TESTNET);
    vi.mocked(stellarUtils.getRpcClient).mockReturnValue(mockServer);
    vi.mocked(mockServer.getLatestLedger).mockResolvedValue({
      sequence: txSignatureExpiration - 10,
    } as Api.GetLatestLedgerResponse);

    // Create valid requirements (V2 format)
    // Note: Values must match the transaction XDR from shared test
    validRequirements = {
      scheme: "exact",
      network: STELLAR_TESTNET_CAIP2,
      amount: "10000", // Extracted from transaction XDR
      payTo: TRANSACTION_RECIPIENT, // Must match transaction's recipient
      maxTimeoutSeconds: 60,
      asset: ASSET,
      extra: {
        maxLedgerOffset: 12,
      },
    };

    // Build full V2 PaymentPayload with mocked transaction
    validPayload = {
      x402Version: 2,
      resource: {
        url: "https://example.com/resource",
        description: "Test payment",
        mimeType: "application/json",
      },
      accepted: validRequirements,
      payload: {
        transaction: baseTransactionXDR,
      },
    };

    stellarPayload = validPayload.payload as { transaction: string };
    const txEnvelope = xdr.TransactionEnvelope.fromXDR(stellarPayload.transaction, "base64");
    baseTransaction = new Transaction(stellarPayload.transaction, networkPassphrase);
    baseSorobanData = txEnvelope.v1()?.tx()?.ext()?.sorobanData() || undefined;
    baseOperation = baseTransaction.operations[0] as Operation.InvokeHostFunction;
    baseFunc = baseOperation.func;
    baseInvokeContractArgs = baseFunc.invokeContract();
  });

  /**
   * Builds a modified transaction and wraps it in a PaymentPayload.
   */
  function buildStellarPayloadFromOp(
    operation: xdr.Operation,
    options?: { includeSorobanData?: boolean },
  ): PaymentPayload {
    const modifiedTx = new TransactionBuilder(account, {
      fee: baseTransaction.fee,
      networkPassphrase,
      ledgerbounds: baseTransaction.ledgerBounds,
      ...(options?.includeSorobanData !== false &&
        baseSorobanData && { sorobanData: baseSorobanData }),
    })
      .addOperation(operation)
      .setTimeout(validRequirements.maxTimeoutSeconds)
      .build();
    return {
      ...validPayload,
      payload: { transaction: modifiedTx.toXDR() },
    };
  }

  beforeEach(() => {
    // Random selection for 1-2 facilitators
    const useTwoFacilitators = Math.random() > 0.5;
    facilitatorSigners = useTwoFacilitators
      ? [facilitatorSigner1, facilitatorSigner2]
      : [facilitatorSigner1];

    // Use a high max fee for tests to avoid fee validation errors in tests that check other validations
    facilitator = new ExactStellarScheme(facilitatorSigners, {
      areFeesSponsored: true,
      maxTransactionFeeStroops: 1_000_000,
    });

    const expectedAssetHash = new Address(ASSET).toScAddress().contractId();
    const defaultTransferEvent = createMockContractEvent({
      from: CLIENT_PUBLIC,
      to: TRANSACTION_RECIPIENT,
      amount: BigInt(validRequirements.amount),
      contractId: expectedAssetHash,
    });

    vi.mocked(mockServer.simulateTransaction).mockResolvedValue({
      id: "test",
      latestLedger: 123,
      events: [defaultTransferEvent],
      _parsed: true,
      transactionData: new SorobanDataBuilder(),
      minResourceFee: "100",
      cost: { cpuInsns: "0", memBytes: "0" },
      results: [],
    } as Api.SimulateTransactionSuccessResponse);
  });

  describe("validation errors", () => {
    it("should reject invalid x402 version, scheme, and network mismatch", async () => {
      let result = await facilitator.verify(
        { ...validPayload, x402Version: 9 }, // ❌ unsupported x402 version
        validRequirements,
      );
      expect(result).toEqual(invalidVerifyResponse("invalid_x402_version"));

      result = await facilitator.verify(
        {
          ...validPayload,
          accepted: { ...validPayload.accepted, scheme: "invalid" }, // ❌ wrong scheme
        },
        validRequirements,
      );
      expect(result).toEqual(invalidVerifyResponse("unsupported_scheme"));

      result = await facilitator.verify(
        {
          ...validPayload,
          accepted: { ...validPayload.accepted, network: "foo:bar" }, // ❌ wrong network
        },
        validRequirements,
      );
      expect(result).toEqual(invalidVerifyResponse("network_mismatch"));
    });

    it("should reject transactions with fees exceeding the maximum", async () => {
      const lowMaxFeeFacilitator = new ExactStellarScheme(facilitatorSigners, {
        areFeesSponsored: true,
        maxTransactionFeeStroops: 1000, // 1000 stroops max
      });

      vi.mocked(stellarUtils.getRpcClient).mockReturnValue(mockServer as rpc.Server);
      vi.mocked(stellarUtils.getNetworkPassphrase).mockReturnValue(StellarNetworks.TESTNET);

      const result = await lowMaxFeeFacilitator.verify(validPayload, validRequirements);
      expect(result).toEqual(
        invalidVerifyResponse("invalid_exact_stellar_payload_fee_exceeds_maximum"),
      );
    });

    it("should reject transactions with fees below simulation minimum", async () => {
      const expectedAssetHashForFeeTest = new Address(ASSET).toScAddress().contractId();
      const mockTransferEventForFeeTest = createMockContractEvent({
        from: CLIENT_PUBLIC,
        to: TRANSACTION_RECIPIENT,
        amount: BigInt("10000"),
        contractId: expectedAssetHashForFeeTest,
      });

      const originalSimulate = vi.mocked(stellarUtils.getRpcClient).getMockImplementation();
      const mockServerWithHighMinFee = {
        ...mockServer,
        simulateTransaction: vi.fn().mockResolvedValue({
          id: "test",
          latestLedger: 123,
          events: [mockTransferEventForFeeTest],
          _parsed: true,
          transactionData: new SorobanDataBuilder(),
          minResourceFee: "999999999",
          cost: { cpuInsns: "0", memBytes: "0" },
          results: [],
        } as Api.SimulateTransactionSuccessResponse),
      };

      vi.mocked(stellarUtils.getRpcClient).mockReturnValue(
        mockServerWithHighMinFee as unknown as rpc.Server,
      );
      vi.mocked(stellarUtils.getNetworkPassphrase).mockReturnValue(StellarNetworks.TESTNET);

      try {
        const result = await facilitator.verify(validPayload, validRequirements);
        expect(result).toEqual(
          invalidVerifyResponse("invalid_exact_stellar_payload_fee_below_minimum", CLIENT_PUBLIC),
        );
      } finally {
        vi.mocked(stellarUtils.getRpcClient).mockImplementation(originalSimulate!);
      }
    });

    describe("mismatching networks", () => {
      it("should reject mismatching requirement<>payload networks", async () => {
        const requirements: PaymentRequirements = {
          ...validRequirements,
          network: "eip155:84532" as never, // ❌ requirements network != payload accepted
        };
        const result = await facilitator.verify(validPayload, requirements);
        expect(result).toEqual(invalidVerifyResponse("network_mismatch"));
      });

      it("should reject when network is not a Stellar network", async () => {
        const wrongNetwork = "eip155:84532" as never; // ❌ non-Stellar network
        const requirements: PaymentRequirements = {
          ...validRequirements,
          network: wrongNetwork,
        };
        const payload: PaymentPayload = {
          ...validPayload,
          accepted: { ...validPayload.accepted, network: wrongNetwork },
        };
        const result = await facilitator.verify(payload, requirements);
        expect(result).toEqual(invalidVerifyResponse("invalid_network"));
      });
    });

    it("should reject malformed transaction XDR", async () => {
      const payload = {
        ...validPayload,
        payload: { transaction: "AAAA" }, // ❌ Invalid XDR
      };
      const result = await facilitator.verify(payload, validRequirements);
      expect(result).toEqual(invalidVerifyResponse("invalid_exact_stellar_payload_malformed"));
    });

    it("should reject wrong operation count", async () => {
      expect(baseSorobanData).toBeDefined();

      const parsedOperation = Operation.invokeHostFunction(baseOperation);
      const modifiedTx = new TransactionBuilder(account, {
        fee: baseTransaction.fee,
        networkPassphrase,
        ledgerbounds: baseTransaction.ledgerBounds,
        sorobanData: baseSorobanData,
      })
        .addOperation(parsedOperation)
        .addOperation(parsedOperation) // ❌ Multiple operations are forbidden
        .setTimeout(validRequirements.maxTimeoutSeconds)
        .build();

      const modifiedStellarPayload: PaymentPayload = {
        ...validPayload,
        payload: { transaction: modifiedTx.toXDR() },
      };

      const result = await facilitator.verify(modifiedStellarPayload, validRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_stellar_payload_wrong_operation");
    });

    it("should reject wrong operation type", async () => {
      const paymentOp = Operation.payment({
        // ❌ operation of unsupported type (MUST be invokeHostFunction)
        destination: CLIENT_PUBLIC,
        asset: Asset.native(),
        amount: "1",
      });
      const modifiedStellarPayload = buildStellarPayloadFromOp(paymentOp, {
        includeSorobanData: false,
      });

      const result = await facilitator.verify(modifiedStellarPayload, validRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_stellar_payload_wrong_operation");
    });

    it("should reject wrong contract function name", async () => {
      const wrongFuncArgs = new xdr.InvokeContractArgs({
        contractAddress: baseInvokeContractArgs.contractAddress(),
        functionName: "mint", // ❌ function name MUST be "transfer"
        args: baseInvokeContractArgs.args(),
      });
      const modifiedFunc = xdr.HostFunction.hostFunctionTypeInvokeContract(wrongFuncArgs);
      const modifiedOperation = Operation.invokeHostFunction({
        ...baseOperation,
        func: modifiedFunc,
      });
      const modifiedStellarPayload = buildStellarPayloadFromOp(modifiedOperation);

      const result = await facilitator.verify(modifiedStellarPayload, validRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_stellar_payload_wrong_function_name");
    });

    it("should reject wrong asset, recipient, or amount", async () => {
      let result = await facilitator.verify(validPayload, {
        ...validRequirements,
        asset: "CDNVQW44C3HALYNVQ4SOBXY5EWYTGVYXX6JPESOLQDABJI5FC5LTRRUE", // ❌ wrong asset
      });
      expect(result.invalidReason).toBe("invalid_exact_stellar_payload_wrong_asset");

      result = await facilitator.verify(validPayload, {
        ...validRequirements,
        payTo: "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER", // ❌ wrong recipient
      });
      expect(result.invalidReason).toBe("invalid_exact_stellar_payload_wrong_recipient");
      expect(result.payer).toBe(CLIENT_PUBLIC);

      result = await facilitator.verify(validPayload, {
        ...validRequirements,
        amount: "10001", // ❌ wrong amount
      });
      expect(result.invalidReason).toBe("invalid_exact_stellar_payload_wrong_amount");
      expect(result.payer).toBe(CLIENT_PUBLIC);
    });

    describe("Authorization entries and facilitator safety", () => {
      it("should reject when facilitator is the payer (from address)", async () => {
        const facilitatorAddress = facilitatorSigner1.address;

        if (!baseSorobanData || !baseOperation.auth?.length) {
          throw new Error("Missing sorobanData or auth in test transaction");
        }

        const originalArgs = baseInvokeContractArgs.args();
        const facilitatorKeypair = Keypair.fromPublicKey(facilitatorAddress);
        const facilitatorScAddress = xdr.ScVal.scvAddress(
          xdr.ScAddress.scAddressTypeAccount(
            xdr.PublicKey.publicKeyTypeEd25519(facilitatorKeypair.rawPublicKey()),
          ),
        );

        const modifiedInvokeContractArgs = new xdr.InvokeContractArgs({
          contractAddress: baseInvokeContractArgs.contractAddress(),
          functionName: baseInvokeContractArgs.functionName(),
          args: [
            facilitatorScAddress, // ❌ facilitator CANNOT be the payer
            originalArgs[1],
            originalArgs[2],
          ],
        });
        const modifiedFunc = xdr.HostFunction.hostFunctionTypeInvokeContract(
          modifiedInvokeContractArgs,
        );
        const modifiedOperation = Operation.invokeHostFunction({
          ...baseOperation,
          func: modifiedFunc,
        });
        const modifiedStellarPayload = buildStellarPayloadFromOp(modifiedOperation);

        const result = await facilitator.verify(modifiedStellarPayload, validRequirements);
        expect(result.isValid).toBe(false);
        expect(result.invalidReason).toBe("invalid_exact_stellar_payload_facilitator_is_payer");
      });

      it("should reject empty auth entries array", async () => {
        const modifiedOperation = Operation.invokeHostFunction({
          ...baseOperation,
          auth: [], // ❌ Empty auth array
        });
        const modifiedStellarPayload = buildStellarPayloadFromOp(modifiedOperation);

        const result = await facilitator.verify(modifiedStellarPayload, validRequirements);
        expect(result.isValid).toBe(false);
        expect(result.invalidReason).toBe("invalid_exact_stellar_payload_no_auth_entries");
      });

      it("should reject missing payer signature", async () => {
        if (!baseSorobanData || !baseOperation.auth || baseOperation.auth.length === 0) {
          throw new Error("Missing sorobanData or auth in test transaction");
        }

        const originalAuth = baseOperation.auth[0];
        const originalCreds = originalAuth.credentials().address();

        const unsignedCreds = new xdr.SorobanAddressCredentials({
          address: originalCreds.address(),
          nonce: originalCreds.nonce(),
          signatureExpirationLedger: originalCreds.signatureExpirationLedger(),
          signature: xdr.ScVal.scvVoid(), // ❌ payer signature is missing
        });

        const authWithoutSignature = new xdr.SorobanAuthorizationEntry({
          credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(unsignedCreds),
          rootInvocation: originalAuth.rootInvocation(),
        });

        const modifiedOperation = Operation.invokeHostFunction({
          ...baseOperation,
          auth: [authWithoutSignature],
        });
        const modifiedStellarPayload = buildStellarPayloadFromOp(modifiedOperation);

        const result = await facilitator.verify(modifiedStellarPayload, validRequirements);
        expect(result.isValid).toBe(false);
        expect(result.invalidReason).toBe("invalid_exact_stellar_payload_missing_payer_signature");
        expect(result.payer).toBe(CLIENT_PUBLIC);
      });

      it("should reject unexpected pending signatures", async () => {
        if (!baseSorobanData || !baseOperation.auth || baseOperation.auth.length === 0) {
          throw new Error("Missing sorobanData or auth in test transaction");
        }

        const originalAuth = baseOperation.auth[0];
        const originalCreds = originalAuth.credentials().address();

        const otherKeypair = Keypair.random();
        const otherAddressScVal = xdr.ScAddress.scAddressTypeAccount(
          xdr.PublicKey.publicKeyTypeEd25519(otherKeypair.rawPublicKey()),
        );

        const pendingCreds = new xdr.SorobanAddressCredentials({
          address: otherAddressScVal,
          nonce: originalCreds.nonce(),
          signatureExpirationLedger: originalCreds.signatureExpirationLedger(),
          signature: xdr.ScVal.scvVoid(),
        });

        const pendingAuth = new xdr.SorobanAuthorizationEntry({
          credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(pendingCreds),
          rootInvocation: originalAuth.rootInvocation(),
        });

        const modifiedOperation = Operation.invokeHostFunction({
          ...baseOperation,
          auth: [originalAuth, pendingAuth], // ❌ unexpected pending signature(s)
        });
        const modifiedStellarPayload = buildStellarPayloadFromOp(modifiedOperation);

        const result = await facilitator.verify(modifiedStellarPayload, validRequirements);
        expect(result.isValid).toBe(false);
        expect(result.invalidReason).toBe(
          "invalid_exact_stellar_payload_unexpected_pending_signatures",
        );
        expect(result.payer).toBe(CLIENT_PUBLIC);
      });

      it("should reject expiration ledger too far in the future", async () => {
        if (!baseSorobanData || !baseOperation.auth || baseOperation.auth.length === 0) {
          throw new Error("Missing sorobanData or auth in test transaction");
        }

        const originalAuth = baseOperation.auth[0];
        const originalCreds = originalAuth.credentials().address();
        const farFuture = (txSignatureExpiration + 10_000).toString();

        const farFutureCreds = new xdr.SorobanAddressCredentials({
          address: originalCreds.address(),
          nonce: originalCreds.nonce(),
          signatureExpirationLedger: Number(farFuture), // ❌ Signature expiration too far
          signature: originalCreds.signature(),
        });

        const authWithFarExpiration = new xdr.SorobanAuthorizationEntry({
          credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(farFutureCreds),
          rootInvocation: originalAuth.rootInvocation(),
        });

        const modifiedOperation = Operation.invokeHostFunction({
          ...baseOperation,
          auth: [authWithFarExpiration],
        });
        const modifiedStellarPayload = buildStellarPayloadFromOp(modifiedOperation);

        const result = await facilitator.verify(modifiedStellarPayload, validRequirements);
        expect(result.isValid).toBe(false);
        expect(result.invalidReason).toBe("invalid_exact_stellar_signature_expiration_too_far");
        expect(result.payer).toBe(CLIENT_PUBLIC);
      });

      describe("credential type validation", () => {
        it("should reject auth entries with non-sorobanCredentialsAddress credentials", async () => {
          if (!baseSorobanData) {
            throw new Error("Missing sorobanData in test transaction");
          }

          const sourceAccountAuth = xdr.SorobanAuthorizationEntry.fromXDR(
            xdr.SorobanAuthorizationEntry.toXDR(
              new xdr.SorobanAuthorizationEntry({
                credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(), // ❌ not sorobanCredentialsAddress
                rootInvocation: baseOperation.auth![0].rootInvocation(),
              }),
            ),
          );

          const modifiedOperation = Operation.invokeHostFunction({
            ...baseOperation,
            auth: [sourceAccountAuth],
          });
          const modifiedStellarPayload = buildStellarPayloadFromOp(modifiedOperation);

          const result = await facilitator.verify(modifiedStellarPayload, validRequirements);
          expect(result.isValid).toBe(false);
          expect(result.invalidReason).toBe(
            "invalid_exact_stellar_payload_unsupported_credential_type",
          );
        });
      });

      describe("sub-invocation validation", () => {
        it("should reject auth entries with sub-invocations", async () => {
          if (!baseSorobanData || !baseOperation.auth || baseOperation.auth.length === 0) {
            throw new Error("Missing sorobanData or auth in test transaction");
          }

          const originalAuth = baseOperation.auth[0];
          const originalRootInvocation = originalAuth.rootInvocation();

          const subInvocation = new xdr.SorobanAuthorizedInvocation({
            function: originalRootInvocation.function(),
            subInvocations: [],
          });

          const rootWithSubInvocations = new xdr.SorobanAuthorizedInvocation({
            function: originalRootInvocation.function(),
            subInvocations: [subInvocation], // ❌ sub-invocations not allowed
          });

          const authWithSubInvocations = new xdr.SorobanAuthorizationEntry({
            credentials: originalAuth.credentials(),
            rootInvocation: rootWithSubInvocations,
          });

          const modifiedOperation = Operation.invokeHostFunction({
            ...baseOperation,
            auth: [authWithSubInvocations],
          });
          const modifiedStellarPayload = buildStellarPayloadFromOp(modifiedOperation);

          const result = await facilitator.verify(modifiedStellarPayload, validRequirements);
          expect(result.isValid).toBe(false);
          expect(result.invalidReason).toBe("invalid_exact_stellar_payload_has_subinvocations");
        });
      });

      describe("facilitator in auth entries validation", () => {
        it("should reject when facilitator address is in auth entries", async () => {
          if (!baseSorobanData || !baseOperation.auth || baseOperation.auth.length === 0) {
            throw new Error("Missing sorobanData or auth in test transaction");
          }

          const facilitatorAddress = facilitatorSigner1.address;
          const originalAuth = baseOperation.auth[0];
          const originalAddressCredentials = originalAuth.credentials().address();

          const facilitatorKeypair = Keypair.fromPublicKey(facilitatorAddress);
          const facilitatorAddressScVal = xdr.ScAddress.scAddressTypeAccount(
            xdr.PublicKey.publicKeyTypeEd25519(facilitatorKeypair.rawPublicKey()),
          );

          const facilitatorCredentials = new xdr.SorobanAddressCredentials({
            address: facilitatorAddressScVal, // ❌ facilitator address in auth entry
            nonce: originalAddressCredentials.nonce(),
            signatureExpirationLedger: originalAddressCredentials.signatureExpirationLedger(),
            signature: originalAddressCredentials.signature(),
          });

          const authWithFacilitator = new xdr.SorobanAuthorizationEntry({
            credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(facilitatorCredentials),
            rootInvocation: originalAuth.rootInvocation(),
          });

          const modifiedOperation = Operation.invokeHostFunction({
            ...baseOperation,
            auth: [authWithFacilitator],
          });
          const modifiedStellarPayload = buildStellarPayloadFromOp(modifiedOperation);

          const result = await facilitator.verify(modifiedStellarPayload, validRequirements);
          expect(result.isValid).toBe(false);
          expect(result.invalidReason).toBe("invalid_exact_stellar_payload_facilitator_in_auth");
        });
      });

      describe("should reject when source is unauthorized", () => {
        it("should reject operation.source == facilitatorAccount", async () => {
          const facilitatorAddress = facilitatorSigner1.address;

          if (!baseSorobanData) {
            throw new Error("Missing sorobanData in test transaction");
          }

          const modifiedOperation = Operation.invokeHostFunction({
            ...baseOperation,
            source: facilitatorAddress, // ❌ operation source is facilitator
          });
          const modifiedStellarPayload = buildStellarPayloadFromOp(modifiedOperation);

          const result = await facilitator.verify(modifiedStellarPayload, validRequirements);
          expect(result.isValid).toBe(false);
          expect(result.invalidReason).toBe("invalid_exact_stellar_payload_unsafe_tx_or_op_source");
        });

        it("should reject transaction.source == facilitatorAccount", async () => {
          const facilitatorAddress = facilitatorSigner1.address;

          if (!baseSorobanData) {
            throw new Error("Missing sorobanData in test transaction");
          }

          const modifiedOperation = Operation.invokeHostFunction({
            ...baseOperation,
          });
          const facilitatorAccount = new Account(facilitatorAddress, "100"); // ❌ transaction source is facilitator
          const modifiedTx = new TransactionBuilder(facilitatorAccount, {
            fee: baseTransaction.fee,
            networkPassphrase,
            ledgerbounds: baseTransaction.ledgerBounds,
            sorobanData: baseSorobanData,
          })
            .addOperation(modifiedOperation)
            .setTimeout(validRequirements.maxTimeoutSeconds)
            .build();

          const modifiedStellarPayload: PaymentPayload = {
            ...validPayload,
            payload: {
              transaction: modifiedTx.toXDR(),
            },
          };

          const result = await facilitator.verify(modifiedStellarPayload, validRequirements);
          expect(result.isValid).toBe(false);
          expect(result.invalidReason).toBe("invalid_exact_stellar_payload_unsafe_tx_or_op_source");
        });
      });
    });

    it("should reject simulation failure", async () => {
      vi.mocked(mockServer.simulateTransaction).mockResolvedValueOnce({
        error: "Simulation failed", // ❌ Simulation error
        events: [],
        id: "test",
        latestLedger: 123,
        _parsed: true,
      } as Api.SimulateTransactionErrorResponse);

      const result = await facilitator.verify(validPayload, validRequirements);
      expect(result.invalidReason).toBe("invalid_exact_stellar_payload_simulation_failed");
      expect(result.payer).toBe(CLIENT_PUBLIC);
    });

    // Event-based balance change validation
    describe("simulation event validation", () => {
      const expectedAssetHash = () => new Address(ASSET).toScAddress().contractId();

      it("should reject when simulation shows multiple transfer events", async () => {
        const mockTransferEvent1 = createMockContractEvent({
          from: CLIENT_PUBLIC,
          to: TRANSACTION_RECIPIENT,
          amount: BigInt(10000),
          contractId: expectedAssetHash(),
        });
        const mockTransferEvent2 = createMockContractEvent({
          from: CLIENT_PUBLIC,
          to: "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER",
          amount: BigInt(5000),
          contractId: expectedAssetHash(),
        });

        vi.mocked(mockServer.simulateTransaction).mockResolvedValueOnce({
          id: "test",
          latestLedger: 123,
          events: [mockTransferEvent1, mockTransferEvent2], // ❌ multiple transfer events
          _parsed: true,
          transactionData: new SorobanDataBuilder(),
          minResourceFee: "100",
          cost: { cpuInsns: "0", memBytes: "0" },
          results: [],
        } as Api.SimulateTransactionSuccessResponse);

        const result = await facilitator.verify(validPayload, validRequirements);
        expect(result.isValid).toBe(false);
        expect(result.invalidReason).toBe("invalid_exact_stellar_payload_multiple_transfers");
      });

      it("should reject when transfer event has wrong from address", async () => {
        const mockTransferEvent = createMockContractEvent({
          from: "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER", // ❌ wrong `from` address
          to: FACILITATOR_PUBLIC,
          amount: BigInt(10000),
          contractId: expectedAssetHash(),
        });

        vi.mocked(mockServer.simulateTransaction).mockResolvedValueOnce({
          id: "test",
          latestLedger: 123,
          events: [mockTransferEvent],
          _parsed: true,
          transactionData: new SorobanDataBuilder(),
          minResourceFee: "100",
          cost: { cpuInsns: "0", memBytes: "0" },
          results: [],
        } as Api.SimulateTransactionSuccessResponse);

        const result = await facilitator.verify(validPayload, validRequirements);
        expect(result.isValid).toBe(false);
        expect(result.invalidReason).toBe("invalid_exact_stellar_payload_event_wrong_from");
      });

      it("should reject when transfer event has wrong to address", async () => {
        const mockTransferEvent = createMockContractEvent({
          from: CLIENT_PUBLIC,
          to: "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER", // ❌ wrong `to` address
          amount: BigInt(10000),
          contractId: expectedAssetHash(),
        });

        vi.mocked(mockServer.simulateTransaction).mockResolvedValueOnce({
          id: "test",
          latestLedger: 123,
          events: [mockTransferEvent],
          _parsed: true,
          transactionData: new SorobanDataBuilder(),
          minResourceFee: "100",
          cost: { cpuInsns: "0", memBytes: "0" },
          results: [],
        } as Api.SimulateTransactionSuccessResponse);

        const result = await facilitator.verify(validPayload, validRequirements);
        expect(result.isValid).toBe(false);
        expect(result.invalidReason).toBe("invalid_exact_stellar_payload_event_wrong_to");
      });

      it("should reject when transfer event has wrong amount", async () => {
        const mockTransferEvent = createMockContractEvent({
          from: CLIENT_PUBLIC,
          to: TRANSACTION_RECIPIENT,
          amount: BigInt(5000), // ❌ wrong `amount` (expected 10000)
          contractId: expectedAssetHash(),
        });

        vi.mocked(mockServer.simulateTransaction).mockResolvedValueOnce({
          id: "test",
          latestLedger: 123,
          events: [mockTransferEvent],
          _parsed: true,
          transactionData: new SorobanDataBuilder(),
          minResourceFee: "100",
          cost: { cpuInsns: "0", memBytes: "0" },
          results: [],
        } as Api.SimulateTransactionSuccessResponse);

        const result = await facilitator.verify(validPayload, validRequirements);
        expect(result.isValid).toBe(false);
        expect(result.invalidReason).toBe("invalid_exact_stellar_payload_event_wrong_amount");
      });

      it("should reject when transfer event has null contractId", async () => {
        const mockTransferEvent = createMockContractEvent({
          from: CLIENT_PUBLIC,
          to: TRANSACTION_RECIPIENT,
          amount: BigInt(10000),
          contractId: null,
        });

        vi.mocked(mockServer.simulateTransaction).mockResolvedValueOnce({
          id: "test",
          latestLedger: 123,
          events: [mockTransferEvent],
          _parsed: true,
          transactionData: new SorobanDataBuilder(),
          minResourceFee: "100",
          cost: { cpuInsns: "0", memBytes: "0" },
          results: [],
        } as Api.SimulateTransactionSuccessResponse);

        const result = await facilitator.verify(validPayload, validRequirements);
        expect(result.isValid).toBe(false);
        expect(result.invalidReason).toBe(
          "invalid_exact_stellar_payload_event_missing_contract_id",
        );
      });

      it("should reject when transfer event has wrong asset (contract address)", async () => {
        const wrongAsset = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
        const mockTransferEvent = createMockContractEvent({
          from: CLIENT_PUBLIC,
          to: TRANSACTION_RECIPIENT,
          amount: BigInt(10000),
          contractId: new Address(wrongAsset).toScAddress().contractId(),
        });

        vi.mocked(mockServer.simulateTransaction).mockResolvedValueOnce({
          id: "test",
          latestLedger: 123,
          events: [mockTransferEvent],
          _parsed: true,
          transactionData: new SorobanDataBuilder(),
          minResourceFee: "100",
          cost: { cpuInsns: "0", memBytes: "0" },
          results: [],
        } as Api.SimulateTransactionSuccessResponse);

        const result = await facilitator.verify(validPayload, validRequirements);
        expect(result.isValid).toBe(false);
        expect(result.invalidReason).toBe("invalid_exact_stellar_payload_event_wrong_asset");
      });

      it("should reject when no transfer events are present", async () => {
        vi.mocked(mockServer.simulateTransaction).mockResolvedValueOnce({
          id: "test",
          latestLedger: 123,
          events: [], // ❌ no transfer events
          _parsed: true,
          transactionData: new SorobanDataBuilder(),
          minResourceFee: "100",
          cost: { cpuInsns: "0", memBytes: "0" },
          results: [],
        } as Api.SimulateTransactionSuccessResponse);

        const result = await facilitator.verify(validPayload, validRequirements);
        expect(result.isValid).toBe(false);
        expect(result.invalidReason).toBe("invalid_exact_stellar_payload_no_transfer_events");
      });

      it("should reject when a contract event is not a transfer", async () => {
        const mockNonTransferEvent = createMockContractEvent({
          from: CLIENT_PUBLIC,
          to: FACILITATOR_PUBLIC,
          amount: BigInt(10000),
          fnName: "mint", // ❌ event is not "transfer"
        });

        vi.mocked(mockServer.simulateTransaction).mockResolvedValueOnce({
          id: "test",
          latestLedger: 123,
          events: [mockNonTransferEvent],
          _parsed: true,
          transactionData: new SorobanDataBuilder(),
          minResourceFee: "100",
          cost: { cpuInsns: "0", memBytes: "0" },
          results: [],
        } as Api.SimulateTransactionSuccessResponse);

        const result = await facilitator.verify(validPayload, validRequirements);
        expect(result.isValid).toBe(false);
        expect(result.invalidReason).toBe("invalid_exact_stellar_payload_event_not_transfer");
      });

      it("should ignore non-contract events and still accept valid transfer", async () => {
        const mockTransferEvent = createMockContractEvent({
          from: CLIENT_PUBLIC,
          to: TRANSACTION_RECIPIENT,
          amount: BigInt(10000),
          contractId: expectedAssetHash(),
        });
        const nonContractEvent = createMockSystemEvent();

        vi.mocked(mockServer.simulateTransaction).mockResolvedValueOnce({
          id: "test",
          latestLedger: 123,
          events: [nonContractEvent, mockTransferEvent],
          _parsed: true,
          transactionData: new SorobanDataBuilder(),
          minResourceFee: "100",
          cost: { cpuInsns: "0", memBytes: "0" },
          results: [],
        } as Api.SimulateTransactionSuccessResponse);

        const result = await facilitator.verify(validPayload, validRequirements);
        expect(result.isValid).toBe(true);
      });
    });
  });

  describe("🎉 Successful verification", () => {
    it("should verify valid payment", async () => {
      const result = await facilitator.verify(validPayload, validRequirements);
      expect(result).toEqual(validVerifyResponse(CLIENT_PUBLIC));
      expect(stellarUtils.getRpcClient).toHaveBeenCalledWith(STELLAR_TESTNET_CAIP2, undefined);
      expect(mockServer.simulateTransaction).toHaveBeenCalled();
    });
  });
});
