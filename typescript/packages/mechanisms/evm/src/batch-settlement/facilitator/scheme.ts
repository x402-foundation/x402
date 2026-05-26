import {
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  FacilitatorContext,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { FacilitatorEvmSigner } from "../../signer";
import { BATCH_SETTLEMENT_SCHEME } from "../constants";
import {
  isBatchSettlementDepositPayload,
  isBatchSettlementVoucherPayload,
  isBatchSettlementClaimPayload,
  isBatchSettlementSettlePayload,
  isBatchSettlementRefundPayload,
  isBatchSettlementEnrichedRefundPayload,
} from "../types";
import type { AuthorizerSigner } from "../types";
import { verifyDeposit, settleDeposit } from "./deposit";
import { verifyVoucher } from "./voucher";
import { executeClaimWithSignature } from "./claim";
import { executeSettle } from "./settle";
import { executeRefundWithSignature } from "./refund";
import * as Errors from "../errors";

/**
 * Facilitator-side implementation of the `batch-settlement` scheme for EVM networks.
 *
 * Routes incoming verify/settle requests to the appropriate handler based on payload
 * type (deposit, voucher, claim, settle, refund).
 */
export class BatchSettlementEvmScheme implements SchemeNetworkFacilitator {
  readonly scheme = BATCH_SETTLEMENT_SCHEME;
  readonly caipFamily = "eip155:*";

  /**
   * Creates a facilitator scheme for verifying and settling batch-settlement payments.
   *
   * @param signer - Facilitator EVM signer(s) used for tx submission and onchain reads.
   * @param authorizerSigner - Dedicated key that provides EIP-712 signatures for
   *   `claimWithSignature` / `refundWithSignature`.  The facilitator will sign missing
   *   authorizer signatures using this key when the server omits them.
   */
  constructor(
    private readonly signer: FacilitatorEvmSigner,
    private readonly authorizerSigner: AuthorizerSigner,
  ) {}

  /**
   * Returns facilitator-specific extra fields to be merged into payment requirements.
   *
   * Exposes the configured `receiverAuthorizer` address so the server and client can
   * embed it in `ChannelConfig`.
   *
   * @param _ - Network identifier (unused).
   * @returns Extra fields containing `receiverAuthorizer`.
   */
  getExtra(_: string): { receiverAuthorizer: `0x${string}` } | undefined {
    return { receiverAuthorizer: this.authorizerSigner.address };
  }

  /**
   * Returns all facilitator signer addresses available for the given network.
   *
   * @param _ - Network identifier (unused).
   * @returns Array of hex addresses.
   */
  getSigners(_: string): `0x${string}`[] {
    return [...this.signer.getAddresses()];
  }

  /**
   * Verifies a payment payload (deposit or voucher) without executing settlement.
   *
   * @param payload - The x402 payment payload envelope.
   * @param requirements - Server payment requirements (scheme, network, asset, amount).
   * @param context - Optional facilitator extension context.
   * @returns A {@link VerifyResponse} indicating validity with payer and channel state in `extra`.
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<VerifyResponse> {
    const rawPayload = payload.payload;

    if (
      payload.accepted.scheme !== BATCH_SETTLEMENT_SCHEME ||
      requirements.scheme !== BATCH_SETTLEMENT_SCHEME
    ) {
      return { isValid: false, invalidReason: Errors.ErrInvalidScheme };
    }

    if (payload.accepted.network !== requirements.network) {
      return { isValid: false, invalidReason: Errors.ErrNetworkMismatch };
    }

    if (isBatchSettlementDepositPayload(rawPayload)) {
      return verifyDeposit(this.signer, payload, rawPayload, requirements, context);
    }

    if (isBatchSettlementVoucherPayload(rawPayload)) {
      return verifyVoucher(this.signer, rawPayload, requirements, rawPayload.channelConfig);
    }

    if (isBatchSettlementRefundPayload(rawPayload)) {
      return verifyVoucher(this.signer, rawPayload, requirements, rawPayload.channelConfig);
    }

    return { isValid: false, invalidReason: Errors.ErrInvalidPayloadType };
  }

  /**
   * Executes settlement for a payment payload.
   *
   * Dispatches to the correct handler based on payload settle action:
   * - `deposit` → onchain `deposit(config, amount, collector, collectorData)`
   * - `claim` → onchain `claimWithSignature(VoucherClaim[], bytes)`
   * - `settle` → onchain `settle(receiver, token)`
   * - `refund` → optional claim + onchain `refundWithSignature(config, amount, nonce, sig)`
   *
   * @param payload - The x402 payment payload envelope.
   * @param requirements - Server payment requirements.
   * @param context - Optional facilitator extension context.
   * @returns A {@link SettleResponse} with the transaction hash on success.
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<SettleResponse> {
    const rawPayload = payload.payload;

    if (isBatchSettlementDepositPayload(rawPayload)) {
      return settleDeposit(this.signer, payload, rawPayload, requirements, context);
    }

    if (isBatchSettlementClaimPayload(rawPayload)) {
      return executeClaimWithSignature(
        this.signer,
        rawPayload,
        requirements,
        this.authorizerSigner,
      );
    }

    if (isBatchSettlementEnrichedRefundPayload(rawPayload)) {
      return executeRefundWithSignature(
        this.signer,
        rawPayload,
        requirements,
        this.authorizerSigner,
      );
    }

    if (isBatchSettlementSettlePayload(rawPayload)) {
      return executeSettle(this.signer, rawPayload, requirements);
    }

    return {
      success: false,
      errorReason: Errors.ErrInvalidPayloadType,
      transaction: "",
      network: requirements.network,
    };
  }
}
