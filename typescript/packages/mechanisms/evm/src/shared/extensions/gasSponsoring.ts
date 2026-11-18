import type {
  PaymentRequirements,
  PaymentPayloadResult,
  PaymentPayloadContext,
} from "@x402/core/types";
import {
  EIP2612_GAS_SPONSORING_KEY,
  ERC20_APPROVAL_GAS_SPONSORING_KEY,
} from "../../exact/extensions";
import { getAddress } from "viem";
import { PERMIT2_ADDRESS, erc20AllowanceAbi } from "../../constants";
import { getEvmChainId } from "../../utils";
import { ClientEvmSigner } from "../../signer";
import { signEip2612Permit } from "../../exact/client/eip2612";
import { signErc20ApprovalTransaction } from "../../exact/client/erc20approval";
import { resolveExtensionRpcCapabilities, type EvmSchemeOptions } from "../rpc";

const warnedNetworks = new Set<string>();

/**
 * Warns, once per network per process, that gas sponsoring was advertised but
 * cannot be used because the client cannot read the chain.
 *
 * Without `readContract` on the signer or an `rpcUrl` in the scheme options the
 * payload goes out without the sponsored permit/approval, and a fresh wallet
 * gets `412 permit2_allowance_required` from the facilitator with nothing in
 * the client to say why. Warned rather than thrown so an existing integration
 * keeps its current behaviour; the fix is one of the two named in the message.
 *
 * @param network - The CAIP-2 network the payment requirements are for
 */
function warnCannotReadForSponsoring(network: string): void {
  if (warnedNetworks.has(network)) return;
  warnedNetworks.add(network);
  console.warn(
    `[x402] gas sponsoring is advertised for ${network} but the client cannot read the chain, ` +
      "so the sponsored permit/approval will not be signed and a fresh wallet will get " +
      "412 permit2_allowance_required. Pass { rpcUrl } to ExactEvmScheme, or use a signer " +
      "with readContract (e.g. toClientEvmSigner(account, publicClient)).",
  );
}

/**
 * Clears the once-per-network warning state. Test hook.
 *
 * @internal
 */
export function _resetSponsoringWarnings(): void {
  warnedNetworks.clear();
}

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
  options: EvmSchemeOptions | undefined,
  requirements: PaymentRequirements,
  result: PaymentPayloadResult,
  context?: PaymentPayloadContext,
  approvalAmount?: string,
): Promise<Record<string, unknown> | undefined> {
  if (!context?.extensions?.[EIP2612_GAS_SPONSORING_KEY]) {
    return undefined;
  }

  const capabilities = resolveExtensionRpcCapabilities(requirements.network, signer, options);

  if (!capabilities.readContract) {
    // The server advertised sponsoring and the client would sign the permit,
    // but it cannot read `allowance`/`nonces`: the signer has no `readContract`
    // and no `rpcUrl` was configured. Returning silently here sends a payload
    // without the permit, and the facilitator answers 412
    // permit2_allowance_required with nothing to say why.
    warnCannotReadForSponsoring(requirements.network);
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
  options: EvmSchemeOptions | undefined,
  requirements: PaymentRequirements,
  context?: PaymentPayloadContext,
  approvalAmount?: string,
): Promise<Record<string, unknown> | undefined> {
  if (!context?.extensions?.[ERC20_APPROVAL_GAS_SPONSORING_KEY]) {
    return undefined;
  }

  const capabilities = resolveExtensionRpcCapabilities(requirements.network, signer, options);

  if (!capabilities.readContract) {
    warnCannotReadForSponsoring(requirements.network);
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
