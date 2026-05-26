import {
  createSolanaRpc,
  devnet,
  mainnet,
  RpcDevnet,
  SolanaRpcApiDevnet,
  SolanaRpcApiMainnet,
  RpcMainnet,
  createSolanaRpcSubscriptions,
  RpcSubscriptionsFromTransport,
  SolanaRpcSubscriptionsApi,
  RpcSubscriptionsTransportFromClusterUrl,
  ClusterUrl,
} from "@solana/kit";
import { Network } from "../../types/shared";

/**
 * Default public RPC endpoint for Solana devnet
 */
const DEVNET_RPC_URL = "https://api.devnet.solana.com";

/**
 * Default public RPC endpoint for Solana mainnet
 */
const MAINNET_RPC_URL = "https://api.mainnet-beta.solana.com";

/**
 * Default public WebSocket endpoint for Solana devnet
 */
const DEVNET_WS_URL = "wss://api.devnet.solana.com";

/**
 * Default public WebSocket endpoint for Solana mainnet
 */
const MAINNET_WS_URL = "wss://api.mainnet-beta.solana.com";

/**
 * Creates a Solana RPC client for the devnet network.
 *
 * @param url - Optional URL of the devnet network.
 * @returns A Solana RPC client.
 */
export function createDevnetRpcClient(url?: string): RpcDevnet<SolanaRpcApiDevnet> {
  return createSolanaRpc(
    url ? devnet(url) : devnet(DEVNET_RPC_URL),
  ) as RpcDevnet<SolanaRpcApiDevnet>;
}

/**
 * Creates a Solana RPC client for the mainnet network.
 *
 * @param url - Optional URL of the mainnet network.
 * @returns A Solana RPC client.
 */
export function createMainnetRpcClient(url?: string): RpcMainnet<SolanaRpcApiMainnet> {
  return createSolanaRpc(
    url ? mainnet(url) : mainnet(MAINNET_RPC_URL),
  ) as RpcMainnet<SolanaRpcApiMainnet>;
}

/**
 * Gets the RPC client for the given network.
 *
 * @param network - The network to get the RPC client for
 * @param url - Optional URL of the network. If not provided, the default URL will be used.
 * @returns The RPC client for the given network
 */
export function getRpcClient(
  network: Network,
  url?: string,
): RpcDevnet<SolanaRpcApiDevnet> | RpcMainnet<SolanaRpcApiMainnet> {
  // TODO: should the networks be replaced with enum references?
  if (network === "solana-devnet") {
    return createDevnetRpcClient(url);
  } else if (network === "solana") {
    return createMainnetRpcClient(url);
  } else {
    throw new Error("Invalid network");
  }
}

/**
 * Gets the RPC subscriptions for the given network.
 *
 * @param network - The network to get the RPC subscriptions for
 * @param url - Optional URL of the network. If not provided, the default URL will be used.
 * @returns The RPC subscriptions for the given network
 */
export function getRpcSubscriptions(
  network: Network,
  url?: string,
): RpcSubscriptionsFromTransport<
  SolanaRpcSubscriptionsApi,
  RpcSubscriptionsTransportFromClusterUrl<ClusterUrl>
> {
  // TODO: should the networks be replaced with enum references?
  if (network === "solana-devnet") {
    return createSolanaRpcSubscriptions(devnet(url ? httpToWs(url) : DEVNET_WS_URL));
  } else if (network === "solana") {
    return createSolanaRpcSubscriptions(mainnet(url ? httpToWs(url) : MAINNET_WS_URL));
  } else {
    throw new Error("Invalid network");
  }
}

/**
 *
 * Converts an HTTP URL to a WebSocket URL
 *
 * @param url - The URL to convert to a WebSocket URL
 * @returns The WebSocket URL
 */
function httpToWs(url: string): string {
  if (url.startsWith("http")) {
    return url.replace("http", "ws");
  }
  return url;
}
