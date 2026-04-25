import type { Address, Client, Chain, Transport, Account } from "viem";

/**
 * Minimal ERC-20 ABI covering the read-only methods used by the paywall.
 */
const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

/**
 * Gets the ERC-20 token balance for the given owner address.
 * Returns 0n on any read failure so the paywall UI can degrade gracefully.
 *
 * @param client - Viem client instance connected to the blockchain
 * @param tokenAddress - The ERC-20 contract address
 * @param ownerAddress - The address whose balance to look up
 * @returns Balance in atomic units (0n on error)
 */
export async function getTokenBalance<
  TTransport extends Transport,
  TChain extends Chain,
  TAccount extends Account | undefined = undefined,
>(
  client: Client<TTransport, TChain, TAccount>,
  tokenAddress: Address,
  ownerAddress: Address,
): Promise<bigint> {
  try {
    const balance = await client.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [ownerAddress],
    });
    return balance as bigint;
  } catch (error) {
    console.error("Failed to fetch token balance:", error);
    return 0n;
  }
}

/**
 * Reads the ERC-20 `decimals()` precision from the token contract.
 * Falls back to 6 (USDC standard) on any read failure so the paywall keeps rendering.
 *
 * @param client - Viem client instance connected to the blockchain
 * @param tokenAddress - The ERC-20 contract address
 * @returns The token's decimal precision (6 on error)
 */
export async function getTokenDecimals<
  TTransport extends Transport,
  TChain extends Chain,
  TAccount extends Account | undefined = undefined,
>(client: Client<TTransport, TChain, TAccount>, tokenAddress: Address): Promise<number> {
  try {
    const decimals = await client.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "decimals",
    });
    return Number(decimals);
  } catch (error) {
    console.error("Failed to fetch token decimals:", error);
    return 6;
  }
}
