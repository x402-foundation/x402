import type {
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  FacilitatorContext,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { InMemoryPendingSettlementStore, PendingSettlementStore } from "@x402/core/facilitator";
import type { FacilitatorHederaBatchSigner } from "../signer";
import { BATCH_SETTLEMENT_DEPLOYMENTS, BATCH_SETTLEMENT_SCHEME } from "../constants";
import {
  isBatchSettlementDepositPayload,
  isBatchSettlementVoucherPayload,
  isBatchSettlementClaimPayload,
  isBatchSettlementSettlePayload,
  isBatchSettlementRefundPayload,
  isBatchSettlementEnrichedRefundPayload,
} from "../types";
import type { AuthorizerSigner } from "../types";
import { isSupportedHederaNetwork } from "../../utils";
import { verifyDeposit, settleDeposit } from "./deposit";
import { verifyVoucher } from "./voucher";
import { executeClaimWithSignature } from "./claim";
import { executeSettle } from "./settle";
import { executeRefundWithSignature } from "./refund";
import * as Errors from "../errors";

/** Per-operation gas limit overrides. */
export type BatchSettlementHederaGasConfig = Partial<{
  deposit: bigint;
  claim: bigint;
  settle: bigint;
  refund: bigint;
}>;

export interface BatchSettlementHederaSchemeConfig {
  /**
   * Lets a retried deposit settle for the same authorization reconcile against an
   * already-submitted transaction instead of re-submitting (see {@link PendingSettlementStore}).
   * Defaults to a fresh in-memory store; inject a shared implementation for multi-instance
   * facilitators.
   */
  pendingSettlementStore?: PendingSettlementStore;
  /**
   * Simulate contract calls through the Mirror Node before submitting them (default true).
   * Disable when the Mirror Node cannot simulate a system-contract path in your environment.
   */
  simulateBeforeSend?: boolean;
  /** Gas limit overrides (defaults from `HEDERA_GAS` in constants). */
  gas?: BatchSettlementHederaGasConfig;
  /**
   * How long reads that immediately follow a write keep polling the Mirror Node before trusting
   * a stale answer (default `CHANNEL_STATE_POLL_MS`). Set to 0 in tests with fake transports.
   */
  mirrorLagPollMs?: number;
}

/**
 * Facilitator-side implementation of the `batch-settlement` scheme for Hedera networks.
 *
 * Routes incoming verify/settle requests to the appropriate handler based on payload
 * type (deposit, voucher, claim, settle, refund). Contract writes are submitted as HAPI
 * `ContractExecuteTransaction`s paid by the facilitator account; reads go through the Mirror Node.
 */
export class BatchSettlementHederaScheme implements SchemeNetworkFacilitator {
  readonly scheme = BATCH_SETTLEMENT_SCHEME;
  readonly caipFamily = "hedera:*";
  private readonly simulateBeforeSend: boolean;
  private readonly gas: BatchSettlementHederaGasConfig;
  private readonly pendingStore: PendingSettlementStore;
  private readonly mirrorLagPollMs: number | undefined;

  /**
   * Creates a facilitator scheme for verifying and settling batch-settlement payments.
   *
   * @param signer - Facilitator Hedera signer used for tx submission, reads and signature checks.
   * @param authorizerSigner - Optional dedicated Hedera account key that signs `ClaimBatch` /
   *   `Refund` digests. When provided, the facilitator advertises its address as
   *   `receiverAuthorizer` in `/supported` and signs missing authorizer signatures. A facilitator
   *   that advertises a `receiverAuthorizer` must authenticate refund requests (see the spec).
   * @param config - Optional configuration.
   */
  constructor(
    private readonly signer: FacilitatorHederaBatchSigner,
    private readonly authorizerSigner?: AuthorizerSigner,
    config?: BatchSettlementHederaSchemeConfig,
  ) {
    this.simulateBeforeSend = config?.simulateBeforeSend ?? true;
    this.gas = config?.gas ?? {};
    this.pendingStore = config?.pendingSettlementStore ?? new InMemoryPendingSettlementStore();
    this.mirrorLagPollMs = config?.mirrorLagPollMs;
  }

  /**
   * Returns facilitator-specific extra fields to be merged into payment requirements.
   *
   * @param _ - Network identifier (unused).
   * @returns Extra fields containing `receiverAuthorizer`, or `undefined`.
   */
  getExtra(_: string): { receiverAuthorizer: `0x${string}` } | undefined {
    if (!this.authorizerSigner) {
      return undefined;
    }
    return { receiverAuthorizer: this.authorizerSigner.address };
  }

  /**
   * Returns all facilitator fee-payer account ids for the given network.
   *
   * @param _ - Network identifier (unused).
   * @returns Array of Hedera account ids.
   */
  getSigners(_: string): string[] {
    return [...this.signer.getAddresses()];
  }

  /**
   * Verifies a payment payload (deposit, voucher or refund) without executing settlement.
   *
   * @param payload - The x402 payment payload envelope.
   * @param requirements - Server payment requirements.
   * @param context - Optional facilitator extension context (unused).
   * @returns A {@link VerifyResponse} with payer and channel state in `extra`.
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<VerifyResponse> {
    void context;
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

    const networkErr = this.networkError(requirements.network);
    if (networkErr) {
      return {
        isValid: false,
        invalidReason: Errors.ErrNetworkMismatch,
        invalidMessage: networkErr,
      };
    }

    if (isBatchSettlementDepositPayload(rawPayload)) {
      return verifyDeposit(this.signer, payload, rawPayload, requirements, {
        simulateBeforeSend: this.simulateBeforeSend,
        gas: this.gas.deposit,
      });
    }

    if (isBatchSettlementVoucherPayload(rawPayload) || isBatchSettlementRefundPayload(rawPayload)) {
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
   * @param context - Optional facilitator extension context (unused).
   * @returns A {@link SettleResponse} with the Hedera transaction id on success.
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<SettleResponse> {
    void context;
    const rawPayload = payload.payload;

    const networkErr = this.networkError(requirements.network);
    if (networkErr) {
      return {
        success: false,
        errorReason: Errors.ErrNetworkMismatch,
        errorMessage: networkErr,
        transaction: "",
        network: requirements.network,
      };
    }

    if (isBatchSettlementDepositPayload(rawPayload)) {
      return settleDeposit(
        this.signer,
        payload,
        rawPayload,
        requirements,
        {
          simulateBeforeSend: this.simulateBeforeSend,
          gas: this.gas.deposit,
          pollMs: this.mirrorLagPollMs,
        },
        this.pendingStore,
      );
    }

    if (isBatchSettlementClaimPayload(rawPayload)) {
      return executeClaimWithSignature(
        this.signer,
        rawPayload,
        requirements,
        this.authorizerSigner,
        { simulateBeforeSend: this.simulateBeforeSend, gas: this.gas.claim },
      );
    }

    if (isBatchSettlementEnrichedRefundPayload(rawPayload)) {
      return executeRefundWithSignature(
        this.signer,
        rawPayload,
        requirements,
        this.authorizerSigner,
        { simulateBeforeSend: this.simulateBeforeSend, gas: this.gas.refund },
      );
    }

    if (isBatchSettlementSettlePayload(rawPayload)) {
      return executeSettle(this.signer, rawPayload, requirements, {
        simulateBeforeSend: this.simulateBeforeSend,
        gas: this.gas.settle,
        pollMs: this.mirrorLagPollMs,
      });
    }

    return {
      success: false,
      errorReason: Errors.ErrInvalidPayloadType,
      transaction: "",
      network: requirements.network,
    };
  }

  /**
   * Checks that the network is a supported Hedera network with a configured deployment.
   *
   * @param network - CAIP-2 network.
   * @returns A problem description, or `undefined` when usable.
   */
  private networkError(network: string): string | undefined {
    if (!isSupportedHederaNetwork(network)) {
      return `unsupported Hedera network ${network}`;
    }
    if (!BATCH_SETTLEMENT_DEPLOYMENTS[network]) {
      return `no batch-settlement deployment configured for ${network}`;
    }
    return undefined;
  }
}
