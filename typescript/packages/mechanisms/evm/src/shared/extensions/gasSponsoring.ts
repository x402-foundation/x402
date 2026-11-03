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
import { ClientEvmSigner, EvmRpcNotConfiguredError } from "../../signer";
import { signEip2612Permit } from "../../exact/client/eip2612";
import { signErc20ApprovalTransaction } from "../../exact/client/erc20approval";

const warnedNetworks = new Set<string>();

/**
 * Warns, once per network per process, that gas sponsoring was advertised but
 * cannot be used because the client cannot read the chain.
 *
 * Without a signer that reads this network the payload goes out without the
 * sponsored permit/approval, and a fresh wallet gets
 * `412 permit2_allowance_required` from the facilitator with nothing in the
 * client to say why. Warned rather than thrown so an existing integration
 * keeps its current behaviour; the fix is named in the message.
 *
 * @param network - The CAIP-2 network the payment requirements are for
 */
function warnCannotReadForSponsoring(network: string): void {
  if (warnedNetworks.has(network)) return;
  warnedNetworks.add(network);
  console.warn(
    `[x402] gas sponsoring is advertised for ${network} but the client cannot read the chain, ` +
      "so the sponsored permit/approval will not be signed and a fresh wallet will get " +
      "412 permit2_allowance_required. Give the signer an RPC for this network with " +
      "toClientEvmSigner(account, rpc).",
  );
}

/**
 * Reads the payer's Permit2 allowance for the sponsored token.
 *
 * @param readContract - The signer's `readContract`
 * @param owner - The payer address
 * @param requirements - The payment requirements naming network and asset
 * @returns The allowance, `"unreadable"` when the signer has no RPC for the network,
 *   or `undefined` when the read failed for another reason
 */
async function readPermit2Allowance(
  readContract: NonNullable<ClientEvmSigner["readContract"]>,
  owner: `0x${string}`,
  requirements: PaymentRequirements,
): Promise<bigint | "unreadable" | undefined> {
  try {
    return (await readContract(
      {
        address: getAddress(requirements.asset),
        abi: erc20AllowanceAbi,
        functionName: "allowance",
        args: [owner, PERMIT2_ADDRESS],
      },
      requirements.network,
    )) as bigint;
  } catch (error) {
    if (error instanceof EvmRpcNotConfiguredError) {
      return "unreadable";
    }
    // Any other allowance failure proceeds with signing.
    return undefined;
  }
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
 * @param requirements - The payment requirements from the server
 * @param result - The payment payload result from the scheme
 * @param context - Optional context containing server extensions and metadata
 * @param approvalAmount - Optional amount to approve instead of `requirements.amount`
 * @returns Extension data for EIP-2612 gas sponsoring, or undefined if not applicable
 */
export async function trySignEip2612PermitExtension(
  signer: ClientEvmSigner,
  requirements: PaymentRequirements,
  result: PaymentPayloadResult,
  context?: PaymentPayloadContext,
  approvalAmount?: string,
): Promise<Record<string, unknown> | undefined> {
  if (!context?.extensions?.[EIP2612_GAS_SPONSORING_KEY]) {
    return undefined;
  }

  const readContract = signer.readContract;
  if (!readContract) {
    // The server advertised sponsoring and the client would sign the permit,
    // but it cannot read `allowance`/`nonces`: the signer has no `readContract`.
    // Returning silently here sends a payload without the permit, and the
    // facilitator answers 412 permit2_allowance_required with nothing to say why.
    warnCannotReadForSponsoring(requirements.network);
    return undefined;
  }

  const tokenName = requirements.extra?.name as string | undefined;
  const tokenVersion = requirements.extra?.version as string | undefined;
  if (!tokenName || !tokenVersion) {
    return undefined;
  }

  const requiredAllowance = approvalAmount ?? requirements.amount;
  const allowance = await readPermit2Allowance(readContract, signer.address, requirements);
  if (allowance === "unreadable") {
    warnCannotReadForSponsoring(requirements.network);
    return undefined;
  }
  if (allowance !== undefined && allowance >= BigInt(requiredAllowance)) {
    return undefined;
  }

  const permit2Auth = result.payload?.permit2Authorization as Record<string, unknown> | undefined;
  const deadline =
    (permit2Auth?.deadline as string) ??
    Math.floor(Date.now() / 1000 + requirements.maxTimeoutSeconds).toString();

  const info = await signEip2612Permit(
    {
      address: signer.address,
      signTypedData: msg => signer.signTypedData(msg),
      readContract,
    },
    getAddress(requirements.asset),
    tokenName,
    tokenVersion,
    requirements.network,
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
 * @param requirements - The payment requirements from the server
 * @param context - Optional context containing server extensions and metadata
 * @param approvalAmount - Optional amount to check for Permit2 allowance
 * @returns Extension data for ERC-20 approval gas sponsoring, or undefined if not applicable
 */
export async function trySignErc20ApprovalExtension(
  signer: ClientEvmSigner,
  requirements: PaymentRequirements,
  context?: PaymentPayloadContext,
  approvalAmount?: string,
): Promise<Record<string, unknown> | undefined> {
  if (!context?.extensions?.[ERC20_APPROVAL_GAS_SPONSORING_KEY]) {
    return undefined;
  }

  const { readContract, signTransaction, getTransactionCount, estimateFeesPerGas } = signer;
  if (!readContract) {
    warnCannotReadForSponsoring(requirements.network);
    return undefined;
  }

  if (!signTransaction || !getTransactionCount) {
    return undefined;
  }

  const requiredAllowance = approvalAmount ?? requirements.amount;
  const allowance = await readPermit2Allowance(readContract, signer.address, requirements);
  if (allowance === "unreadable") {
    warnCannotReadForSponsoring(requirements.network);
    return undefined;
  }
  if (allowance !== undefined && allowance >= BigInt(requiredAllowance)) {
    return undefined;
  }

  const info = await signErc20ApprovalTransaction(
    {
      address: signer.address,
      signTransaction,
      getTransactionCount,
      estimateFeesPerGas,
    },
    getAddress(requirements.asset),
    requirements.network,
  );

  return {
    [ERC20_APPROVAL_GAS_SPONSORING_KEY]: { info },
  };
}
