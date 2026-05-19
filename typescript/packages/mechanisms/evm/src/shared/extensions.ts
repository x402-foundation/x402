import type {
  FacilitatorContext,
  FacilitatorExtension,
  PaymentPayload,
  PaymentRequirements,
  PaymentPayloadResult,
  PaymentPayloadContext,
} from "@x402/core/types";
import { EIP2612_GAS_SPONSORING_KEY, ERC20_APPROVAL_GAS_SPONSORING_KEY } from "../exact/extensions";
import { getAddress, type Hex } from "viem";
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

export const BUILDER_CODE_KEY = "builder-code" as const;

export interface SettlementCalldataContext {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
  paymentRequiredExtensions?: Record<string, unknown>;
}

export interface BuilderCodeFacilitatorExtension extends FacilitatorExtension {
  key: typeof BUILDER_CODE_KEY;
  buildSettlementCalldataSuffix?(
    ctx: SettlementCalldataContext,
  ): Hex | undefined | Promise<Hex | undefined>;
}

type CalldataContributorResolver = (
  context: FacilitatorContext,
  ctx: SettlementCalldataContext,
) => Promise<Hex | undefined>;

const BUILDER_CODE_RESOLVER: CalldataContributorResolver = async (context, ctx) => {
  const ext = context.getExtension<BuilderCodeFacilitatorExtension>(BUILDER_CODE_KEY);
  if (!ext?.buildSettlementCalldataSuffix) {
    return undefined;
  }

  return ext.buildSettlementCalldataSuffix(ctx);
};

const CALDATA_RESOLVERS: CalldataContributorResolver[] = [BUILDER_CODE_RESOLVER];

/**
 * Resolves and concatenates settlement calldata suffixes from registered extensions.
 *
 * @param context - Facilitator context with registered extensions
 * @param ctx - Settlement calldata context passed to extension resolvers
 * @returns Hex-encoded suffix to append to settlement calldata, or undefined if none
 */
export async function resolveSettlementCalldataSuffix(
  context: FacilitatorContext | undefined,
  ctx: SettlementCalldataContext,
): Promise<Hex | undefined> {
  if (!context) {
    return undefined;
  }

  const parts: Hex[] = [];
  for (const resolver of CALDATA_RESOLVERS) {
    const suffix = await resolver(context, ctx);
    if (suffix && suffix !== "0x" && suffix.length > 2) {
      parts.push(suffix);
    }
  }

  if (parts.length === 0) {
    return undefined;
  }

  if (parts.length === 1) {
    return parts[0];
  }

  return parts.reduce((acc, part, index) => {
    if (index === 0) {
      return part;
    }
    const stripped = part.startsWith("0x") ? part.slice(2) : part;
    return `${acc}${stripped}` as Hex;
  });
}

/**
 * Appends a hex suffix to encoded contract calldata.
 *
 * @param calldata - Base encoded function calldata
 * @param suffix - Optional hex suffix (with or without 0x prefix)
 * @returns Calldata with suffix appended, or the original calldata when suffix is empty
 */
export function appendCalldataSuffix(calldata: Hex, suffix?: Hex): Hex {
  if (!suffix || suffix === "0x" || suffix.length <= 2) {
    return calldata;
  }
  const suffixHex = suffix.startsWith("0x") ? suffix.slice(2) : suffix;
  return `${calldata}${suffixHex}` as Hex;
}
