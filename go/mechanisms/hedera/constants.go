package hedera

import "time"

const (
	// SchemeExact is the scheme identifier for exact payments.
	SchemeExact = "exact"

	// Asset transfer methods defined by the exact Hedera spec. Absent means cryptoTransfer.
	AssetTransferMethodCryptoTransfer   = "cryptoTransfer"
	AssetTransferMethodTransferExecutor = "transferExecutor"

	// HBARAssetID is the x402 asset id for native HBAR (tinybars).
	HBARAssetID = "0.0.0"

	// CAIP-2 network identifiers.
	HederaMainnetCAIP2 = "hedera:mainnet"
	HederaTestnetCAIP2 = "hedera:testnet"

	// Mirror Node REST API base URLs.
	HederaMainnetMirrorNodeURL = "https://mainnet-public.mirrornode.hedera.com"
	HederaTestnetMirrorNodeURL = "https://testnet.mirrornode.hedera.com"

	// Circle USDC token ids.
	HederaMainnetUSDC = "0.0.456858"
	HederaTestnetUSDC = "0.0.429274"

	// HederaUSDCDecimals is USDC decimals on Hedera.
	HederaUSDCDecimals = 6

	// Alias policy values for payTo resolution.
	AliasPolicyReject = "reject"
	AliasPolicyAllow  = "allow"

	// SettlementTTL is how long a transaction stays in the duplicate settlement cache.
	SettlementTTL = 120 * time.Second
)
