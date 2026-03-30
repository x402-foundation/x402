import { createPublicClient, http } from "viem";
import type { ClientEvmSigner } from "../signer";
import { getEvmChainId } from "../utils";

export type EvmSchemeConfig = {
  rpcUrl?: string;
};

export type EvmSchemeConfigByChainId = Record<number, EvmSchemeConfig>;

export type EvmSchemeOptions = EvmSchemeConfig | EvmSchemeConfigByChainId;

/** @deprecated Use EvmSchemeConfig */
export type ExactEvmSchemeConfig = EvmSchemeConfig;
/** @deprecated Use EvmSchemeConfigByChainId */
export type ExactEvmSchemeConfigByChainId = EvmSchemeConfigByChainId;
/** @deprecated Use EvmSchemeOptions */
export type ExactEvmSchemeOptions = EvmSchemeOptions;

type ExtensionRpcCapabilities = Pick<
  ClientEvmSigner,
  "readContract" | "signTransaction" | "getTransactionCount" | "estimateFeesPerGas"
>;

const rpcClientCache = new Map<string, ReturnType<typeof createPublicClient>>();

/**
 * Check if options is a per-chain-id configuration map.
 *
 * @param options - The EVM scheme options to check
 * @returns True if the options are keyed by chain ID
 */
function isConfigByChainId(options: EvmSchemeOptions): options is EvmSchemeConfigByChainId {
  const keys = Object.keys(options);
  return keys.length > 0 && keys.every(key => /^\d+$/.test(key));
}

/**
 * Get or create a cached viem public client for the given RPC URL.
 *
 * @param rpcUrl - The JSON-RPC endpoint URL
 * @returns A viem PublicClient instance
 */
function getRpcClient(rpcUrl: string): ReturnType<typeof createPublicClient> {
  const existing = rpcClientCache.get(rpcUrl);
  if (existing) {
    return existing;
  }

  const client = createPublicClient({
    transport: http(rpcUrl),
  });
  rpcClientCache.set(rpcUrl, client);
  return client;
}

/**
 * Resolve an RPC URL from scheme options for the given network.
 *
 * @param network - The CAIP-2 network identifier
 * @param options - Optional EVM scheme options (flat or per-chain-id)
 * @returns The resolved RPC URL, or undefined if not configured
 */
export function resolveRpcUrl(network: string, options?: EvmSchemeOptions): string | undefined {
  if (!options) {
    return undefined;
  }

  if (isConfigByChainId(options)) {
    const chainId = getEvmChainId(network);
    const optionsByChainId = options as EvmSchemeConfigByChainId;
    return optionsByChainId[chainId]?.rpcUrl;
  }

  return (options as EvmSchemeConfig).rpcUrl;
}

/**
 * Resolve RPC capabilities for extensions, backfilling from a public RPC client when the signer lacks them.
 *
 * @param network - The CAIP-2 network identifier
 * @param signer - The client EVM signer
 * @param options - Optional EVM scheme options for RPC URL resolution
 * @returns Extension RPC capabilities (readContract, signTransaction, etc.)
 */
export function resolveExtensionRpcCapabilities(
  network: string,
  signer: ClientEvmSigner,
  options?: EvmSchemeOptions,
): ExtensionRpcCapabilities {
  const capabilities: ExtensionRpcCapabilities = {
    signTransaction: signer.signTransaction,
    readContract: signer.readContract,
    getTransactionCount: signer.getTransactionCount,
    estimateFeesPerGas: signer.estimateFeesPerGas,
  };

  const needsRpcBackfill =
    !capabilities.readContract ||
    !capabilities.getTransactionCount ||
    !capabilities.estimateFeesPerGas;
  if (!needsRpcBackfill) {
    return capabilities;
  }

  const rpcUrl = resolveRpcUrl(network, options);
  if (!rpcUrl) {
    return capabilities;
  }
  const rpcClient = getRpcClient(rpcUrl);
  if (!capabilities.readContract) {
    capabilities.readContract = args => rpcClient.readContract(args as never) as Promise<unknown>;
  }
  if (!capabilities.getTransactionCount) {
    capabilities.getTransactionCount = async args =>
      rpcClient.getTransactionCount({ address: args.address });
  }
  if (!capabilities.estimateFeesPerGas) {
    capabilities.estimateFeesPerGas = async () => rpcClient.estimateFeesPerGas();
  }

  return capabilities;
}
