import {
  Account,
  AccountAddress,
  AccountAuthenticator,
  AccountAuthenticatorEd25519,
  AccountAuthenticatorNoAccountAuthenticator,
  ChainId,
  Ed25519PublicKey,
  Ed25519Signature,
  EntryFunction,
  Identifier,
  ModuleId,
  RawTransaction,
  Script,
  SimpleTransaction,
  StructTag,
  TransactionPayloadEntryFunction,
  TransactionPayloadScript,
  TypeTagStruct,
  U64,
} from "@aptos-labs/ts-sdk";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ExactAptosScheme as ExactAptosFacilitator } from "../../src/exact/facilitator/scheme";
import { toFacilitatorAptosSigner } from "../../src/signer";
import { createAptosClient, encodeAptosPayload } from "../../src/utils";

vi.mock("../../src/utils", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/utils")>();
  return { ...actual, createAptosClient: vi.fn() };
});
import {
  MAX_GAS_AMOUNT,
  MAX_GAS_UNIT_PRICE,
  USDC_TESTNET_FA,
  APTOS_TESTNET_CAIP2,
} from "../../src/constants";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { ExactAptosPayload } from "../../src/types";

const TESTNET_CHAIN_ID = 2;
const FUTURE_EXPIRATION = BigInt(Math.floor(Date.now() / 1000) + 3600);
// A past expiration lets us verify checks that come BEFORE the expiration check
// pass without reaching network calls (balance lookup, simulation).
const PAST_EXPIRATION = BigInt(Math.floor(Date.now() / 1000) - 100);
const TEST_PAY_TO = "0x0000000000000000000000000000000000000000000000000000000000000001";
const TEST_AMOUNT = 1000n;

function buildTransferEntryFn(
  asset: string,
  payTo: string,
  amount: bigint,
  opts?: {
    moduleName?: "primary_fungible_store" | "fungible_asset";
    functionName?: string;
    typeArgCount?: number;
    args?: unknown[];
  },
): EntryFunction {
  const moduleName = opts?.moduleName ?? "primary_fungible_store";
  const functionName = opts?.functionName ?? "transfer";
  const typeArgs =
    opts?.typeArgCount === 0
      ? []
      : [
          new TypeTagStruct(
            new StructTag(
              AccountAddress.ONE,
              new Identifier("fungible_asset"),
              new Identifier("Metadata"),
              [],
            ),
          ),
          ...(opts?.typeArgCount === 2
            ? [
                new TypeTagStruct(
                  new StructTag(
                    AccountAddress.ONE,
                    new Identifier("fungible_asset"),
                    new Identifier("Metadata"),
                    [],
                  ),
                ),
              ]
            : []),
        ];
  const args =
    opts?.args ??
    ([AccountAddress.from(asset), AccountAddress.from(payTo), new U64(amount)] as unknown[]);

  return new EntryFunction(
    new ModuleId(AccountAddress.ONE, new Identifier(moduleName)),
    new Identifier(functionName),
    typeArgs,
    args,
  );
}

function buildEncodedTransaction(opts: {
  sender: Account;
  feePayer?: Account;
  maxGasAmount?: bigint;
  gasUnitPrice?: bigint;
  expiration?: bigint;
  senderAuth?: AccountAuthenticator;
  chainId?: number;
  entryFn?: EntryFunction;
  scriptPayload?: TransactionPayloadScript;
}): string {
  const {
    sender,
    feePayer,
    maxGasAmount = 200_000n,
    gasUnitPrice = 100n,
    expiration = FUTURE_EXPIRATION,
    senderAuth,
    chainId = TESTNET_CHAIN_ID,
    entryFn = buildTransferEntryFn(USDC_TESTNET_FA, TEST_PAY_TO, TEST_AMOUNT),
    scriptPayload,
  } = opts;

  const payload = scriptPayload ?? new TransactionPayloadEntryFunction(entryFn);
  const rawTx = new RawTransaction(
    sender.accountAddress,
    0n,
    payload,
    maxGasAmount,
    gasUnitPrice,
    expiration,
    new ChainId(chainId),
  );

  const simpleTx = feePayer
    ? new SimpleTransaction(rawTx, feePayer.accountAddress)
    : new SimpleTransaction(rawTx);
  const authenticator = senderAuth ?? sender.signTransactionWithAuthenticator(simpleTx);
  return encodeAptosPayload(simpleTx.bcsToBytes(), authenticator.bcsToBytes());
}

function buildPayload(encodedTx: string): PaymentPayload {
  return {
    x402Version: 2,
    accepted: { scheme: "exact", network: APTOS_TESTNET_CAIP2 },
    payload: { transaction: encodedTx } as ExactAptosPayload,
  };
}

function buildRequirements(feePayerAddress?: string): PaymentRequirements {
  return {
    scheme: "exact",
    network: APTOS_TESTNET_CAIP2,
    asset: USDC_TESTNET_FA,
    amount: TEST_AMOUNT.toString(),
    payTo: TEST_PAY_TO,
    maxTimeoutSeconds: 3600,
    extra: feePayerAddress ? { feePayer: feePayerAddress } : {},
  };
}

describe("ExactAptosFacilitator.verify() - gas parameter validation", () => {
  let sender: Account;
  let feePayerAccount: Account;
  let facilitator: ExactAptosFacilitator;

  beforeEach(() => {
    sender = Account.generate();
    feePayerAccount = Account.generate();
    facilitator = new ExactAptosFacilitator(toFacilitatorAptosSigner(feePayerAccount));
  });

  describe("gas_unit_price bounds check", () => {
    it("rejects when gas_unit_price exceeds MAX_GAS_UNIT_PRICE", async () => {
      const encodedTx = buildEncodedTransaction({
        sender,
        feePayer: feePayerAccount,
        gasUnitPrice: MAX_GAS_UNIT_PRICE + 1n,
      });

      const result = await facilitator.verify(
        buildPayload(encodedTx),
        buildRequirements(feePayerAccount.accountAddress.toStringLong()),
      );

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toContain("invalid_exact_aptos_payload_gas_unit_price_too_high");
    });

    it("includes the offending value and limit in the error message", async () => {
      const inflatedPrice = MAX_GAS_UNIT_PRICE + 5000n;
      const encodedTx = buildEncodedTransaction({
        sender,
        feePayer: feePayerAccount,
        gasUnitPrice: inflatedPrice,
      });

      const result = await facilitator.verify(
        buildPayload(encodedTx),
        buildRequirements(feePayerAccount.accountAddress.toStringLong()),
      );

      expect(result.invalidReason).toContain(inflatedPrice.toString());
      expect(result.invalidReason).toContain(MAX_GAS_UNIT_PRICE.toString());
    });

    it("passes the gas_unit_price check when at the limit exactly", async () => {
      // PAST_EXPIRATION causes the expiration check (which comes after gas checks) to reject.
      // If we instead got a gas_unit_price error here the check would be rejecting valid prices.
      const encodedTx = buildEncodedTransaction({
        sender,
        feePayer: feePayerAccount,
        gasUnitPrice: MAX_GAS_UNIT_PRICE,
        expiration: PAST_EXPIRATION,
      });

      const result = await facilitator.verify(
        buildPayload(encodedTx),
        buildRequirements(feePayerAccount.accountAddress.toStringLong()),
      );

      expect(result.invalidReason).not.toContain("gas_unit_price");
      expect(result.invalidReason).toBe("invalid_exact_aptos_payload_transaction_expired");
    });

    it("passes the gas_unit_price check when below the limit", async () => {
      const encodedTx = buildEncodedTransaction({
        sender,
        feePayer: feePayerAccount,
        gasUnitPrice: 100n,
        expiration: PAST_EXPIRATION,
      });

      const result = await facilitator.verify(
        buildPayload(encodedTx),
        buildRequirements(feePayerAccount.accountAddress.toStringLong()),
      );

      expect(result.invalidReason).not.toContain("gas_unit_price");
      expect(result.invalidReason).toBe("invalid_exact_aptos_payload_transaction_expired");
    });
  });

  describe("max_gas_amount bounds check", () => {
    it("rejects when max_gas_amount exceeds MAX_GAS_AMOUNT", async () => {
      const encodedTx = buildEncodedTransaction({
        sender,
        feePayer: feePayerAccount,
        maxGasAmount: MAX_GAS_AMOUNT + 1n,
      });

      const result = await facilitator.verify(
        buildPayload(encodedTx),
        buildRequirements(feePayerAccount.accountAddress.toStringLong()),
      );

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toContain("invalid_exact_aptos_payload_gas_too_high");
    });

    it("passes the max_gas_amount check when at the limit exactly", async () => {
      const encodedTx = buildEncodedTransaction({
        sender,
        feePayer: feePayerAccount,
        maxGasAmount: MAX_GAS_AMOUNT,
        expiration: PAST_EXPIRATION,
      });

      const result = await facilitator.verify(
        buildPayload(encodedTx),
        buildRequirements(feePayerAccount.accountAddress.toStringLong()),
      );

      expect(result.invalidReason).not.toContain("gas_too_high");
      expect(result.invalidReason).toBe("invalid_exact_aptos_payload_transaction_expired");
    });
  });

  describe("non-sponsored transactions skip gas checks", () => {
    it("does not apply gas checks when feePayer is absent from requirements", async () => {
      // Both limits exceeded — would be rejected immediately if sponsored.
      const encodedTx = buildEncodedTransaction({
        sender,
        maxGasAmount: MAX_GAS_AMOUNT + 1n,
        gasUnitPrice: MAX_GAS_UNIT_PRICE + 1n,
        expiration: PAST_EXPIRATION,
      });

      const result = await facilitator.verify(
        buildPayload(encodedTx),
        buildRequirements(), // no feePayer → non-sponsored
      );

      expect(result.invalidReason).not.toContain("gas_unit_price");
      expect(result.invalidReason).not.toContain("gas_too_high");
      // Falls through to expiration check, which rejects for the expected reason
      expect(result.invalidReason).toBe("invalid_exact_aptos_payload_transaction_expired");
    });
  });
});

describe("ExactAptosFacilitator.verify() - signature verification", () => {
  let sender: Account;
  let feePayerAccount: Account;
  let facilitator: ExactAptosFacilitator;

  beforeEach(() => {
    sender = Account.generate();
    feePayerAccount = Account.generate();
    facilitator = new ExactAptosFacilitator(toFacilitatorAptosSigner(feePayerAccount));
  });

  it("rejects a forged all-zero Ed25519 signature before network calls", async () => {
    const forgedAuth = new AccountAuthenticatorEd25519(
      sender.publicKey as Ed25519PublicKey,
      new Ed25519Signature(new Uint8Array(64)),
    );
    const encodedTx = buildEncodedTransaction({
      sender,
      feePayer: feePayerAccount,
      expiration: PAST_EXPIRATION,
      senderAuth: forgedAuth,
    });

    const result = await facilitator.verify(
      buildPayload(encodedTx),
      buildRequirements(feePayerAccount.accountAddress.toStringLong()),
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(
      "invalid_exact_aptos_payload_sender_authenticator_invalid_signature",
    );
  });

  it("accepts a valid sponsored signature and reaches later checks", async () => {
    const encodedTx = buildEncodedTransaction({
      sender,
      feePayer: feePayerAccount,
      expiration: PAST_EXPIRATION,
    });

    const result = await facilitator.verify(
      buildPayload(encodedTx),
      buildRequirements(feePayerAccount.accountAddress.toStringLong()),
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_aptos_payload_transaction_expired");
    expect(result.invalidReason).not.toBe(
      "invalid_exact_aptos_payload_sender_authenticator_invalid_signature",
    );
  });

  it("accepts a valid non-sponsored signature and reaches later checks", async () => {
    const encodedTx = buildEncodedTransaction({
      sender,
      expiration: PAST_EXPIRATION,
    });

    const result = await facilitator.verify(buildPayload(encodedTx), buildRequirements());

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_aptos_payload_transaction_expired");
    expect(result.invalidReason).not.toBe(
      "invalid_exact_aptos_payload_sender_authenticator_invalid_signature",
    );
  });
});

describe("ExactAptosFacilitator.verify() - payload validation", () => {
  let sender: Account;
  let feePayerAccount: Account;
  let facilitator: ExactAptosFacilitator;
  const mockGetBalances = vi.fn();
  const mockSimulate = vi.fn();

  beforeEach(() => {
    sender = Account.generate();
    feePayerAccount = Account.generate();
    facilitator = new ExactAptosFacilitator(toFacilitatorAptosSigner(feePayerAccount));
    mockGetBalances.mockResolvedValue([{ amount: TEST_AMOUNT.toString() }]);
    mockSimulate.mockResolvedValue([{ success: true }]);
    vi.mocked(createAptosClient).mockReturnValue({
      getCurrentFungibleAssetBalances: mockGetBalances,
      transaction: { simulate: { simple: mockSimulate } },
    } as unknown as ReturnType<typeof createAptosClient>);
  });

  it("rejects unsupported x402 version", async () => {
    const encodedTx = buildEncodedTransaction({ sender, expiration: PAST_EXPIRATION });
    const payload = buildPayload(encodedTx);
    payload.x402Version = 1;

    const result = await facilitator.verify(payload, buildRequirements());

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_aptos_payload_unsupported_version");
  });

  it("rejects unsupported scheme", async () => {
    const encodedTx = buildEncodedTransaction({ sender, expiration: PAST_EXPIRATION });
    const payload = buildPayload(encodedTx);
    payload.accepted.scheme = "upto";

    const result = await facilitator.verify(payload, buildRequirements());

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("unsupported_scheme");
  });

  it("rejects network mismatch", async () => {
    const encodedTx = buildEncodedTransaction({ sender, expiration: PAST_EXPIRATION });
    const requirements = buildRequirements();
    requirements.network = "aptos:1";

    const result = await facilitator.verify(buildPayload(encodedTx), requirements);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("network_mismatch");
  });

  it("rejects fee payer not managed by facilitator", async () => {
    const encodedTx = buildEncodedTransaction({
      sender,
      feePayer: feePayerAccount,
      expiration: PAST_EXPIRATION,
    });
    const otherFeePayer = Account.generate().accountAddress.toStringLong();

    const result = await facilitator.verify(
      buildPayload(encodedTx),
      buildRequirements(otherFeePayer),
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("fee_payer_not_managed_by_facilitator");
  });

  it("rejects chain id mismatch", async () => {
    const encodedTx = buildEncodedTransaction({
      sender,
      expiration: PAST_EXPIRATION,
      chainId: 1,
    });

    const result = await facilitator.verify(buildPayload(encodedTx), buildRequirements());

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("invalid_exact_aptos_payload_chain_id_mismatch");
  });

  it("rejects Ed25519 authenticator when public key does not match sender", async () => {
    const wrongSigner = Account.generate();
    const rawTx = new RawTransaction(
      sender.accountAddress,
      0n,
      new TransactionPayloadEntryFunction(
        buildTransferEntryFn(USDC_TESTNET_FA, TEST_PAY_TO, TEST_AMOUNT),
      ),
      200_000n,
      100n,
      PAST_EXPIRATION,
      new ChainId(TESTNET_CHAIN_ID),
    );
    const simpleTx = new SimpleTransaction(rawTx);
    const mismatchedAuth = wrongSigner.signTransactionWithAuthenticator(simpleTx);
    const encodedTx = encodeAptosPayload(simpleTx.bcsToBytes(), mismatchedAuth.bcsToBytes());

    const result = await facilitator.verify(buildPayload(encodedTx), buildRequirements());

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_aptos_payload_sender_authenticator_mismatch");
  });

  it("rejects unsupported authenticator type", async () => {
    const unsupportedAuth = new AccountAuthenticatorNoAccountAuthenticator();
    const encodedTx = buildEncodedTransaction({
      sender,
      expiration: PAST_EXPIRATION,
      senderAuth: unsupportedAuth,
    });

    const result = await facilitator.verify(buildPayload(encodedTx), buildRequirements());

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_aptos_payload_unsupported_authenticator");
  });

  it("rejects fee payer address mismatch on sponsored transaction", async () => {
    const otherFeePayer = Account.generate();
    const encodedTx = buildEncodedTransaction({
      sender,
      feePayer: otherFeePayer,
      expiration: PAST_EXPIRATION,
    });

    const result = await facilitator.verify(
      buildPayload(encodedTx),
      buildRequirements(feePayerAccount.accountAddress.toStringLong()),
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_aptos_payload_fee_payer_mismatch");
  });

  it("rejects when fee payer is also the sender on sponsored transaction", async () => {
    const encodedTx = buildEncodedTransaction({
      sender: feePayerAccount,
      feePayer: feePayerAccount,
      expiration: PAST_EXPIRATION,
    });

    const result = await facilitator.verify(
      buildPayload(encodedTx),
      buildRequirements(feePayerAccount.accountAddress.toStringLong()),
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_aptos_payload_fee_payer_transferring_funds");
  });

  it("rejects non-entry-function payloads", async () => {
    const scriptPayload = new TransactionPayloadScript(new Script(new Uint8Array(0), [], []));
    const encodedTx = buildEncodedTransaction({
      sender,
      expiration: FUTURE_EXPIRATION,
      scriptPayload,
    });

    const result = await facilitator.verify(buildPayload(encodedTx), buildRequirements());

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_aptos_payload_missing_entry_function");
  });

  it("rejects wrong transfer function", async () => {
    const encodedTx = buildEncodedTransaction({
      sender,
      expiration: FUTURE_EXPIRATION,
      entryFn: buildTransferEntryFn(USDC_TESTNET_FA, TEST_PAY_TO, TEST_AMOUNT, {
        moduleName: "fungible_asset",
        functionName: "mint",
      }),
    });

    const result = await facilitator.verify(buildPayload(encodedTx), buildRequirements());

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_aptos_payload_wrong_function");
  });

  it("accepts fungible_asset::transfer as a valid transfer function", async () => {
    const encodedTx = buildEncodedTransaction({
      sender,
      expiration: PAST_EXPIRATION,
      entryFn: buildTransferEntryFn(USDC_TESTNET_FA, TEST_PAY_TO, TEST_AMOUNT, {
        moduleName: "fungible_asset",
      }),
    });

    const result = await facilitator.verify(buildPayload(encodedTx), buildRequirements());

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_aptos_payload_transaction_expired");
  });

  it("rejects wrong type argument count", async () => {
    const encodedTx = buildEncodedTransaction({
      sender,
      expiration: FUTURE_EXPIRATION,
      entryFn: buildTransferEntryFn(USDC_TESTNET_FA, TEST_PAY_TO, TEST_AMOUNT, {
        typeArgCount: 0,
      }),
    });

    const result = await facilitator.verify(buildPayload(encodedTx), buildRequirements());

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_aptos_payload_wrong_type_args");
  });

  it("rejects wrong argument count", async () => {
    const encodedTx = buildEncodedTransaction({
      sender,
      expiration: FUTURE_EXPIRATION,
      entryFn: buildTransferEntryFn(USDC_TESTNET_FA, TEST_PAY_TO, TEST_AMOUNT, {
        args: [AccountAddress.from(USDC_TESTNET_FA), AccountAddress.from(TEST_PAY_TO)],
      }),
    });

    const result = await facilitator.verify(buildPayload(encodedTx), buildRequirements());

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_aptos_payload_wrong_args");
  });

  it("rejects asset mismatch", async () => {
    const wrongAsset = Account.generate().accountAddress.toStringLong();
    const encodedTx = buildEncodedTransaction({
      sender,
      expiration: FUTURE_EXPIRATION,
      entryFn: buildTransferEntryFn(wrongAsset, TEST_PAY_TO, TEST_AMOUNT),
    });

    const result = await facilitator.verify(buildPayload(encodedTx), buildRequirements());

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_aptos_payload_asset_mismatch");
  });

  it("rejects amount mismatch", async () => {
    const encodedTx = buildEncodedTransaction({
      sender,
      expiration: FUTURE_EXPIRATION,
      entryFn: buildTransferEntryFn(USDC_TESTNET_FA, TEST_PAY_TO, 999n),
    });

    const result = await facilitator.verify(buildPayload(encodedTx), buildRequirements());

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_aptos_payload_amount_mismatch");
  });

  it("rejects recipient mismatch", async () => {
    const wrongRecipient = Account.generate().accountAddress.toStringLong();
    const encodedTx = buildEncodedTransaction({
      sender,
      expiration: FUTURE_EXPIRATION,
      entryFn: buildTransferEntryFn(USDC_TESTNET_FA, wrongRecipient, TEST_AMOUNT),
    });

    const result = await facilitator.verify(buildPayload(encodedTx), buildRequirements());

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_aptos_payload_recipient_mismatch");
  });

  it("returns verification error for malformed payload", async () => {
    const payload = buildPayload("not-valid-base64-json");
    payload.payload = { transaction: "!!!" } as ExactAptosPayload["transaction"] & object;

    const result = await facilitator.verify(payload, buildRequirements());

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("invalid_exact_aptos_payload_verification_error");
  });
});

describe("ExactAptosFacilitator.verify() - balance and simulation", () => {
  let sender: Account;
  let feePayerAccount: Account;
  let facilitator: ExactAptosFacilitator;
  const mockGetBalances = vi.fn();
  const mockSimulate = vi.fn();

  beforeEach(() => {
    sender = Account.generate();
    feePayerAccount = Account.generate();
    facilitator = new ExactAptosFacilitator(toFacilitatorAptosSigner(feePayerAccount));
    mockGetBalances.mockReset();
    mockSimulate.mockReset();
    vi.mocked(createAptosClient).mockReturnValue({
      getCurrentFungibleAssetBalances: mockGetBalances,
      transaction: { simulate: { simple: mockSimulate } },
    } as unknown as ReturnType<typeof createAptosClient>);
  });

  it("rejects when sender has insufficient balance", async () => {
    mockGetBalances.mockResolvedValue([{ amount: "0" }]);
    const encodedTx = buildEncodedTransaction({ sender, expiration: FUTURE_EXPIRATION });

    const result = await facilitator.verify(buildPayload(encodedTx), buildRequirements());

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_aptos_payload_insufficient_balance");
  });

  it("rejects when simulation fails", async () => {
    mockGetBalances.mockResolvedValue([{ amount: TEST_AMOUNT.toString() }]);
    mockSimulate.mockResolvedValue([{ success: false, vm_status: "INSUFFICIENT_BALANCE" }]);
    const encodedTx = buildEncodedTransaction({ sender, expiration: FUTURE_EXPIRATION });

    const result = await facilitator.verify(buildPayload(encodedTx), buildRequirements());

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("invalid_exact_aptos_payload_simulation_failed");
  });

  it("accepts a valid non-sponsored payment after balance and simulation checks", async () => {
    mockGetBalances.mockResolvedValue([{ amount: TEST_AMOUNT.toString() }]);
    mockSimulate.mockResolvedValue([{ success: true }]);
    const encodedTx = buildEncodedTransaction({ sender, expiration: FUTURE_EXPIRATION });

    const result = await facilitator.verify(buildPayload(encodedTx), buildRequirements());

    expect(result.isValid).toBe(true);
    expect(result.invalidReason).toBeUndefined();
    expect(result.payer).toBe(sender.accountAddress.toString());
  });
});

describe("ExactAptosFacilitator.settle()", () => {
  let sender: Account;
  let feePayerAccount: Account;

  beforeEach(() => {
    sender = Account.generate();
    feePayerAccount = Account.generate();
    vi.mocked(createAptosClient).mockReturnValue({
      getCurrentFungibleAssetBalances: vi
        .fn()
        .mockResolvedValue([{ amount: TEST_AMOUNT.toString() }]),
      transaction: { simulate: { simple: vi.fn().mockResolvedValue([{ success: true }]) } },
    } as unknown as ReturnType<typeof createAptosClient>);
  });

  it("returns verification failure without submitting", async () => {
    const mockSigner = {
      getAddresses: () => [feePayerAccount.accountAddress.toStringLong()],
      signAndSubmitAsFeePayer: vi.fn(),
      submitTransaction: vi.fn(),
      simulateTransaction: vi.fn(),
      waitForTransaction: vi.fn(),
    };
    const facilitator = new ExactAptosFacilitator(mockSigner);
    const encodedTx = buildEncodedTransaction({ sender, expiration: PAST_EXPIRATION });

    const result = await facilitator.settle(buildPayload(encodedTx), buildRequirements());

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("invalid_exact_aptos_payload_transaction_expired");
    expect(mockSigner.submitTransaction).not.toHaveBeenCalled();
  });

  it("submits non-sponsored transaction after successful verification", async () => {
    const mockSigner = {
      getAddresses: () => [feePayerAccount.accountAddress.toStringLong()],
      signAndSubmitAsFeePayer: vi.fn(),
      submitTransaction: vi.fn().mockResolvedValue({ hash: "0xdeadbeef" }),
      simulateTransaction: vi.fn(),
      waitForTransaction: vi.fn().mockResolvedValue(undefined),
    };
    const facilitator = new ExactAptosFacilitator(mockSigner);
    const encodedTx = buildEncodedTransaction({ sender, expiration: FUTURE_EXPIRATION });

    const result = await facilitator.settle(buildPayload(encodedTx), buildRequirements());

    expect(result.success).toBe(true);
    expect(result.transaction).toBe("0xdeadbeef");
    expect(mockSigner.submitTransaction).toHaveBeenCalledOnce();
    expect(mockSigner.waitForTransaction).toHaveBeenCalledWith("0xdeadbeef", APTOS_TESTNET_CAIP2);
  });

  it("submits sponsored transaction via fee payer signer", async () => {
    const mockSigner = {
      getAddresses: () => [feePayerAccount.accountAddress.toStringLong()],
      signAndSubmitAsFeePayer: vi.fn().mockResolvedValue({ hash: "0xfeedface" }),
      submitTransaction: vi.fn(),
      simulateTransaction: vi.fn(),
      waitForTransaction: vi.fn().mockResolvedValue(undefined),
    };
    const facilitator = new ExactAptosFacilitator(mockSigner);
    const encodedTx = buildEncodedTransaction({
      sender,
      feePayer: feePayerAccount,
      expiration: FUTURE_EXPIRATION,
    });

    const result = await facilitator.settle(
      buildPayload(encodedTx),
      buildRequirements(feePayerAccount.accountAddress.toStringLong()),
    );

    expect(result.success).toBe(true);
    expect(result.transaction).toBe("0xfeedface");
    expect(mockSigner.signAndSubmitAsFeePayer).toHaveBeenCalledOnce();
  });

  it("returns transaction_failed when submission throws", async () => {
    const mockSigner = {
      getAddresses: () => [feePayerAccount.accountAddress.toStringLong()],
      signAndSubmitAsFeePayer: vi.fn(),
      submitTransaction: vi.fn().mockRejectedValue(new Error("rpc unavailable")),
      simulateTransaction: vi.fn(),
      waitForTransaction: vi.fn(),
    };
    const facilitator = new ExactAptosFacilitator(mockSigner);
    const encodedTx = buildEncodedTransaction({ sender, expiration: FUTURE_EXPIRATION });

    const result = await facilitator.settle(buildPayload(encodedTx), buildRequirements());

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("transaction_failed: rpc unavailable");
  });
});
