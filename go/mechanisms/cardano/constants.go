package cardano

import (
	"regexp"

	x402 "github.com/x402-foundation/x402/go/v2"
)

// Canonical CAIP-2 identifiers advertised by the Cardano mechanism.
const (
	CardanoMainnetCAIP2 = "cardano:mainnet"
	CardanoPreprodCAIP2 = "cardano:preprod"
	CardanoPreviewCAIP2 = "cardano:preview"
)

// CIP-34 aliases accepted on input and normalized to the canonical identifiers.
const (
	CardanoMainnetCIP34 = "cip34:1-764824073"
	CardanoPreprodCIP34 = "cip34:0-1"
	CardanoPreviewCIP34 = "cip34:0-2"
)

// CardanoNetworks lists the canonical networks in advertisement order.
var CardanoNetworks = []string{CardanoMainnetCAIP2, CardanoPreprodCAIP2, CardanoPreviewCAIP2}

var networkAliases = map[string]string{
	CardanoMainnetCIP34: CardanoMainnetCAIP2,
	CardanoPreprodCIP34: CardanoPreprodCAIP2,
	CardanoPreviewCIP34: CardanoPreviewCAIP2,
}

// Ledger network ids carried in addresses and the transaction body.
const (
	NetworkIDMainnet = 1
	NetworkIDTestnet = 0
)

const (
	// SchemeExact is the scheme identifier for exact payments.
	SchemeExact = "exact"

	// CaipFamily groups all Cardano networks in /supported.
	CaipFamily = "cardano:*"

	// LovelaceAsset is the asset unit of ADA.
	LovelaceAsset = "lovelace"

	// MinUtxoOverheadBytes is the ledger's per-output overhead in the min-UTxO formula.
	MinUtxoOverheadBytes = 160
)

// USDM default assets (CIP-68 fungible token names).
const (
	USDMMainnetPolicyID     = "c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad"
	USDMPreprodPolicyID     = "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9"
	USDMAssetNameHex        = "0014df105553444d"
	USDMAssetNameHexPreprod = "0014df10745553444d"
	USDMMainnetAsset        = USDMMainnetPolicyID + "." + USDMAssetNameHex
	USDMPreprodAsset        = USDMPreprodPolicyID + "." + USDMAssetNameHexPreprod
	USDMDefaultDecimals     = 6
)

// Confirmation policy bounds; -1 is mempool acceptance, 0 block inclusion.
const (
	DefaultL1Confirmations = 1
	MinL1Confirmations     = -1
	MaxL1Confirmations     = 20
)

// Asset transfer methods.
const (
	AssetTransferMethodDefault = "default"
	AssetTransferMethodMasumi  = "masumi"
	AssetTransferMethodScript  = "script"
)

var (
	assetRegex          = regexp.MustCompile(`^(lovelace|[0-9a-fA-F]{56}\.[0-9a-fA-F]{0,64})$`)
	canonicalAssetRegex = regexp.MustCompile(`^(lovelace|[0-9a-f]{56}\.[0-9a-f]{0,64})$`)
	positiveAmountRegex = regexp.MustCompile(`^[1-9][0-9]*$`)
	addressRegex        = regexp.MustCompile(`^(addr1|addr_test1)[0-9a-z]+$`)
	utxoRefRegex        = regexp.MustCompile(`^[0-9a-fA-F]{64}#\d+$`)
)

// Error reasons. Values are wire-visible and identical to the TypeScript SDK.
const (
	ErrUnsupportedScheme              = "unsupported_scheme"
	ErrInvalidPayload                 = "invalid_exact_cardano_payload"
	ErrRequirementsInvalid            = "invalid_exact_cardano_requirements"
	ErrNetworkMismatch                = "network_mismatch"
	ErrTransactionDecodeFailed        = "invalid_exact_cardano_payload_transaction_decode_failed"
	ErrNetworkIDMismatch              = "invalid_exact_cardano_payload_network_id_mismatch"
	ErrRecipientMismatch              = "invalid_exact_cardano_payload_recipient_mismatch"
	ErrAssetMismatch                  = "invalid_exact_cardano_payload_asset_mismatch"
	ErrAmountInsufficient             = "invalid_exact_cardano_payload_amount_insufficient"
	ErrNonceInvalid                   = "invalid_exact_cardano_payload_nonce_invalid"
	ErrNonceNotInInputs               = "invalid_exact_cardano_payload_nonce_not_in_inputs"
	ErrNonceNotOnChain                = "invalid_exact_cardano_payload_nonce_not_on_chain"
	ErrInputNotAvailable              = "invalid_exact_cardano_payload_input_not_available"
	ErrTTLExpired                     = "invalid_exact_cardano_payload_ttl_expired"
	ErrValidityNotYetValid            = "invalid_exact_cardano_payload_not_yet_valid"
	ErrChainLookupFailed              = "exact_cardano_facilitator_chain_lookup_failed"
	ErrSettlementFailed               = "exact_cardano_settlement_failed"
	ErrSettlementDefinitivelyRejected = "exact_cardano_settlement_definitively_rejected"
	ErrSettlementNotConfirmed         = "exact_cardano_settlement_not_confirmed"
	ErrDuplicateSettlement            = "duplicate_settlement"
	ErrMasumiTermsUnknown             = "masumi_terms_unknown"
	ErrMasumiTermsMismatch            = "masumi_terms_mismatch"
	ErrSettlementPending              = x402.ErrSettlementPending
	ErrScriptAddressMismatch          = "invalid_exact_cardano_payload_script_address_mismatch"
	ErrTransactionUnsigned            = "invalid_exact_cardano_payload_unsigned"
	ErrInvalidSignature               = "invalid_exact_cardano_payload_invalid_signature"
	ErrTransactionPhase2Invalid       = "invalid_exact_cardano_payload_phase2_invalid"
	ErrTransactionPhase1Invalid       = "invalid_exact_cardano_payload_phase1_invalid"
	ErrValueNotConserved              = "invalid_exact_cardano_payload_value_not_conserved"
	ErrFeeBelowMinimum                = "invalid_exact_cardano_payload_fee_below_minimum"
	ErrInputValueUnavailable          = "exact_cardano_facilitator_input_value_unavailable"
	ErrMinUtxoInsufficient            = "invalid_exact_cardano_payload_min_utxo_insufficient"
	ErrMasumiContractMismatch         = "invalid_exact_cardano_payload_masumi_contract_mismatch"
	ErrMasumiDatumMissing             = "invalid_exact_cardano_payload_masumi_datum_missing"
	ErrMasumiDatumMismatch            = "invalid_exact_cardano_payload_masumi_datum_mismatch"
	ErrMasumiDatumInvalid             = "invalid_exact_cardano_payload_masumi_datum_invalid"
	ErrMasumiDeadline                 = "invalid_exact_cardano_payload_masumi_deadline"
	ErrMasumiCollateral               = "invalid_exact_cardano_payload_masumi_collateral"
	ErrMasumiMinUtxo                  = "invalid_exact_cardano_payload_masumi_min_utxo"
	ErrMasumiReferenceScript          = "invalid_exact_cardano_payload_masumi_reference_script"
	ErrMasumiAsset                    = "invalid_exact_cardano_payload_masumi_asset"
	ErrPolicyInvalid                  = "invalid_exact_cardano_requirements_policy"
	ErrTTLTooFar                      = "invalid_exact_cardano_payload_ttl_too_far"
	ErrEvidenceUnavailable            = "exact_cardano_facilitator_evidence_unavailable"
	ErrMasumiSchema                   = "invalid_exact_cardano_requirements_masumi_schema"
	ErrMasumiCommitment               = "invalid_exact_cardano_requirements_masumi_commitment"
	ErrMasumiSellerSignature          = "invalid_exact_cardano_requirements_masumi_seller_signature"
	ErrMasumiIdentifier               = "invalid_exact_cardano_requirements_masumi_identifier"
	ErrMasumiAgentIdentifier          = "invalid_exact_cardano_requirements_masumi_agent_identifier"
	ErrMasumiDeployment               = "invalid_exact_cardano_requirements_masumi_deployment"
	ErrMasumiEscrowOutputCount        = "invalid_exact_cardano_payload_masumi_escrow_output_count"
)
