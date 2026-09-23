/**
 * Payload for shielded EVM payments.
 *
 * The client unshields tokens from a privacy pool directly to the payTo address.
 * The txHash is the on-chain transaction that the facilitator verifies.
 */
export type ShieldedPayload = {
  txHash: `0x${string}`;
  nullifiers?: string[];
};

/**
 * Function that performs the on-chain unshield operation.
 * Injected by the client — not tied to any specific privacy pool SDK.
 */
export type UnshieldFn = (
  token: string,
  amount: string,
  to: string,
  network: string,
) => Promise<{ txHash: `0x${string}` }>;

/**
 * Minimal provider interface for fetching transaction receipts.
 * Compatible with viem's PublicClient.
 */
export type ShieldedProvider = {
  getTransactionReceipt(args: {
    hash: `0x${string}`;
  }): Promise<TransactionReceipt | null>;
};

export type TransactionReceipt = {
  status: "success" | "reverted";
  logs: Array<{
    address: string;
    topics: string[];
    data: string;
  }>;
};

/**
 * Replay store interface — tracks used txHashes to prevent reuse.
 */
export type ReplayStore = {
  has(key: string): boolean | Promise<boolean>;
  add(key: string): void | Promise<void>;
};

/**
 * Configuration for the shielded facilitator.
 */
export type ShieldedFacilitatorConfig = {
  provider: ShieldedProvider;
  poolContracts: Record<number, string[]>;
  replayStore?: ReplayStore;
};

/**
 * Configuration for the shielded server.
 */
export type ShieldedServerConfig = {
  poolContracts: Record<number, string[]>;
  defaultDecimals?: number;
};
