import type { PaymentPayload, PaymentRequirements, VerifyResponse } from "@x402/core/types";
import {
  errorMessage,
  hasSplits,
  parseTransferExecutorPayload,
  type TransferExecutorPayloadParse,
} from "../../internal";
import type { FacilitatorHederaSigner } from "../../signer";
import type { ExactHederaTransferExecutorPayload } from "../../types";
import { isHbarAsset } from "../../utils";
import {
  isExecutorAdmitted,
  isTransferExecutorEnabled,
  type HederaAliasPolicy,
  type HederaTransferExecutorConfig,
  type TransferExecutorSigner,
} from "./config";
import {
  ErrAddressResolutionFailed,
  ErrCustomFeeAsset,
  ErrExecutorNotAdmitted,
  ErrInvalidPayload,
  ErrInvalidPayloadAuthorization,
  ErrInvalidPayloadExecutor,
  ErrInvalidPayloadPayer,
  ErrInvalidPaymentRequirements,
  ErrInvalidTransferExecutorPayload,
  ErrSimulationGasExceeded,
  ErrSimulationReverted,
  ErrUnexpectedVerifyError,
  ErrUnsupportedAssetTransferMethod,
} from "./errors";
import {
  encodeExecuteTransferCall,
  isUint256,
  toEvmAssetAddress,
  toLongZeroAddress,
} from "./executeTransferCall";
import {
  TRANSFER_EXECUTOR_REQUIREMENT_CODES,
  validateExactRequirements,
  type VerifyRejection,
} from "./requirements";

/**
 * The code for each malformed payload field.
 */
const MALFORMED_PAYLOAD_CODES: Record<
  Extract<TransferExecutorPayloadParse, { malformedField: string }>["malformedField"],
  string
> = {
  payload: ErrInvalidTransferExecutorPayload,
  payer: ErrInvalidPayloadPayer,
  executor: ErrInvalidPayloadExecutor,
  authorization: ErrInvalidPayloadAuthorization,
};

/**
 * What `transferExecutor` verification reads from the scheme.
 */
export type TransferExecutorContext = {
  signer: FacilitatorHederaSigner;
  /**
   * The scheme's copy: gas settings fixed, executor lists live. Undefined when
   * the method is off.
   */
  config: HederaTransferExecutorConfig | undefined;
  aliasPolicy: HederaAliasPolicy;
  /**
   * Read-only in-flight check, set for `/verify` only.
   */
  isInFlight?: (network: string, payload: ExactHederaTransferExecutorPayload) => boolean;
};

/**
 * The `executeTransfer` call exactly as verification simulated it.
 */
export type PreparedExecuteTransfer = {
  network: string;
  executor: string;
  feePayer: string;
  payer: string;
  payToAccountId: string;
  /**
   * Calldata exactly as simulated.
   */
  functionParameters: string;
  /**
   * `config.gasLimit` exactly as simulated.
   */
  gas: number;
};

/**
 * Verification outcome. A valid payment carries the prepared call and the
 * signer whose capabilities verification checked.
 */
export type TransferExecutorVerification =
  | { response: VerifyRejection; call?: undefined }
  | { response: VerifyResponse; call: PreparedExecuteTransfer; signer: TransferExecutorSigner };

/**
 * Verifies a `transferExecutor` payment.
 *
 * @param ctx - Signer, config and alias policy
 * @param payload - Payment payload
 * @param requirements - Matched requirements
 * @returns The verify response, plus the prepared call when valid
 */
export async function verifyTransferExecutor(
  ctx: TransferExecutorContext,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): Promise<TransferExecutorVerification> {
  const requirementsFailure = validateExactRequirements(payload, requirements, {
    aliasPolicy: ctx.aliasPolicy,
    checkFeePayerParity: false,
    codes: TRANSFER_EXECUTOR_REQUIREMENT_CODES,
  });
  if (requirementsFailure) {
    return { response: requirementsFailure };
  }
  // The exact scheme requires a network without the extension to reject it, not ignore it.
  if (hasSplits(requirements.extra)) {
    return invalid(
      ErrInvalidPaymentRequirements,
      "",
      "transferExecutor does not implement extra.splits",
    );
  }
  // A bad requirement, not an infrastructure fault: rejected before encoding.
  if (!isUint256(BigInt(requirements.amount))) {
    return invalid(ErrInvalidPaymentRequirements, "");
  }

  const parsed = parseTransferExecutorPayload(payload.payload);
  if ("malformedField" in parsed) {
    return invalid(MALFORMED_PAYLOAD_CODES[parsed.malformedField], "");
  }
  const transfer = parsed.payload;
  const { payer } = transfer;
  const { network } = requirements;
  const { signer, config } = ctx;

  // Read-only: verify never takes the guard, settle does.
  if (ctx.isInFlight?.(network, transfer)) {
    return invalid(ErrInvalidPayload, payer, "payload already in flight");
  }

  // Runs before the custom-fee read, which needs a transferExecutor capability.
  if (config === undefined || !isTransferExecutorEnabled(signer, config, network)) {
    return invalid(ErrUnsupportedAssetTransferMethod, payer);
  }

  try {
    return await verifyEnabledTransfer(signer, config, requirements, transfer);
  } catch (error) {
    // Transport and infrastructure failures are never blamed on the payer.
    return invalid(ErrUnexpectedVerifyError, payer, errorMessage(error));
  }
}

/**
 * Runs the steps that need the signer's `transferExecutor` capabilities.
 * Throws on transport errors.
 *
 * @param signer - Signer with every capability
 * @param config - The scheme's `transferExecutor` options
 * @param requirements - Validated requirements
 * @param transfer - Well-formed payload
 * @returns The verification
 */
async function verifyEnabledTransfer(
  signer: TransferExecutorSigner,
  config: HederaTransferExecutorConfig,
  requirements: PaymentRequirements,
  transfer: ExactHederaTransferExecutorPayload,
): Promise<TransferExecutorVerification> {
  const { network, asset } = requirements;
  const { payer } = transfer;

  if (!isHbarAsset(asset)) {
    const fees = await signer.getTokenCustomFees({ tokenId: asset, network });
    if (fees === undefined) {
      return invalid(
        ErrInvalidPaymentRequirements,
        payer,
        `asset ${asset} is not a fungible token on ${network}`,
      );
    }
    if (fees.fixedFeeCount + fees.fractionalFeeCount + fees.royaltyFeeCount !== 0) {
      return invalid(ErrCustomFeeAsset, payer);
    }
  }

  // Judged against the facilitator's own list, whatever the requirements name.
  if (!isExecutorAdmitted(config, network, transfer.executor)) {
    return invalid(ErrExecutorNotAdmitted, payer);
  }

  // Not found is the payer's problem; a thrown transport error is not.
  const payerAddress = await signer.resolveEvmAddress({ account: payer, network });
  if (payerAddress === undefined) {
    return invalid(ErrAddressResolutionFailed, payer, `payer ${payer} has no EVM address`);
  }
  const payToAddress = await signer.resolveEvmAddress({ account: requirements.payTo, network });
  if (payToAddress === undefined) {
    return invalid(
      ErrAddressResolutionFailed,
      payer,
      `payTo ${requirements.payTo} has no EVM address`,
    );
  }
  // Drawn per call, as `/supported` draws its advertised `feePayer`; enablement
  // checked there is one. Settle submits from the account simulated here. It is
  // our own account, so a failure to resolve it is misconfiguration.
  const addresses = signer.getAddresses();
  const feePayer = addresses[Math.floor(Math.random() * addresses.length)];
  const feePayerAddress = await signer.resolveEvmAddress({ account: feePayer, network });
  if (feePayerAddress === undefined) {
    throw new Error(`fee payer ${feePayer} has no EVM address`);
  }

  // Built from the requirements and payload.payer only, never from client calldata.
  const call: PreparedExecuteTransfer = {
    network,
    executor: transfer.executor,
    feePayer,
    payer,
    payToAccountId: payToAddress.accountId,
    functionParameters: encodeExecuteTransferCall({
      from: payerAddress.evmAddress,
      asset: toEvmAssetAddress(asset),
      to: payToAddress.evmAddress,
      amount: BigInt(requirements.amount),
      authorization: transfer.authorization,
    }),
    gas: config.gasLimit,
  };

  // Simulated from the account and with the gas limit settlement submits with.
  const simulationParams = {
    network,
    from: feePayerAddress.evmAddress,
    to: toLongZeroAddress(call.executor),
    data: call.functionParameters,
    gas: call.gas,
  };
  const outcome = await signer.simulateContractCall({ ...simulationParams, estimate: false });
  if (outcome.reverted) {
    return invalid(ErrSimulationReverted, payer, outcome.reason);
  }

  // Opt-in: only a configured ceiling turns on the estimating simulation.
  const ceiling = config.simulationGasCeiling;
  if (ceiling !== undefined) {
    const estimated = await signer.simulateContractCall({ ...simulationParams, estimate: true });
    if (estimated.reverted) {
      return invalid(ErrSimulationReverted, payer, estimated.reason);
    }
    if (estimated.gasEstimate === undefined) {
      throw new Error("estimating simulation returned no gas estimate");
    }
    if (estimated.gasEstimate > ceiling) {
      return invalid(
        ErrSimulationGasExceeded,
        payer,
        `estimated gas ${estimated.gasEstimate} exceeds ceiling ${ceiling}`,
      );
    }
  }

  return { response: { isValid: true, payer }, call, signer };
}

/**
 * Builds a failed verification.
 *
 * @param invalidReason - Error code
 * @param payer - Payer to report
 * @param invalidMessage - Optional detail
 * @returns Verification without a prepared call
 */
function invalid(
  invalidReason: string,
  payer: string,
  invalidMessage?: string,
): TransferExecutorVerification {
  return {
    response:
      invalidMessage === undefined
        ? { isValid: false, invalidReason, payer }
        : { isValid: false, invalidReason, invalidMessage, payer },
  };
}
