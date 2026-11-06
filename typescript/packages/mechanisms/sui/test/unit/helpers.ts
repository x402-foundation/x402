import { TransactionError, type ClientWithCoreApi, type SuiClientTypes } from "@mysten/sui/client";
import type { Signer } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, toBase64 } from "@mysten/sui/utils";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { vi } from "vitest";
import { SUI_TESTNET_CAIP2, USDC_TESTNET } from "../../src/constants";
import type { ExactSuiPayload } from "../../src/types";

export const payerKeypair = new Ed25519Keypair();
export const payer = payerKeypair.toSuiAddress();
export const payTo = new Ed25519Keypair().toSuiAddress();
export const sponsorKeypair = new Ed25519Keypair();
export const feePayer = sponsorKeypair.toSuiAddress();

/** 32 zero bytes, base58: a well-formed stand-in for the chain identifier. */
export const CHAIN_ID = "11111111111111111111111111111111";
export const EPOCH = 100;

type Expiration =
  | { None: true }
  | { Validity: Record<string, unknown> }
  | { Epoch: number }
  | {
      ValidDuring: {
        minEpoch: string | null;
        maxEpoch: string | null;
        minTimestamp: null;
        maxTimestamp: null;
        chain: string;
        nonce: number;
      };
    };

/**
 * A `ValidDuring` expiration over the given epochs.
 *
 * @param minEpoch - First valid epoch
 * @param maxEpoch - Last valid epoch
 * @returns The expiration
 */
export function validDuring(
  minEpoch: number | null = EPOCH,
  maxEpoch: number | null = EPOCH + 1,
): Expiration {
  return {
    ValidDuring: {
      minEpoch: minEpoch === null ? null : String(minEpoch),
      maxEpoch: maxEpoch === null ? null : String(maxEpoch),
      minTimestamp: null,
      maxTimestamp: null,
      chain: CHAIN_ID,
      nonce: 7,
    },
  };
}

export type TestTransactionOptions = {
  /** Gas owned by the sponsor (`feePayer`) with an empty payment. */
  sponsored?: boolean;
  sender?: string;
  gasOwner?: string;
  gasBudget?: number;
  /** Gas coin objects; defaults to none (address-balance gas). */
  gasCoins?: number;
  /** Also transfer the gas coin to `payTo`. */
  useGasCoin?: boolean;
  /** Add a SUI withdrawal from this source. */
  withdrawFrom?: "sender" | "sponsor" | "sponsor-allowance";
  nonce?: string;
  nonceUsed?: boolean;
  expiration?: Expiration;
  /** Distinguishes otherwise identical transactions. */
  amount?: number;
};

/**
 * Build a resolved address-balance payment offline: a USDC withdrawal from the
 * sender, `redeem_funds`, then `send_funds` to `payTo`, with a `ValidDuring`
 * expiration. Self-paid by default; `sponsored` sets `feePayer` as gas owner.
 *
 * @param options - Overrides
 * @returns Base64-encoded transaction bytes
 */
export async function buildTestTransaction(options: TestTransactionOptions = {}): Promise<string> {
  const {
    sponsored = false,
    sender = payer,
    gasOwner = sponsored ? feePayer : undefined,
    gasBudget = 2_000_000,
    gasCoins = 0,
    useGasCoin = false,
    withdrawFrom,
    nonce,
    nonceUsed = false,
    expiration = validDuring(),
    amount = 10_000,
  } = options;

  const tx = new Transaction();
  tx.setSender(sender);
  const [balance] = tx.moveCall({
    target: "0x2::balance::redeem_funds",
    typeArguments: [USDC_TESTNET],
    arguments: [tx.withdrawal({ amount, type: USDC_TESTNET })],
  });
  tx.moveCall({
    target: "0x2::balance::send_funds",
    typeArguments: [USDC_TESTNET],
    arguments: [balance, tx.pure.address(payTo)],
  });
  if (useGasCoin) {
    tx.transferObjects([tx.gas], tx.pure.address(payTo));
  }
  if (withdrawFrom) {
    const withdrawal =
      withdrawFrom === "sender"
        ? tx.withdrawal({ amount: 1 })
        : withdrawFrom === "sponsor"
          ? tx.withdrawal({ amount: 1, from: "sponsor" })
          : tx.withdrawal({
              amount: 1,
              from: "allowance",
              funder: feePayer,
              allowance: `0x${"55".repeat(32)}`,
            });
    tx.moveCall({
      target: "0x2::balance::redeem_funds",
      typeArguments: ["0x2::sui::SUI"],
      arguments: [withdrawal],
    });
  }
  if (nonce) {
    const nonceArg = tx.pure(fromBase64(nonce));
    if (nonceUsed) {
      tx.moveCall({ target: `0x${"33".repeat(32)}::receipt::write`, arguments: [nonceArg] });
    }
  }

  if (gasOwner) tx.setGasOwner(gasOwner);
  tx.setGasPrice(1000);
  tx.setGasBudget(gasBudget);
  tx.setGasPayment(
    Array.from({ length: gasCoins }, (_, i) => ({
      objectId: `0x${(0x22 + i).toString(16).repeat(32)}`,
      version: "1",
      digest: CHAIN_ID,
    })),
  );
  tx.setExpiration(expiration);

  return toBase64(await tx.build());
}

/**
 * The digest of Base64 transaction bytes.
 *
 * @param transaction - Base64-encoded transaction bytes
 * @returns The digest
 */
export function digestOf(transaction: string): Promise<string> {
  return Transaction.from(transaction).getDigest();
}

/**
 * Sign transaction bytes and assemble an ExactSuiPayload.
 *
 * @param transaction - Base64-encoded transaction bytes
 * @param signer - The signer (defaults to the shared payer keypair)
 * @returns The signed payload
 */
export async function signPayload(
  transaction: string,
  signer: Signer = payerKeypair,
): Promise<ExactSuiPayload> {
  const { signature } = await signer.signTransaction(fromBase64(transaction));
  return { transaction, signature };
}

/**
 * Produce a serialized signature over transaction bytes.
 *
 * @param transaction - Base64-encoded transaction bytes
 * @param signer - The signer (defaults to the shared payer keypair)
 * @returns The base64 serialized signature
 */
export async function signOnly(
  transaction: string,
  signer: Signer = payerKeypair,
): Promise<string> {
  const { signature } = await signer.signTransaction(fromBase64(transaction));
  return signature;
}

/**
 * Payment requirements for the standard test payment.
 *
 * @param overrides - Field overrides
 * @returns Payment requirements
 */
export function testRequirements(overrides?: Partial<PaymentRequirements>): PaymentRequirements {
  return {
    scheme: "exact",
    network: SUI_TESTNET_CAIP2,
    amount: "10000",
    asset: USDC_TESTNET,
    payTo,
    maxTimeoutSeconds: 300,
    extra: {},
    ...overrides,
  };
}

/**
 * Wrap a Sui payload in the x402 payment envelope.
 *
 * @param payload - The scheme payload
 * @param requirements - The accepted requirements
 * @returns The payment payload envelope
 */
export function testPayload(
  payload: ExactSuiPayload,
  requirements: PaymentRequirements = testRequirements(),
): PaymentPayload {
  return {
    x402Version: 2,
    accepted: requirements,
    payload: payload as unknown as Record<string, unknown>,
  };
}

/**
 * Balance changes for an exact single-recipient payment (payer debit + credit).
 *
 * @param amount - Amount credited to payTo / debited from payer
 * @returns Balance change list
 */
export function exactBalanceChanges(amount = "10000"): SuiClientTypes.BalanceChange[] {
  return [
    { coinType: USDC_TESTNET, address: payer, amount: `-${amount}` },
    { coinType: USDC_TESTNET, address: payTo, amount },
  ];
}

/**
 * A transaction record.
 *
 * @param status - The execution status
 * @param balanceChanges - The balance changes
 * @param digest - The transaction digest
 * @param epoch - The executed epoch
 * @returns A Transaction record
 */
function record(
  status: SuiClientTypes.ExecutionStatus,
  balanceChanges: SuiClientTypes.BalanceChange[],
  digest: string,
  epoch: string,
): SuiClientTypes.Transaction<{ balanceChanges: true }> {
  return {
    digest,
    signatures: [],
    epoch,
    timestampMs: null,
    checkpoint: null,
    status,
    balanceChanges,
    effects: undefined,
    events: undefined,
    objectTypes: undefined,
    transaction: undefined,
    bcs: undefined,
  };
}

/**
 * A successful transaction record with the given balance changes.
 *
 * @param balanceChanges - The balance changes
 * @param digest - The transaction digest
 * @param epoch - The executed epoch
 * @returns A Transaction record
 */
export function successRecord(
  balanceChanges: SuiClientTypes.BalanceChange[],
  digest = "test-digest",
  epoch = String(EPOCH),
) {
  return record({ success: true, error: null }, balanceChanges, digest, epoch);
}

/**
 * A failed transaction record.
 *
 * @param message - The execution error message
 * @param digest - The transaction digest
 * @returns A failed Transaction record
 */
export function failureRecord(message: string, digest = "failed-digest") {
  return record({ success: false, error: { message } } as never, [], digest, String(EPOCH));
}

/**
 * A mock Sui client whose core methods are vitest mocks. `getTransaction`
 * defaults to the SDK's structured not-found error, and the current epoch is
 * {@link EPOCH}.
 *
 * @returns The mock client and its core method mocks
 */
export function mockClient() {
  const core = {
    simulateTransaction: vi.fn(),
    executeTransaction: vi.fn(),
    getTransaction: vi
      .fn()
      .mockImplementation(({ digest }: { digest: string }) =>
        Promise.reject(new TransactionError("notFound", digest)),
      ),
    waitForTransaction: vi.fn().mockResolvedValue(undefined),
    getCurrentSystemState: vi
      .fn()
      .mockResolvedValue({ systemState: { epoch: String(EPOCH), referenceGasPrice: "1000" } }),
  };
  return { client: { core } as unknown as ClientWithCoreApi, core };
}

export { toBase64, fromBase64 };
