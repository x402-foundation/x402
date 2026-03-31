package evm

import (
	"math/big"
)

const (
	// Scheme identifiers
	SchemeExact = "exact"
	SchemeUpto  = "upto"

	// Default token decimals for USDC
	DefaultDecimals = 6

	// EIP-3009 function names
	FunctionTransferWithAuthorization = "transferWithAuthorization"
	FunctionReceiveWithAuthorization  = "receiveWithAuthorization"
	FunctionAuthorizationState        = "authorizationState"
	FunctionTryAggregate              = "tryAggregate"

	// Permit2 function names
	FunctionSettle           = "settle"
	FunctionSettleWithPermit = "settleWithPermit"

	// Transaction status
	TxStatusSuccess = 1
	TxStatusFailed  = 0

	// Default validity period (1 hour)
	DefaultValidityPeriod = 3600 // seconds

	// ERC-6492 magic value (last 32 bytes of wrapped signature)
	// This is bytes32(uint256(keccak256("erc6492.invalid.signature")) - 1)
	ERC6492MagicValue = "0x6492649264926492649264926492649264926492649264926492649264926492"

	// EIP-1271 magic value (returned by isValidSignature on success)
	EIP1271MagicValue = "0x1626ba7e"

	// Shared error constants (used by verify_universal.go and other shared utilities)
	ErrUndeployedSmartWallet = "invalid_exact_evm_payload_undeployed_smart_wallet"

	// Permit2 constants
	// PERMIT2Address is the canonical Uniswap Permit2 contract address.
	// Same address on all EVM chains via CREATE2 deployment.
	PERMIT2Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3"

	// MULTICALL3Address is the canonical Multicall3 deployment address.
	// Same address on all EVM chains via CREATE2 deployment.
	MULTICALL3Address = "0xcA11bde05977b3631167028862bE2a173976CA11"

	// X402ExactPermit2ProxyAddress is the x402 exact payment proxy.
	// Vanity address: 0x4020...0001 for easy recognition.
	X402ExactPermit2ProxyAddress = "0x402085c248EeA27D92E8b30b2C58ed07f9E20001"

	// X402UptoPermit2ProxyAddress is the x402 upto payment proxy.
	// Vanity address: 0x4020...0002 for easy recognition.
	X402UptoPermit2ProxyAddress = "0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002"

	// Permit2DeadlineBuffer is the time buffer (in seconds) added when checking
	// deadline expiration to account for block propagation time.
	Permit2DeadlineBuffer = 6

	// ERC20ApproveGasLimit is the gas limit for a standard ERC-20 approve() transaction.
	ERC20ApproveGasLimit = 70000

	// DefaultMaxFeePerGas is the fallback max fee per gas (1 gwei) for gas cost estimation.
	DefaultMaxFeePerGas = 1_000_000_000
)

var (
	// Network chain IDs
	ChainIDBase        = big.NewInt(8453)
	ChainIDBaseSepolia = big.NewInt(84532)
	ChainIDMegaETH     = big.NewInt(4326)
	ChainIDMonad       = big.NewInt(143)
	ChainIDMezoTestnet = big.NewInt(31611)
	ChainIDStable      = big.NewInt(988)
	ChainIDPolygon     = big.NewInt(137)
	ChainIDArbOne      = big.NewInt(42161)
	ChainIDArbSepolia  = big.NewInt(421614)

	// Network configurations
	// See DEFAULT_ASSET.md for guidelines on adding new chains
	//
	// Default Asset Selection Policy:
	// - Each chain has the right to determine its own default stablecoin
	// - If the chain has officially endorsed a stablecoin, that asset should be used
	// - If no official stance exists, the chain team should make the selection
	//
	// Both EIP-3009 (transferWithAuthorization) and Permit2 asset transfer methods are supported.
	// EIP-3009 is the default. Set AssetTransferMethod to AssetTransferMethodPermit2 for tokens
	// that don't support EIP-3009. See DEFAULT_ASSET.md for details.
	NetworkConfigs = map[string]NetworkConfig{
		// Base Mainnet
		"eip155:8453": {
			ChainID: ChainIDBase,
			DefaultAsset: AssetInfo{
				Address:  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base
				Name:     "USD Coin",
				Version:  "2",
				Decimals: DefaultDecimals,
			},
		},
		// Base Sepolia Testnet
		"eip155:84532": {
			ChainID: ChainIDBaseSepolia,
			DefaultAsset: AssetInfo{
				Address:  "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // USDC on Base Sepolia
				Name:     "USDC",
				Version:  "2",
				Decimals: DefaultDecimals,
			},
		},
		// MegaETH Mainnet (uses Permit2 instead of EIP-3009, supports EIP-2612)
		"eip155:4326": {
			ChainID: ChainIDMegaETH,
			DefaultAsset: AssetInfo{
				Address:             "0xFAfDdbb3FC7688494971a79cc65DCa3EF82079E7", // USDM (MegaUSD)
				Name:                "MegaUSD",
				Version:             "1",
				Decimals:            18,
				AssetTransferMethod: AssetTransferMethodPermit2,
				SupportsEip2612:     true,
			},
		},
		// Monad Mainnet
		"eip155:143": {
			ChainID: ChainIDMonad,
			DefaultAsset: AssetInfo{
				Address:  "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", // USDC on Monad
				Name:     "USD Coin",
				Version:  "2",
				Decimals: DefaultDecimals,
			},
		},
		// Mezo Testnet (uses Permit2 instead of EIP-3009, supports EIP-2612)
		"eip155:31611": {
			ChainID: ChainIDMezoTestnet,
			DefaultAsset: AssetInfo{
				Address:             "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503", // mUSD on Mezo Testnet
				Name:                "Mezo USD",
				Version:             "1",
				Decimals:            18,
				AssetTransferMethod: AssetTransferMethodPermit2,
				SupportsEip2612:     true,
			},
		},
		// Stable Mainnet
		"eip155:988": {
			ChainID: ChainIDStable,
			DefaultAsset: AssetInfo{
				Address:  "0x779Ded0c9e1022225f8E0630b35a9b54bE713736", // USDT0 on Stable
				Name:     "USDT0",
				Version:  "1",
				Decimals: DefaultDecimals,
			},
		},
		// Polygon Mainnet
		"eip155:137": {
			ChainID: ChainIDPolygon,
			DefaultAsset: AssetInfo{
				Address:  "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", // USDC on Polygon
				Name:     "USD Coin",
				Version:  "2",
				Decimals: DefaultDecimals,
			},
		},

		// Arbitrum One
		"eip155:42161": {
			ChainID: ChainIDArbOne,
			DefaultAsset: AssetInfo{
				Address:  "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // USDC on ArbOne
				Name:     "USD Coin",
				Version:  "2",
				Decimals: DefaultDecimals,
			},
		},
		// Arbitrum Sepolia
		"eip155:421614": {
			ChainID: ChainIDArbSepolia,
			DefaultAsset: AssetInfo{
				Address:  "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", // USDC on ArbSepolia
				Name:     "USD Coin",
				Version:  "2",
				Decimals: DefaultDecimals,
			},
		},
	}

	// EIP-3009 ABI for transferWithAuthorization with v,r,s (EOA signatures)
	TransferWithAuthorizationVRSABI = []byte(`[
		{
			"inputs": [
				{"name": "from", "type": "address"},
				{"name": "to", "type": "address"},
				{"name": "value", "type": "uint256"},
				{"name": "validAfter", "type": "uint256"},
				{"name": "validBefore", "type": "uint256"},
				{"name": "nonce", "type": "bytes32"},
				{"name": "v", "type": "uint8"},
				{"name": "r", "type": "bytes32"},
				{"name": "s", "type": "bytes32"}
			],
			"name": "transferWithAuthorization",
			"outputs": [],
			"stateMutability": "nonpayable",
			"type": "function"
		}
	]`)

	// EIP-3009 ABI for transferWithAuthorization with bytes signature (smart wallets)
	TransferWithAuthorizationBytesABI = []byte(`[
		{
			"inputs": [
				{"name": "from", "type": "address"},
				{"name": "to", "type": "address"},
				{"name": "value", "type": "uint256"},
				{"name": "validAfter", "type": "uint256"},
				{"name": "validBefore", "type": "uint256"},
				{"name": "nonce", "type": "bytes32"},
				{"name": "signature", "type": "bytes"}
			],
			"name": "transferWithAuthorization",
			"outputs": [],
			"stateMutability": "nonpayable",
			"type": "function"
		}
	]`)

	// Legacy: Combined ABI (deprecated, use specific ABIs above)
	TransferWithAuthorizationABI = TransferWithAuthorizationVRSABI

	// ABI for authorizationState check
	AuthorizationStateABI = []byte(`[
		{
			"inputs": [
				{"name": "authorizer", "type": "address"},
				{"name": "nonce", "type": "bytes32"}
			],
			"name": "authorizationState",
			"outputs": [{"name": "", "type": "bool"}],
			"stateMutability": "view",
			"type": "function"
		}
	]`)

	// Multicall3TryAggregateABI batches arbitrary eth_call requests.
	Multicall3TryAggregateABI = []byte(`[
		{
			"inputs": [
				{"name": "requireSuccess", "type": "bool"},
				{
					"name": "calls",
					"type": "tuple[]",
					"components": [
						{"name": "target", "type": "address"},
						{"name": "callData", "type": "bytes"}
					]
				}
			],
			"name": "tryAggregate",
			"outputs": [
				{
					"name": "returnData",
					"type": "tuple[]",
					"components": [
						{"name": "success", "type": "bool"},
						{"name": "returnData", "type": "bytes"}
					]
				}
			],
			"stateMutability": "payable",
			"type": "function"
		}
	]`)

	// ERC20AllowanceABI for checking Permit2 approval
	ERC20AllowanceABI = []byte(`[
		{
			"inputs": [
				{"name": "owner", "type": "address"},
				{"name": "spender", "type": "address"}
			],
			"name": "allowance",
			"outputs": [{"name": "", "type": "uint256"}],
			"stateMutability": "view",
			"type": "function"
		}
	]`)

	// ERC20ApproveABI for approving Permit2
	ERC20ApproveABI = []byte(`[
		{
			"inputs": [
				{"name": "spender", "type": "address"},
				{"name": "amount", "type": "uint256"}
			],
			"name": "approve",
			"outputs": [{"name": "", "type": "bool"}],
			"stateMutability": "nonpayable",
			"type": "function"
		}
	]`)

	// ERC20BalanceOfABI for checking token balance
	ERC20BalanceOfABI = []byte(`[
		{
			"inputs": [
				{"name": "account", "type": "address"}
			],
			"name": "balanceOf",
			"outputs": [{"name": "", "type": "uint256"}],
			"stateMutability": "view",
			"type": "function"
		}
	]`)

	// ERC20NameABI for checking EIP-712 domain name diagnostics.
	ERC20NameABI = []byte(`[
		{
			"inputs": [],
			"name": "name",
			"outputs": [{"name": "", "type": "string"}],
			"stateMutability": "view",
			"type": "function"
		}
	]`)

	// ERC20VersionABI for checking EIP-712 domain version diagnostics.
	ERC20VersionABI = []byte(`[
		{
			"inputs": [],
			"name": "version",
			"outputs": [{"name": "", "type": "string"}],
			"stateMutability": "view",
			"type": "function"
		}
	]`)

	// X402ExactPermit2ProxySettleABI for calling settle on x402ExactPermit2Proxy
	X402ExactPermit2ProxySettleABI = []byte(`[
		{
			"type": "function",
			"name": "settle",
			"inputs": [
				{
					"name": "permit",
					"type": "tuple",
					"components": [
						{
							"name": "permitted",
							"type": "tuple",
							"components": [
								{"name": "token", "type": "address"},
								{"name": "amount", "type": "uint256"}
							]
						},
						{"name": "nonce", "type": "uint256"},
						{"name": "deadline", "type": "uint256"}
					]
				},
				{"name": "owner", "type": "address"},
				{
					"name": "witness",
					"type": "tuple",
					"components": [
						{"name": "to", "type": "address"},
						{"name": "validAfter", "type": "uint256"}
					]
				},
				{"name": "signature", "type": "bytes"}
			],
			"outputs": [],
			"stateMutability": "nonpayable"
		}
	]`)

	// X402ExactPermit2ProxyPermit2ABI for verifying proxy deployment
	X402ExactPermit2ProxyPermit2ABI = []byte(`[
		{
			"inputs": [],
			"name": "PERMIT2",
			"outputs": [{"name": "", "type": "address"}],
			"stateMutability": "view",
			"type": "function"
		}
	]`)

	// Multicall3GetEthBalanceABI for querying native ETH balance via Multicall3.
	Multicall3GetEthBalanceABI = []byte(`[
		{
			"inputs": [
				{"name": "addr", "type": "address"}
			],
			"name": "getEthBalance",
			"outputs": [{"name": "balance", "type": "uint256"}],
			"stateMutability": "view",
			"type": "function"
		}
	]`)

	// X402UptoPermit2ProxySettleABI for calling settle on x402UptoPermit2Proxy.
	// Differs from exact: takes an additional `amount` param and witness includes `facilitator`.
	X402UptoPermit2ProxySettleABI = []byte(`[
		{
			"type": "function",
			"name": "settle",
			"inputs": [
				{
					"name": "permit",
					"type": "tuple",
					"components": [
						{
							"name": "permitted",
							"type": "tuple",
							"components": [
								{"name": "token", "type": "address"},
								{"name": "amount", "type": "uint256"}
							]
						},
						{"name": "nonce", "type": "uint256"},
						{"name": "deadline", "type": "uint256"}
					]
				},
				{"name": "amount", "type": "uint256"},
				{"name": "owner", "type": "address"},
				{
					"name": "witness",
					"type": "tuple",
					"components": [
						{"name": "to", "type": "address"},
						{"name": "facilitator", "type": "address"},
						{"name": "validAfter", "type": "uint256"}
					]
				},
				{"name": "signature", "type": "bytes"}
			],
			"outputs": [],
			"stateMutability": "nonpayable"
		}
	]`)

	// X402UptoPermit2ProxySettleWithPermitABI for calling settleWithPermit on x402UptoPermit2Proxy (EIP-2612 extension).
	X402UptoPermit2ProxySettleWithPermitABI = []byte(`[
		{
			"type": "function",
			"name": "settleWithPermit",
			"inputs": [
				{
					"name": "permit2612",
					"type": "tuple",
					"components": [
						{"name": "value", "type": "uint256"},
						{"name": "deadline", "type": "uint256"},
						{"name": "r", "type": "bytes32"},
						{"name": "s", "type": "bytes32"},
						{"name": "v", "type": "uint8"}
					]
				},
				{
					"name": "permit",
					"type": "tuple",
					"components": [
						{
							"name": "permitted",
							"type": "tuple",
							"components": [
								{"name": "token", "type": "address"},
								{"name": "amount", "type": "uint256"}
							]
						},
						{"name": "nonce", "type": "uint256"},
						{"name": "deadline", "type": "uint256"}
					]
				},
				{"name": "amount", "type": "uint256"},
				{"name": "owner", "type": "address"},
				{
					"name": "witness",
					"type": "tuple",
					"components": [
						{"name": "to", "type": "address"},
						{"name": "facilitator", "type": "address"},
						{"name": "validAfter", "type": "uint256"}
					]
				},
				{"name": "signature", "type": "bytes"}
			],
			"outputs": [],
			"stateMutability": "nonpayable"
		}
	]`)

	// X402UptoPermit2ProxyPermit2ABI for verifying upto proxy deployment
	X402UptoPermit2ProxyPermit2ABI = []byte(`[
		{
			"inputs": [],
			"name": "PERMIT2",
			"outputs": [{"name": "", "type": "address"}],
			"stateMutability": "view",
			"type": "function"
		}
	]`)

	// EIP2612NoncesABI for querying EIP-2612 nonces
	EIP2612NoncesABI = []byte(`[
		{
			"inputs": [
				{"name": "owner", "type": "address"}
			],
			"name": "nonces",
			"outputs": [{"name": "", "type": "uint256"}],
			"stateMutability": "view",
			"type": "function"
		}
	]`)

	// X402ExactPermit2ProxySettleWithPermitABI for calling settleWithPermit (EIP-2612 extension)
	X402ExactPermit2ProxySettleWithPermitABI = []byte(`[
		{
			"type": "function",
			"name": "settleWithPermit",
			"inputs": [
				{
					"name": "permit2612",
					"type": "tuple",
					"components": [
						{"name": "value", "type": "uint256"},
						{"name": "deadline", "type": "uint256"},
						{"name": "r", "type": "bytes32"},
						{"name": "s", "type": "bytes32"},
						{"name": "v", "type": "uint8"}
					]
				},
				{
					"name": "permit",
					"type": "tuple",
					"components": [
						{
							"name": "permitted",
							"type": "tuple",
							"components": [
								{"name": "token", "type": "address"},
								{"name": "amount", "type": "uint256"}
							]
						},
						{"name": "nonce", "type": "uint256"},
						{"name": "deadline", "type": "uint256"}
					]
				},
				{"name": "owner", "type": "address"},
				{
					"name": "witness",
					"type": "tuple",
					"components": [
						{"name": "to", "type": "address"},
						{"name": "validAfter", "type": "uint256"}
					]
				},
				{"name": "signature", "type": "bytes"}
			],
			"outputs": [],
			"stateMutability": "nonpayable"
		}
	]`)

	// EIP712DomainTypes defines the standard EIP-712 domain type for Permit2.
	// Permit2 uses name + chainId + verifyingContract (no version field).
	EIP712DomainTypes = []TypedDataField{
		{Name: "name", Type: "string"},
		{Name: "chainId", Type: "uint256"},
		{Name: "verifyingContract", Type: "address"},
	}

	// Permit2WitnessTypes defines the EIP-712 types for Permit2 with witness.
	// Field order MUST match the on-chain Permit2 contract and TypeScript implementation.
	Permit2WitnessTypes = map[string][]TypedDataField{
		"PermitWitnessTransferFrom": {
			{Name: "permitted", Type: "TokenPermissions"},
			{Name: "spender", Type: "address"},
			{Name: "nonce", Type: "uint256"},
			{Name: "deadline", Type: "uint256"},
			{Name: "witness", Type: "Witness"},
		},
		"TokenPermissions": {
			{Name: "token", Type: "address"},
			{Name: "amount", Type: "uint256"},
		},
		"Witness": {
			{Name: "to", Type: "address"},
			{Name: "validAfter", Type: "uint256"},
		},
	}
)

// GetPermit2EIP712Types returns the complete EIP-712 types map for Permit2 signing.
// This combines the EIP712Domain with the Permit2-specific types.
// Use this function instead of defining types locally to ensure consistency.
func GetPermit2EIP712Types() map[string][]TypedDataField {
	return map[string][]TypedDataField{
		"EIP712Domain":              EIP712DomainTypes,
		"PermitWitnessTransferFrom": Permit2WitnessTypes["PermitWitnessTransferFrom"],
		"TokenPermissions":          Permit2WitnessTypes["TokenPermissions"],
		"Witness":                   Permit2WitnessTypes["Witness"],
	}
}

// EIP2612PermitTypes defines the EIP-712 types for EIP-2612 permit signing.
var EIP2612PermitTypes = map[string][]TypedDataField{
	"Permit": {
		{Name: "owner", Type: "address"},
		{Name: "spender", Type: "address"},
		{Name: "value", Type: "uint256"},
		{Name: "nonce", Type: "uint256"},
		{Name: "deadline", Type: "uint256"},
	},
}

// EIP712DomainTypesWithVersion is the standard EIP-712 domain type with version field.
// Used by EIP-2612 tokens (unlike Permit2 which omits version).
var EIP712DomainTypesWithVersion = []TypedDataField{
	{Name: "name", Type: "string"},
	{Name: "version", Type: "string"},
	{Name: "chainId", Type: "uint256"},
	{Name: "verifyingContract", Type: "address"},
}

// GetEIP2612EIP712Types returns the complete EIP-712 types map for EIP-2612 signing.
func GetEIP2612EIP712Types() map[string][]TypedDataField {
	return map[string][]TypedDataField{
		"EIP712Domain": EIP712DomainTypesWithVersion,
		"Permit":       EIP2612PermitTypes["Permit"],
	}
}

// UptoPermit2WitnessTypes defines the EIP-712 types for the upto Permit2 witness.
// The upto witness includes a `facilitator` field absent from the exact witness.
// Only the address matching witness.facilitator can call settle() on-chain.
// Field order MUST match the on-chain x402UptoPermit2Proxy contract and TypeScript implementation.
var UptoPermit2WitnessTypes = map[string][]TypedDataField{
	"PermitWitnessTransferFrom": {
		{Name: "permitted", Type: "TokenPermissions"},
		{Name: "spender", Type: "address"},
		{Name: "nonce", Type: "uint256"},
		{Name: "deadline", Type: "uint256"},
		{Name: "witness", Type: "Witness"},
	},
	"TokenPermissions": {
		{Name: "token", Type: "address"},
		{Name: "amount", Type: "uint256"},
	},
	"Witness": {
		{Name: "to", Type: "address"},
		{Name: "facilitator", Type: "address"},
		{Name: "validAfter", Type: "uint256"},
	},
}

// GetUptoPermit2EIP712Types returns the complete EIP-712 types map for upto Permit2 signing.
// This combines the EIP712Domain with the upto-specific Permit2 types (including facilitator in witness).
func GetUptoPermit2EIP712Types() map[string][]TypedDataField {
	return map[string][]TypedDataField{
		"EIP712Domain":              EIP712DomainTypes,
		"PermitWitnessTransferFrom": UptoPermit2WitnessTypes["PermitWitnessTransferFrom"],
		"TokenPermissions":          UptoPermit2WitnessTypes["TokenPermissions"],
		"Witness":                   UptoPermit2WitnessTypes["Witness"],
	}
}
