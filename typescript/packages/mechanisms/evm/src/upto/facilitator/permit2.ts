import {
  PaymentPayload,
  PaymentRequirements,
  FacilitatorContext,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  extractEip2612GasSponsoringInfo,
  extractErc20ApprovalGasSponsoringInfo,
  ERC20_APPROVAL_GAS_SPONSORING_KEY,
  resolveErc20ApprovalExtensionSigner,
  type Erc20ApprovalGasSponsoringFacilitatorExtension,
  type Erc20ApprovalGasSponsoringSigner,
} from "../../exact/extensions";
import { getAddress, encodeFunctionData } from "viem";
import {
  PERMIT2_ADDRESS,
  uptoPermit2WitnessTypes,
  x402UptoPermit2ProxyABI,
  x402UptoPermit2ProxyAddress,
} from "../../constants";
import {
  ErrPermit2AmountMismatch,
  ErrUptoSettlementExceedsAmount,
  ErrUptoFacilitatorMismatch,
  ErrUptoInvalidScheme,
  ErrUptoNetworkMismatch,
} from "./errors";
import { FacilitatorEvmSigner } from "../../signer";
import { UptoPermit2Payload } from "../../types";
import { getEvmChainId } from "../../utils";
import { validateErc20ApprovalForPayment } from "../../shared/erc20approval";
import {
  buildUptoPermit2SettleArgs,
  waitAndReturnSettleResponse,
  mapSettleError,
  splitEip2612Signature,
  simulatePermit2Settle,
  simulatePermit2SettleWithPermit,
  simulatePermit2SettleWithErc20Approval,
  diagnosePermit2SimulationFailure,
  checkPermit2Prerequisites,
  validateEip2612PermitForPayment,
  type Permit2ProxyConfig,
} from "../../shared/permit2";
import type { Eip2612GasSponsoringInfo } from "../../exact/extensions";

const uptoProxyConfig: Permit2ProxyConfig = {
  proxyAddress: x402UptoPermit2ProxyAddress,
  proxyABI: x402UptoPermit2ProxyABI,
};

export interface VerifyUptoPermit2Options {
  simulate?: boolean;
}

export interface UptoPermit2FacilitatorConfig {
  simulateInSettle?: boolean;
}

/**
 * Verifies an upto Permit2 payment payload against the given requirements.
 *
 * Validates scheme, network, spender, recipient, facilitator, deadline, amount,
 * token, signature, Permit2 allowance, and payer balance.
 *
 * @param signer - The facilitator signer for contract reads and signature verification
 * @param payload - The payment payload to verify
 * @param requirements - The payment requirements to verify against
 * @param permit2Payload - The upto Permit2 specific payload with witness data
 * @param context - Optional facilitator context for extension-provided capabilities
 * @param options - Optional verification options (e.g., skip simulation)
 * @returns Promise resolving to a verification response indicating validity
 */
export async function verifyUptoPermit2(
  signer: FacilitatorEvmSigner,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  permit2Payload: UptoPermit2Payload,
  context?: FacilitatorContext,
  options?: VerifyUptoPermit2Options,
): Promise<VerifyResponse> {
  const payer = permit2Payload.permit2Authorization.from;

  if (payload.accepted.scheme !== "upto" || requirements.scheme !== "upto") {
    return {
      isValid: false,
      invalidReason: ErrUptoInvalidScheme,
      payer,
    };
  }

  if (payload.accepted.network !== requirements.network) {
    return {
      isValid: false,
      invalidReason: ErrUptoNetworkMismatch,
      payer,
    };
  }

  const chainId = getEvmChainId(requirements.network);
  const tokenAddress = getAddress(requirements.asset);

  if (
    getAddress(permit2Payload.permit2Authorization.spender) !==
    getAddress(x402UptoPermit2ProxyAddress)
  ) {
    return {
      isValid: false,
      invalidReason: "invalid_permit2_spender",
      payer,
    };
  }

  if (
    getAddress(permit2Payload.permit2Authorization.witness.to) !== getAddress(requirements.payTo)
  ) {
    return {
      isValid: false,
      invalidReason: "invalid_permit2_recipient_mismatch",
      payer,
    };
  }

  // Verify the facilitator address in the witness matches our own address
  const facilitatorAddresses = signer.getAddresses();
  const witnessFacilitator = getAddress(permit2Payload.permit2Authorization.witness.facilitator);
  const isFacilitatorMatch = facilitatorAddresses.some(
    addr => getAddress(addr) === witnessFacilitator,
  );
  if (!isFacilitatorMatch) {
    return {
      isValid: false,
      invalidReason: ErrUptoFacilitatorMismatch,
      payer,
    };
  }

  const now = Math.floor(Date.now() / 1000);
  if (BigInt(permit2Payload.permit2Authorization.deadline) < BigInt(now + 6)) {
    return {
      isValid: false,
      invalidReason: "permit2_deadline_expired",
      payer,
    };
  }

  if (BigInt(permit2Payload.permit2Authorization.witness.validAfter) > BigInt(now)) {
    return {
      isValid: false,
      invalidReason: "permit2_not_yet_valid",
      payer,
    };
  }

  if (
    BigInt(permit2Payload.permit2Authorization.permitted.amount) !== BigInt(requirements.amount)
  ) {
    return {
      isValid: false,
      invalidReason: ErrPermit2AmountMismatch,
      payer,
    };
  }

  if (getAddress(permit2Payload.permit2Authorization.permitted.token) !== tokenAddress) {
    return {
      isValid: false,
      invalidReason: "permit2_token_mismatch",
      payer,
    };
  }

  // Verify signature using upto-specific witness types (includes facilitator)
  const permit2TypedData = {
    types: uptoPermit2WitnessTypes,
    primaryType: "PermitWitnessTransferFrom" as const,
    domain: {
      name: "Permit2",
      chainId,
      verifyingContract: PERMIT2_ADDRESS,
    },
    message: {
      permitted: {
        token: getAddress(permit2Payload.permit2Authorization.permitted.token),
        amount: BigInt(permit2Payload.permit2Authorization.permitted.amount),
      },
      spender: getAddress(permit2Payload.permit2Authorization.spender),
      nonce: BigInt(permit2Payload.permit2Authorization.nonce),
      deadline: BigInt(permit2Payload.permit2Authorization.deadline),
      witness: {
        to: getAddress(permit2Payload.permit2Authorization.witness.to),
        facilitator: getAddress(permit2Payload.permit2Authorization.witness.facilitator),
        validAfter: BigInt(permit2Payload.permit2Authorization.witness.validAfter),
      },
    },
  };

  // Verify signature
  // Note: verifyTypedData is implementation-dependent and pluggable on FacilitatorEvmSigner
  // Some implementations only do EOA-style ECDSA recovery (e.g. viem/utils verifyTypedData, ethers.verifyTypedData)
  // Viem's publicClient.verifyTypedData supports EOA and Smart Contract Account (ERC-1271 / ERC-6492) signature verification
  let signatureValid = false;
  try {
    signatureValid = await signer.verifyTypedData({
      address: payer,
      ...permit2TypedData,
      signature: permit2Payload.signature,
    });
  } catch {
    signatureValid = false;
  }

  if (!signatureValid) {
    // Check if the payer is a deployed smart contract (ERC-1271 / ERC-6492)
    const bytecode = await signer.getCode({ address: payer });
    const isDeployedContract = bytecode && bytecode !== "0x";

    if (!isDeployedContract) {
      return {
        isValid: false,
        invalidReason: "invalid_permit2_signature",
        payer,
      };
    }
    // Deployed smart contract: fall through to simulation
  }

  // If simulation is disabled, return early
  if (options?.simulate === false) {
    return { isValid: true, invalidReason: undefined, payer };
  }

  const facilitatorAddress = getAddress(permit2Payload.permit2Authorization.witness.facilitator);
  // Per spec §Phase 3 Step 7: simulate with requirements.amount (the worst-case charge).
  // At verify time, requirements.amount = max authorized amount.
  // At settle time, requirements.amount = actual settlement amount (≤ max).
  const uptoSettleArgs = buildUptoPermit2SettleArgs(
    permit2Payload,
    BigInt(requirements.amount),
    facilitatorAddress,
  );

  const eip2612InfoForSim = extractEip2612GasSponsoringInfo(payload);
  if (eip2612InfoForSim) {
    const fieldResult = validateEip2612PermitForPayment(eip2612InfoForSim, payer, tokenAddress);
    if (!fieldResult.isValid) {
      return { isValid: false, invalidReason: fieldResult.invalidReason!, payer };
    }

    const simOk = await simulatePermit2SettleWithPermit(
      uptoProxyConfig,
      signer,
      uptoSettleArgs,
      eip2612InfoForSim,
    );
    if (!simOk) {
      return diagnosePermit2SimulationFailure(
        uptoProxyConfig,
        signer,
        tokenAddress,
        permit2Payload,
        requirements.amount,
      );
    }

    return { isValid: true, invalidReason: undefined, payer };
  }

  const erc20GasSponsorshipExtension =
    context?.getExtension<Erc20ApprovalGasSponsoringFacilitatorExtension>(
      ERC20_APPROVAL_GAS_SPONSORING_KEY,
    );
  if (erc20GasSponsorshipExtension) {
    const erc20Info = extractErc20ApprovalGasSponsoringInfo(payload);
    if (erc20Info) {
      const fieldResult = await validateErc20ApprovalForPayment(erc20Info, payer, tokenAddress);
      if (!fieldResult.isValid) {
        return { isValid: false, invalidReason: fieldResult.invalidReason!, payer };
      }

      const extensionSigner = resolveErc20ApprovalExtensionSigner(
        erc20GasSponsorshipExtension,
        requirements.network,
      );

      if (extensionSigner?.simulateTransactions) {
        const simOk = await simulatePermit2SettleWithErc20Approval(
          uptoProxyConfig,
          extensionSigner,
          uptoSettleArgs,
          erc20Info,
        );
        if (!simOk) {
          return diagnosePermit2SimulationFailure(
            uptoProxyConfig,
            signer,
            tokenAddress,
            permit2Payload,
            requirements.amount,
          );
        }
        return { isValid: true, invalidReason: undefined, payer };
      }

      return checkPermit2Prerequisites(
        uptoProxyConfig,
        signer,
        tokenAddress,
        payer,
        requirements.amount,
      );
    }
  }

  const simOk = await simulatePermit2Settle(uptoProxyConfig, signer, uptoSettleArgs);
  if (!simOk) {
    return diagnosePermit2SimulationFailure(
      uptoProxyConfig,
      signer,
      tokenAddress,
      permit2Payload,
      requirements.amount,
    );
  }

  return {
    isValid: true,
    invalidReason: undefined,
    payer,
  };
}

/**
 * Settles an upto Permit2 payment on-chain.
 *
 * Verifies the payment first, then selects the appropriate settlement path:
 * EIP-2612 atomic permit, ERC-20 approval extension, or direct settlement.
 *
 * @param signer - The facilitator signer for contract writes
 * @param payload - The payment payload to settle
 * @param requirements - The payment requirements
 * @param permit2Payload - The upto Permit2 specific payload with witness data
 * @param context - Optional facilitator context for extension-provided capabilities
 * @param config - Optional facilitator configuration (e.g., simulation settings for settle)
 * @returns Promise resolving to a settlement response indicating success or failure
 */
export async function settleUptoPermit2(
  signer: FacilitatorEvmSigner,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  permit2Payload: UptoPermit2Payload,
  context?: FacilitatorContext,
  config?: UptoPermit2FacilitatorConfig,
): Promise<SettleResponse> {
  const payer = permit2Payload.permit2Authorization.from;
  const settlementAmount = BigInt(requirements.amount);

  // Re-verify the signature before settling. We override `requirements.amount`
  // with the *authorized maximum* (`permitted.amount`) — NOT the actual
  // settlement amount — because `verifyUptoPermit2` performs strict equality
  // (`permitted.amount === requirements.amount`) to confirm the payload matches
  // what the client signed.  The actual settlement amount, which may be lower
  // than the authorized maximum, is validated separately in the guard below
  // (`settlementAmount > permitted.amount`).
  const verifyRequirements: PaymentRequirements = {
    ...requirements,
    amount: permit2Payload.permit2Authorization.permitted.amount,
  };

  const valid = await verifyUptoPermit2(
    signer,
    payload,
    verifyRequirements,
    permit2Payload,
    context,
    { simulate: config?.simulateInSettle ?? true },
  );
  if (!valid.isValid) {
    return {
      success: false,
      network: payload.accepted.network,
      transaction: "",
      errorReason: valid.invalidReason ?? "invalid_scheme",
      payer,
    };
  }

  // Zero settlement — no on-chain tx needed
  if (settlementAmount === 0n) {
    return {
      success: true,
      transaction: "",
      network: payload.accepted.network,
      payer,
      amount: "0",
    };
  }

  if (settlementAmount > BigInt(permit2Payload.permit2Authorization.permitted.amount)) {
    return {
      success: false,
      network: payload.accepted.network,
      transaction: "",
      errorReason: ErrUptoSettlementExceedsAmount,
      payer,
    };
  }

  const facilitatorAddress = getAddress(permit2Payload.permit2Authorization.witness.facilitator);

  // Branch: EIP-2612 gas sponsoring (atomic settleWithPermit via contract)
  const eip2612Info = extractEip2612GasSponsoringInfo(payload);
  if (eip2612Info) {
    return settleUptoWithEIP2612(
      signer,
      payload,
      permit2Payload,
      eip2612Info,
      settlementAmount,
      facilitatorAddress,
    );
  }

  // Branch: ERC-20 approval gas sponsoring (broadcast approval + settle via extension signer)
  const erc20Info = extractErc20ApprovalGasSponsoringInfo(payload);
  if (erc20Info) {
    const erc20GasSponsorshipExtension =
      context?.getExtension<Erc20ApprovalGasSponsoringFacilitatorExtension>(
        ERC20_APPROVAL_GAS_SPONSORING_KEY,
      );
    const extensionSigner = resolveErc20ApprovalExtensionSigner(
      erc20GasSponsorshipExtension,
      payload.accepted.network,
    );
    if (extensionSigner) {
      return settleUptoWithERC20Approval(
        extensionSigner,
        payload,
        permit2Payload,
        erc20Info,
        settlementAmount,
        facilitatorAddress,
      );
    }
  }

  // Branch: standard settle (allowance already on-chain)
  return settleUptoDirect(signer, payload, permit2Payload, settlementAmount, facilitatorAddress);
}

/**
 * Settles an upto Permit2 payment via settleWithPermit, including the EIP-2612 permit atomically.
 *
 * @param signer - The facilitator signer for contract writes
 * @param payload - The payment payload for network info
 * @param permit2Payload - The upto Permit2 specific payload with authorization and signature
 * @param eip2612Info - The EIP-2612 gas sponsoring info from the payload extension
 * @param settlementAmount - The amount to settle on-chain
 * @param facilitatorAddress - The facilitator address authorized in the witness
 * @returns Promise resolving to a settlement response
 */
async function settleUptoWithEIP2612(
  signer: FacilitatorEvmSigner,
  payload: PaymentPayload,
  permit2Payload: UptoPermit2Payload,
  eip2612Info: Eip2612GasSponsoringInfo,
  settlementAmount: bigint,
  facilitatorAddress: `0x${string}`,
): Promise<SettleResponse> {
  const payer = permit2Payload.permit2Authorization.from;
  try {
    const { v, r, s } = splitEip2612Signature(eip2612Info.signature);

    const tx = await signer.writeContract({
      address: uptoProxyConfig.proxyAddress,
      abi: uptoProxyConfig.proxyABI,
      functionName: "settleWithPermit",
      args: [
        {
          value: BigInt(eip2612Info.amount),
          deadline: BigInt(eip2612Info.deadline),
          r,
          s,
          v,
        },
        ...buildUptoPermit2SettleArgs(permit2Payload, settlementAmount, facilitatorAddress),
      ],
    });

    const response = await waitAndReturnSettleResponse(signer, tx, payload, payer);
    return { ...response, amount: settlementAmount.toString() };
  } catch (error) {
    return mapSettleError(error, payload, payer);
  }
}

/**
 * Settles an upto Permit2 payment using an ERC-20 approval gas sponsoring extension.
 *
 * Broadcasts the pre-signed approval transaction followed by the settle transaction
 * via the extension signer.
 *
 * @param extensionSigner - The extension signer with sendTransactions capability
 * @param payload - The payment payload for network info
 * @param permit2Payload - The upto Permit2 specific payload with authorization and signature
 * @param erc20Info - Object containing the signed approval transaction
 * @param erc20Info.signedTransaction - The RLP-encoded signed ERC-20 approve transaction hex string
 * @param settlementAmount - The amount to settle on-chain
 * @param facilitatorAddress - The facilitator address authorized in the witness
 * @returns Promise resolving to a settlement response
 */
async function settleUptoWithERC20Approval(
  extensionSigner: Erc20ApprovalGasSponsoringSigner,
  payload: PaymentPayload,
  permit2Payload: UptoPermit2Payload,
  erc20Info: { signedTransaction: string },
  settlementAmount: bigint,
  facilitatorAddress: `0x${string}`,
): Promise<SettleResponse> {
  const payer = permit2Payload.permit2Authorization.from;

  try {
    const settleData = encodeFunctionData({
      abi: uptoProxyConfig.proxyABI,
      functionName: "settle",
      args: buildUptoPermit2SettleArgs(permit2Payload, settlementAmount, facilitatorAddress),
    });

    const txHashes = await extensionSigner.sendTransactions([
      erc20Info.signedTransaction as `0x${string}`,
      { to: uptoProxyConfig.proxyAddress, data: settleData, gas: BigInt(300_000) },
    ]);

    const settleTxHash = txHashes[txHashes.length - 1];
    const response = await waitAndReturnSettleResponse(
      extensionSigner,
      settleTxHash,
      payload,
      payer,
    );
    return { ...response, amount: settlementAmount.toString() };
  } catch (error) {
    return mapSettleError(error, payload, payer);
  }
}

/**
 * Settles an upto Permit2 payment directly when Permit2 allowance is already on-chain.
 *
 * @param signer - The facilitator signer for contract writes
 * @param payload - The payment payload for network info
 * @param permit2Payload - The upto Permit2 specific payload with authorization and signature
 * @param settlementAmount - The amount to settle on-chain
 * @param facilitatorAddress - The facilitator address authorized in the witness
 * @returns Promise resolving to a settlement response
 */
async function settleUptoDirect(
  signer: FacilitatorEvmSigner,
  payload: PaymentPayload,
  permit2Payload: UptoPermit2Payload,
  settlementAmount: bigint,
  facilitatorAddress: `0x${string}`,
): Promise<SettleResponse> {
  const payer = permit2Payload.permit2Authorization.from;
  try {
    const tx = await signer.writeContract({
      address: uptoProxyConfig.proxyAddress,
      abi: uptoProxyConfig.proxyABI,
      functionName: "settle",
      args: buildUptoPermit2SettleArgs(permit2Payload, settlementAmount, facilitatorAddress),
    });

    const response = await waitAndReturnSettleResponse(signer, tx, payload, payer);
    return { ...response, amount: settlementAmount.toString() };
  } catch (error) {
    return mapSettleError(error, payload, payer);
  }
}
