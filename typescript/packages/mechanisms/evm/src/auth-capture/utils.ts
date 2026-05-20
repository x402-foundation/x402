/**
 * Parse chainId from CAIP-2 network identifier
 *
 * @param network - CAIP-2 network identifier (e.g., 'eip155:84532')
 * @returns The chain ID as a number
 */
export function parseChainId(network: string): number {
  const parts = network.split(":");
  if (parts.length !== 2 || parts[0] !== "eip155") {
    throw new Error(`Invalid network format: ${network}. Expected 'eip155:<chainId>'`);
  }
  const chainId = parseInt(parts[1], 10);
  if (isNaN(chainId)) {
    throw new Error(`Invalid chainId in network: ${network}`);
  }
  return chainId;
}
