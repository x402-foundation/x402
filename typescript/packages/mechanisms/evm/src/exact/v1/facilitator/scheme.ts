import {
  PaymentPayload,
  PaymentPayloadV1,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { PaymentRequirementsV1 } from "@x402/core/types/v1";
import { getAddress, Hex, isAddressEqual, parseErc6492Signature } from "viem";
import { authorizationTypes } from "../../../constants";
import { FacilitatorEvmSigner } from "../../../signer";
import { ExactEvmPayloadV1 } from "../../../types";
import { EvmNetworkV1, getEvmChainIdV1 } from "../../../v1";
import * as Errors from "../../facilitator/errors";
import {
  diagnoseEip3009SimulationFailure,
  executeTransferWithAuthorization,
  simulateEip3009Transfer,
} from "../../facilitator/eip3009-utils";

export interface VerifyV1Options {
  /** Run onchain simulation. Defaults to true. */
  simulate?: boolean;
}

export interface ExactEvmSchemeV1Config {
  /**
   * If enabled, the facilitator will deploy ERC-4337 smart wallets
   * via EIP-6492 when encountering undeployed contract signatures.
   *
   * @default false
   */
  deployERC4337WithEIP6492?: boolean;
  /**
   * If enabled, simulates transaction before settling. Defaults to false, ie only simulate during verify.
   *
   * @default false
   */
  simulateInSettle?: boolean;
}

/**
 * EVM facilitator implementation for the Exact payment scheme (V1).
 */
export class ExactEvmSchemeV1 implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = "eip155:*";
  private readonly config: Required<ExactEvmSchemeV1Config>;

  /**
   * Creates a new ExactEvmFacilitatorV1 instance.
   *
   * @param signer - The EVM signer for facilitator operations
   * @param config - Optional configuration for the facilitator
   */
  constructor(
    private readonly signer: FacilitatorEvmSigner,
    config?: ExactEvmSchemeV1Config,
  ) {
    this.config = {
      deployERC4337WithEIP6492: config?.deployERC4337WithEIP6492 ?? false,
      simulateInSettle: config?.simulateInSettle ?? false,
    };
  }

  /**
   * Get mechanism-specific extra data for the supported kinds endpoint.
   * For EVM, no extra data is needed.
   *
   * @param _ - The network identifier (unused for EVM)
   * @returns undefined (EVM has no extra data)
   */
  getExtra(_: string): Record<string, unknown> | undefined {
    return undefined;
  }

  /**
   * Get signer addresses used by this facilitator.
   * Returns all addresses this facilitator can use for signing/settling transactions.
   *
   * @param _ - The network identifier (unused for EVM, addresses are network-agnostic)
   * @returns Array of facilitator wallet addresses
   */
  getSigners(_: string): string[] {
    return [...this.signer.getAddresses()];
  }

  /**
   * Verifies a payment payload (V1).
   *
   * @param payload - The payment payload to verify
   * @param requirements - The payment requirements
   * @returns Promise resolving to verification response
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    return this._verify(payload, requirements);
  }

  /**
   * Settles a payment by executing the transfer (V1).
   *
   * @param payload - The payment payload to settle
   * @param requirements - The payment requirements
   * @returns Promise resolving to settlement response
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const payloadV1 = payload as unknown as PaymentPayloadV1;
    const exactEvmPayload = payload.payload as ExactEvmPayloadV1;

    // Re-verify before settling
    const valid = await this._verify(payload, requirements, {
      simulate: this.config.simulateInSettle ?? false,
    });
    if (!valid.isValid) {
      return {
        success: false,
        network: payloadV1.network,
        transaction: "",
        errorReason: valid.invalidReason ?? Errors.ErrInvalidScheme,
        payer: exactEvmPayload.authorization.from,
      };
    }

    try {
      // Parse ERC-6492 signature if applicable (for optional deployment)
      const { address: factoryAddress, data: factoryCalldata } = parseErc6492Signature(
        exactEvmPayload.signature!,
      );

      // Deploy ERC-4337 smart wallet via EIP-6492 if configured and needed
      if (
        this.config.deployERC4337WithEIP6492 &&
        factoryAddress &&
        factoryCalldata &&
        !isAddressEqual(factoryAddress, "0x0000000000000000000000000000000000000000")
      ) {
        // Check if smart wallet is already deployed
        const payerAddress = exactEvmPayload.authorization.from;
        const bytecode = await this.signer.getCode({ address: payerAddress });

        if (!bytecode || bytecode === "0x") {
          // Send the factory calldata directly as a transaction
          // The factoryCalldata already contains the complete encoded function call
          const deployTx = await this.signer.sendTransaction({
            to: factoryAddress as Hex,
            data: factoryCalldata as Hex,
          });

          // Wait for deployment transaction
          await this.signer.waitForTransactionReceipt({ hash: deployTx });
        }
      }

      const tx = await executeTransferWithAuthorization(
        this.signer,
        getAddress(requirements.asset),
        exactEvmPayload,
      );

      // Wait for transaction confirmation
      const receipt = await this.signer.waitForTransactionReceipt({ hash: tx });

      if (receipt.status !== "success") {
        return {
          success: false,
          errorReason: Errors.ErrTransactionFailed,
          transaction: tx,
          network: payloadV1.network,
          payer: exactEvmPayload.authorization.from,
        };
      }

      return {
        success: true,
        transaction: tx,
        network: payloadV1.network,
        payer: exactEvmPayload.authorization.from,
      };
    } catch (error) {
      return {
        success: false,
        errorReason: error instanceof Error ? error.message : Errors.ErrTransactionFailed,
        transaction: "",
        network: payloadV1.network,
        payer: exactEvmPayload.authorization.from,
      };
    }
  }

  /**
   * Internal verify with optional simulation control.
   *
   * @param payload - The payment payload to verify
   * @param requirements - The payment requirements
   * @param options - Verification options (e.g. simulate)
   * @returns Promise resolving to verification response
   */
  private async _verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    options?: VerifyV1Options,
  ): Promise<VerifyResponse> {
    const requirementsV1 = requirements as unknown as PaymentRequirementsV1;
    const payloadV1 = payload as unknown as PaymentPayloadV1;
    const exactEvmPayload = payload.payload as ExactEvmPayloadV1;
    const payer = exactEvmPayload.authorization.from;
    let eip6492Deployment:
      | { factoryAddress: `0x${string}`; factoryCalldata: `0x${string}` }
      | undefined;

    // Verify scheme matches
    if (payloadV1.scheme !== "exact" || requirements.scheme !== "exact") {
      return {
        isValid: false,
        invalidReason: Errors.ErrInvalidScheme,
        payer,
      };
    }

    // Get chain configuration
    let chainId: number;
    try {
      chainId = getEvmChainIdV1(payloadV1.network as EvmNetworkV1);
    } catch {
      return {
        isValid: false,
        invalidReason: Errors.ErrNetworkMismatch,
        payer,
      };
    }

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
    if (payloadV1.network !== requirements.network) {
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
        chainId,
        verifyingContract: erc20Address,
      },
      message: {
        from: exactEvmPayload.authorization.from,
        to: exactEvmPayload.authorization.to,
        value: BigInt(exactEvmPayload.authorization.value),
        validAfter: BigInt(exactEvmPayload.authorization.validAfter),
        validBefore: BigInt(exactEvmPayload.authorization.validBefore),
        nonce: exactEvmPayload.authorization.nonce,
      },
    };

    // Verify signature (flatten EIP-6492 handling out of catch block)
    let isValid = false;
    try {
      isValid = await this.signer.verifyTypedData({
        address: payer,
        ...permitTypedData,
        signature: exactEvmPayload.signature!,
      });
    } catch {
      isValid = false;
    }

    const signature = exactEvmPayload.signature!;
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
      const isSmartWallet = sigLen > 130; // 65 bytes = 130 hex chars for EOA

      if (!isSmartWallet) {
        return {
          isValid: false,
          invalidReason: Errors.ErrInvalidSignature,
          payer,
        };
      }

      const bytecode = await this.signer.getCode({ address: payer });
      const isDeployed = bytecode && bytecode !== "0x";

      if (!isDeployed && !hasDeploymentInfo) {
        return {
          isValid: false,
          invalidReason: Errors.ErrUndeployedSmartWallet,
          payer,
        };
      }
    }

    // Verify payment recipient matches
    if (getAddress(exactEvmPayload.authorization.to) !== getAddress(requirements.payTo)) {
      return {
        isValid: false,
        invalidReason: Errors.ErrRecipientMismatch,
        payer,
      };
    }

    // Verify validBefore is in the future (with 6 second buffer for block time)
    const now = Math.floor(Date.now() / 1000);
    if (BigInt(exactEvmPayload.authorization.validBefore) < BigInt(now + 6)) {
      return {
        isValid: false,
        invalidReason: Errors.ErrValidBeforeExpired,
        payer,
      };
    }

    // Verify validAfter is not in the future
    if (BigInt(exactEvmPayload.authorization.validAfter) > BigInt(now)) {
      return {
        isValid: false,
        invalidReason: Errors.ErrValidAfterInFuture,
        payer,
      };
    }

    // Verify amount exactly matches requirements
    if (BigInt(exactEvmPayload.authorization.value) !== BigInt(requirementsV1.maxAmountRequired)) {
      return {
        isValid: false,
        invalidReason: Errors.ErrInvalidAuthorizationValue,
        payer,
      };
    }

    // Transaction simulation
    if (options?.simulate !== false) {
      const simulationSucceeded = await simulateEip3009Transfer(
        this.signer,
        erc20Address,
        exactEvmPayload,
        eip6492Deployment,
      );
      if (!simulationSucceeded) {
        return diagnoseEip3009SimulationFailure(
          this.signer,
          erc20Address,
          exactEvmPayload,
          requirements,
          requirementsV1.maxAmountRequired,
        );
      }
    }

    return {
      isValid: true,
      invalidReason: undefined,
      payer,
    };
  }
}
