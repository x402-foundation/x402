import type { Network } from "@x402/core/types";
import { createPublicClient, http, type Log } from "viem";
import { getEvmChainId } from "./utils";

type ReadContractArgs = {
  address: `0x${string}`;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
};

type FeesPerGas = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };

/**
 * ClientEvmSigner - Used by x402 clients to sign payment authorizations.
 *
 * Typically a viem LocalAccount:
 * ```typescript
 * const account = privateKeyToAccount('0x...');
 * ```
 *
 * Or composed with onchain reads via `toClientEvmSigner(account, rpc)`.
 *
 * Every onchain read takes the CAIP-2 `network` to read as its trailing argument.
 */
export type ClientEvmSigner = {
  readonly address: `0x${string}`;
  signTypedData(message: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<`0x${string}`>;
  /**
   * Optional onchain reads.
   * Required for extension enrichment (EIP-2612 / ERC-20 approval) and batch-settlement channel recovery.
   */
  readContract?(args: ReadContractArgs, network: Network): Promise<unknown>;
  /**
   * Optional: Signs a raw EIP-1559 transaction without broadcasting.
   * Required for ERC-20 approval gas sponsoring when the token lacks EIP-2612.
   */
  signTransaction?(args: {
    to: `0x${string}`;
    data: `0x${string}`;
    nonce: number;
    gas: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    chainId: number;
  }): Promise<`0x${string}`>;
  /**
   * Optional: Gets the current transaction count (nonce) for an address.
   * Required for ERC-20 approval gas sponsoring.
   */
  getTransactionCount?(args: { address: `0x${string}` }, network: Network): Promise<number>;
  /**
   * Optional: Estimates current gas fees per gas. Used by ERC-20 approval gas sponsoring,
   * which falls back to default fees without it.
   *
   * The leading `undefined` keeps a viem `PublicClient` assignable: its `estimateFeesPerGas`
   * takes an optional parameters object that a bare `network` string does not satisfy.
   */
  estimateFeesPerGas?(args: undefined, network: Network): Promise<FeesPerGas>;
};

/** Optional {@link ClientEvmSigner} capability a scheme can require. */
export type ClientEvmCapability =
  | "readContract"
  | "signTransaction"
  | "getTransactionCount"
  | "estimateFeesPerGas";

/**
 * Asserts that a client signer exposes every capability a component needs.
 *
 * @param signer - Client signer to validate
 * @param capabilities - Optional signer methods the component calls
 * @param label - Component name for error messages
 * @throws Error naming the first missing capability
 */
export function assertClientEvmCapabilities<C extends ClientEvmCapability>(
  signer: ClientEvmSigner,
  capabilities: readonly C[],
  label: string,
): asserts signer is ClientEvmSigner & Required<Pick<ClientEvmSigner, C>> {
  for (const method of capabilities) {
    if (typeof signer[method] !== "function") {
      throw new Error(`${label} requires ${method} on the signer.`);
    }
  }
}

/**
 * viem-like public client that {@link toClientEvmSigner} reads through.
 *
 * A defined `chain` binds the client to that chain id. An undefined `chain` cannot be
 * checked, so the client is used for every network.
 */
export type EvmRpcClient = {
  readonly chain?: { readonly id: number };
  readContract(args: ReadContractArgs): Promise<unknown>;
  getTransactionCount(args: { address: `0x${string}` }): Promise<number>;
  estimateFeesPerGas(): Promise<FeesPerGas>;
};

/** JSON-RPC endpoint that {@link toClientEvmSigner} creates a cached public client for. */
export type EvmRpcEndpoint = { rpcUrl: string };

/**
 * RPC configuration for {@link toClientEvmSigner}: a public client, one endpoint used for
 * every network, or endpoints keyed by EVM chain id.
 */
export type EvmRpcConfig = EvmRpcClient | EvmRpcEndpoint | Record<number, EvmRpcEndpoint>;

/** Thrown by a composed signer's read when its RPC configuration does not cover the network. */
export class EvmRpcNotConfiguredError extends Error {
  /**
   * Creates the error for an uncovered network.
   *
   * @param network - CAIP-2 network that was read
   * @param reason - Optional detail on why the configuration does not cover it
   */
  constructor(
    readonly network: Network,
    reason?: string,
  ) {
    super(
      `No EVM RPC is configured for ${network}${reason ? ` (${reason})` : ""}. ` +
        "Configure one with toClientEvmSigner(account, rpc).",
    );
    this.name = "EvmRpcNotConfiguredError";
  }
}

const rpcClientCache = new Map<string, EvmRpcClient>();

/**
 * Gets or creates the cached public client for an RPC URL.
 *
 * @param rpcUrl - JSON-RPC endpoint URL
 * @returns The public client for `rpcUrl`
 */
function rpcClientForUrl(rpcUrl: string): EvmRpcClient {
  const existing = rpcClientCache.get(rpcUrl);
  if (existing) {
    return existing;
  }
  const client = createPublicClient({ transport: http(rpcUrl) });
  rpcClientCache.set(rpcUrl, client);
  return client;
}

/**
 * Builds the network-to-client router for an RPC configuration.
 *
 * @param rpc - RPC configuration passed to {@link toClientEvmSigner}
 * @returns A function returning the client that serves a network
 */
function rpcClientRouter(rpc: EvmRpcConfig): (network: Network) => EvmRpcClient {
  if ("readContract" in rpc) {
    return network => {
      // Reading another chain through a chain-bound client would return that chain's state.
      if (rpc.chain !== undefined && rpc.chain.id !== getEvmChainId(network)) {
        throw new EvmRpcNotConfiguredError(
          network,
          `the public client is bound to chain ${rpc.chain.id}`,
        );
      }
      return rpc;
    };
  }
  if ("rpcUrl" in rpc) {
    const { rpcUrl } = rpc;
    return () => rpcClientForUrl(rpcUrl);
  }
  return network => {
    const endpoint: EvmRpcEndpoint | undefined = rpc[getEvmChainId(network)];
    if (!endpoint) {
      throw new EvmRpcNotConfiguredError(network);
    }
    return rpcClientForUrl(endpoint.rpcUrl);
  };
}

/**
 * FacilitatorEvmSigner - Used by x402 facilitators to verify and settle payments
 * This is typically a viem PublicClient + WalletClient combination that can
 * read contract state, verify signatures, write transactions, and wait for receipts
 *
 * Supports multiple addresses for load balancing, key rotation, and high availability
 */
export type FacilitatorEvmSigner = {
  /**
   * Get all addresses this facilitator can use for signing
   * Enables dynamic address selection for load balancing and key rotation
   */
  getAddresses(): readonly `0x${string}`[];

  readContract(args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
    account?: `0x${string}`;
  }): Promise<unknown>;
  verifyTypedData(args: {
    address: `0x${string}`;
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
    signature: `0x${string}`;
  }): Promise<boolean>;
  writeContract(args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
    gas?: bigint;
    dataSuffix?: `0x${string}`;
  }): Promise<`0x${string}`>;
  sendTransaction(args: { to: `0x${string}`; data: `0x${string}` }): Promise<`0x${string}`>;
  waitForTransactionReceipt(args: {
    hash: `0x${string}`;
    /** Milliseconds to wait before giving up; set by {@link toFacilitatorEvmSigner}. */
    timeout?: number;
  }): Promise<{
    status: string;
    logs?: readonly Log[];
  }>;
  getCode(args: { address: `0x${string}` }): Promise<`0x${string}` | undefined>;
  simulateCalls?(args: {
    account: `0x${string}`;
    calls: readonly {
      to: `0x${string}`;
      data?: `0x${string}`;
      abi?: readonly unknown[];
      functionName?: string;
      args?: readonly unknown[];
      gas?: bigint;
    }[];
  }): Promise<{
    results: readonly {
      status: "success" | "failure";
      result?: unknown;
      logs?: readonly Log[];
      data?: `0x${string}`;
      gasUsed?: bigint;
    }[];
  }>;
};

/**
 * Composes a ClientEvmSigner from a signer and the RPC that serves its onchain reads.
 *
 * This is the one place client RPC is configured. Use it when your signer
 * (e.g., `privateKeyToAccount`) cannot read the chain. The signer's own
 * `readContract`, `getTransactionCount` and `estimateFeesPerGas` take precedence
 * over `rpc`. Reads route by their `network` argument: a public client bound to
 * another chain, or a chain-id map without an entry for the network, throws
 * {@link EvmRpcNotConfiguredError} instead of reading.
 *
 * @param signer - A signer with `address` and `signTypedData`, and optionally its own reads
 * @param rpc - A viem public client, `{ rpcUrl }` for every network, or `{ [chainId]: { rpcUrl } }`
 * @returns A ClientEvmSigner with any available optional capabilities
 *
 * @example
 * ```typescript
 * const account = privateKeyToAccount("0x...");
 * const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
 * const signer = toClientEvmSigner(account, publicClient);
 * const multiChainSigner = toClientEvmSigner(account, {
 *   8453: { rpcUrl: "https://mainnet.base.org" },
 *   137: { rpcUrl: "https://polygon-rpc.com" },
 * });
 * ```
 */
export function toClientEvmSigner(signer: ClientEvmSigner, rpc?: EvmRpcConfig): ClientEvmSigner {
  const clientFor = rpc === undefined ? undefined : rpcClientRouter(rpc);

  const result: ClientEvmSigner = {
    address: signer.address,
    signTypedData: msg => signer.signTypedData(msg),
  };

  const readContract = signer.readContract;
  if (readContract) {
    result.readContract = (args, network) => readContract(args, network);
  } else if (clientFor) {
    result.readContract = async (args, network) => clientFor(network).readContract(args);
  }

  const signTransaction = signer.signTransaction;
  if (signTransaction) {
    result.signTransaction = args => signTransaction(args);
  }

  const getTransactionCount = signer.getTransactionCount;
  if (getTransactionCount) {
    result.getTransactionCount = (args, network) => getTransactionCount(args, network);
  } else if (clientFor) {
    result.getTransactionCount = async (args, network) =>
      clientFor(network).getTransactionCount(args);
  }

  const estimateFeesPerGas = signer.estimateFeesPerGas;
  if (estimateFeesPerGas) {
    result.estimateFeesPerGas = (args, network) => estimateFeesPerGas(args, network);
  } else if (clientFor) {
    result.estimateFeesPerGas = async (_args, network) => clientFor(network).estimateFeesPerGas();
  }

  return result;
}

/** viem's own `waitForTransactionReceipt` default, so wrapping is behavior-preserving. */
const DEFAULT_CONFIRMATION_TIMEOUT_MS = 180_000;

/**
 * Converts a viem client with single address to a FacilitatorEvmSigner
 * Wraps the single address in a getAddresses() function for compatibility
 *
 * Every receipt wait the returned signer performs is bounded by `confirmationTimeoutMs`.
 * Facilitators behind a platform request deadline (serverless functions, gateway timeouts)
 * should set it below that deadline, so settlement reports `settlement_pending` with the
 * broadcast hash instead of the process being killed mid-wait.
 *
 * @param client - The client to convert (must have 'address' property)
 * @param options - Optional signer behavior
 * @param options.confirmationTimeoutMs - Receipt-wait bound in milliseconds. Defaults to 180_000.
 * @returns FacilitatorEvmSigner with getAddresses() support
 */
export function toFacilitatorEvmSigner(
  client: Omit<FacilitatorEvmSigner, "getAddresses"> & { address: `0x${string}` },
  {
    confirmationTimeoutMs = DEFAULT_CONFIRMATION_TIMEOUT_MS,
  }: { confirmationTimeoutMs?: number } = {},
): FacilitatorEvmSigner {
  return {
    ...client,
    getAddresses: () => [client.address],
    waitForTransactionReceipt: args =>
      client.waitForTransactionReceipt({ ...args, timeout: confirmationTimeoutMs }),
  };
}
