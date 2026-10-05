"""Cardano network, asset and error constants from the exact scheme."""

import re

CARDANO_MAINNET_CAIP2 = "cardano:mainnet"
CARDANO_PREPROD_CAIP2 = "cardano:preprod"
CARDANO_PREVIEW_CAIP2 = "cardano:preview"
CARDANO_MAINNET_CIP34 = "cip34:1-764824073"
CARDANO_PREPROD_CIP34 = "cip34:0-1"
CARDANO_PREVIEW_CIP34 = "cip34:0-2"
CARDANO_NETWORK_ID_MAINNET = 1
CARDANO_NETWORK_ID_TESTNET = 0
SCHEME_EXACT = "exact"
USDM_MAINNET_POLICY_ID = "c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad"
USDM_PREPROD_POLICY_ID = "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9"
USDM_ASSET_NAME_HEX = "0014df105553444d"
USDM_ASSET_NAME_HEX_PREPROD = "0014df10745553444d"
USDM_MAINNET_ASSET = f"{USDM_MAINNET_POLICY_ID}.{USDM_ASSET_NAME_HEX}"
USDM_PREPROD_ASSET = f"{USDM_PREPROD_POLICY_ID}.{USDM_ASSET_NAME_HEX_PREPROD}"
USDM_DEFAULT_DECIMALS = 6
LOVELACE_ASSET = "lovelace"
CARDANO_MIN_UTXO_OVERHEAD_BYTES = 160
DEFAULT_L1_CONFIRMATIONS = 1
MIN_L1_CONFIRMATIONS = -1
MAX_L1_CONFIRMATIONS = 20
ASSET_TRANSFER_METHOD_DEFAULT = "default"
ASSET_TRANSFER_METHOD_MASUMI = "masumi"
ASSET_TRANSFER_METHOD_SCRIPT = "script"
ERR_UNSUPPORTED_SCHEME = "unsupported_scheme"
ERR_INVALID_PAYLOAD = "invalid_exact_cardano_payload"
ERR_REQUIREMENTS_INVALID = "invalid_exact_cardano_requirements"
ERR_NETWORK_MISMATCH = "network_mismatch"
ERR_TRANSACTION_DECODE_FAILED = "invalid_exact_cardano_payload_transaction_decode_failed"
ERR_NETWORK_ID_MISMATCH = "invalid_exact_cardano_payload_network_id_mismatch"
ERR_RECIPIENT_MISMATCH = "invalid_exact_cardano_payload_recipient_mismatch"
ERR_ASSET_MISMATCH = "invalid_exact_cardano_payload_asset_mismatch"
ERR_AMOUNT_INSUFFICIENT = "invalid_exact_cardano_payload_amount_insufficient"
ERR_NONCE_INVALID = "invalid_exact_cardano_payload_nonce_invalid"
ERR_NONCE_NOT_IN_INPUTS = "invalid_exact_cardano_payload_nonce_not_in_inputs"
ERR_NONCE_NOT_ON_CHAIN = "invalid_exact_cardano_payload_nonce_not_on_chain"
ERR_INPUT_NOT_AVAILABLE = "invalid_exact_cardano_payload_input_not_available"
ERR_TTL_EXPIRED = "invalid_exact_cardano_payload_ttl_expired"
ERR_VALIDITY_NOT_YET_VALID = "invalid_exact_cardano_payload_not_yet_valid"
ERR_CHAIN_LOOKUP_FAILED = "exact_cardano_facilitator_chain_lookup_failed"
ERR_SETTLEMENT_FAILED = "exact_cardano_settlement_failed"
ERR_SETTLEMENT_DEFINITIVELY_REJECTED = "exact_cardano_settlement_definitively_rejected"
ERR_SETTLEMENT_NOT_CONFIRMED = "exact_cardano_settlement_not_confirmed"
ERR_DUPLICATE_SETTLEMENT = "duplicate_settlement"
ERR_MASUMI_TERMS_UNKNOWN = "masumi_terms_unknown"
ERR_MASUMI_TERMS_MISMATCH = "masumi_terms_mismatch"
ERR_SETTLEMENT_PENDING = "settlement_pending"
ERR_SCRIPT_ADDRESS_MISMATCH = "invalid_exact_cardano_payload_script_address_mismatch"
ERR_TRANSACTION_UNSIGNED = "invalid_exact_cardano_payload_unsigned"
ERR_INVALID_SIGNATURE = "invalid_exact_cardano_payload_invalid_signature"
ERR_TRANSACTION_PHASE2_INVALID = "invalid_exact_cardano_payload_phase2_invalid"
ERR_TRANSACTION_PHASE1_INVALID = "invalid_exact_cardano_payload_phase1_invalid"
ERR_VALUE_NOT_CONSERVED = "invalid_exact_cardano_payload_value_not_conserved"
ERR_FEE_BELOW_MINIMUM = "invalid_exact_cardano_payload_fee_below_minimum"
ERR_INPUT_VALUE_UNAVAILABLE = "exact_cardano_facilitator_input_value_unavailable"
ERR_MIN_UTXO_INSUFFICIENT = "invalid_exact_cardano_payload_min_utxo_insufficient"
ERR_MASUMI_CONTRACT_MISMATCH = "invalid_exact_cardano_payload_masumi_contract_mismatch"
ERR_MASUMI_DATUM_MISSING = "invalid_exact_cardano_payload_masumi_datum_missing"
ERR_MASUMI_DATUM_MISMATCH = "invalid_exact_cardano_payload_masumi_datum_mismatch"
ERR_MASUMI_DATUM_INVALID = "invalid_exact_cardano_payload_masumi_datum_invalid"
ERR_MASUMI_DEADLINE = "invalid_exact_cardano_payload_masumi_deadline"
ERR_MASUMI_COLLATERAL = "invalid_exact_cardano_payload_masumi_collateral"
ERR_MASUMI_MIN_UTXO = "invalid_exact_cardano_payload_masumi_min_utxo"
ERR_MASUMI_REFERENCE_SCRIPT = "invalid_exact_cardano_payload_masumi_reference_script"
ERR_MASUMI_ASSET = "invalid_exact_cardano_payload_masumi_asset"
ERR_POLICY_INVALID = "invalid_exact_cardano_requirements_policy"
ERR_TTL_TOO_FAR = "invalid_exact_cardano_payload_ttl_too_far"
ERR_EVIDENCE_UNAVAILABLE = "exact_cardano_facilitator_evidence_unavailable"
ERR_MASUMI_SCHEMA = "invalid_exact_cardano_requirements_masumi_schema"
ERR_MASUMI_COMMITMENT = "invalid_exact_cardano_requirements_masumi_commitment"
ERR_MASUMI_SELLER_SIGNATURE = "invalid_exact_cardano_requirements_masumi_seller_signature"
ERR_MASUMI_IDENTIFIER = "invalid_exact_cardano_requirements_masumi_identifier"
ERR_MASUMI_AGENT_IDENTIFIER = "invalid_exact_cardano_requirements_masumi_agent_identifier"
ERR_MASUMI_DEPLOYMENT = "invalid_exact_cardano_requirements_masumi_deployment"
ERR_MASUMI_ESCROW_OUTPUT_COUNT = "invalid_exact_cardano_payload_masumi_escrow_output_count"

CARDANO_NETWORKS = (CARDANO_MAINNET_CAIP2, CARDANO_PREPROD_CAIP2, CARDANO_PREVIEW_CAIP2)
CARDANO_NETWORK_ALIASES = {
    CARDANO_MAINNET_CIP34: CARDANO_MAINNET_CAIP2,
    CARDANO_PREPROD_CIP34: CARDANO_PREPROD_CAIP2,
    CARDANO_PREVIEW_CIP34: CARDANO_PREVIEW_CAIP2,
}

CARDANO_ASSET_REGEX = re.compile(r"^(lovelace|[0-9a-fA-F]{56}\.[0-9a-fA-F]{0,64})$")
CANONICAL_CARDANO_ASSET_REGEX = re.compile(r"^(lovelace|[0-9a-f]{56}\.[0-9a-f]{0,64})$")
POSITIVE_CANONICAL_AMOUNT_REGEX = re.compile(r"^[1-9][0-9]*$")
CARDANO_ADDRESS_REGEX = re.compile(r"^(addr1|addr_test1)[0-9a-z]+$")
CARDANO_UTXO_REF_REGEX = re.compile(r"^[0-9a-fA-F]{64}#\d+$")


def normalize_cardano_network(network: str) -> str:
    """Resolve accepted CIP-34 aliases to the advertised network identifier."""
    return CARDANO_NETWORK_ALIASES.get(network, network)


def is_cardano_network(network: str) -> bool:
    """Whether a network or alias identifies a supported Cardano chain."""
    return normalize_cardano_network(network) in CARDANO_NETWORKS


def get_cardano_network_id(network: str) -> int:
    """Return the address/body network id; reject unknown chains."""
    canonical = normalize_cardano_network(network)
    if canonical not in CARDANO_NETWORKS:
        raise ValueError(f"Unsupported Cardano network: {network}")
    return 1 if canonical == CARDANO_MAINNET_CAIP2 else 0
