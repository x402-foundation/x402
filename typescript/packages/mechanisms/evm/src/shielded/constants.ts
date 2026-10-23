/**
 * Known privacy pool contract addresses by chain ID.
 *
 * These are the default pool contracts accepted by the facilitator.
 * Resource servers can override with their own list via extra.poolContracts.
 *
 * Currently includes Railgun relay contracts. Additional pools can be
 * registered by passing them in ShieldedFacilitatorConfig.poolContracts.
 */
export const DEFAULT_POOL_CONTRACTS: Record<number, string[]> = {
  // Base
  8453: ["0x26111e2379E5fC0A7Cd8728fe52c7b84CA4fbE85"],
  // Ethereum
  1: ["0xfa7093cdd9ee6932b4eb2c9e1cde7ce00b1fa4b9"],
  // BSC
  56: ["0x9dB0eDC77C9047a06Fd6dE82c892630DAa5eF601"],
  // Polygon
  137: ["0x19b620929f97b7b990801496c3b361ca5def8c71"],
  // Arbitrum
  42161: ["0xfa7093cdd9ee6932b4eb2c9e1cde7ce00b1fa4b9"],
};

/**
 * ERC-20 Transfer event topic (keccak256 of "Transfer(address,address,uint256)").
 */
export const TRANSFER_EVENT_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
