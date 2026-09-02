import { sha256 } from "@noble/hashes/sha256";
import { ErrInvalidPayloadTransaction } from "./exact/facilitator/errors";
import {
  isAddress,
  getBase58Encoder,
  getBase64Decoder,
  getBase64Encoder,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
  type Blockhash,
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
import type { PendingSettlementStore } from "@x402/core/facilitator";
import type { Network, PaymentRequirements, SettleResponse } from "@x402/core/types";
import {
  SVM_ADDRESS_REGEX,
  DEVNET_RPC_URL,
  TESTNET_RPC_URL,
  MAINNET_RPC_URL,
  SOLANA_MAINNET_CAIP2,
  SOLANA_DEVNET_CAIP2,
  SOLANA_TESTNET_CAIP2,
  normalizeNetwork,
} from "./constants";
import { DEFAULT_ASSETS, findDefaultAsset, getDefaultAsset } from "./defaultAssets";
import type { ExactSvmPayloadV1 } from "./types";
import { SLOT_COMMITMENT } from "./upto/shared";

export { normalizeNetwork } from "./constants";

/**
 * Validate Solana address format
 *
 * The regex gates the charset and length; `isAddress` additionally requires the
 * base58 to decode to 32 bytes, which the regex alone allows through. Anything
 * looser accepts strings no Solana runtime (or the Go SDK's decoder) would.
 *
 * @param address - Base58 encoded address string
 * @returns true if address is valid, false otherwise
 */
export function validateSvmAddress(address: string): boolean {
  return SVM_ADDRESS_REGEX.test(address) && isAddress(address);
}

/**
 * Compute a stable, immutable cache key for a decoded transaction by hashing its
 * message bytes. The fee-payer signature (slot 0) is overwritten by the facilitator
 * before broadcast, so an attacker can randomize those bytes to bypass a wire-bytes
 * cache key. The message is what every signer commits to, making its hash a reliable
 * payment identity.
 *
 * @param transaction - Decoded transaction whose message bytes to hash
 * @returns Base64-encoded SHA-256 hash of the transaction message bytes
 */
export function transactionMessageHash(transaction: Transaction): string {
  return getBase64Decoder().decode(sha256(Uint8Array.from(transaction.messageBytes)));
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
    throw new Error(ErrInvalidPayloadTransaction);
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
 * Resolve the transaction-lifetime blockhash for a payment.
 *
 * Prefers a server-provided blockhash carried in the 402 challenge
 * (`extra.recentBlockhash` + `extra.lastValidBlockHeight`) so the client needn't
 * make its own RPC round-trip. Falls back to fetching one from `rpc` when the
 * challenge omits it or contains a malformed value.
 *
 * @param rpc - RPC client used for the fallback fetch
 * @param requirements - The payment requirements (challenge) being paid
 * @returns The blockhash and its last-valid block height
 */
export async function resolveBlockhash(
  rpc: ReturnType<typeof createRpcClient>,
  requirements: PaymentRequirements,
): Promise<{ blockhash: Blockhash; lastValidBlockHeight: bigint }> {
  const provided = requirements.extra?.recentBlockhash;
  if (typeof provided === "string" && provided !== "") {
    try {
      if (getBase58Encoder().encode(provided).length === 32) {
        const lastValid = requirements.extra?.lastValidBlockHeight;
        let lastValidBlockHeight = 0n;
        if (typeof lastValid === "string" && /^\d+$/.test(lastValid)) {
          lastValidBlockHeight = BigInt(lastValid);
        } else if (
          typeof lastValid === "number" &&
          Number.isSafeInteger(lastValid) &&
          lastValid >= 0
        ) {
          lastValidBlockHeight = BigInt(lastValid);
        }

        return { blockhash: provided as Blockhash, lastValidBlockHeight };
      }
    } catch {
      // Invalid optional hints are ignored; fetch a usable blockhash below.
    }
  }

  const { value } = await rpc.getLatestBlockhash().send();
  return value;
}

/**
 * Resolve the channel open-slot anchor (`open_slot` PDA seed) for a payment.
 *
 * Prefers a server-provided slot carried in the 402 challenge
 * (`extra.recentSlot`) so the client needn't make its own RPC round-trip. Falls
 * back to `rpc.getSlot({ commitment: SLOT_COMMITMENT })` when the challenge
 * omits it or contains a malformed value. Finalized commitment keeps
 * `openSlot <= clock.slot` true when the open lands, matching the facilitator.
 *
 * @param rpc - RPC client used for the fallback fetch
 * @param requirements - The payment requirements (challenge) being paid
 * @returns The open slot as a u64 bigint
 */
export async function resolveOpenSlot(
  rpc: ReturnType<typeof createRpcClient>,
  requirements: PaymentRequirements,
): Promise<bigint> {
  const provided = requirements.extra?.recentSlot;
  if (provided !== undefined && provided !== null) {
    try {
      let parsed: bigint;
      if (typeof provided === "bigint") {
        parsed = provided;
      } else if (typeof provided === "number") {
        if (!Number.isSafeInteger(provided) || provided < 0) {
          throw new Error("extra.recentSlot must be a non-negative safe integer");
        }
        parsed = BigInt(provided);
      } else if (typeof provided === "string" && /^\d+$/.test(provided)) {
        parsed = BigInt(provided);
      } else {
        throw new Error("extra.recentSlot must be an unsigned integer");
      }
      if (parsed > (1n << 64n) - 1n) {
        throw new Error("extra.recentSlot must fit in u64");
      }
      return parsed;
    } catch {
      // Invalid optional hints are ignored; fetch a usable slot below.
    }
  }

  return await rpc.getSlot({ commitment: SLOT_COMMITMENT }).send();
}

/**
 * Get the default USDC mint address for a network
 *
 * @param network - Network identifier (CAIP-2 or V1 format)
 * @returns USDC mint address for the network
 */
export function getUsdcAddress(network: Network): string {
  return getDefaultAsset(network).asset;
}

/**
 * Get the mint address for a supported stablecoin on a network.
 *
 * @param symbol - Stablecoin symbol
 * @param network - Network identifier (CAIP-2 or V1 format)
 * @returns Mint address for the symbol and network
 */
export function getStablecoinAddress(symbol: string, network: Network): string {
  return getDefaultAsset(network, symbol).asset;
}

/**
 * Resolve a stablecoin symbol to a mint address. Unknown values are returned as-is.
 *
 * @param currency - Stablecoin symbol or raw mint address
 * @param network - Network identifier (CAIP-2 or V1 format)
 * @returns Mint address, undefined for SOL, or the original currency for unknown mints
 */
export function resolveStablecoinMint(currency: string, network: Network): string | undefined {
  const normalized = currency.toUpperCase();
  if (normalized === "SOL") return undefined;
  try {
    return getDefaultAsset(network, currency).asset;
  } catch {
    return currency;
  }
}

/**
 * Return the supported stablecoin symbol for a symbol or known mint address.
 *
 * @param currency - Stablecoin symbol or raw mint address
 * @returns Supported stablecoin symbol if recognized
 */
export function getStablecoinSymbol(currency: string): string | undefined {
  const normalized = currency.toUpperCase();
  for (const assets of Object.values(DEFAULT_ASSETS)) {
    if (!assets) continue;
    const match = assets.find(
      entry => entry.symbol.toUpperCase() === normalized || entry.asset === currency,
    );
    if (match) return match.symbol;
  }
}

/**
 * Return the known token program for a supported stablecoin symbol or mint.
 * Unknown values default to SPL Token.
 *
 * @param currency - Stablecoin symbol or raw mint address
 * @param network - Network identifier (CAIP-2 or V1 format)
 * @returns SPL Token or Token-2022 program address
 */
export function getStablecoinTokenProgram(currency: string, network: Network): string {
  const resolvedMint = resolveStablecoinMint(currency, network);
  if (!resolvedMint) return TOKEN_PROGRAM_ADDRESS.toString();
  const byMint = findDefaultAsset(resolvedMint, network);
  if (byMint) return byMint.tokenProgram;
  try {
    return getDefaultAsset(network, currency).tokenProgram;
  } catch {
    return TOKEN_PROGRAM_ADDRESS.toString();
  }
}

/**
 * Thrown by a {@link PendingSettlementStore}-aware confirmation wait (e.g.
 * `FacilitatorSvmSigner.confirmTransaction`) when the transaction reached the
 * chain and failed there — a definite onchain rejection, not a
 * confirmation-wait timeout whose outcome is still unknown. Callers must
 * treat this as terminal: release any dedup/pending-settlement lock and
 * report a failure instead of `settlement_pending`. Any other confirmation
 * error (timeout or otherwise) is treated conservatively as non-terminal,
 * since a fresh broadcast while the original might still land risks a
 * double-spend.
 */
export class TransactionOnchainFailureError extends Error {
  /**
   * Create the error for a transaction that reached the chain and failed there.
   *
   * @param message - Description of the onchain failure, e.g. the decoded transaction error
   */
  constructor(message: string) {
    super(message);
    this.name = "TransactionOnchainFailureError";
  }
}

/**
 * Persists `signature` under `key` in `store` so a subsequent settle attempt
 * for the same payload can reconcile against it instead of re-broadcasting,
 * then returns the `settlement_pending` response carrying `error`'s message.
 *
 * If the store write itself fails, a later retry has no record to reconcile
 * against — returning `settlement_pending` regardless would let it blindly
 * re-verify/re-broadcast and risk a double-send. In that case this instead
 * returns a terminal failure (`terminalReason`), preserving `signature` for
 * manual reconciliation.
 *
 * @param store - The pending-settlement store to update
 * @param key - Deterministic key for this payload (e.g. a signature or channel id)
 * @param signature - The broadcast signature to persist and report
 * @param payer - The payer address
 * @param network - Network the transaction was broadcast to
 * @param pendingReason - Error reason to report when the store write succeeds
 * @param terminalReason - Error reason to report when the store write fails
 * @param error - The confirmation-wait error that triggered this call
 * @returns The settlement_pending or terminal SettleResponse
 */
export async function recordPendingOrTerminal(
  store: PendingSettlementStore,
  key: string,
  signature: string,
  payer: string,
  network: Network,
  pendingReason: string,
  terminalReason: string,
  error: unknown,
): Promise<SettleResponse> {
  try {
    await store.set(key, signature);
  } catch (storeError) {
    return {
      success: false,
      errorReason: terminalReason,
      errorMessage: `settlement_pending, but failed to persist for retry: ${
        storeError instanceof Error ? storeError.message : String(storeError)
      }`,
      transaction: signature,
      network,
      payer,
    };
  }
  return {
    success: false,
    errorReason: pendingReason,
    errorMessage: error instanceof Error ? error.message : String(error),
    transaction: signature,
    network,
    payer,
  };
}

// Re-export from core for backward compatibility
export { convertToTokenAmount, numberToDecimalString } from "@x402/core/utils";
