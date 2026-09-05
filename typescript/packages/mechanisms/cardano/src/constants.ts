/**
 * Network identifier for Cardano Mainnet.
 *
 * `cardano:mainnet`/`cardano:preprod`/`cardano:preview` are the canonical,
 * advertised x402 identifiers (good DX, and they disambiguate the two
 * testnets). They are valid CAIP-2 syntax over the (unregistered) `cardano`
 * namespace; no registered CASA `cardano` namespace exists, so `cardano:1`
 * would be no more canonical — and it cannot distinguish preprod from preview,
 * which share network id 0. The only standardized form is CIP-34's
 * `cip34:NetworkId-NetworkMagic`, which has poor DX. We accept those CIP-34
 * forms as input aliases (see {@link normalizeCardanoNetwork}) and normalize
 * them to these canonical ids; `/supported` advertises only the canonical ids.
 */
export const CARDANO_MAINNET_CAIP2 = "cardano:mainnet";

/**
 * Network identifier for Cardano Preprod (testnet).
 */
export const CARDANO_PREPROD_CAIP2 = "cardano:preprod";

/**
 * Network identifier for Cardano Preview (testnet).
 */
export const CARDANO_PREVIEW_CAIP2 = "cardano:preview";

/**
 * All Cardano networks supported by this implementation.
 */
export const CARDANO_NETWORKS = [
  CARDANO_MAINNET_CAIP2,
  CARDANO_PREPROD_CAIP2,
  CARDANO_PREVIEW_CAIP2,
] as const;

/**
 * CIP-34 network identifiers (`cip34:NetworkId-NetworkMagic`). Accepted as
 * input aliases for the canonical ids above. Network magics: mainnet =
 * 764824073, preprod = 1, preview = 2.
 */
export const CARDANO_MAINNET_CIP34 = "cip34:1-764824073";
export const CARDANO_PREPROD_CIP34 = "cip34:0-1";
export const CARDANO_PREVIEW_CIP34 = "cip34:0-2";

/**
 * Maps each accepted CIP-34 alias to its canonical x402 Cardano network id.
 */
const CARDANO_NETWORK_ALIASES: Record<string, string> = {
  [CARDANO_MAINNET_CIP34]: CARDANO_MAINNET_CAIP2,
  [CARDANO_PREPROD_CIP34]: CARDANO_PREPROD_CAIP2,
  [CARDANO_PREVIEW_CIP34]: CARDANO_PREVIEW_CAIP2,
};

/**
 * Normalizes a network identifier to its canonical x402 Cardano form. Known
 * CIP-34 aliases are folded to the canonical id; any other value (already
 * canonical, or a non-Cardano network) is returned unchanged so existing
 * rejection paths still apply.
 *
 * @param network - The network identifier to normalize.
 * @returns The canonical Cardano network id, or the input unchanged.
 */
export function normalizeCardanoNetwork(network: string): string {
  return CARDANO_NETWORK_ALIASES[network] ?? network;
}

/**
 * Cardano network ID encoded inside transaction bodies.
 * Mainnet = 1, every testnet = 0.
 */
export const CARDANO_NETWORK_ID_MAINNET = 1;
/**
 * Cardano network ID encoded inside transaction bodies for testnets.
 */
export const CARDANO_NETWORK_ID_TESTNET = 0;

/**
 * The Exact scheme identifier (matches other mechanisms).
 */
export const SCHEME_EXACT = "exact";

/**
 * USDM policy id on Cardano Mainnet.
 */
export const USDM_MAINNET_POLICY_ID = "c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad";
/**
 * USDM policy id on Cardano Preprod.
 */
export const USDM_PREPROD_POLICY_ID = "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9";

/**
 * USDM (333) reference asset name (hex of "(333) USDM").
 *
 * The CIP-68 reference token uses the (333) prefix `0014df10` followed by the
 * hex-encoded UTF-8 of `USDM` (0x5553444d).
 */
export const USDM_ASSET_NAME_HEX = "0014df105553444d";
export const USDM_ASSET_NAME_HEX_PREPROD = "0014df10745553444d";
/**
 * Default USDM unit on Mainnet (`policyId.assetNameHex`).
 */
export const USDM_MAINNET_ASSET = `${USDM_MAINNET_POLICY_ID}.${USDM_ASSET_NAME_HEX}`;

/**
 * Default USDM unit on Preprod (`policyId.assetNameHex`).
 */
export const USDM_PREPROD_ASSET = `${USDM_PREPROD_POLICY_ID}.${USDM_ASSET_NAME_HEX_PREPROD}`;

/**
 * Default decimals for USDM (matches USDC).
 */
export const USDM_DEFAULT_DECIMALS = 6;

/**
 * Asset identifier for native ADA. The Cardano facilitator special-cases
 * this value: lovelace lives in an output's `coin` field, not in its
 * multi-asset map, so the verifier compares against `output.coin` when the
 * asset string is exactly `"lovelace"`.
 */
export const LOVELACE_ASSET = "lovelace";

/**
 * Constant overhead (bytes) in the Babbage/Conway min-UTXO formula
 * `(160 + |serialized_output|) * coinsPerUtxoByte` — 20 words x 8 bytes for the
 * transaction input and its UTXO-map entry.
 */
export const CARDANO_MIN_UTXO_OVERHEAD_BYTES = 160;

/**
 * Cardano asset unit regex.
 *
 * Accepts either the literal `"lovelace"` (native ADA) or a
 * `policyId.assetNameHex` pair, where:
 * - policyId: 28 bytes -> 56 hex characters.
 * - assetName: 0..32 bytes -> 0..64 hex characters.
 */
export const CARDANO_ASSET_REGEX = /^(lovelace|[0-9a-fA-F]{56}\.[0-9a-fA-F]{0,64})$/;
/** Canonical Cardano asset unit: lowercase policy/asset hex, or `lovelace`. */
export const CANONICAL_CARDANO_ASSET_REGEX = /^(lovelace|[0-9a-f]{56}\.[0-9a-f]{0,64})$/;
/** Positive canonical decimal integer with no leading zero. */
export const POSITIVE_CANONICAL_AMOUNT_REGEX = /^[1-9][0-9]*$/;

/**
 * Cardano payment address regex (very permissive).
 * - Mainnet bech32: `addr1...`
 * - Testnet bech32: `addr_test1...`
 */
export const CARDANO_ADDRESS_REGEX = /^(addr1|addr_test1)[0-9a-z]+$/;

/**
 * UTXO reference regex: `${txHashHex}#${index}`.
 * - txHash: 32 bytes -> 64 hex characters.
 * - index: non-negative integer.
 */
export const CARDANO_UTXO_REF_REGEX = /^[0-9a-fA-F]{64}#\d+$/;

/**
 * Submission policy values a server may declare in `extra.submissionPolicy`.
 * Omission normalizes to `server`. `either` is a policy, never a payload mode.
 */
export const SUBMISSION_POLICY_SERVER = "server";
/** Submission policy: the client broadcasts before the paid retry. */
export const SUBMISSION_POLICY_CLIENT = "client";
/** Submission policy: the client picks either mode. */
export const SUBMISSION_POLICY_EITHER = "either";

/**
 * Default `confirmationPolicy.l1Confirmations` when the requirements omit it,
 * and the inclusive bounds the spec allows (`-1` = authenticated mempool
 * acceptance, `0` = canonical block inclusion, `1..20` = newer canonical blocks).
 */
export const DEFAULT_L1_CONFIRMATIONS = 1;
/** Lowest accepted `l1Confirmations` (authenticated mempool acceptance). */
export const MIN_L1_CONFIRMATIONS = -1;
/** Highest accepted `l1Confirmations`. */
export const MAX_L1_CONFIRMATIONS = 20;

/** Settlement layer selected by a Masumi payload. */
export const SETTLEMENT_LAYER_L1 = "l1";
/** Settlement layer selected by a Masumi payload for a Hydra head. */
export const SETTLEMENT_LAYER_HYDRA = "hydra";

/**
 * Maximum allowed value for assetTransferMethod.
 */
export const ASSET_TRANSFER_METHOD_DEFAULT = "default";
/**
 * Marker for the Masumi smart-contract assetTransferMethod.
 */
export const ASSET_TRANSFER_METHOD_MASUMI = "masumi";
/**
 * Marker for the script assetTransferMethod.
 */
export const ASSET_TRANSFER_METHOD_SCRIPT = "script";

/**
 * Resolves the Cardano network ID embedded in the transaction body for a given
 * x402 network identifier.
 *
 * @param network - The x402 network identifier (e.g. "cardano:mainnet").
 * @returns The Cardano network ID (1 = mainnet, 0 = testnet).
 */
export function getCardanoNetworkId(network: string): number {
  switch (normalizeCardanoNetwork(network)) {
    case CARDANO_MAINNET_CAIP2:
      return CARDANO_NETWORK_ID_MAINNET;
    case CARDANO_PREPROD_CAIP2:
    case CARDANO_PREVIEW_CAIP2:
      return CARDANO_NETWORK_ID_TESTNET;
    default:
      throw new Error(`Unsupported Cardano network: ${network}`);
  }
}

/**
 * Returns true when the supplied network identifier is one of the Cardano
 * networks supported by this mechanism.
 *
 * @param network - The network identifier to validate.
 * @returns True if the network is a supported Cardano network.
 */
export function isCardanoNetwork(network: string): boolean {
  return (CARDANO_NETWORKS as readonly string[]).includes(normalizeCardanoNetwork(network));
}

/**
 * Error codes produced by the Cardano facilitator. Mirrors SVM/Aptos style for
 * easy log filtering.
 */
export const ERR_UNSUPPORTED_SCHEME = "unsupported_scheme";
/** Error: payload is missing required fields. */
export const ERR_INVALID_PAYLOAD = "invalid_exact_cardano_payload";
/** Error: canonical payment requirements are malformed. */
export const ERR_REQUIREMENTS_INVALID = "invalid_exact_cardano_requirements";
/** Error: declared and accepted networks differ. */
export const ERR_NETWORK_MISMATCH = "network_mismatch";
/** Error: signed transaction could not be CBOR decoded. */
export const ERR_TRANSACTION_DECODE_FAILED =
  "invalid_exact_cardano_payload_transaction_decode_failed";
/** Error: transaction targets a different Cardano network than required. */
export const ERR_NETWORK_ID_MISMATCH = "invalid_exact_cardano_payload_network_id_mismatch";
/** Error: transaction has no output going to the requirements.payTo address. */
export const ERR_RECIPIENT_MISMATCH = "invalid_exact_cardano_payload_recipient_mismatch";
/** Error: matching output exists but pays a different asset. */
export const ERR_ASSET_MISMATCH = "invalid_exact_cardano_payload_asset_mismatch";
/** Error: matching output pays the right asset but not enough of it. */
export const ERR_AMOUNT_INSUFFICIENT = "invalid_exact_cardano_payload_amount_insufficient";
/** Error: nonce UTXO reference is missing or malformed. */
export const ERR_NONCE_INVALID = "invalid_exact_cardano_payload_nonce_invalid";
/** Error: nonce UTXO is not present as one of the transaction inputs. */
export const ERR_NONCE_NOT_IN_INPUTS = "invalid_exact_cardano_payload_nonce_not_in_inputs";
/** Error: nonce UTXO no longer exists on chain (already spent or never existed). */
export const ERR_NONCE_NOT_ON_CHAIN = "invalid_exact_cardano_payload_nonce_not_on_chain";
/** Error: a transaction input is no longer available (spent) — the tx would be rejected at submission. */
export const ERR_INPUT_NOT_AVAILABLE = "invalid_exact_cardano_payload_input_not_available";
/** Error: transaction TTL has already passed. */
export const ERR_TTL_EXPIRED = "invalid_exact_cardano_payload_ttl_expired";
/** Error: transaction's lower validity bound is in the future. */
export const ERR_VALIDITY_NOT_YET_VALID = "invalid_exact_cardano_payload_not_yet_valid";
/** Error: facilitator could not perform an on-chain lookup needed for verification. */
export const ERR_CHAIN_LOOKUP_FAILED = "exact_cardano_facilitator_chain_lookup_failed";
/** Error: settlement failed when submitting the transaction. */
export const ERR_SETTLEMENT_FAILED = "exact_cardano_settlement_failed";
/** Error: the node definitively rejected the transaction before ledger acceptance. */
export const ERR_SETTLEMENT_DEFINITIVELY_REJECTED =
  "exact_cardano_settlement_definitively_rejected";
/** Error: facilitator declined a `mempool`-only settlement and `acceptMempool` is disabled. */
export const ERR_SETTLEMENT_NOT_CONFIRMED = "exact_cardano_settlement_not_confirmed";
/** Error: duplicate settlement detected within the cache window. */
export const ERR_DUPLICATE_SETTLEMENT = "duplicate_settlement";
/** Error: a paid retry quotes Masumi terms this resource server never issued. */
export const ERR_MASUMI_TERMS_UNKNOWN = "masumi_terms_unknown";
/** Error: a paid retry altered the Masumi requirements it was issued. */
export const ERR_MASUMI_TERMS_MISMATCH = "masumi_terms_mismatch";
/** Error: the transaction is valid but has not yet reached the required evidence level. */
export const ERR_PAYMENT_PENDING = "payment_pending";
/** Error: the script assetTransferMethod was selected but reconstruction failed. */
export const ERR_SCRIPT_ADDRESS_MISMATCH = "invalid_exact_cardano_payload_script_address_mismatch";
/** Error: transaction is not signed (no vkey/bootstrap witnesses present). */
export const ERR_TRANSACTION_UNSIGNED = "invalid_exact_cardano_payload_unsigned";
/** Error: a vkey witness signature is not valid over the transaction body. */
export const ERR_INVALID_SIGNATURE = "invalid_exact_cardano_payload_invalid_signature";
/**
 * Error: the transaction is a failed-script (phase-2 invalid) transaction. It
 * lands under its own id but consumes collateral instead of its inputs and
 * creates none of its declared outputs, so it pays nothing.
 */
export const ERR_TRANSACTION_PHASE2_INVALID = "invalid_exact_cardano_payload_phase2_invalid";
/** Error: transaction fails complete Cardano ledger phase-1 validation. */
export const ERR_TRANSACTION_PHASE1_INVALID = "invalid_exact_cardano_payload_phase1_invalid";
/** Error: the recipient output's lovelace is below the protocol min-UTXO. */
export const ERR_MIN_UTXO_INSUFFICIENT = "invalid_exact_cardano_payload_min_utxo_insufficient";
/** Error: masumi payTo is not the known Masumi escrow address for the network. */
export const ERR_MASUMI_CONTRACT_MISMATCH =
  "invalid_exact_cardano_payload_masumi_contract_mismatch";
/** Error: the masumi escrow output carries no inline datum. */
export const ERR_MASUMI_DATUM_MISSING = "invalid_exact_cardano_payload_masumi_datum_missing";
/** Error: the masumi lock datum does not match the requirements' extra fields. */
export const ERR_MASUMI_DATUM_MISMATCH = "invalid_exact_cardano_payload_masumi_datum_mismatch";
/** Error: the masumi lock datum is structurally invalid or violates lock invariants. */
export const ERR_MASUMI_DATUM_INVALID = "invalid_exact_cardano_payload_masumi_datum_invalid";
/** Error: the tx validity upper bound is not on/before the datum's pay_by_time. */
export const ERR_MASUMI_DEADLINE = "invalid_exact_cardano_payload_masumi_deadline";
/** Error: collateral_return_lovelace violates the floor / ceiling / amount rules. */
export const ERR_MASUMI_COLLATERAL = "invalid_exact_cardano_payload_masumi_collateral";
/** Error: the escrow output lovelace is below the (post-result) min-UTXO. */
export const ERR_MASUMI_MIN_UTXO = "invalid_exact_cardano_payload_masumi_min_utxo";
/** Error: the escrow output carries a reference script (must not be set). */
export const ERR_MASUMI_REFERENCE_SCRIPT = "invalid_exact_cardano_payload_masumi_reference_script";
/** Error: the escrow output does not carry the requested asset/amount. */
export const ERR_MASUMI_ASSET = "invalid_exact_cardano_payload_masumi_asset";
/** Error: `extra.submissionPolicy` / `extra.confirmationPolicy` is malformed. */
export const ERR_POLICY_INVALID = "invalid_exact_cardano_requirements_policy";
/** Error: the normalized `payload.submissionMode` is not allowed by `submissionPolicy`. */
export const ERR_SUBMISSION_MODE_MISMATCH =
  "invalid_exact_cardano_payload_submission_mode_mismatch";
/** Error: the TTL is later than now + `maxTimeoutSeconds` (rule 7 upper bound). */
export const ERR_TTL_TOO_FAR = "invalid_exact_cardano_payload_ttl_too_far";
/** Error: client mode requires authenticated evidence the facilitator cannot obtain. */
export const ERR_EVIDENCE_UNAVAILABLE = "exact_cardano_facilitator_evidence_unavailable";
/** Error: client-mode evidence does not prove the exact transaction consumed the nonce. */
export const ERR_EVIDENCE_MISMATCH = "invalid_exact_cardano_payload_evidence_mismatch";
/** Error: the payload selected a settlement layer this facilitator does not support. */
export const ERR_SETTLEMENT_LAYER_UNSUPPORTED =
  "invalid_exact_cardano_payload_settlement_layer_unsupported";
/** Error: `payload.settlementLayer` is not allowed by `terms.settlementPolicy`. */
export const ERR_SETTLEMENT_LAYER_MISMATCH =
  "invalid_exact_cardano_payload_settlement_layer_mismatch";
/** Error: the masumi `extra` block violates the closed-object wire schema. */
export const ERR_MASUMI_SCHEMA = "invalid_exact_cardano_requirements_masumi_schema";
/** Error: an `inputCommitment` part digest or the commitment digest does not recompute. */
export const ERR_MASUMI_COMMITMENT = "invalid_exact_cardano_requirements_masumi_commitment";
/** Error: the seller's COSE authorization over `termsDigest` does not verify. */
export const ERR_MASUMI_SELLER_SIGNATURE =
  "invalid_exact_cardano_requirements_masumi_seller_signature";
/** Error: `blockchainIdentifier` does not decode to the reconstructed identifier. */
export const ERR_MASUMI_IDENTIFIER = "invalid_exact_cardano_requirements_masumi_identifier";
/** Error: `agentIdentifier` does not carry the Masumi V2 registry policy id. */
export const ERR_MASUMI_AGENT_IDENTIFIER =
  "invalid_exact_cardano_requirements_masumi_agent_identifier";
/** Error: the derived deployment escrow address does not equal `payTo`. */
export const ERR_MASUMI_DEPLOYMENT = "invalid_exact_cardano_requirements_masumi_deployment";
/** Error: the transaction carries more than one output at the escrow address. */
export const ERR_MASUMI_ESCROW_OUTPUT_COUNT =
  "invalid_exact_cardano_payload_masumi_escrow_output_count";
