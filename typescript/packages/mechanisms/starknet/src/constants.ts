import { hash, num } from "starknet";

/**
 * CAIP-2 network identifier for Starknet Mainnet.
 */
export const STARKNET_MAINNET_CAIP2 = "starknet:SN_MAIN";

/**
 * CAIP-2 network identifier for Starknet Sepolia.
 */
export const STARKNET_SEPOLIA_CAIP2 = "starknet:SN_SEPOLIA";

/**
 * Felt grammar, in the two encodings a payload may use. Both are LENGTH bounds,
 * not range checks: a felt is under 2^252, so 64 hex or 78 decimal digits cannot
 * exclude a legal value, while keeping every match linear in a bounded input.
 * {@link STARK_PRIME} bounds the value where a value bound is what is wanted.
 */
export const HEX_FELT_REGEX = /^0x[0-9a-fA-F]{1,64}$/;
export const DECIMAL_FELT_REGEX = /^[0-9]{1,78}$/;

/**
 * Grammar for a Starknet address: 1 to 64 hex characters with a 0x prefix, no
 * fixed padding. This is a shape check only - 64 hex digits span 2^256, well
 * past the felt field, so {@link STARK_PRIME} bounds the value separately.
 */
export const STARKNET_ADDRESS_REGEX = HEX_FELT_REGEX;

/**
 * The Cairo field modulus. Every felt, and therefore every contract address,
 * is strictly below it; starknet.js enforces the same bound when hashing.
 */
export const STARK_PRIME = 2n ** 251n + 17n * 2n ** 192n + 1n;

/** Largest value a single u256 limb (low / high) may hold. */
export const U128_MAX = (1n << 128n) - 1n;

/**
 * Chain id felts keyed by CAIP-2 network identifier. The value is the felt
 * encoding of the Starknet chain id short string (`starknet_chainId`).
 */
export const CHAIN_IDS: Record<string, string> = {
  [STARKNET_MAINNET_CAIP2]: "0x534e5f4d41494e", // "SN_MAIN"
  [STARKNET_SEPOLIA_CAIP2]: "0x534e5f5345504f4c4941", // "SN_SEPOLIA"
};

/**
 * Maps a CAIP-2 network identifier to its chain id felt.
 *
 * @param network - The CAIP-2 network identifier (e.g. "starknet:SN_MAIN")
 * @returns The chain id felt as a hex string
 */
export function getStarknetChainId(network: string): string {
  const chainId = CHAIN_IDS[network];
  if (!chainId) {
    throw new Error(`Unsupported Starknet network: ${network}`);
  }
  return chainId;
}

/**
 * Default public JSON-RPC endpoints keyed by CAIP-2 network identifier.
 * These are overridable via client/facilitator configuration.
 */
export const DEFAULT_RPC_URLS: Record<string, string> = {
  [STARKNET_MAINNET_CAIP2]: "https://api.cartridge.gg/x/starknet/mainnet",
  [STARKNET_SEPOLIA_CAIP2]: "https://api.cartridge.gg/x/starknet/sepolia",
};

/**
 * Resolves the default JSON-RPC endpoint for a network.
 *
 * @param network - The CAIP-2 network identifier
 * @returns The default RPC URL for the network
 */
export function getStarknetRpcUrl(network: string): string {
  const url = DEFAULT_RPC_URLS[network];
  if (!url) {
    throw new Error(`Unsupported Starknet network: ${network}`);
  }
  return url;
}

/**
 * Circle-issued USDC, the default asset dollar prices resolve to (see
 * `defaultAssets.ts`). Any SNIP-2 token exposing `transfer` and a balance
 * getter may be used as `asset`; this is a deployment choice, not a scheme
 * requirement.
 */
export const USDC_MAINNET = "0x033068F6539f8e6e6b131e6B2B814e6c34A5224bC66947c47DaB9dFeE93b35fb";
export const USDC_SEPOLIA = "0x0512feAc6339Ff7889822cb5aA2a86C848e9D392bB0E3E237C008674feeD8343";

/**
 * Block every facilitator read is pinned to.
 *
 * RPC 0.9 renamed the `pending` tag to `pre_confirmed`, and current nodes
 * reject `pending` outright with "Invalid block id". starknet v8 already
 * defaults to `latest`, so pinning here is a deliberate, verifiable choice
 * rather than a workaround: one read block the whole package agrees on, and a
 * guard against a future SDK default reintroducing pre-confirmed reads.
 *
 * Reading confirmed state is also the safer default, and its staleness costs
 * gas rather than funds. A nonce consumed in the not-yet-closed block still
 * reads as unused here, and a balance already spent there still reads as
 * available; in both cases the settlement is broadcast and reverts. A revert
 * rolls the SNIP-9 nonce back, so the authorization stays retryable, and if
 * some other transaction did execute this same authorization the consumed-nonce
 * rescue resolves it to that transaction. No path reports success for a payment
 * that did not verifiably land.
 */
export const READ_BLOCK = "latest";

/**
 * The `transfer(recipient, amount)` entry point selector for SNIP-2 tokens.
 */
export const TRANSFER_SELECTOR = hash.getSelectorFromName("transfer");

/**
 * The SNIP-2 `Transfer` event selector, normalized to hex. Distinct from
 * {@link TRANSFER_SELECTOR}: that is the entry point called, this is the first
 * key of the event it emits, and it is matched against both event keys and RPC
 * `getEvents` filters.
 */
export const TRANSFER_EVENT_SELECTOR = num.toHex(hash.getSelectorFromName("Transfer"));

/**
 * The SNIP-6 `is_valid_signature` success magic value, felt encoding of "VALID".
 */
export const VALID_SIGNATURE_MAGIC = "0x56414c4944";

/**
 * The SNIP-9 ANY_CALLER sentinel (felt encoding of the short string
 * "ANY_CALLER"). Forbidden as a `feePayer`: it would turn a caller-bound
 * authorization into a bearer one that anyone could submit.
 */
export const ANY_CALLER = "0x414e595f43414c4c4552";

/**
 * Symmetric clock-skew margin applied to SNIP-9 time bounds, in seconds.
 * Absorbs sequencer block-timestamp lag relative to wall clock.
 */
export const SKEW_MARGIN_SECONDS = 30;

/**
 * Minimum seconds that must remain before `Execute Before` at verification, so
 * the authorization cannot expire in flight between /verify and settlement.
 */
export const MIN_REMAINING_WINDOW_SECONDS = 30;

/**
 * Upper bound on the felt-array signature length. Guards against RPC calldata
 * bloat while still admitting multisig and guardian account signatures.
 */
export const MAX_SIGNATURE_FELTS = 32;

/**
 * Per-request network budget for RPC and paymaster calls. starknet v8 exposes no
 * timeout of its own, so an unresponsive node would otherwise hold a request
 * open until the socket died - and /verify is unauthenticated, so that is
 * reachable by anyone.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Upper bound on a request timeout (2^31 - 1), matching `@x402/core`'s own
 * `timeoutMs` contract: `AbortSignal.timeout` takes a 32-bit delay, and Node
 * clamps a larger one to 1 ms, so every request would abort at once.
 */
export const MAX_REQUEST_TIMEOUT_MS = 2_147_483_647;

/**
 * Starknet-specific `invalidReason` / `errorReason` codes. See the Error Codes
 * table in the merged spec (specs/schemes/exact/scheme_exact_starknet.md).
 */
export const STARKNET_ERROR_REASONS = {
  INVALID_SIGNATURE: "invalid_exact_starknet_payload_signature",
  ASSET_MISMATCH: "invalid_exact_starknet_payload_asset_mismatch",
  RECIPIENT_MISMATCH: "invalid_exact_starknet_payload_recipient_mismatch",
  AMOUNT_MISMATCH: "invalid_exact_starknet_payload_amount_mismatch",
  INVALID_CALLER: "invalid_exact_starknet_payload_caller",
  ACCOUNT_NOT_DEPLOYED: "account_not_deployed",
  EXPIRED: "outside_execution_expired",
  WINDOW_EXCEEDS_MAX_TIMEOUT: "outside_execution_window_exceeds_max_timeout",
  NONCE_ALREADY_USED: "nonce_already_used",
  SIMULATION_FAILED: "simulation_failed",
  DUPLICATE_SETTLEMENT: "duplicate_settlement",
  SETTLEMENT_PENDING: "settlement_pending",
} as const;
