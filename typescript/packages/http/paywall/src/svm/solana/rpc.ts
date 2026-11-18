import {
  createSolanaRpc,
  devnet,
  mainnet,
  RpcDevnet,
  SolanaRpcApiDevnet,
  SolanaRpcApiMainnet,
  RpcMainnet,
} from "@solana/kit";
import { SOLANA_NETWORK_REFS } from "../../paywallUtils";

/**
 * Default public RPC endpoint for Solana devnet
 */
const DEVNET_RPC_URL = "https://api.devnet.solana.com";

/**
 * Default public RPC endpoint for Solana mainnet
 */
const MAINNET_RPC_URL = "https://api.mainnet-beta.solana.com";

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
 * @param network - The network to get the RPC client for (CAIP-2 format: solana:reference)
 * @param url - Optional URL of the network. If not provided, the default URL will be used.
 * @returns The RPC client for the given network
 */
export function getRpcClient(
  network: string,
  url?: string,
): RpcDevnet<SolanaRpcApiDevnet> | RpcMainnet<SolanaRpcApiMainnet> {
  if (!network.startsWith("solana:")) {
    throw new Error(
      `Invalid network format. Expected CAIP-2 format (solana:reference), got: ${network}`,
    );
  }

  const ref = network.split(":")[1];
  const isDevnet = ref === SOLANA_NETWORK_REFS.DEVNET;

  return isDevnet ? createDevnetRpcClient(url) : createMainnetRpcClient(url);
}
