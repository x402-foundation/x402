import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import type { FacilitatorSuiSigner } from "../../signer";
import type { ExactSuiPayload } from "../../types";
import {
  GASLESS_ALLOWED_TARGETS,
  GASLESS_ALLOWED_NON_MOVECALL,
  normalizeMoveTarget,
} from "../../constants";
import { matchBalanceChanges, outputsOf } from "../../utils";

/**
 * Sui facilitator implementation for the Exact payment scheme.
 *
 * Verifies a signed-but-not-executed gasless transaction by binding the
 * signature to the sender, asserting the gasless BCS shape (zero gas + an
 * allowlisted-command-only PTB), rejecting an already-executed transaction (the
 * stateless replay guard — simulation alone is NOT one for Address Balances),
 * simulating it, and matching the asset balance changes against the declared
 * outputs EXACTLY. Settles by keyless broadcast (idempotent, executed-first).
 */
export class ExactSuiScheme implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = "sui:*";

  /**
   * Creates a new ExactSuiScheme facilitator instance.
   *
   * @param signer - The facilitator signer for verification, simulation, and broadcast
   */
  constructor(private readonly signer: FacilitatorSuiSigner) {}

  /**
   * Get mechanism-specific extra data for the supported kinds endpoint. The
   * gasless path is sponsor-free, so there is no feePayer to advertise.
   *
   * @param _ - The network identifier (unused)
   * @returns Always undefined — gasless needs no sponsor metadata
   */
  getExtra(_: Network): Record<string, unknown> | undefined {
    void _;
    return undefined;
  }

  /**
   * Get the facilitator's broadcast identities for a network. Empty on the
   * pure gasless path (keyless broadcast — there is no sponsor key).
   *
   * @param _ - The network identifier (unused)
   * @returns Array of signer addresses
   */
  getSigners(_: string): string[] {
    void _;
    return [...this.signer.getAddresses()];
  }

  /**
   * Verify a payment payload (the spec's `exact`-Sui verification):
   * version/scheme/network/shape → signature binds the sender → gasless command
   * shape → not-already-executed (the stateless replay guard) → simulate succeeds →
   * exact balance-change match against the declared outputs.
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
      // Step 1: version + scheme + network + payload shape.
      if (payload.x402Version !== 2) {
        return { isValid: false, invalidReason: "invalid_x402_version", payer: "" };
      }
      if (payload.accepted.scheme !== "exact" || requirements.scheme !== "exact") {
        return { isValid: false, invalidReason: "invalid_scheme", payer: "" };
      }
      if (payload.accepted.network !== requirements.network) {
        return { isValid: false, invalidReason: "invalid_network", payer: "" };
      }
      const suiPayload = payload.payload as ExactSuiPayload;
      if (!suiPayload?.transaction || !suiPayload?.signature) {
        return { isValid: false, invalidReason: "invalid_payload", payer: "" };
      }

      // Step 2: signature is valid AND the recovered address is the tx sender.
      let payer: string;
      try {
        payer = await this.signer.verifySignature(
          suiPayload.transaction,
          suiPayload.signature,
          requirements.network,
        );
      } catch (error) {
        return {
          isValid: false,
          invalidReason: "invalid_exact_sui_payload_signature",
          invalidMessage: error instanceof Error ? error.message : String(error),
          payer: "",
        };
      }

      const data = Transaction.from(fromBase64(suiPayload.transaction)).getData();
      if ((data.sender ?? "").toLowerCase() !== payer.toLowerCase()) {
        return {
          isValid: false,
          invalidReason: "invalid_exact_sui_payload_signature",
          invalidMessage: `recovered ${payer} ≠ tx sender ${data.sender}`,
          payer,
        };
      }

      // Step 3: gasless-shape assertions — zero gas + allowlisted commands only.
      const gasShape = this.assertGaslessShape(data);
      if (gasShape) {
        return {
          isValid: false,
          invalidReason: "invalid_payload",
          invalidMessage: gasShape,
          payer,
        };
      }

      // Step 4: replay guard — reject an ALREADY-EXECUTED transaction. Simulation is
      // NOT a replay guard for the gasless Address-Balance path: a gasless transfer
      // has no object inputs, so re-simulating already-executed bytes still succeeds
      // (nothing was consumed). The stateless guard is to compute the digest from the
      // signed bytes and ask the chain whether it is already committed.
      const digest = await Transaction.from(fromBase64(suiPayload.transaction)).getDigest();
      if (await this.signer.isTransactionExecuted(digest, requirements.network)) {
        return {
          isValid: false,
          invalidReason: "invalid_transaction_state",
          invalidMessage: `transaction ${digest} already executed`,
          payer,
        };
      }

      // Step 5: simulate — proves it would succeed and is not expired (TTL).
      const sim = await this.signer.simulateTransaction(
        suiPayload.transaction,
        requirements.network,
      );
      if (sim.effects?.status?.status !== "success") {
        return {
          isValid: false,
          invalidReason: "invalid_transaction_state",
          invalidMessage: sim.effects?.status?.error || "simulation failed",
          payer,
        };
      }

      // Step 6: balance-change match against the declared outputs.
      const outputs = outputsOf(requirements);
      const problems = matchBalanceChanges(
        sim.balanceChanges ?? [],
        requirements.asset,
        outputs,
        payer,
      );
      if (problems.length > 0) {
        const declared = Array.isArray(requirements.extra?.outputs);
        return {
          isValid: false,
          invalidReason: declared
            ? "invalid_exact_sui_payload_outputs_mismatch"
            : "invalid_exact_sui_payload_recipient_mismatch",
          invalidMessage: problems.join("; "),
          payer,
        };
      }

      return { isValid: true, invalidReason: undefined, payer };
    } catch (error) {
      return {
        isValid: false,
        invalidReason: "invalid_exact_sui_payload_verification_error",
        invalidMessage: error instanceof Error ? error.message : String(error),
        payer: "",
      };
    }
  }

  /**
   * Settle a payment by broadcasting the signed transaction (keyless).
   *
   * Idempotent by construction: it FIRST computes the digest from the signed bytes and
   * checks whether the transaction is already committed on-chain. If so it returns the
   * original digest as success WITHOUT re-broadcasting — re-broadcasting an executed
   * gasless tx over gRPC throws (whereas JSON-RPC returns the digest), so the executed-
   * first check is the portable way to make a re-settle a no-op rather than an error.
   * This also avoids re-verifying an already-executed payment, which the verify replay
   * guard (step 4) now rejects — a legitimate re-settle must still succeed.
   *
   * For a NOT-yet-executed payment it re-verifies (defense in depth) before broadcast.
   *
   * @param payload - The payment payload to settle
   * @param requirements - The payment requirements
   * @returns Promise resolving to settlement response
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const suiPayload = payload.payload as ExactSuiPayload;

    // Idempotency: an already-committed transaction settles to its original digest
    // (no re-broadcast, no double charge). The signature/payload may be malformed,
    // so guard the decode and fall through to verify on any failure.
    let knownDigest: string | undefined;
    try {
      knownDigest = await Transaction.from(fromBase64(suiPayload.transaction)).getDigest();
      if (
        knownDigest &&
        (await this.signer.isTransactionExecuted(knownDigest, requirements.network))
      ) {
        return {
          success: true,
          transaction: knownDigest,
          network: payload.accepted.network,
          payer: Transaction.from(fromBase64(suiPayload.transaction)).getData().sender ?? "",
        };
      }
    } catch {
      // Undecodable bytes — let verify produce the precise rejection below.
    }

    const verification = await this.verify(payload, requirements);
    if (!verification.isValid) {
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: verification.invalidReason ?? "verification_failed",
        payer: verification.payer,
      };
    }

    try {
      const digest = await this.signer.executeTransaction(
        suiPayload.transaction,
        suiPayload.signature,
        requirements.network,
      );
      await this.signer.waitForTransaction(digest, requirements.network);

      return {
        success: true,
        transaction: digest,
        network: payload.accepted.network,
        payer: verification.payer,
      };
    } catch (error) {
      // A race: the tx committed between our executed-check and broadcast. If it is
      // now on-chain, treat the settle as the idempotent success it is.
      if (
        knownDigest &&
        (await this.signer.isTransactionExecuted(knownDigest, requirements.network))
      ) {
        return {
          success: true,
          transaction: knownDigest,
          network: payload.accepted.network,
          payer: verification.payer,
        };
      }
      return {
        success: false,
        errorReason: "transaction_failed",
        errorMessage: error instanceof Error ? error.message : String(error),
        transaction: "",
        network: payload.accepted.network,
        payer: verification.payer,
      };
    }
  }

  /**
   * Assert the gasless BCS shape of decoded transaction data: `gasPrice == 0`,
   * `gasPayment == []`, and EVERY command is either an allowlisted gasless MoveCall
   * or a tolerated native coin-plumbing command (`SplitCoins` / `MergeCoins`).
   * Returns a problem string, or "" when gasless-safe.
   *
   * The coin-plumbing tolerance is load-bearing: a payer sourcing from a `Coin<T>`
   * OBJECT (the COMMON case — anyone who just received USDC via a classic transfer,
   * with zero Address Balance) gets a PTB the SDK builds as
   * `[SplitCoins, coin::into_balance, balance::send_funds, coin::send_funds]`. Without
   * `SplitCoins`/`MergeCoins` on the allowlist the facilitator would reject the very
   * payloads its OWN client produces. This is safe because (a) `TransferObjects` — the
   * object-leak vector — and every other command stay rejected, and (b) the exact-fee
   * balance-change match (step 5, `matchBalanceChanges`) binds the ACTUAL money
   * movement: every declared output is credited exactly, the payer is debited exactly,
   * and no undeclared address receives the asset — so the plumbing commands can move
   * nothing the exact-fee check does not already account for.
   *
   * @param data - The decoded transaction data (`Transaction.getData()`)
   * @returns A problem description, or "" when the shape is gasless-safe
   */
  private assertGaslessShape(data: ReturnType<Transaction["getData"]>): string {
    const price = data.gasData?.price;
    if (!(price === "0" || price === null || price === undefined)) {
      return `non-zero gasPrice: ${price}`;
    }
    const payment = data.gasData?.payment;
    const emptyPayment =
      payment === null || payment === undefined || (Array.isArray(payment) && payment.length === 0);
    if (!emptyPayment) {
      return `non-empty gasPayment: ${JSON.stringify(payment)}`;
    }
    for (const cmd of data.commands) {
      if (cmd.$kind === "MoveCall" && cmd.MoveCall) {
        const target = normalizeMoveTarget(
          cmd.MoveCall.package,
          cmd.MoveCall.module,
          cmd.MoveCall.function,
        );
        if (!GASLESS_ALLOWED_TARGETS.has(target)) {
          return `disallowed target: ${target}`;
        }
      } else if (!GASLESS_ALLOWED_NON_MOVECALL.has(cmd.$kind)) {
        return `disallowed command: ${cmd.$kind}`;
      }
    }
    return "";
  }
}
