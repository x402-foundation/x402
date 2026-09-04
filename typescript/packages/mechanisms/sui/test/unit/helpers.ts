import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client";
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

/**
 * Build a fully resolved transaction offline. Verification is effects-only, so a
 * placeholder `transferObjects` stands in for the command graph. When `nonce` is
 * given, its bytes ride as a Pure input — unused by default, or consumed by a
 * command with `nonceUsed`.
 *
 * @param options - Overrides
 * @param options.sender - Sender address (defaults to the shared payer)
 * @param options.nonce - Optional Base64 server-nonce to embed as a Pure input
 * @param options.nonceUsed - Reference the nonce Pure input from a command
 * @param options.expiration - Transaction expiration (defaults to None)
 * @returns Base64-encoded transaction bytes
 */
export async function buildTestTransaction(options?: {
  sender?: string;
  nonce?: string;
  nonceUsed?: boolean;
  expiration?: { $kind?: string } | { Epoch: number } | { None: true };
}): Promise<string> {
  const { sender = payer, nonce, nonceUsed = false, expiration = { None: true } } = options ?? {};

  const tx = new Transaction();
  tx.setSender(sender);
  tx.transferObjects(
    [
      tx.objectRef({
        objectId: `0x${"11".repeat(32)}`,
        version: "1",
        digest: "11111111111111111111111111111111",
      }),
    ],
    tx.pure.address(payTo),
  );
  if (nonce) {
    const nonceArg = tx.pure(fromBase64(nonce));
    if (nonceUsed) {
      // Consume the nonce Pure input from a command, as a client might when
      // writing it to an on-chain receipt.
      tx.moveCall({ target: `0x${"33".repeat(32)}::receipt::write`, arguments: [nonceArg] });
    }
  }

  tx.setGasPrice(1000);
  tx.setGasBudget(5_000_000);
  tx.setGasPayment([
    { objectId: `0x${"22".repeat(32)}`, version: "1", digest: "11111111111111111111111111111111" },
  ]);
  tx.setExpiration(expiration as never);

  return toBase64(await tx.build());
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
 * Produce a serialized signature over transaction bytes without assembling a
 * payload. Useful for building multi-signature `signature` arrays.
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
 * A successful transaction record with the given balance changes.
 *
 * @param balanceChanges - The balance changes
 * @param digest - The transaction digest
 * @returns A Transaction record
 */
export function successRecord(
  balanceChanges: SuiClientTypes.BalanceChange[],
  digest = "test-digest",
): SuiClientTypes.Transaction<{ balanceChanges: true }> {
  return {
    digest,
    signatures: [],
    epoch: "1",
    status: { success: true, error: null },
    balanceChanges,
    effects: undefined,
    events: undefined,
    objectTypes: undefined,
    transaction: undefined,
    bcs: undefined,
  };
}

/**
 * A failed transaction record.
 *
 * @param message - The execution error message
 * @param digest - The transaction digest
 * @returns A failed Transaction record
 */
export function failureRecord(
  message: string,
  digest = "failed-digest",
): SuiClientTypes.Transaction<{ balanceChanges: true }> {
  return {
    digest,
    signatures: [],
    epoch: "1",
    status: { success: false, error: { message } },
    balanceChanges: [],
    effects: undefined,
    events: undefined,
    objectTypes: undefined,
    transaction: undefined,
    bcs: undefined,
  };
}

/**
 * A mock Sui client whose core methods are vitest mocks. `getTransaction`
 * defaults to not-found (so the replay guard passes).
 *
 * @returns The mock client and its core method mocks
 */
export function mockClient() {
  const core = {
    simulateTransaction: vi.fn(),
    executeTransaction: vi.fn(),
    getTransaction: vi.fn().mockRejectedValue(
      Object.assign(new Error("Transaction%20test-digest%20not%20found"), {
        code: "NOT_FOUND",
      }),
    ),
    waitForTransaction: vi.fn().mockResolvedValue(undefined),
  };
  return { client: { core } as unknown as ClientWithCoreApi, core };
}

export { toBase64, fromBase64 };
