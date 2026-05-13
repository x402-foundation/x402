import { PaymentRequirements, PaymentPayloadResult, PaymentPayloadContext } from "@x402/core/types";
import { EIP2612_GAS_SPONSORING_KEY, ERC20_APPROVAL_GAS_SPONSORING_KEY } from "../exact/extensions";
import { getAddress } from "viem";
import { PERMIT2_ADDRESS, erc20AllowanceAbi } from "../constants";
import { getEvmChainId } from "../utils";
import { ClientEvmSigner } from "../signer";
import { signEip2612Permit } from "../exact/client/eip2612";
import { signErc20ApprovalTransaction } from "../exact/client/erc20approval";
import { resolveExtensionRpcCapabilities, type ExactEvmSchemeOptions } from "./rpc";

/**
 * Attempts to sign an EIP-2612 permit for gasless Permit2 approval.
 *
 * @param signer - The EVM client signer
 * @param options - Optional RPC configuration for backfilling capabilities
 * @param requirements - The payment requirements from the server
 * @param result - The payment payload result from the scheme
 * @param context - Optional context containing server extensions and metadata
 * @param approvalAmount - Optional amount to approve instead of `requirements.amount`
 * @returns Extension data for EIP-2612 gas sponsoring, or undefined if not applicable
 */
export async function trySignEip2612PermitExtension(
  signer: ClientEvmSigner,
  options: ExactEvmSchemeOptions | undefined,
  requirements: PaymentRequirements,
  result: PaymentPayloadResult,
  context?: PaymentPayloadContext,
  approvalAmount?: string,
): Promise<Record<string, unknown> | undefined> {
  const capabilities = resolveExtensionRpcCapabilities(requirements.network, signer, options);

  if (!capabilities.readContract) {
    return undefined;
  }

  if (!context?.extensions?.[EIP2612_GAS_SPONSORING_KEY]) {
    return undefined;
  }

  const tokenName = requirements.extra?.name as string | undefined;
  const tokenVersion = requirements.extra?.version as string | undefined;
  if (!tokenName || !tokenVersion) {
    return undefined;
  }

  const chainId = getEvmChainId(requirements.network);
  const tokenAddress = getAddress(requirements.asset) as `0x${string}`;
  const requiredAllowance = approvalAmount ?? requirements.amount;

  try {
    const allowance = (await capabilities.readContract({
      address: tokenAddress,
      abi: erc20AllowanceAbi,
      functionName: "allowance",
      args: [signer.address, PERMIT2_ADDRESS],
    })) as bigint;

    if (allowance >= BigInt(requiredAllowance)) {
      return undefined;
    }
  } catch {
    // Allowance check failed, proceed with signing
  }

  const permit2Auth = result.payload?.permit2Authorization as Record<string, unknown> | undefined;
  const deadline =
    (permit2Auth?.deadline as string) ??
    Math.floor(Date.now() / 1000 + requirements.maxTimeoutSeconds).toString();

  const info = await signEip2612Permit(
    {
      address: signer.address,
      signTypedData: msg => signer.signTypedData(msg),
      readContract: capabilities.readContract,
    },
    tokenAddress,
    tokenName,
    tokenVersion,
    chainId,
    deadline,
    requiredAllowance,
  );

  return {
    [EIP2612_GAS_SPONSORING_KEY]: { info },
  };
}

/**
 * Attempts to sign an ERC-20 approval transaction for gasless Permit2 approval.
 *
 * @param signer - The EVM client signer
 * @param options - Optional RPC configuration for backfilling capabilities
 * @param requirements - The payment requirements from the server
 * @param context - Optional context containing server extensions and metadata
 * @param approvalAmount - Optional amount to check for Permit2 allowance
 * @returns Extension data for ERC-20 approval gas sponsoring, or undefined if not applicable
 */
export async function trySignErc20ApprovalExtension(
  signer: ClientEvmSigner,
  options: ExactEvmSchemeOptions | undefined,
  requirements: PaymentRequirements,
  context?: PaymentPayloadContext,
  approvalAmount?: string,
): Promise<Record<string, unknown> | undefined> {
  const capabilities = resolveExtensionRpcCapabilities(requirements.network, signer, options);

  if (!capabilities.readContract) {
    return undefined;
  }

  if (!context?.extensions?.[ERC20_APPROVAL_GAS_SPONSORING_KEY]) {
    return undefined;
  }

  if (!capabilities.signTransaction || !capabilities.getTransactionCount) {
    return undefined;
  }

  const chainId = getEvmChainId(requirements.network);
  const tokenAddress = getAddress(requirements.asset) as `0x${string}`;
  const requiredAllowance = approvalAmount ?? requirements.amount;

  try {
    const allowance = (await capabilities.readContract({
      address: tokenAddress,
      abi: erc20AllowanceAbi,
      functionName: "allowance",
      args: [signer.address, PERMIT2_ADDRESS],
    })) as bigint;

    if (allowance >= BigInt(requiredAllowance)) {
      return undefined;
    }
  } catch {
    // Allowance check failed, proceed with signing
  }

  const info = await signErc20ApprovalTransaction(
    {
      address: signer.address,
      signTransaction: capabilities.signTransaction,
      getTransactionCount: capabilities.getTransactionCount,
      estimateFeesPerGas: capabilities.estimateFeesPerGas,
    },
    tokenAddress,
    chainId,
  );

  return {
    [ERC20_APPROVAL_GAS_SPONSORING_KEY]: { info },
  };
}
