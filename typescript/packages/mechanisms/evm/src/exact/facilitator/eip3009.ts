import {
  PaymentPayload,
  PaymentRequirements,
  FacilitatorContext,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { getAddress, Hex, isAddressEqual, parseErc6492Signature } from "viem";
import { authorizationTypes } from "../../constants";
import { FacilitatorEvmSigner } from "../../signer";
import { getEvmChainId } from "../../utils";
import { ExactEIP3009Payload } from "../../types";
import * as Errors from "./errors";
import { resolveDataSuffix } from "../../shared/extensions";
import { verifyTypedDataSignature, classifyErc6492Payer } from "../../shared/verifySignature";
import {
  diagnoseEip3009SimulationFailure,
  executeTransferWithAuthorization,
  parseEip3009TransferError,
  simulateEip3009TransferResult,
} from "./eip3009-utils";

export interface VerifyEIP3009Options {
  /** Run onchain simulation. Defaults to true. */
  simulate?: boolean;
}

export interface EIP3009FacilitatorConfig {
  /**
   * Allowlist of factory contract addresses (hex strings, case-insensitive) that the facilitator
   * will call when deploying an undeployed smart wallet via ERC-6492.
   *
   * A non-empty list enables ERC-4337 smart wallet deployment via EIP-6492. Facilitators must
   * explicitly list every factory they trust to prevent arbitrary transaction injection via
   * attacker-controlled ERC-6492 signature wrappers. An empty or omitted list denies all factory
   * deployment calls.
   *
   * @default []
   */
  eip6492AllowedFactories?: string[];
  /**
   * If enabled, simulates transaction before settling. Defaults to false, ie only simulate during verify.
   *
   * @default false
   */
  simulateInSettle?: boolean;
}

/**
 * Verifies an EIP-3009 payment payload.
 *
 * @param signer - The facilitator signer for contract reads
 * @param payload - The payment payload to verify
 * @param requirements - The payment requirements
 * @param eip3009Payload - The EIP-3009 specific payload
 * @param options - Optional verification options
 * @param allowedFactories - Allowlisted ERC-6492 factory addresses; a counterfactual payment whose
 *   factory is not in this list is rejected here so verify mirrors settle's policy gate.
 * @returns Promise resolving to verification response
 */
export async function verifyEIP3009(
  signer: FacilitatorEvmSigner,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  eip3009Payload: ExactEIP3009Payload,
  options?: VerifyEIP3009Options,
  allowedFactories: string[] = [],
): Promise<VerifyResponse> {
  const payer = eip3009Payload.authorization.from;
  let eip6492Deployment:
    | { factoryAddress: `0x${string}`; factoryCalldata: `0x${string}` }
    | undefined;

  // Verify scheme matches
  if (payload.accepted.scheme !== "exact" || requirements.scheme !== "exact") {
    return {
      isValid: false,
      invalidReason: Errors.ErrInvalidScheme,
      payer,
    };
  }

  // Get chain configuration
  if (!requirements.extra?.name || !requirements.extra?.version) {
    return {
      isValid: false,
      invalidReason: Errors.ErrMissingEip712Domain,
      payer,
    };
  }

  const { name, version } = requirements.extra as { name: string; version: string };
  const erc20Address = getAddress(requirements.asset);

  // Verify network matches
  if (payload.accepted.network !== requirements.network) {
    return {
      isValid: false,
      invalidReason: Errors.ErrNetworkMismatch,
      payer,
    };
  }

  // Build typed data for signature verification
  const permitTypedData = {
    types: authorizationTypes,
    primaryType: "TransferWithAuthorization" as const,
    domain: {
      name,
      version,
      chainId: getEvmChainId(requirements.network),
      verifyingContract: erc20Address,
    },
    message: {
      from: eip3009Payload.authorization.from,
      to: eip3009Payload.authorization.to,
      value: BigInt(eip3009Payload.authorization.value),
      validAfter: BigInt(eip3009Payload.authorization.validAfter),
      validBefore: BigInt(eip3009Payload.authorization.validBefore),
      nonce: eip3009Payload.authorization.nonce,
    },
  };

  const signature = eip3009Payload.signature!;

  // Classify the payer: fetch code once, parse ERC-6492 wrapper, determine counterfactual.
  // Using classifyErc6492Payer avoids duplicating this block across eip3009.ts / v1/scheme.ts.
  const {
    isCounterfactual,
    innerSignature,
    eip6492Deployment: classification6492,
  } = await classifyErc6492Payer(signer, signature, payer);

  if (classification6492) {
    eip6492Deployment = classification6492;
  }

  if (isCounterfactual) {
    // Counterfactual deposits are deployed by settle via the factory, which is gated by the
    // allowlist. Enforce the same gate here so verify does not return isValid:true for a payment
    // that settle will reject with ErrFactoryNotAllowed (verify must predict settle).
    const factory = classification6492?.factoryAddress;
    const factoryAllowed =
      !!factory && allowedFactories.some(a => a.trim().toLowerCase() === factory.toLowerCase());
    if (!factoryAllowed) {
      return {
        isValid: false,
        invalidReason: Errors.ErrFactoryNotAllowed,
        payer,
      };
    }
  }

  if (!isCounterfactual) {
    // For deployed addresses (plain EOA, smart contract, 7702 EOA): verify the
    // signature using a strict primitive that mirrors on-chain SignatureChecker
    // semantics — ecrecover when no code, strict EIP-1271 when code is present.
    // No ECDSA fallback for code addresses; that fallback causes pre-verify to
    // accept sigs the on-chain token rejects (empirically confirmed on Base Sepolia).
    const isValid = await verifyTypedDataSignature(signer, {
      address: eip3009Payload.authorization.from,
      ...permitTypedData,
      signature: innerSignature,
    });
    if (!isValid) {
      return {
        isValid: false,
        invalidReason: Errors.ErrInvalidSignature,
        payer,
      };
    }
  }
  // Counterfactual: skip pre-verify and defer to on-chain simulation/settle which
  // deploys the factory first then atomically validates the signature.

  // Verify payment recipient matches
  if (getAddress(eip3009Payload.authorization.to) !== getAddress(requirements.payTo)) {
    return {
      isValid: false,
      invalidReason: Errors.ErrRecipientMismatch,
      payer,
    };
  }

  // Verify validBefore is in the future (with 6 second buffer for block time)
  const now = Math.floor(Date.now() / 1000);
  if (BigInt(eip3009Payload.authorization.validBefore) < BigInt(now + 6)) {
    return {
      isValid: false,
      invalidReason: Errors.ErrValidBeforeExpired,
      payer,
    };
  }

  // Verify validAfter is not in the future
  if (BigInt(eip3009Payload.authorization.validAfter) > BigInt(now)) {
    return {
      isValid: false,
      invalidReason: Errors.ErrValidAfterInFuture,
      payer,
    };
  }

  // Verify amount exactly matches requirements
  if (BigInt(eip3009Payload.authorization.value) !== BigInt(requirements.amount)) {
    return {
      isValid: false,
      invalidReason: Errors.ErrInvalidAuthorizationValue,
      payer,
    };
  }

  // Reject payments whose asset is an EOA — eth_call on an EOA silently returns
  // empty data without reverting, so simulation would pass but no Transfer event
  // would be emitted, producing a silent no-op settlement.
  const assetBytecode = await signer.getCode({ address: erc20Address });
  if (!assetBytecode || assetBytecode === "0x") {
    return { isValid: false, invalidReason: Errors.ErrAssetNotDeployedContract, payer };
  }

  // Transaction simulation
  if (options?.simulate !== false) {
    const { ok, error: simError } = await simulateEip3009TransferResult(
      signer,
      erc20Address,
      eip3009Payload,
      eip6492Deployment,
    );
    if (!ok) {
      const diagnosis = await diagnoseEip3009SimulationFailure(
        signer,
        erc20Address,
        eip3009Payload,
        requirements,
        requirements.amount,
      );
      // Carry the raw revert text so the concrete reason survives the mapping to a code.
      const rawMessage =
        simError instanceof Error ? simError.message : simError ? String(simError) : undefined;
      return rawMessage ? { ...diagnosis, invalidMessage: rawMessage } : diagnosis;
    }
  }

  return {
    isValid: true,
    invalidReason: undefined,
    payer,
  };
}

/**
 * Settles an EIP-3009 payment by executing transferWithAuthorization.
 *
 * @param signer - The facilitator signer for contract writes
 * @param payload - The payment payload to settle
 * @param requirements - The payment requirements
 * @param eip3009Payload - The EIP-3009 specific payload
 * @param config - Facilitator configuration
 * @param context - Optional facilitator context for extension capabilities
 * @returns Promise resolving to settlement response
 */
export async function settleEIP3009(
  signer: FacilitatorEvmSigner,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  eip3009Payload: ExactEIP3009Payload,
  config: EIP3009FacilitatorConfig,
  context?: FacilitatorContext,
): Promise<SettleResponse> {
  const payer = eip3009Payload.authorization.from;

  // Re-verify before settling
  const valid = await verifyEIP3009(
    signer,
    payload,
    requirements,
    eip3009Payload,
    { simulate: config.simulateInSettle ?? false },
    config.eip6492AllowedFactories ?? [],
  );
  if (!valid.isValid) {
    return {
      success: false,
      network: payload.accepted.network,
      transaction: "",
      errorReason: valid.invalidReason ?? Errors.ErrInvalidScheme,
      payer,
    };
  }

  try {
    // Parse ERC-6492 signature if applicable (for optional deployment).
    // Keep the full result so we can access the inner signature later for
    // the post-deploy transfer simulation.
    const settleErc6492Data = parseErc6492Signature(eip3009Payload.signature!);
    const {
      address: factoryAddress,
      data: factoryCalldata,
      signature: erc6492InnerSig,
    } = settleErc6492Data;

    // Deploy ERC-4337 smart wallet via EIP-6492 if factory is in the allowlist
    if (
      factoryAddress &&
      factoryCalldata &&
      !isAddressEqual(factoryAddress, "0x0000000000000000000000000000000000000000")
    ) {
      // Check if smart wallet is already deployed
      const bytecode = await signer.getCode({ address: payer });

      if (!bytecode || bytecode === "0x") {
        const normalizedFactory = factoryAddress.toLowerCase();
        const isAllowed = (config.eip6492AllowedFactories ?? []).some(
          allowed => allowed.toLowerCase() === normalizedFactory,
        );
        if (!isAllowed) {
          return {
            success: false,
            errorReason: Errors.ErrFactoryNotAllowed,
            transaction: "",
            network: payload.accepted.network,
            payer,
          };
        }

        // Wallet not deployed - attempt deployment
        const deployTx = await signer.sendTransaction({
          to: factoryAddress as Hex,
          data: factoryCalldata as Hex,
        });

        // Wait for deployment and check whether it actually succeeded.
        // A reverted factory tx would silently proceed without this check, misclassifying
        // the downstream transfer failure as an invalid-signature error.
        const deployReceipt = await signer.waitForTransactionReceipt({ hash: deployTx });
        if (deployReceipt.status !== "success") {
          return {
            success: false,
            errorReason: Errors.ErrSmartWalletDeploymentFailed,
            transaction: "",
            network: payload.accepted.network,
            payer,
          };
        }

        // Do NOT re-simulate the transfer here. The single authoritative pre-check is the
        // atomic Multicall3 deploy+transfer simulation that runs in verify (one eth_call,
        // state carried across both sub-calls). A second standalone eth_call after the real
        // deploy tx is unreliable — the read can race the deploy's state propagation across
        // load-balanced RPC nodes — and was producing false `eip6492_deployed_inner_wallet_
        // signature_unsupported` rejections for valid wallets (e.g. Coinbase Smart Wallet).
        // The on-chain transferWithAuthorization below is itself the definitive signature
        // check (the token routes to the wallet's isValidSignature); a genuinely
        // unsupported inner signature reverts there and is classified by the catch block.
      }
    }

    const dataSuffix = await resolveDataSuffix(context, {
      paymentPayload: payload,
      paymentRequirements: requirements,
    });

    // When the original signature was ERC-6492 wrapped (deployed wallet), use the
    // extracted inner signature for the on-chain transferWithAuthorization call.
    // FiatTokenV2_2's isValidSignature on the deployed contract expects the compact inner signature
    const settlePayload =
      erc6492InnerSig && erc6492InnerSig !== eip3009Payload.signature
        ? { ...eip3009Payload, signature: erc6492InnerSig }
        : eip3009Payload;

    const tx = await executeTransferWithAuthorization(
      signer,
      getAddress(requirements.asset),
      settlePayload,
      dataSuffix,
    );

    // Wait for transaction confirmation
    const receipt = await signer.waitForTransactionReceipt({ hash: tx });

    if (receipt.status !== "success") {
      return {
        success: false,
        errorReason: Errors.ErrTransactionFailed,
        transaction: tx,
        network: payload.accepted.network,
        payer,
      };
    }

    return {
      success: true,
      transaction: tx,
      network: payload.accepted.network,
      payer,
    };
  } catch (error) {
    // Preserve the raw revert text alongside the mapped code. The mapper collapses many
    // distinct on-chain reverts into a single reason (e.g. ErrInvalidSignature), so without
    // the original message the true cause is invisible to callers/operators.
    return {
      success: false,
      errorReason: parseEip3009TransferError(error),
      errorMessage: error instanceof Error ? error.message : String(error),
      transaction: "",
      network: payload.accepted.network,
      payer,
    };
  }
}
