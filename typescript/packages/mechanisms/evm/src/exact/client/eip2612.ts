import { getAddress } from "viem";
import { eip2612PermitTypes, eip2612NoncesAbi, PERMIT2_ADDRESS } from "../../constants";
import { ClientEvmSigner } from "../../signer";
import type { Eip2612GasSponsoringInfo } from "../extensions";

export type Eip2612PermitSigner = Pick<ClientEvmSigner, "address" | "signTypedData"> & {
  readContract: NonNullable<ClientEvmSigner["readContract"]>;
};

/**
 * Signs an EIP-2612 permit authorizing the Permit2 contract to spend tokens.
 *
 * This creates a gasless off-chain signature that the facilitator can submit
 * on-chain via `x402Permit2Proxy.settleWithPermit()`.
 *
 * The `permittedAmount` must match the Permit2 `permitted.amount` exactly, as the
 * proxy contract enforces `permit2612.value == permittedAmount`.
 *
 * @param signer - The client EVM signer (must support readContract for nonce query)
 * @param tokenAddress - The ERC-20 token contract address
 * @param tokenName - The token name (from paymentRequirements.extra.name)
 * @param tokenVersion - The token version (from paymentRequirements.extra.version)
 * @param chainId - The chain ID
 * @param deadline - The deadline for the permit (unix timestamp as string)
 * @param permittedAmount - The Permit2 permitted amount (must match exactly)
 * @returns The EIP-2612 gas sponsoring info object
 */
export async function signEip2612Permit(
  signer: Eip2612PermitSigner,
  tokenAddress: `0x${string}`,
  tokenName: string,
  tokenVersion: string,
  chainId: number,
  deadline: string,
  permittedAmount: string,
): Promise<Eip2612GasSponsoringInfo> {
  const owner = signer.address;
  const spender = getAddress(PERMIT2_ADDRESS);

  // Query the current EIP-2612 nonce from the token contract
  const nonce = (await signer.readContract({
    address: tokenAddress,
    abi: eip2612NoncesAbi,
    functionName: "nonces",
    args: [owner],
  })) as bigint;

  // Construct EIP-712 domain for the token's permit function
  const domain = {
    name: tokenName,
    version: tokenVersion,
    chainId,
    verifyingContract: tokenAddress,
  };

  const approvalAmount = BigInt(permittedAmount);

  const message = {
    owner,
    spender,
    value: approvalAmount,
    nonce,
    deadline: BigInt(deadline),
  };

  // Sign the EIP-2612 permit
  const signature = await signer.signTypedData({
    domain,
    types: eip2612PermitTypes,
    primaryType: "Permit",
    message,
  });

  return {
    from: owner,
    asset: tokenAddress,
    spender,
    amount: approvalAmount.toString(),
    nonce: nonce.toString(),
    deadline,
    signature,
    version: "1",
  };
}
