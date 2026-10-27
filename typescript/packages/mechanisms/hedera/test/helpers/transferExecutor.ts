/**
 * Shared builders for the `transferExecutor` facilitator unit tests.
 */
import { vi } from "vitest";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { FacilitatorHederaSigner, HederaTokenCustomFees } from "../../src/signer";
import type { HederaTransactionRecordEntry, HederaTransferEntry } from "../../src/types";

/**
 * Builds a payment payload whose `accepted` echoes the requirements.
 *
 * @param requirements - Accepted requirements
 * @param payload - Scheme payload, possibly malformed
 * @returns Payment payload
 */
export function createPaymentPayload(
  requirements: PaymentRequirements,
  payload: unknown,
): PaymentPayload {
  return {
    x402Version: 2,
    resource: { url: "https://example.com", description: "resource", mimeType: "application/json" },
    accepted: requirements,
    payload: payload as Record<string, unknown>,
  };
}

/**
 * Builds a facilitator signer whose capabilities are bare spies: enough for
 * `transferExecutor` to count as enabled, and for checks that end before any I/O.
 * The custom-fee read, which runs before method support, reports a token
 * without custom fees.
 *
 * @param addresses - Fee payer account ids
 * @returns Signer with every capability
 */
export function createStubTransferExecutorSigner(addresses: readonly string[] = ["0.0.5001"]) {
  return {
    getAddresses: () => addresses,
    signAndSubmitTransaction: vi.fn(),
    verifyPayerSignature: vi.fn(),
    preflightTransfer: vi.fn(),
    resolveEvmAddress: vi.fn(),
    getTokenCustomFees: vi.fn(
      async (): Promise<HederaTokenCustomFees | undefined> => ({
        fixedFeeCount: 0,
        fractionalFeeCount: 0,
        royaltyFeeCount: 0,
      }),
    ),
    simulateContractCall: vi.fn(),
    submitContractExecute: vi.fn(),
    getTransactionRecord: vi.fn(),
  } satisfies FacilitatorHederaSigner;
}

/**
 * Builds a transfer list entry.
 *
 * @param accountId - Account credited (positive) or debited (negative)
 * @param amount - Signed amount in base units
 * @returns Transfer entry
 */
export function transferEntry(accountId: string, amount: bigint): HederaTransferEntry {
  return { accountId, amount: amount.toString() };
}

/**
 * Builds a record entry with empty lists.
 *
 * @param overrides - Fields to set
 * @returns Record entry
 */
export function recordEntry(
  overrides: Partial<HederaTransactionRecordEntry> = {},
): HederaTransactionRecordEntry {
  return {
    result: "SUCCESS",
    chargedFee: "0",
    hbarTransfers: [],
    tokenTransfers: {},
    nftTransfers: [],
    stakingRewardTransfers: [],
    ...overrides,
  };
}

/**
 * Encodes an address as an indexed event topic.
 *
 * @param address - 0x-hex address
 * @returns 32-byte topic
 */
export function addressTopic(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}
