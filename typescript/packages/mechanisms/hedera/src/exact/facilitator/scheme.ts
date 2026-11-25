import type {
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  HEDERA_CRYPTO_TRANSFER_METHOD,
  HEDERA_TRANSFER_EXECUTOR_METHOD,
  SUPPORTED_HEDERA_NETWORKS,
} from "../../constants";
import type { FacilitatorHederaSigner } from "../../signer";
import type { HederaAssetTransferMethod, HederaSupportedKindExtra } from "../../types";
import { isSupportedHederaNetwork, resolveHederaAssetTransferMethod } from "../../utils";
import {
  admitsAnyExecutor,
  getAdmittedExecutors,
  isTransferExecutorEnabled,
  parseTransferExecutorConfig,
  type HederaFacilitatorConfig,
  type HederaTransferExecutorConfig,
} from "./config";
import { settleCryptoTransfer, verifyCryptoTransfer } from "./cryptoTransfer";
import { ErrInvalidAssetTransferMethod, ErrInvalidPayload } from "./errors";
import { InFlightGuard, transferExecutorInFlightKey } from "./inFlightGuard";
import { CRYPTO_TRANSFER_REQUIREMENT_CODES } from "./requirements";
import {
  settleTransferExecutor,
  type PendingTransferExecutorSettlement,
  type TransferExecutorSettleContext,
} from "./transferExecutorSettle";
import { verifyTransferExecutor } from "./transferExecutorVerify";

/**
 * Outcome of selecting the asset transfer method for a payment.
 */
type AssetTransferMethodSelection =
  | { method: HederaAssetTransferMethod }
  | { method: null; invalidReason: string };

/**
 * Verify and settle for one asset transfer method.
 */
type AssetTransferMethodHandler = {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
};

/**
 * Selects the asset transfer method named by the requirements and checks that
 * `accepted` names the same one. An absent method counts as `cryptoTransfer`
 * on both sides. Synchronous, so settle dispatches before its first await.
 *
 * @param payload - Payment payload
 * @param requirements - Matched requirements
 * @returns The method, or the reason no method applies
 */
function selectAssetTransferMethod(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): AssetTransferMethodSelection {
  const method = resolveHederaAssetTransferMethod(requirements.extra);
  const accepted = resolveHederaAssetTransferMethod(payload.accepted.extra);
  if (method === null || accepted === null) {
    return { method: null, invalidReason: ErrInvalidAssetTransferMethod };
  }
  if (accepted !== method) {
    const invalidReason =
      method === HEDERA_TRANSFER_EXECUTOR_METHOD
        ? ErrInvalidPayload
        : CRYPTO_TRANSFER_REQUIREMENT_CODES.mismatch;
    return { method: null, invalidReason };
  }
  return { method };
}

/**
 * Hedera facilitator implementation for the Exact payment scheme.
 */
export class ExactHederaScheme implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = "hedera:*";
  private readonly transferExecutor: TransferExecutorSettleContext;
  /**
   * The options as constructed, kept after a pattern registration turns the method off.
   */
  private readonly transferExecutorOptions: HederaTransferExecutorConfig | undefined;
  /**
   * One handler per method, so adding a method without handling it fails to compile.
   */
  private readonly methods: Record<HederaAssetTransferMethod, AssetTransferMethodHandler>;

  /**
   * Creates a new facilitator scheme.
   *
   * @param signer - Facilitator signer implementation
   * @param config - Optional behavior config
   * @throws Error when `config.transferExecutor` is invalid
   */
  constructor(
    private readonly signer: FacilitatorHederaSigner,
    config: HederaFacilitatorConfig = {},
  ) {
    const aliasPolicy = config.aliasPolicy ?? "reject";
    const guard = new InFlightGuard<PendingTransferExecutorSettlement>();
    this.transferExecutorOptions = parseTransferExecutorConfig(config.transferExecutor);
    const transferExecutor: TransferExecutorSettleContext = {
      signer,
      config: this.transferExecutorOptions,
      aliasPolicy,
      guard,
    };
    this.transferExecutor = transferExecutor;
    this.methods = {
      [HEDERA_CRYPTO_TRANSFER_METHOD]: {
        verify: (payload, requirements) =>
          verifyCryptoTransfer(signer, payload, requirements, aliasPolicy),
        settle: (payload, requirements) =>
          settleCryptoTransfer(signer, payload, requirements, aliasPolicy),
      },
      [HEDERA_TRANSFER_EXECUTOR_METHOD]: {
        verify: async (payload, requirements) => {
          const verification = await verifyTransferExecutor(
            {
              ...transferExecutor,
              // Read-only: only settle takes the guard.
              isInFlight: (network, transfer) =>
                guard.isHeld(transferExecutorInFlightKey(network, transfer)),
            },
            payload,
            requirements,
          );
          return verification.response;
        },
        settle: (payload, requirements) =>
          settleTransferExecutor(transferExecutor, payload, requirements),
      },
    };
  }

  /**
   * Returns mechanism-specific `extra` data.
   *
   * Called with a network pattern such as `"hedera:*"`, it turns
   * `transferExecutor` off on this instance: core then advertises one kind for
   * the pattern, which cannot list each network's executors, and a facilitator
   * must reject executors it does not advertise. It throws when the options
   * admit an executor, and returns `{ feePayer }` otherwise.
   *
   * @param network - Network identifier, or the pattern the scheme was registered under
   * @returns Extra object with feePayer, plus the methods and executors when
   *          `transferExecutor` is enabled on `network`
   * @throws Error when `network` is not a concrete supported network and
   *         `transferExecutor` admits an executor
   */
  getExtra(network: string): Record<string, unknown> | undefined {
    if (!isSupportedHederaNetwork(network)) {
      this.transferExecutor.config = undefined;
      if (admitsAnyExecutor(this.transferExecutorOptions)) {
        throw new Error(
          `transferExecutor admits executors, but ExactHederaScheme is registered for "${network}". ` +
            `Register it for concrete networks (${SUPPORTED_HEDERA_NETWORKS.join(", ")}), or admit no executors.`,
        );
      }
    }
    const addresses = this.signer.getAddresses();
    if (addresses.length === 0) {
      return undefined;
    }
    const randomIndex = Math.floor(Math.random() * addresses.length);
    const extra: HederaSupportedKindExtra = { feePayer: addresses[randomIndex] };
    const { config } = this.transferExecutor;
    if (isTransferExecutorEnabled(this.signer, config, network)) {
      // The methods enabled here, not every defined method: a new method must
      // be enabled before it is advertised.
      extra.assetTransferMethods = [HEDERA_CRYPTO_TRANSFER_METHOD, HEDERA_TRANSFER_EXECUTOR_METHOD];
      extra.executors = [...getAdmittedExecutors(config, network)];
    }
    return extra;
  }

  /**
   * Returns managed signer addresses for this facilitator.
   *
   * @param _ - Network identifier
   * @returns Signer account ids
   */
  getSigners(_: string): string[] {
    return [...this.signer.getAddresses()];
  }

  /**
   * Verify an exact Hedera payload.
   *
   * @param payload - Payment payload
   * @param requirements - Matched payment requirements
   * @returns Verification result
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const selection = selectAssetTransferMethod(payload, requirements);
    if (selection.method === null) {
      return { isValid: false, invalidReason: selection.invalidReason, payer: "" };
    }
    return this.methods[selection.method].verify(payload, requirements);
  }

  /**
   * Settles a verified exact payment.
   *
   * @param payload - Payment payload
   * @param requirements - Matched requirements
   * @returns Settlement response
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const selection = selectAssetTransferMethod(payload, requirements);
    if (selection.method === null) {
      return {
        success: false,
        network: requirements.network,
        transaction: "",
        errorReason: selection.invalidReason,
        payer: "",
      };
    }
    return this.methods[selection.method].settle(payload, requirements);
  }
}
