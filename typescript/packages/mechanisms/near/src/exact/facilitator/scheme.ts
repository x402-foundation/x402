import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  DEFAULT_MAX_SPONSORED_GAS,
  EMPTY_CONTRACT_CODE_HASH,
  FT_TRANSFER_METHOD,
  NONCE_RANGE_MULTIPLIER,
  ONE_YOCTO,
  isNearNetwork,
} from "../../constants";
import { SettlementCache } from "../../settlement-cache";
import type { FacilitatorNearSigner } from "../../signer";
import type { ExactNearPayload } from "../../types";
import {
  computeTimeoutBlocks,
  decodeSignedDelegateB64,
  parseFtTransferArgs,
  settlementCacheKey,
} from "../../utils";

/**
 * Configuration options for {@link ExactNearScheme}.
 */
export type ExactNearFacilitatorOptions = {
  /**
   * Maximum sponsored gas (in gas units) the facilitator will accept on the
   * delegated `ft_transfer` (spec §7). Defaults to {@link DEFAULT_MAX_SPONSORED_GAS}.
   */
  maxSponsoredGas?: bigint;
};

/**
 * Facilitator-side NEAR exact-scheme implementation (spec §1–§10).
 *
 * Verification decodes the client's NEP-366 `SignedDelegate`, checks it against
 * the payment requirements, verifies its signature, and performs targeted
 * chain-state preflight against current onchain state. Settlement re-runs
 * verification, deduplicates concurrent submissions, submits the delegate
 * action through a facilitator-selected relayer, and waits for the inner
 * `ft_transfer` receipt before reporting success.
 */
export class ExactNearScheme implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = "near:*";

  private readonly settlementCache: SettlementCache;
  private readonly maxSponsoredGas: bigint;

  /**
   * Creates an ExactNearScheme.
   *
   * @param signer - Facilitator signer abstraction (relayer config + NEAR RPC).
   * @param settlementCache - Optional shared duplicate-settlement cache (spec §10);
   *   one is created if omitted.
   * @param options - Optional scheme configuration.
   */
  constructor(
    private readonly signer: FacilitatorNearSigner,
    settlementCache?: SettlementCache,
    options?: ExactNearFacilitatorOptions,
  ) {
    this.settlementCache = settlementCache ?? new SettlementCache();
    this.maxSponsoredGas = options?.maxSponsoredGas ?? DEFAULT_MAX_SPONSORED_GAS;
  }

  /**
   * Mechanism-specific extra data for the supported-kinds endpoint.
   *
   * NEAR exact payments need no scheme-specific `extra` in `PaymentRequirements`:
   * the relayer is facilitator-local configuration and MUST NOT be required from
   * the client (spec §3), so this returns `undefined`.
   *
   * @param _ - Network identifier (unused).
   * @returns `undefined`.
   */
  getExtra(_: string): Record<string, unknown> | undefined {
    return undefined;
  }

  /**
   * Relayer account IDs managed by this facilitator, advertised on the
   * supported-kinds endpoint so clients can see who sponsors the transaction.
   *
   * @param _ - Network identifier (unused).
   * @returns Relayer account IDs.
   */
  getSigners(_: string): string[] {
    return [...this.signer.getRelayerIds()];
  }

  /**
   * Verifies a NEAR `exact` payment payload against payment requirements.
   *
   * @param payload - Payment payload.
   * @param requirements - Payment requirements.
   * @returns Verification response.
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    try {
      // ── §1 Version, scheme, network ──────────────────────────────────────
      if (payload.x402Version !== 2) {
        return this.invalid("invalid_x402_version");
      }
      if (payload.accepted.scheme !== this.scheme || requirements.scheme !== this.scheme) {
        return this.invalid("unsupported_scheme");
      }
      if (!isNearNetwork(requirements.network)) {
        return this.invalid("invalid_network");
      }
      if (payload.accepted.network !== requirements.network) {
        return this.invalid("invalid_exact_near_network_mismatch");
      }

      // ── §2 Requirement consistency ───────────────────────────────────────
      if (payload.accepted.asset !== requirements.asset) {
        return this.invalid("invalid_exact_near_asset_mismatch");
      }
      if (payload.accepted.payTo !== requirements.payTo) {
        return this.invalid("invalid_exact_near_pay_to_mismatch");
      }
      if (payload.accepted.amount !== requirements.amount) {
        return this.invalid("invalid_exact_near_amount_mismatch");
      }
      const maxTimeoutSeconds = requirements.maxTimeoutSeconds;
      if (!Number.isInteger(maxTimeoutSeconds) || maxTimeoutSeconds <= 0) {
        return this.invalid("invalid_exact_near_max_timeout");
      }

      // Payload shape.
      const nearPayload = payload.payload as ExactNearPayload | undefined;
      if (!nearPayload || typeof nearPayload.signedDelegateAction !== "string") {
        return this.invalid("invalid_exact_near_payload_shape");
      }

      // ── §4 SignedDelegateAction integrity ────────────────────────────────
      let decoded;
      try {
        decoded = decodeSignedDelegateB64(nearPayload.signedDelegateAction);
      } catch {
        return this.invalid("invalid_exact_near_payload_signed_delegate_action");
      }
      const delegate = decoded.delegate;

      // Signature must verify before we attribute `payer` to any party.
      if (!decoded.verifySignature()) {
        return this.invalid("invalid_exact_near_payload_signature");
      }
      // From here the sender is cryptographically attributed.
      const payer = delegate.senderId;

      // ── §3 Relayer sponsorship abuse prevention ──────────────────────────
      const relayers = this.signer.getRelayerIds();
      if (relayers.length === 0) {
        return this.invalid("invalid_exact_near_no_relayer_configured", payer);
      }
      if (relayers.includes(payer)) {
        return this.invalid("invalid_exact_near_relayer_cannot_be_payer", payer);
      }

      // ── §6 Delegated action safety (exactly one ft_transfer) ─────────────
      if (delegate.actionCount !== 1) {
        return this.invalid("invalid_exact_near_payload_action_count", payer);
      }
      const fc = delegate.functionCall;
      if (!fc) {
        return this.invalid("invalid_exact_near_payload_action_kind", payer);
      }
      if (fc.methodName !== FT_TRANSFER_METHOD) {
        return this.invalid("invalid_exact_near_payload_method_name", payer);
      }

      // ── §7 Token transfer intent and exactness ───────────────────────────
      if (delegate.receiverId !== requirements.asset) {
        return this.invalid("invalid_exact_near_payload_token_contract_mismatch", payer);
      }
      let transfer;
      try {
        transfer = parseFtTransferArgs(fc.args);
      } catch {
        return this.invalid("invalid_exact_near_payload_ft_transfer_args", payer);
      }
      if (transfer.receiver_id !== requirements.payTo) {
        return this.invalid("invalid_exact_near_payload_recipient_mismatch", payer);
      }
      if (transfer.amount !== requirements.amount) {
        return this.invalid("invalid_exact_near_payload_amount_mismatch", payer);
      }
      // The 1 yoctoNEAR deposit is NEP-141's `ft_transfer` security marker; requiring it
      // also forces the signing key to be FullAccess, since FunctionCall keys cannot attach
      // a positive deposit (reinforces the §8 access-key permission check below).
      if (fc.deposit !== ONE_YOCTO) {
        return this.invalid("invalid_exact_near_payload_attached_deposit", payer);
      }
      if (fc.gas > this.maxSponsoredGas) {
        return this.invalid("invalid_exact_near_payload_gas_limit_exceeded", payer);
      }

      // ── §5 Replay and expiry (deterministic timeout mapping + nonce) ─────
      const heightResult = await this.safe(
        () => this.signer.getCurrentBlockHeight(requirements.network),
        "invalid_exact_near_current_block_height_unavailable",
      );
      if (!heightResult.ok) {
        return this.invalid(heightResult.reason, payer);
      }
      const currentHeight = heightResult.value;

      const timeoutBlocks = computeTimeoutBlocks(maxTimeoutSeconds);
      const remainingBlocks = delegate.maxBlockHeight - currentHeight;
      if (remainingBlocks <= 0n) {
        return this.invalid("invalid_exact_near_payload_delegate_action_expired", payer);
      }
      if (remainingBlocks > timeoutBlocks) {
        return this.invalid(
          "invalid_exact_near_payload_delegate_action_timeout_window_exceeds_max_timeout",
          payer,
        );
      }
      if (delegate.nonce >= currentHeight * NONCE_RANGE_MULTIPLIER) {
        return this.invalid("invalid_exact_near_payload_delegate_action_nonce_out_of_range", payer);
      }

      const accessKeyResult = await this.safe(
        () =>
          this.signer.viewAccessKey({
            network: requirements.network,
            accountId: delegate.senderId,
            publicKey: delegate.publicKey,
          }),
        "invalid_exact_near_access_key_lookup_failed",
      );
      if (!accessKeyResult.ok) {
        return this.invalid(accessKeyResult.reason, payer);
      }
      const accessKey = accessKeyResult.value;
      if (!accessKey) {
        return this.invalid("invalid_exact_near_access_key_not_found", payer);
      }
      // Core replay guard: the on-chain access-key nonce is authoritative, so any delegate
      // nonce at or below it has already been used — no facilitator-side nonce store needed.
      if (delegate.nonce <= accessKey.nonce) {
        return this.invalid("invalid_exact_near_payload_delegate_action_nonce_already_used", payer);
      }

      // ── §8 Access-key permission safety ──────────────────────────────────
      if (accessKey.permissionKind === "FunctionCall") {
        return this.invalid("invalid_exact_near_function_call_key_not_allowed", payer);
      }
      if (accessKey.permissionKind !== "FullAccess") {
        return this.invalid("invalid_exact_near_unsupported_access_key_permission", payer);
      }

      // ── §9 Chain-state preflight ─────────────────────────────────────────
      const senderAccount = await this.safe(
        () =>
          this.signer.viewAccount({ network: requirements.network, accountId: delegate.senderId }),
        "invalid_exact_near_account_lookup_failed",
      );
      if (!senderAccount.ok) {
        return this.invalid(senderAccount.reason, payer);
      }
      if (!senderAccount.value) {
        return this.invalid("invalid_exact_near_sender_account_not_found", payer);
      }

      const tokenAccount = await this.safe(
        () =>
          this.signer.viewAccount({ network: requirements.network, accountId: requirements.asset }),
        "invalid_exact_near_token_account_lookup_failed",
      );
      if (!tokenAccount.ok) {
        return this.invalid(tokenAccount.reason, payer);
      }
      if (!tokenAccount.value) {
        return this.invalid("invalid_exact_near_token_account_not_found", payer);
      }
      if (tokenAccount.value.codeHash === EMPTY_CONTRACT_CODE_HASH) {
        return this.invalid("invalid_exact_near_token_contract_no_code", payer);
      }

      const balanceResult = await this.safe(
        () =>
          this.signer.ftBalanceOf({
            network: requirements.network,
            token: requirements.asset,
            accountId: delegate.senderId,
          }),
        "invalid_exact_near_balance_check_failed",
      );
      if (!balanceResult.ok) {
        return this.invalid(balanceResult.reason, payer);
      }
      if (balanceResult.value < BigInt(requirements.amount)) {
        return this.invalid("insufficient_funds", payer);
      }

      const storageResult = await this.safe(
        () =>
          this.signer.storageBalanceOf({
            network: requirements.network,
            token: requirements.asset,
            accountId: requirements.payTo,
          }),
        "invalid_exact_near_storage_check_failed",
      );
      if (!storageResult.ok) {
        return this.invalid(storageResult.reason, payer);
      }
      if (storageResult.value.supported && !storageResult.value.registered) {
        return this.invalid("invalid_exact_near_recipient_not_registered_for_storage", payer);
      }

      return { isValid: true, payer };
    } catch (error) {
      // Unexpected error: fail closed without attributing a payer.
      return {
        isValid: false,
        invalidReason: "unexpected_verify_error",
        invalidMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Settles a verified NEAR payment by submitting the delegate action through a
   * facilitator-selected relayer and waiting for the inner `ft_transfer` receipt.
   *
   * @param payload - Payment payload.
   * @param requirements - Payment requirements.
   * @returns Settlement response.
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    // Re-run verification; never trust a prior /verify result (spec, Settlement).
    const verified = await this.verify(payload, requirements);
    if (!verified.isValid) {
      return this.settleFailure(
        verified.invalidReason || "verification_failed",
        requirements.network,
        verified.payer,
      );
    }

    const relayerId = this.signer.getRelayerIds()[0];
    if (!relayerId) {
      return this.settleFailure(
        "invalid_exact_near_no_relayer_configured",
        requirements.network,
        verified.payer,
      );
    }

    const nearPayload = payload.payload as ExactNearPayload;

    // §10 duplicate-settlement mitigation. The decode + cache check must complete
    // synchronously (before the first await) so concurrent /settle calls for the
    // same payload are caught before any network work begins.
    let maxBlockHeight: bigint;
    try {
      maxBlockHeight = decodeSignedDelegateB64(nearPayload.signedDelegateAction).delegate
        .maxBlockHeight;
    } catch {
      return this.settleFailure(
        "invalid_exact_near_payload_signed_delegate_action",
        requirements.network,
        verified.payer,
      );
    }
    const cacheKey = settlementCacheKey(nearPayload.signedDelegateAction);
    if (this.settlementCache.isDuplicate(cacheKey, maxBlockHeight)) {
      return this.settleFailure("duplicate_settlement", requirements.network, verified.payer);
    }

    try {
      const outcome = await this.signer.submitSignedDelegateAction({
        network: requirements.network,
        relayerId,
        signedDelegateAction: nearPayload.signedDelegateAction,
      });

      // Success requires the inner ft_transfer receipt itself to have succeeded
      // (spec §7 / Settlement) — outer-transaction acceptance is not sufficient.
      if (outcome.innerReceipt.kind !== "success") {
        return {
          success: false,
          errorReason: "settlement_failed",
          errorMessage: outcome.innerReceipt.error,
          transaction: outcome.transaction,
          network: requirements.network,
          payer: verified.payer,
        };
      }

      return {
        success: true,
        transaction: outcome.transaction,
        network: requirements.network,
        payer: verified.payer,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        errorReason: "settlement_failed",
        errorMessage: reason,
        transaction: "",
        network: requirements.network,
        payer: verified.payer,
      };
    } finally {
      // The inner receipt outcome is now authoritatively known (or the attempt
      // errored out), so the in-flight entry can be released (spec §10).
      this.settlementCache.release(cacheKey);
    }
  }

  /**
   * Builds a standard invalid verify response.
   *
   * @param reason - Invalid reason code.
   * @param payer - Payer account, attached only once independently verified.
   * @returns Verify response.
   */
  private invalid(reason: string, payer?: string): VerifyResponse {
    return { isValid: false, invalidReason: reason, payer };
  }

  /**
   * Builds a standard failed settlement response.
   *
   * @param reason - Error reason code.
   * @param network - Network identifier.
   * @param payer - Payer account, when independently verified.
   * @returns Settle response.
   */
  private settleFailure(reason: string, network: Network, payer?: string): SettleResponse {
    return {
      success: false,
      errorReason: reason,
      transaction: "",
      network,
      payer,
    };
  }

  /**
   * Runs an RPC call and converts any thrown error into a fail-closed result
   * carrying the supplied reason code (spec §5 / §9).
   *
   * @param fn - The RPC thunk.
   * @param reason - Reason code to surface when the call throws.
   * @returns A discriminated result with the value or the fail-closed reason.
   */
  private async safe<T>(
    fn: () => Promise<T>,
    reason: string,
  ): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
    try {
      return { ok: true, value: await fn() };
    } catch {
      return { ok: false, reason };
    }
  }
}
