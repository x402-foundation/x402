import type { PaymentPayload, PaymentRequirements, VerifyResponse } from "@x402/core/types";
import {
  errorMessage,
  hasSplits,
  parseTransferExecutorPayload,
  type TransferExecutorPayloadParse,
} from "../../internal";
import type { FacilitatorHederaSigner } from "../../signer";
import type { ExactHederaTransferExecutorPayload } from "../../types";
import { hederaAccountIdsEqual, isHbarAsset } from "../../utils";
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
  // The mirror node reports transfers as JSON numbers, so a larger amount could
  // settle without its record ever matching. Rejected before anything is submitted.
  if (BigInt(requirements.amount) > BigInt(Number.MAX_SAFE_INTEGER)) {
    return invalid(
      ErrInvalidPaymentRequirements,
      "",
      `amount ${requirements.amount} is above ${Number.MAX_SAFE_INTEGER}, the largest the mirror node reports exactly`,
    );
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

  try {
    // The custom-fee rule belongs to the shape checks, so it runs before method
    // support. A signer that can't read fees leaves the method off, so method
    // support rejects first there.
    if (!isHbarAsset(requirements.asset) && canReadCustomFees(signer)) {
      const tokenFailure = await checkTokenCustomFees(signer, requirements, payer);
      if (tokenFailure !== undefined) {
        return tokenFailure;
      }
    }
    if (config === undefined || !isTransferExecutorEnabled(signer, config, network)) {
      return invalid(ErrUnsupportedAssetTransferMethod, payer);
    }
    return await verifyEnabledTransfer(signer, config, requirements, transfer);
  } catch (error) {
    // Transport and infrastructure failures are never blamed on the payer.
    return invalid(ErrUnexpectedVerifyError, payer, errorMessage(error));
  }
}

/**
 * Returns true when the signer can read a token's custom fees.
 *
 * @param signer - Facilitator signer
 * @returns True when `getTokenCustomFees` is implemented
 */
function canReadCustomFees(
  signer: FacilitatorHederaSigner,
): signer is FacilitatorHederaSigner &
  Required<Pick<FacilitatorHederaSigner, "getTokenCustomFees">> {
  return typeof signer.getTokenCustomFees === "function";
}

/**
 * Rejects an HTS asset that is not a fungible token on the network, or that
 * carries a custom fee. Throws on transport errors.
 *
 * @param signer - Signer that can read custom fees
 * @param requirements - Validated requirements with an HTS asset
 * @param payer - Payer to report
 * @returns The failure, or undefined when the token passes
 */
async function checkTokenCustomFees(
  signer: Required<Pick<FacilitatorHederaSigner, "getTokenCustomFees">>,
  requirements: PaymentRequirements,
  payer: string,
): Promise<TransferExecutorVerification | undefined> {
  const { network, asset } = requirements;
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
  return undefined;
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
  // checked there is one. A payer we control pays its own fee: the settlement
  // checks let our account lose `amount` only when it is the fee payer too.
  // Settle submits from the account simulated here. It is our own account, so a
  // failure to resolve it is misconfiguration. payTo never pays the fee: it would
  // net amount - fee, which fails the settlement's payee credit check.
  const feePayers = signer
    .getAddresses()
    .filter(address => !hederaAccountIdsEqual(address, payToAddress.accountId));
  if (feePayers.length === 0) {
    return invalid(
      ErrInvalidPaymentRequirements,
      payer,
      `payTo ${requirements.payTo} is the facilitator's only account, so it would pay the fee and be credited amount - fee`,
    );
  }
  const feePayer =
    feePayers.find(address => hederaAccountIdsEqual(address, payer)) ??
    feePayers[Math.floor(Math.random() * feePayers.length)];
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
