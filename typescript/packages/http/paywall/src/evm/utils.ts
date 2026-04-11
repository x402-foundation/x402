import type { Address, Client, Chain, Transport, Account } from "viem";

/**
 * ERC20 token ABI fragments used by the EVM paywall.
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
 * Gets an ERC-20 token balance for a specific address on the current chain.
 *
 * @param client - Viem client instance connected to the blockchain
 * @param tokenAddress - Token contract address
 * @param address - Address to check the token balance for
 * @returns Token balance as bigint (0 if the lookup fails)
 */
export async function getTokenBalance<
  TTransport extends Transport,
  TChain extends Chain,
  TAccount extends Account | undefined = undefined,
>(
  client: Client<TTransport, TChain, TAccount>,
  tokenAddress: Address,
  address: Address,
): Promise<bigint> {
  try {
    const balance = await client.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [address],
    });
    return balance as bigint;
  } catch (error) {
    console.error("Failed to fetch token balance:", error);
    return 0n;
  }
}

/**
 * Gets the decimal precision for an ERC-20 token.
 *
 * @param client - Viem client instance connected to the blockchain
 * @param tokenAddress - Token contract address
 * @param fallbackDecimals - Decimal precision to use if the lookup fails
 * @returns Token decimals, or the fallback value when unavailable
 */
export async function getTokenDecimals<
  TTransport extends Transport,
  TChain extends Chain,
  TAccount extends Account | undefined = undefined,
>(
  client: Client<TTransport, TChain, TAccount>,
  tokenAddress: Address,
  fallbackDecimals: number = 6,
): Promise<number> {
  try {
    const decimals = await client.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "decimals",
      args: [],
    });
    return Number(decimals);
  } catch (error) {
    console.error("Failed to fetch token decimals:", error);
    return fallbackDecimals;
  }
}
