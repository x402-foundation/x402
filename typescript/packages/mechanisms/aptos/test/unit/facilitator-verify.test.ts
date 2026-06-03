import {
  Account,
  AccountAddress,
  ChainId,
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
import { describe, it, expect, beforeEach } from "vitest";
import { ExactAptosScheme as ExactAptosFacilitator } from "../../src/exact/facilitator/scheme";
import { toFacilitatorAptosSigner } from "../../src/signer";
import { encodeAptosPayload } from "../../src/utils";
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

function buildTransferEntryFn(asset: string, payTo: string, amount: bigint): EntryFunction {
  return new EntryFunction(
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
    [AccountAddress.from(asset), AccountAddress.from(payTo), new U64(amount)],
  );
}

function buildEncodedTransaction(opts: {
  sender: Account;
  feePayer?: Account;
  maxGasAmount?: bigint;
  gasUnitPrice?: bigint;
  expiration?: bigint;
}): string {
  const {
    sender,
    feePayer,
    maxGasAmount = 200_000n,
    gasUnitPrice = 100n,
    expiration = FUTURE_EXPIRATION,
  } = opts;

  const rawTx = new RawTransaction(
    sender.accountAddress,
    0n,
    new TransactionPayloadEntryFunction(
      buildTransferEntryFn(USDC_TESTNET_FA, TEST_PAY_TO, TEST_AMOUNT),
    ),
    maxGasAmount,
    gasUnitPrice,
    expiration,
    new ChainId(TESTNET_CHAIN_ID),
  );

  const simpleTx = feePayer
    ? new SimpleTransaction(rawTx, feePayer.accountAddress)
    : new SimpleTransaction(rawTx);
  const senderAuth = sender.signTransactionWithAuthenticator(simpleTx);
  return encodeAptosPayload(simpleTx.bcsToBytes(), senderAuth.bcsToBytes());
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
