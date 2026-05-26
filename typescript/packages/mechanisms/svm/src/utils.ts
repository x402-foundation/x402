import {
  getBase64Encoder,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
  type Transaction,
  createSolanaRpc,
  devnet,
  testnet,
  mainnet,
  type RpcDevnet,
  type SolanaRpcApiDevnet,
  type RpcTestnet,
  type SolanaRpcApiTestnet,
  type RpcMainnet,
  type SolanaRpcApiMainnet,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import type { Network } from "@x402/core/types";
import {
  SVM_ADDRESS_REGEX,
  DEVNET_RPC_URL,
  TESTNET_RPC_URL,
  MAINNET_RPC_URL,
  USDC_MAINNET_ADDRESS,
  USDC_DEVNET_ADDRESS,
  USDC_TESTNET_ADDRESS,
  SOLANA_MAINNET_CAIP2,
  SOLANA_DEVNET_CAIP2,
  SOLANA_TESTNET_CAIP2,
  V1_TO_V2_NETWORK_MAP,
} from "./constants";
import type { ExactSvmPayloadV1 } from "./types";

/**
 * Normalize network identifier to CAIP-2 format
 * Handles both V1 names (solana, solana-devnet) and V2 CAIP-2 format
 *
 * @param network - Network identifier (V1 or V2 format)
 * @returns CAIP-2 network identifier
 */
export function normalizeNetwork(network: Network): string {
  // If it's already CAIP-2 format (contains ":"), validate it's supported
  if (network.includes(":")) {
    const supported = [SOLANA_MAINNET_CAIP2, SOLANA_DEVNET_CAIP2, SOLANA_TESTNET_CAIP2];
    if (!supported.includes(network)) {
      throw new Error(`Unsupported SVM network: ${network}`);
    }
    return network;
  }

  // Otherwise, it's a V1 network name, convert to CAIP-2
  const caip2Network = V1_TO_V2_NETWORK_MAP[network];
  if (!caip2Network) {
    throw new Error(`Unsupported SVM network: ${network}`);
  }
  return caip2Network;
}

/**
 * Validate Solana address format
 *
 * @param address - Base58 encoded address string
 * @returns true if address is valid, false otherwise
 */
export function validateSvmAddress(address: string): boolean {
  return SVM_ADDRESS_REGEX.test(address);
}

/**
 * Decode a base64 encoded transaction from an SVM payload
 *
 * @param svmPayload - The SVM payload containing a base64 encoded transaction
 * @returns Decoded Transaction object
 */
export function decodeTransactionFromPayload(svmPayload: ExactSvmPayloadV1): Transaction {
  try {
    const base64Encoder = getBase64Encoder();
    const transactionBytes = base64Encoder.encode(svmPayload.transaction);
    const transactionDecoder = getTransactionDecoder();
    return transactionDecoder.decode(transactionBytes);
  } catch (error) {
    console.error("Error decoding transaction:", error);
    throw new Error("invalid_exact_svm_payload_transaction");
  }
}

/**
 * Extract the token sender (owner of the source token account) from a TransferChecked instruction
 *
 * @param transaction - The decoded transaction
 * @returns The token payer address as a base58 string
 */
export function getTokenPayerFromTransaction(transaction: Transaction): string {
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const staticAccounts = compiled.staticAccounts ?? [];
  const instructions = compiled.instructions ?? [];

  for (const ix of instructions) {
    const programIndex = ix.programAddressIndex;
    const programAddress = staticAccounts[programIndex].toString();

    // Check if this is a token program instruction
    if (
      programAddress === TOKEN_PROGRAM_ADDRESS.toString() ||
      programAddress === TOKEN_2022_PROGRAM_ADDRESS.toString()
    ) {
      const accountIndices: number[] = ix.accountIndices ?? [];
      // TransferChecked account order: [source, mint, destination, owner, ...]
      if (accountIndices.length >= 4) {
        const ownerIndex = accountIndices[3];
        const ownerAddress = staticAccounts[ownerIndex].toString();
        if (ownerAddress) return ownerAddress;
      }
    }
  }

  return "";
}

/**
 * Create an RPC client for the specified network
 *
 * @param network - Network identifier (CAIP-2 or V1 format)
 * @param customRpcUrl - Optional custom RPC URL
 * @returns RPC client for the specified network
 */
export function createRpcClient(
  network: Network,
  customRpcUrl?: string,
):
  | RpcDevnet<SolanaRpcApiDevnet>
  | RpcTestnet<SolanaRpcApiTestnet>
  | RpcMainnet<SolanaRpcApiMainnet> {
  const caip2Network = normalizeNetwork(network);

  switch (caip2Network) {
    case SOLANA_DEVNET_CAIP2: {
      const url = customRpcUrl || DEVNET_RPC_URL;
      return createSolanaRpc(devnet(url)) as RpcDevnet<SolanaRpcApiDevnet>;
    }
    case SOLANA_TESTNET_CAIP2: {
      const url = customRpcUrl || TESTNET_RPC_URL;
      return createSolanaRpc(testnet(url)) as RpcTestnet<SolanaRpcApiTestnet>;
    }
    case SOLANA_MAINNET_CAIP2: {
      const url = customRpcUrl || MAINNET_RPC_URL;
      return createSolanaRpc(mainnet(url)) as RpcMainnet<SolanaRpcApiMainnet>;
    }
    default:
      throw new Error(`Unsupported network: ${network}`);
  }
}

/**
 * Get the default USDC mint address for a network
 *
 * @param network - Network identifier (CAIP-2 or V1 format)
 * @returns USDC mint address for the network
 */
export function getUsdcAddress(network: Network): string {
  const caip2Network = normalizeNetwork(network);

  switch (caip2Network) {
    case SOLANA_MAINNET_CAIP2:
      return USDC_MAINNET_ADDRESS;
    case SOLANA_DEVNET_CAIP2:
      return USDC_DEVNET_ADDRESS;
    case SOLANA_TESTNET_CAIP2:
      return USDC_TESTNET_ADDRESS;
    default:
      throw new Error(`No USDC address configured for network: ${network}`);
  }
}

// Re-export from core for backward compatibility
export { convertToTokenAmount, numberToDecimalString } from "@x402/core/utils";
