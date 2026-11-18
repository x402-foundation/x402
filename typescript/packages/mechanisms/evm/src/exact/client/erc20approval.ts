import { encodeFunctionData, getAddress, maxUint256 } from "viem";
import {
  PERMIT2_ADDRESS,
  erc20ApproveAbi,
  ERC20_APPROVE_GAS_LIMIT,
  DEFAULT_MAX_FEE_PER_GAS,
  DEFAULT_MAX_PRIORITY_FEE_PER_GAS,
} from "../../constants";
import { ClientEvmSigner } from "../../signer";
import {
  ERC20_APPROVAL_GAS_SPONSORING_VERSION,
  type Erc20ApprovalGasSponsoringInfo,
} from "../extensions";

export type Erc20ApprovalTxSigner = Pick<ClientEvmSigner, "address"> & {
  signTransaction: NonNullable<ClientEvmSigner["signTransaction"]>;
  getTransactionCount: NonNullable<ClientEvmSigner["getTransactionCount"]>;
  estimateFeesPerGas?: NonNullable<ClientEvmSigner["estimateFeesPerGas"]>;
};

/**
 * Signs an EIP-1559 `approve(Permit2, MaxUint256)` transaction for the given token.
 *
 * The signed transaction is NOT broadcast here — the facilitator broadcasts it
 * atomically before settling the Permit2 payment. This enables Permit2 payments
 * for generic ERC-20 tokens that do NOT implement EIP-2612.
 *
 * Always approves MaxUint256 regardless of the payment amount.
 *
 * @param signer - The client EVM signer (must support signTransaction, getTransactionCount)
 * @param tokenAddress - The ERC-20 token contract address
 * @param chainId - The chain ID
 * @returns The ERC-20 approval gas sponsoring info object
 */
export async function signErc20ApprovalTransaction(
  signer: Erc20ApprovalTxSigner,
  tokenAddress: `0x${string}`,
  chainId: number,
): Promise<Erc20ApprovalGasSponsoringInfo> {
  const from = signer.address;
  const spender = getAddress(PERMIT2_ADDRESS);

  // Encode approve(PERMIT2_ADDRESS, MaxUint256) calldata
  const data = encodeFunctionData({
    abi: erc20ApproveAbi,
    functionName: "approve",
    args: [spender, maxUint256],
  });

  // Get current nonce for the sender
  const nonce = await signer.getTransactionCount({ address: from });

  // Get current fee estimates, with fallback values
  let maxFeePerGas: bigint;
  let maxPriorityFeePerGas: bigint;
  try {
    const fees = await signer.estimateFeesPerGas?.();
    if (!fees) {
      throw new Error("no fee estimates available");
    }
    maxFeePerGas = fees.maxFeePerGas;
    maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
  } catch {
    maxFeePerGas = DEFAULT_MAX_FEE_PER_GAS;
    maxPriorityFeePerGas = DEFAULT_MAX_PRIORITY_FEE_PER_GAS;
  }

  // Sign the EIP-1559 transaction (not broadcast)
  const signedTransaction = await signer.signTransaction({
    to: tokenAddress,
    data,
    nonce,
    gas: ERC20_APPROVE_GAS_LIMIT,
    maxFeePerGas,
    maxPriorityFeePerGas,
    chainId,
  });

  return {
    from,
    asset: tokenAddress,
    spender,
    amount: maxUint256.toString(),
    signedTransaction,
    version: ERC20_APPROVAL_GAS_SPONSORING_VERSION,
  };
}
