import { Account, Address, Chain, Client, Transport } from "viem";
import { ChainConfig, config } from "../../types/shared/evm/config";
import { usdcABI as abi } from "../../types/shared/evm/erc20PermitABI";
import { ConnectedClient } from "../../types/shared/evm/wallet";

/**
 * Gets the USDC contract address for the current chain from the client
 *
 * @param client - The Viem client instance connected to the blockchain
 * @returns The USDC contract address for the current chain
 */
export function getUsdcAddress<
  transport extends Transport,
  chain extends Chain | undefined = undefined,
  account extends Account | undefined = undefined,
>(client: Client<transport, chain, account>): Address {
  return config[client.chain!.id.toString()].usdcAddress as Address;
}

/**
 * Gets the USDC contract address for a specific chain ID
 *
 * @deprecated Use `getUsdcChainConfigForChain` instead
 * @param chainId - The chain ID to get the USDC contract address for
 * @returns The USDC contract address for the specified chain
 */
export function getUsdcAddressForChain(chainId: number): Address {
  return config[chainId.toString()].usdcAddress as Address;
}

/**
 * Gets the USDC address and eip712 domain name for a specific chain ID
 *
 * @param chainId - The chain ID
 * @returns The USDC contract address and eip712 domain name  for the specified chain
 */
export function getUsdcChainConfigForChain(chainId: number): ChainConfig | undefined {
  return config[chainId.toString()];
}

// Cache for storing the version value
let versionCache: string | null = null;

/**
 * Gets the version of the USDC contract, using a cache to avoid repeated calls
 *
 * @param client - The Viem client instance connected to the blockchain
 * @returns A promise that resolves to the USDC contract version string
 */
export async function getVersion<
  transport extends Transport,
  chain extends Chain,
  account extends Account | undefined = undefined,
>(client: ConnectedClient<transport, chain, account>): Promise<string> {
  // Return cached version if available
  if (versionCache !== null) {
    return versionCache;
  }

  // Fetch and cache version if not available
  const version = await client.readContract({
    address: getUsdcAddress(client),
    abi,
    functionName: "version",
  });
  versionCache = version as string;
  return versionCache;
}

/**
 * Gets the USDC balance for a specific address
 *
 * @param client - The Viem client instance connected to the blockchain
 * @param address - The address to check the USDC balance for
 * @returns A promise that resolves to the USDC balance as a bigint
 */
export async function getUSDCBalance<
  transport extends Transport,
  chain extends Chain,
  account extends Account | undefined = undefined,
>(client: ConnectedClient<transport, chain, account>, address: Address): Promise<bigint> {
  const chainId = client.chain!.id;
  const usdc = getUsdcChainConfigForChain(chainId);
  if (!usdc) {
    return 0n;
  }
  const balance = await client.readContract({
    address: usdc.usdcAddress as `0x${string}`,
    abi,
    functionName: "balanceOf",
    args: [address],
  });
  return balance as bigint;
}
