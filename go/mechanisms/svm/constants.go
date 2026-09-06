package svm

import (
	"time"

	"github.com/gagliardetto/solana-go/rpc"
)

const (
	// SchemeExact is the scheme identifier for exact payments
	SchemeExact = "exact"

	// SchemeUpto is the scheme identifier for usage-based payments
	SchemeUpto = "upto"

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

	// MaxMemoBytes is the maximum byte length for seller-defined memo data (extra.memo)
	MaxMemoBytes = 256

	// LighthouseProgramAddress is the wallet-protection program some Solana wallets
	// inject into signed transactions. Path 1 accepts up to 3 Lighthouse instructions
	// plus an optional memo, in any order after ComputeLimit + ComputePrice + TransferChecked.
	LighthouseProgramAddress = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95"

	// MemoProgramAddress is the SPL Memo program address
	MemoProgramAddress = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"

	// DefaultCommitment is the default commitment level for transactions
	DefaultCommitment = rpc.CommitmentConfirmed

	// ConfirmInitialRetryDelay is the delay for the first ConfirmInitialAttempts
	// confirmation polls. Solana slots are ~400ms; a 250ms poll catches a
	// confirmation in the same slot window instead of waiting a full second.
	ConfirmInitialRetryDelay = 250 * time.Millisecond

	// ConfirmInitialAttempts is how many confirmation polls use ConfirmInitialRetryDelay
	// before falling back to ConfirmRetryDelay. 8×250ms + 28×1s preserves the
	// ~30s budget of the previous 30×1s loop.
	ConfirmInitialAttempts = 8

	// MaxConfirmAttempts is the maximum number of confirmation attempts
	MaxConfirmAttempts = 36

	// ConfirmRetryDelay is the delay between confirmation attempts after the
	// initial fast-poll window.
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

	// Supported stablecoin mint addresses beyond USDC.
	USDTMainnetAddress = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"

	USDGMainnetAddress = "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH"
	USDGDevnetAddress  = "4F6PM96JJxngmHnZLBh9n58RH4aTVNWvDs2nuwrT5BP7"
	USDGTestnetAddress = "4F6PM96JJxngmHnZLBh9n58RH4aTVNWvDs2nuwrT5BP7" // Same as devnet

	PYUSDMainnetAddress = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo"
	PYUSDDevnetAddress  = "CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM"
	PYUSDTestnetAddress = "CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM" // Same as devnet

	CASHMainnetAddress = "CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH"

	// Default RPC endpoints for Solana networks.
	MainnetRPCURL = "https://api.mainnet-beta.solana.com"
	DevnetRPCURL  = "https://api.devnet.solana.com"
	TestnetRPCURL = "https://api.testnet.solana.com"

	// Default WebSocket endpoints for Solana networks.
	MainnetWSURL = "wss://api.mainnet-beta.solana.com"
	DevnetWSURL  = "wss://api.devnet.solana.com"
	TestnetWSURL = "wss://api.testnet.solana.com"

	// TokenProgramAddress and Token2022ProgramAddress are the SPL token programs,
	// identical on every Solana network.
	TokenProgramAddress     = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
	Token2022ProgramAddress = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"

	// StablecoinDecimals is the decimal precision of every mint in StablecoinMints.
	StablecoinDecimals = 6
)

var (
	// StablecoinMints maps a supported stablecoin symbol to its mint per network.
	// Symbols without a devnet/testnet mint fall back to their mainnet mint.
	StablecoinMints = map[string]map[string]string{
		"USDC": {
			networkKeyMainnet: USDCMainnetAddress,
			networkKeyDevnet:  USDCDevnetAddress,
			networkKeyTestnet: USDCTestnetAddress,
		},
		"USDT": {
			networkKeyMainnet: USDTMainnetAddress,
		},
		"USDG": {
			networkKeyMainnet: USDGMainnetAddress,
			networkKeyDevnet:  USDGDevnetAddress,
			networkKeyTestnet: USDGTestnetAddress,
		},
		"PYUSD": {
			networkKeyMainnet: PYUSDMainnetAddress,
			networkKeyDevnet:  PYUSDDevnetAddress,
			networkKeyTestnet: PYUSDTestnetAddress,
		},
		"CASH": {
			networkKeyMainnet: CASHMainnetAddress,
		},
	}

	// StablecoinTokenPrograms maps a supported stablecoin symbol to the token
	// program that owns its mint. Anything unrecognized defaults to SPL Token.
	StablecoinTokenPrograms = map[string]string{
		"USDC":  TokenProgramAddress,
		"USDT":  TokenProgramAddress,
		"USDG":  Token2022ProgramAddress,
		"PYUSD": Token2022ProgramAddress,
		"CASH":  Token2022ProgramAddress,
	}
)

// Network keys for the per-network stablecoin mint lookup.
const (
	networkKeyMainnet = "mainnet"
	networkKeyDevnet  = "devnet"
	networkKeyTestnet = "testnet"
)

var (
	// NetworkConfigs maps CAIP-2 network identifiers to transport endpoints.
	// Default assets live in DefaultAssets, not here.
	NetworkConfigs = map[string]NetworkConfig{
		SolanaMainnetCAIP2: {RPCURL: MainnetRPCURL, WSURL: MainnetWSURL},
		SolanaDevnetCAIP2:  {RPCURL: DevnetRPCURL, WSURL: DevnetWSURL},
		SolanaTestnetCAIP2: {RPCURL: TestnetRPCURL, WSURL: TestnetWSURL},
	}

	// V1ToV2NetworkMap maps V1 network names to CAIP-2 identifiers
	V1ToV2NetworkMap = map[string]string{
		SolanaMainnetV1: SolanaMainnetCAIP2,
		SolanaDevnetV1:  SolanaDevnetCAIP2,
		SolanaTestnetV1: SolanaTestnetCAIP2,
	}
)
