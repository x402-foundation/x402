import {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { getAddress, Hex, isAddressEqual, parseErc6492Signature } from "viem";
import { authorizationTypes } from "../../constants";
import { FacilitatorEvmSigner } from "../../signer";
import { getEvmChainId } from "../../utils";
import { ExactEIP3009Payload } from "../../types";
import * as Errors from "./errors";
import {
  diagnoseEip3009SimulationFailure,
  executeTransferWithAuthorization,
  simulateEip3009Transfer,
} from "./eip3009-utils";

export interface VerifyEIP3009Options {
  /** Run onchain simulation. Defaults to true. */
  simulate?: boolean;
}

export interface EIP3009FacilitatorConfig {
  /**
   * If enabled, the facilitator will deploy ERC-4337 smart wallets
   * via EIP-6492 when encountering undeployed contract signatures.
   *
   * @default false
   */
  deployERC4337WithEIP6492: boolean;
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
 * @returns Promise resolving to verification response
 */
export async function verifyEIP3009(
  signer: FacilitatorEvmSigner,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  eip3009Payload: ExactEIP3009Payload,
  options?: VerifyEIP3009Options,
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

  const { name, version } = requirements.extra;
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

  // Verify signature
  // Note: verifyTypedData is implementation-dependent and pluggable on FacilitatorEvmSigner
  // Some implementations only do EOA-style ECDSA recovery (e.g. viem/utils verifyTypedData, ethers.verifyTypedData)
  // Viem's publicClient.verifyTypedData supports EOA and Smart Contract Account (ERC-1271 / ERC-6492) signature verification
  let isValid = false;
  try {
    isValid = await signer.verifyTypedData({
      address: eip3009Payload.authorization.from,
      ...permitTypedData,
      signature: eip3009Payload.signature!,
    });
  } catch {
    isValid = false;
  }
  const signature = eip3009Payload.signature!;
  const sigLen = signature.startsWith("0x") ? signature.length - 2 : signature.length;

  // Extract EIP-6492 deployment info (factory address + calldata) if present
  const erc6492Data = parseErc6492Signature(signature);
  const hasDeploymentInfo =
    erc6492Data.address &&
    erc6492Data.data &&
    !isAddressEqual(erc6492Data.address, "0x0000000000000000000000000000000000000000");

  if (hasDeploymentInfo) {
    eip6492Deployment = {
      factoryAddress: erc6492Data.address!,
      factoryCalldata: erc6492Data.data!,
    };
  }

  if (!isValid) {
    // Check if signature is from a smart wallet
    const isSmartWallet = sigLen > 130; // 65 bytes = 130 hex chars for EOA

    // EOA signature that failed verification — definitely invalid
    if (!isSmartWallet) {
      return {
        isValid: false,
        invalidReason: Errors.ErrInvalidSignature,
        payer,
      };
    }

    // Smart wallet signature: check if deployed or has ERC-6492 deployment info
    const bytecode = await signer.getCode({ address: payer });
    const isDeployed = bytecode && bytecode !== "0x";

    if (!isDeployed && !hasDeploymentInfo) {
      // Undeployed smart wallet with no factory info
      return {
        isValid: false,
        invalidReason: Errors.ErrUndeployedSmartWallet,
        payer,
      };
    }
    // Deployed smart wallet or undeployed with ERC-6492 factory info
    // fall through to remaining field checks and onchain simulation
  }

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

  // Transaction simulation
  if (options?.simulate !== false) {
    const simulationSucceeded = await simulateEip3009Transfer(
      signer,
      erc20Address,
      eip3009Payload,
      eip6492Deployment,
    );
    if (!simulationSucceeded) {
      return diagnoseEip3009SimulationFailure(
        signer,
        erc20Address,
        eip3009Payload,
        requirements,
        requirements.amount,
      );
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
 * @returns Promise resolving to settlement response
 */
export async function settleEIP3009(
  signer: FacilitatorEvmSigner,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  eip3009Payload: ExactEIP3009Payload,
  config: EIP3009FacilitatorConfig,
): Promise<SettleResponse> {
  const payer = eip3009Payload.authorization.from;

  // Re-verify before settling
  const valid = await verifyEIP3009(signer, payload, requirements, eip3009Payload, {
    simulate: config.simulateInSettle ?? false,
  });
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
    // Parse ERC-6492 signature if applicable (for optional deployment)
    const { address: factoryAddress, data: factoryCalldata } = parseErc6492Signature(
      eip3009Payload.signature!,
    );

    // Deploy ERC-4337 smart wallet via EIP-6492 if configured and needed
    if (
      config.deployERC4337WithEIP6492 &&
      factoryAddress &&
      factoryCalldata &&
      !isAddressEqual(factoryAddress, "0x0000000000000000000000000000000000000000")
    ) {
      // Check if smart wallet is already deployed
      const bytecode = await signer.getCode({ address: payer });

      if (!bytecode || bytecode === "0x") {
        // Wallet not deployed - attempt deployment
        const deployTx = await signer.sendTransaction({
          to: factoryAddress as Hex,
          data: factoryCalldata as Hex,
        });

        // Wait for deployment transaction
        await signer.waitForTransactionReceipt({ hash: deployTx });
      }
    }

    const tx = await executeTransferWithAuthorization(
      signer,
      getAddress(requirements.asset),
      eip3009Payload,
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
  } catch {
    return {
      success: false,
      errorReason: Errors.ErrTransactionFailed,
      transaction: "",
      network: payload.accepted.network,
      payer,
    };
  }
}
