import type { Address, Client, Chain, Transport, Account } from "viem";

/**
 * ERC20 ABI for balance and decimal queries
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
    outputs: [{ name: "decimals", type: "uint8" }],
  },
] as const;

/**
 * Gets the token balance for a specific address.
 *
 * @param client - Viem client instance connected to the blockchain
 * @param owner - Address to check the balance for
 * @param tokenAddress - ERC-20 token contract address
 * @returns Token balance as bigint (0 on error)
 */
export async function getTokenBalance<
  TTransport extends Transport,
  TChain extends Chain,
  TAccount extends Account | undefined = undefined,
>(
  client: Client<TTransport, TChain, TAccount>,
  owner: Address,
  tokenAddress: Address,
): Promise<bigint> {
  try {
    const balance = await client.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [owner],
    });
    return balance as bigint;
  } catch (error) {
    console.error("Failed to fetch token balance:", error);
    return 0n;
  }
}

/**
 * Gets the token decimals from the on-chain contract.
 * Falls back to 6 (USDC default) if the query fails.
 *
 * @param client - Viem client instance connected to the blockchain
 * @param tokenAddress - ERC-20 token contract address
 * @returns Token decimals (defaults to 6 on error)
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
