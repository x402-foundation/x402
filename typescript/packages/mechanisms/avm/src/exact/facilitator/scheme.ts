/**
 * AVM Facilitator Scheme for Exact Payment Protocol
 *
 * Verifies and settles Algorand ASA transfer payments.
 */

import {
  decodeTransaction as decodeUnsignedTxn,
  decodeSignedTransaction as decodeSignedTxn,
  encodeTransactionRaw,
  encodeSignedTransaction,
  bytesForSigning,
} from "@algorandfoundation/algokit-utils/transact";
import type { Transaction, SignedTransaction } from "@algorandfoundation/algokit-utils/transact";
import { ed25519Verifier } from "@algorandfoundation/algokit-utils/crypto";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import type { FacilitatorAvmSigner } from "../../signer";
import type { ExactAvmPayloadV2 } from "../../types";
import { isExactAvmPayload } from "../../types";
import { MAX_TRANSACTION_GROUP_SIZE } from "@algorandfoundation/algokit-utils/common";
import { decodeTransaction, hasSignature } from "../../utils";
import { maxReasonableGroupFee } from "../../constants";
import * as Errors from "./errors";

/**
 * AVM facilitator implementation for the Exact payment scheme.
 *
 * Verifies atomic transaction groups and settles ASA transfers for x402 payments.
 * Supports gasless transactions by signing fee payer transactions.
 */
export class ExactAvmScheme implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = "algorand:*";

  /**
   * Creates a new ExactAvmScheme facilitator instance.
   *
   * @param signer - The AVM signer for facilitator operations
   */
  constructor(private readonly signer: FacilitatorAvmSigner) {}

  /**
   * Get mechanism-specific extra data for the supported kinds endpoint.
   * For AVM, returns the feePayer address for gasless transactions.
   *
   * @param _ - The network identifier (unused, feePayer is network-agnostic)
   * @returns Extra data with feePayer address
   */
  getExtra(_: string): Record<string, unknown> | undefined {
    const addresses = this.signer.getAddresses();
    if (addresses.length === 0) {
      return undefined;
    }

    // Random selection distributes ALGO fee costs across multiple signer accounts,
    // preventing any single fee payer from being depleted faster than others.
    const randomIndex = Math.floor(Math.random() * addresses.length);
    return { feePayer: addresses[randomIndex] };
  }

  /**
   * Get signer addresses used by this facilitator.
   * Returns all addresses this facilitator can use for signing fee payer transactions.
   *
   * @param _ - The network identifier (unused, addresses are network-agnostic)
   * @returns Array of facilitator wallet addresses
   */
  getSigners(_: string): string[] {
    return [...this.signer.getAddresses()];
  }

  /**
   * Verifies a payment payload.
   *
   * Verification steps:
   * 1. Validate x402Version, scheme, and network
   * 2. Validate payload format and structure
   * 3. Check group size does not exceed maximum (16)
   * 4. Decode and validate transaction group
   * 5. Verify payment transaction (amount, receiver, asset)
   * 6. Prepare signed group (verify fee payer safety + sign)
   * 7. Simulate transaction group
   *
   * @param payload - The payment payload to verify
   * @param requirements - The payment requirements
   * @returns Promise resolving to verification response
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    try {
      // Validate x402 version
      if (payload.x402Version !== 2) {
        return {
          isValid: false,
          invalidReason: Errors.ErrInvalidVersion,
          invalidMessage: `Expected x402Version 2, got ${payload.x402Version}`,
        };
      }

      // Validate scheme
      if (payload.accepted.scheme !== "exact" || requirements.scheme !== "exact") {
        return {
          isValid: false,
          invalidReason: Errors.ErrInvalidScheme,
          invalidMessage: `Expected scheme "exact", got payload="${payload.accepted.scheme}" requirements="${requirements.scheme}"`,
        };
      }

      // Validate network
      if (payload.accepted.network !== requirements.network) {
        return {
          isValid: false,
          invalidReason: Errors.ErrNetworkMismatch,
          invalidMessage: `Network mismatch: payload="${payload.accepted.network}" requirements="${requirements.network}"`,
        };
      }

      const rawPayload = payload.payload as unknown;

      if (!isExactAvmPayload(rawPayload)) {
        return {
          isValid: false,
          invalidReason: Errors.ErrInvalidPayload,
          invalidMessage: "Payload does not match ExactAvmPayloadV2 format",
        };
      }

      const { paymentGroup, paymentIndex } = rawPayload as ExactAvmPayloadV2;

      if (paymentGroup.length > MAX_TRANSACTION_GROUP_SIZE) {
        return {
          isValid: false,
          invalidReason: Errors.ErrGroupSizeExceeded,
          invalidMessage: `Transaction group has ${paymentGroup.length} transactions, maximum is ${MAX_TRANSACTION_GROUP_SIZE}`,
        };
      }

      if (paymentIndex < 0 || paymentIndex >= paymentGroup.length) {
        return {
          isValid: false,
          invalidReason: Errors.ErrInvalidPaymentIndex,
          invalidMessage: `Payment index ${paymentIndex} out of bounds for group of ${paymentGroup.length}`,
        };
      }

      const facilitatorAddresses = this.signer.getAddresses();

      // Decode all transactions and validate group structure
      const decoded = this.decodeTransactionGroup(paymentGroup, facilitatorAddresses);
      if ("error" in decoded) return decoded.error;

      // Extract payer from payment transaction
      const paymentTxn = decoded.txns[paymentIndex].txn;
      const payer = paymentTxn.sender.toString();

      // SECURITY: Verify facilitator's signers are not transferring their own funds
      if (facilitatorAddresses.includes(payer)) {
        return {
          isValid: false,
          invalidReason: Errors.ErrFacilitatorTransferring,
          invalidMessage: "Facilitator signer cannot be the payment sender",
        };
      }

      // Payment transaction correctness
      const paymentCheck = await this.verifyPaymentTransaction(
        decoded.txns[paymentIndex],
        requirements,
        paymentGroup[paymentIndex],
      );
      if (!paymentCheck.isValid) return paymentCheck;

      // Verify fee payers and sign them for simulation
      const prepared = await this.prepareSignedGroup(decoded.txns, paymentGroup);
      if ("error" in prepared) return prepared.error;

      // Simulate the assembled group
      const simResult = await this.simulateTransactionGroup(
        prepared.signedTxns,
        requirements.network,
      );
      if (!simResult.isValid) return simResult;

      return { isValid: true, payer };
    } catch (error) {
      return {
        isValid: false,
        invalidReason: Errors.ErrInvalidPayload,
        invalidMessage: `Unexpected error: ${error instanceof Error ? error.message : "Unknown"}`,
      };
    }
  }

  /**
   * Settles a payment by submitting the transaction group.
   *
   * Settlement steps:
   * 1. Verify the payment first
   * 2. Decode and sign fee payer transactions (reuses shared decode/sign logic)
   * 3. Submit transaction group
   * 4. Wait for on-chain confirmation
   * 5. Return transaction ID
   *
   * @param payload - The payment payload to settle
   * @param requirements - The payment requirements
   * @returns Promise resolving to settlement response
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    // First verify the payment
    const verification = await this.verify(payload, requirements);
    if (!verification.isValid) {
      return {
        success: false,
        errorReason: verification.invalidReason,
        errorMessage: verification.invalidMessage,
        transaction: "",
        network: requirements.network,
        payer: verification.payer,
      };
    }

    const avmPayload = payload.payload as unknown as ExactAvmPayloadV2;
    const { paymentGroup, paymentIndex } = avmPayload;
    const facilitatorAddresses = this.signer.getAddresses();

    // Reuse shared decode logic
    const decoded = this.decodeTransactionGroup(paymentGroup, facilitatorAddresses);
    if ("error" in decoded) {
      return {
        success: false,
        errorReason: Errors.ErrSettleFailed,
        errorMessage: decoded.error.invalidMessage ?? decoded.error.invalidReason,
        transaction: "",
        network: requirements.network,
        payer: verification.payer,
      };
    }

    // Reuse shared sign logic
    const prepared = await this.prepareSignedGroup(decoded.txns, paymentGroup);
    if ("error" in prepared) {
      return {
        success: false,
        errorReason: Errors.ErrSettleFailed,
        errorMessage: prepared.error.invalidMessage ?? prepared.error.invalidReason,
        transaction: "",
        network: requirements.network,
        payer: verification.payer,
      };
    }

    // Get the payment transaction ID before submission
    const paymentTxnBytes = prepared.signedTxns[paymentIndex];
    const paymentStxn = decodeSignedTxn(paymentTxnBytes);
    const paymentTxId = paymentStxn.txn.txId();

    // Submit transaction group
    try {
      await this.signer.sendTransactions(prepared.signedTxns, requirements.network);
    } catch (error) {
      return {
        success: false,
        errorReason: Errors.ErrSettleFailed,
        errorMessage: `Failed to submit transaction: ${error instanceof Error ? error.message : "Unknown error"}`,
        transaction: paymentTxId,
        network: requirements.network,
        payer: verification.payer,
      };
    }

    // Wait for on-chain confirmation
    try {
      // Wait up to 10 rounds for on-chain confirmation
      await this.signer.waitForConfirmation(paymentTxId, requirements.network, 10);
    } catch (error) {
      return {
        success: false,
        errorReason: Errors.ErrConfirmationFailed,
        errorMessage: `Transaction submitted but confirmation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        transaction: paymentTxId,
        network: requirements.network,
        payer: verification.payer,
      };
    }

    return {
      success: true,
      transaction: paymentTxId,
      network: requirements.network,
      payer: verification.payer,
    };
  }

  /**
   * Decodes all transactions in the group and validates structure.
   *
   * - Signed transactions are decoded as-is
   * - Unsigned transactions are only accepted from facilitator addresses (fee payers)
   * - Verifies group ID consistency across all transactions
   *
   * @param paymentGroup - Array of base64-encoded transaction strings
   * @param facilitatorAddresses - Addresses controlled by this facilitator
   * @returns Decoded transactions or an error response
   */
  private decodeTransactionGroup(
    paymentGroup: string[],
    facilitatorAddresses: readonly string[],
  ): { txns: SignedTransaction[] } | { error: VerifyResponse } {
    const txns: SignedTransaction[] = [];

    for (let i = 0; i < paymentGroup.length; i++) {
      try {
        const bytes = decodeTransaction(paymentGroup[i]);

        try {
          const stxn = decodeSignedTxn(bytes);
          // Validate that decoding actually produced a valid signed transaction.
          // algokit-utils decodeSignedTransaction is lenient and may succeed on raw unsigned
          // bytes, returning a transaction with type "unknown" and missing fields.
          if (!stxn.txn.type || stxn.txn.type === "unknown") {
            throw new Error("Invalid signed transaction: missing type");
          }
          txns.push(stxn);
        } catch {
          // Unsigned transaction — only the facilitator's fee payer txn should be unsigned
          const unsignedTxn = decodeUnsignedTxn(bytes);
          const sender = unsignedTxn.sender.toString();

          if (!facilitatorAddresses.includes(sender)) {
            return {
              error: {
                isValid: false,
                invalidReason: Errors.ErrUnsignedNonFacilitator,
                invalidMessage: `Unsigned transaction at index ${i} from ${sender} is not a facilitator address`,
              },
            };
          }

          // Wrap unsigned txn for simulation (empty signature)
          const encodedForSimulate = encodeSignedTransaction({ txn: unsignedTxn });
          txns.push(decodeSignedTxn(encodedForSimulate));
        }
      } catch {
        return {
          error: {
            isValid: false,
            invalidReason: Errors.ErrInvalidTransaction,
            invalidMessage: `Failed to decode transaction at index ${i}`,
          },
        };
      }
    }

    // Verify group ID consistency
    if (txns.length > 1) {
      const firstGroup = txns[0].txn.group;
      const firstGroupId = firstGroup ? Buffer.from(firstGroup).toString("base64") : null;

      for (let i = 1; i < txns.length; i++) {
        const group = txns[i].txn.group;
        const groupId = group ? Buffer.from(group).toString("base64") : null;
        if (groupId !== firstGroupId) {
          return {
            error: {
              isValid: false,
              invalidReason: Errors.ErrInvalidGroupId,
              invalidMessage: "Transactions have inconsistent group IDs",
            },
          };
        }
      }
    }

    return { txns };
  }

  /**
   * Verifies fee payer transactions and signs them, returning the assembled group
   * ready for simulation or submission.
   *
   * @param decodedTxns - Decoded signed transaction objects
   * @param paymentGroup - Original base64-encoded transaction strings
   * @returns Signed transaction bytes or an error response
   */
  private async prepareSignedGroup(
    decodedTxns: SignedTransaction[],
    paymentGroup: string[],
  ): Promise<{ signedTxns: Uint8Array[] } | { error: VerifyResponse }> {
    const facilitatorAddresses = this.signer.getAddresses();
    const signedTxns: Uint8Array[] = [];

    for (let i = 0; i < decodedTxns.length; i++) {
      const txn = decodedTxns[i].txn;
      const sender = txn.sender.toString();

      if (facilitatorAddresses.includes(sender)) {
        const feeCheck = this.verifyFeePayerTransaction(txn, decodedTxns.length);
        if (!feeCheck.isValid) return { error: feeCheck };

        try {
          const signedTxn = await this.signer.signTransaction(encodeTransactionRaw(txn), sender);
          signedTxns.push(signedTxn);
        } catch (error) {
          return {
            error: {
              isValid: false,
              invalidReason: Errors.ErrInvalidFeePayer,
              invalidMessage: `Failed to sign fee payer transaction: ${error instanceof Error ? error.message : "Unknown error"}`,
            },
          };
        }
      } else {
        signedTxns.push(decodeTransaction(paymentGroup[i]));
      }
    }

    return { signedTxns };
  }

  /**
   * Simulates the transaction group and returns the verification result.
   *
   * @param signedTxns - Signed transaction bytes to simulate
   * @param network - Target network for simulation
   * @returns Verification result from simulation
   */
  private async simulateTransactionGroup(
    signedTxns: Uint8Array[],
    network: Network,
  ): Promise<VerifyResponse> {
    try {
      const simResult = (await this.signer.simulateTransactions(signedTxns, network)) as {
        txnGroups?: Array<{ failureMessage?: string }>;
      };

      if (simResult.txnGroups?.[0]?.failureMessage) {
        return {
          isValid: false,
          invalidReason: Errors.ErrSimulationFailed,
          invalidMessage: simResult.txnGroups[0].failureMessage,
        };
      }

      return { isValid: true };
    } catch (error) {
      return {
        isValid: false,
        invalidReason: Errors.ErrSimulationFailed,
        invalidMessage: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Verifies the payment transaction matches requirements
   *
   * @param stxn - The signed payment transaction
   * @param requirements - Payment requirements to verify against
   * @param encodedTxn - Base64-encoded transaction for signature check
   * @returns Verification result
   */
  private async verifyPaymentTransaction(
    stxn: SignedTransaction,
    requirements: PaymentRequirements,
    encodedTxn: string,
  ): Promise<VerifyResponse> {
    const txn = stxn.txn;

    // Must be an asset transfer
    if (txn.type !== "axfer") {
      return {
        isValid: false,
        invalidReason: Errors.ErrNotAssetTransfer,
        invalidMessage: `Expected asset transfer, got "${txn.type}"`,
      };
    }

    // Access asset transfer properties — properly typed in algokit-utils v10
    const assetTransfer = txn.assetTransfer;

    if (!assetTransfer) {
      return {
        isValid: false,
        invalidReason: Errors.ErrNotAssetTransfer,
        invalidMessage: "Missing assetTransfer data",
      };
    }

    // Use BigInt comparison to avoid string format mismatches (e.g. "1000" vs "1000.0")
    const amount = assetTransfer.amount ?? BigInt(0);

    if (amount !== BigInt(requirements.amount)) {
      return {
        isValid: false,
        invalidReason: Errors.ErrAmountMismatch,
        invalidMessage: `Expected ${requirements.amount}, got ${amount.toString()}`,
      };
    }

    // Verify receiver address matches payTo
    const receiver = assetTransfer.receiver ? assetTransfer.receiver.toString() : "";

    if (receiver !== requirements.payTo) {
      return {
        isValid: false,
        invalidReason: Errors.ErrReceiverMismatch,
        invalidMessage: `Expected ${requirements.payTo}, got ${receiver}`,
      };
    }

    // Verify asset
    const assetId = assetTransfer.assetId?.toString() ?? "";

    if (assetId !== requirements.asset) {
      return {
        isValid: false,
        invalidReason: Errors.ErrAssetMismatch,
        invalidMessage: `Expected asset ${requirements.asset}, got ${assetId}`,
      };
    }

    // Verify signature exists
    const txnBytes = decodeTransaction(encodedTxn);
    if (!hasSignature(txnBytes)) {
      return {
        isValid: false,
        invalidReason: Errors.ErrPaymentNotSigned,
        invalidMessage: "Payment transaction is not signed",
      };
    }

    // Verify the ed25519 signature was actually made by the sender
    if (stxn.sig) {
      const signedMsg = bytesForSigning.transaction(txn);
      const isValidSig = await ed25519Verifier(stxn.sig, signedMsg, txn.sender.publicKey);
      if (!isValidSig) {
        return {
          isValid: false,
          invalidReason: Errors.ErrInvalidSignature,
          invalidMessage: "Payment transaction signature does not match sender",
        };
      }
    }

    return { isValid: true };
  }

  /**
   * Verifies a fee payer transaction is safe to sign
   *
   * @param txn - The fee payer transaction to validate
   * @param groupSize - Number of transactions in the atomic group (for fee cap calculation)
   * @returns Verification result
   */
  private verifyFeePayerTransaction(txn: Transaction, groupSize: number): VerifyResponse {
    // Must be a payment transaction (for fee payment)
    if (txn.type !== "pay") {
      return {
        isValid: false,
        invalidReason: Errors.ErrInvalidFeePayer,
        invalidMessage: `Expected payment transaction, got ${txn.type}`,
      };
    }

    // Access payment fields — properly typed in algokit-utils v10
    const paymentFields = txn.payment;

    // Must have zero amount (self-payment for fee coverage)
    const payAmount = paymentFields?.amount ?? BigInt(0);
    if (payAmount > BigInt(0)) {
      return {
        isValid: false,
        invalidReason: Errors.ErrInvalidFeePayer,
        invalidMessage: "Fee payer amount must be 0",
      };
    }

    // Must be self-payment (receiver == sender)
    if (paymentFields?.receiver) {
      const receiverAddr = paymentFields.receiver.toString();
      const senderAddr = txn.sender.toString();
      if (receiverAddr !== senderAddr) {
        return {
          isValid: false,
          invalidReason: Errors.ErrInvalidFeePayer,
          invalidMessage: "Fee payer receiver must be same as sender (self-payment)",
        };
      }
    }

    // Must not have close remainder to
    if (paymentFields?.closeRemainderTo) {
      return {
        isValid: false,
        invalidReason: Errors.ErrInvalidFeePayer,
        invalidMessage: "closeRemainderTo not allowed on fee payer",
      };
    }

    // Must not have rekey to
    if (txn.rekeyTo) {
      return {
        isValid: false,
        invalidReason: Errors.ErrInvalidFeePayer,
        invalidMessage: "rekeyTo not allowed on fee payer",
      };
    }

    // Fee must be reasonable — during congestion fees can rise, so the cap
    // is 5x the minimum fee (5000 µAlgo) per transaction in the group.
    // The fee payer covers the entire group via Algorand's fee pooling.
    const fee = Number(txn.fee ?? 0);
    const maxFee = maxReasonableGroupFee(groupSize);
    if (fee > maxFee) {
      return {
        isValid: false,
        invalidReason: Errors.ErrFeeTooHigh,
        invalidMessage: `Fee ${fee} exceeds maximum ${maxFee} (${groupSize} txns × 5000 µAlgo)`,
      };
    }

    return { isValid: true };
  }
}
