package svm

import (
	"time"

	"github.com/gagliardetto/solana-go/rpc"
)

const (
	// SchemeExact is the scheme identifier for exact payments
	SchemeExact = "exact"

	// DefaultDecimals is the default token decimals for USDC
	DefaultDecimals = 6

	// DefaultComputeUnitPriceMicrolamports is the default compute unit price in microlamports
	DefaultComputeUnitPriceMicrolamports = 1

	// MaxComputeUnitPriceMicrolamports is the maximum compute unit price in microlamports (facilitator validation limit)
	// 5 lamports = 5,000,000 microlamports
	MaxComputeUnitPriceMicrolamports = 5_000_000

	// DefaultComputeUnitLimit is the default compute unit limit for transactions
	// Set to 20000 to accommodate: transfer (~6200 CUs) + memo (~8500 CUs without signer) + budget instructions (~300 CUs) + headroom
	DefaultComputeUnitLimit uint32 = 20000

	// LighthouseProgramAddress is the Phantom/Solflare Lighthouse program address
	// Phantom and Solflare wallets inject Lighthouse instructions for user protection on mainnet transactions.
	// - Phantom adds 1 Lighthouse instruction (4th instruction)
	// - Solflare adds 2 Lighthouse instructions (4th and 5th instructions)
	// We allow these as optional instructions to support these wallets.
	// See: https://github.com/coinbase/x402/issues/828
	LighthouseProgramAddress = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95"

	// MemoProgramAddress is the SPL Memo program address
	MemoProgramAddress = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"

	// DefaultCommitment is the default commitment level for transactions
	DefaultCommitment = rpc.CommitmentConfirmed

	// MaxConfirmAttempts is the maximum number of confirmation attempts
	MaxConfirmAttempts = 30

	// ConfirmRetryDelay is the base delay between confirmation attempts
	ConfirmRetryDelay = 1 * time.Second

	// SettlementTTL is how long a transaction is held in the duplicate settlement cache.
	// Covers the Solana blockhash lifetime (~60-90s) with margin.
	SettlementTTL = 120 * time.Second

	// CAIP-2 network identifiers (V2)
	SolanaMainnetCAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
	SolanaDevnetCAIP2  = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
	SolanaTestnetCAIP2 = "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z"

	// V1 network names
	SolanaMainnetV1 = "solana"
	SolanaDevnetV1  = "solana-devnet"
	SolanaTestnetV1 = "solana-testnet"

	// USDC mint addresses
	USDCMainnetAddress = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
	USDCDevnetAddress  = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
	USDCTestnetAddress = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" // Same as devnet
)

var (
	// NetworkConfigs maps CAIP-2 identifiers to network configurations
	// See DEFAULT_ASSET.md for guidelines on adding new networks
	NetworkConfigs = map[string]NetworkConfig{
		SolanaMainnetCAIP2: {
			Name:   "Solana Mainnet",
			CAIP2:  SolanaMainnetCAIP2,
			RPCURL: "https://api.mainnet-beta.solana.com",
			DefaultAsset: AssetInfo{
				Address:  USDCMainnetAddress,
				Symbol:   "USDC",
				Decimals: DefaultDecimals,
			},
		},
		SolanaDevnetCAIP2: {
			Name:   "Solana Devnet",
			CAIP2:  SolanaDevnetCAIP2,
			RPCURL: "https://api.devnet.solana.com",
			DefaultAsset: AssetInfo{
				Address:  USDCDevnetAddress,
				Symbol:   "USDC",
				Decimals: DefaultDecimals,
			},
		},
		SolanaTestnetCAIP2: {
			Name:   "Solana Testnet",
			CAIP2:  SolanaTestnetCAIP2,
			RPCURL: "https://api.testnet.solana.com",
			DefaultAsset: AssetInfo{
				Address:  USDCTestnetAddress,
				Symbol:   "USDC",
				Decimals: DefaultDecimals,
			},
		},
	}

	// V1ToV2NetworkMap maps V1 network names to CAIP-2 identifiers
	V1ToV2NetworkMap = map[string]string{
		SolanaMainnetV1: SolanaMainnetCAIP2,
		SolanaDevnetV1:  SolanaDevnetCAIP2,
		SolanaTestnetV1: SolanaTestnetCAIP2,
	}
)
