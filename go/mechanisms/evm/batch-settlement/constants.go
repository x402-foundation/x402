package batchsettlement

import (
	"github.com/ethereum/go-ethereum/crypto"

	"github.com/x402-foundation/x402/go/mechanisms/evm"
)

const (
	// SchemeBatched is the scheme identifier for batch settlement.
	SchemeBatched = "batch-settlement"

	// BatchSettlementAddress is the deployed x402BatchSettlement contract address (CREATE2, all chains).
	BatchSettlementAddress = "0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003"

	// ERC3009DepositCollectorAddress is the deployed ERC3009DepositCollector contract address.
	ERC3009DepositCollectorAddress = "0x4020806089470a89826cB9fB1f4059150b550004"

	// Permit2DepositCollectorAddress is the deployed Permit2DepositCollector contract address.
	Permit2DepositCollectorAddress = "0x4020425FAf3B746C082C2f942b4E5159887B0005"

	// MinWithdrawDelay is the minimum withdraw delay in seconds (15 minutes).
	MinWithdrawDelay = 900

	// MaxWithdrawDelay is the maximum withdraw delay in seconds (30 days).
	MaxWithdrawDelay = 2_592_000
)

// ChannelConfigTypeString is the EIP-712 typed-data primary type string used
// for the onchain channel-id pre-image.
const ChannelConfigTypeString = "ChannelConfig(address payer,address payerAuthorizer,address receiver,address receiverAuthorizer,address token,uint40 withdrawDelay,bytes32 salt)"

// ChannelConfigTypeHash is keccak256(ChannelConfigTypeString).
var ChannelConfigTypeHash = crypto.Keccak256([]byte(ChannelConfigTypeString))

// BatchSettlementDomain is the EIP-712 domain for the batch settlement contract.
// ChainId and VerifyingContract are set per-network at signing time.
var BatchSettlementDomain = evm.TypedDataDomain{
	Name:    "x402 Batch Settlement",
	Version: "1",
}

// ChannelConfigTypes defines the EIP-712 types for the channel-config struct,
// used to compute the chain-bound channel id via hashTypedData.
var ChannelConfigTypes = map[string][]evm.TypedDataField{
	"ChannelConfig": {
		{Name: "payer", Type: "address"},
		{Name: "payerAuthorizer", Type: "address"},
		{Name: "receiver", Type: "address"},
		{Name: "receiverAuthorizer", Type: "address"},
		{Name: "token", Type: "address"},
		{Name: "withdrawDelay", Type: "uint40"},
		{Name: "salt", Type: "bytes32"},
	},
}

// VoucherTypes defines the EIP-712 types for a cumulative voucher.
// Voucher(bytes32 channelId, uint128 maxClaimableAmount)
var VoucherTypes = map[string][]evm.TypedDataField{
	"Voucher": {
		{Name: "channelId", Type: "bytes32"},
		{Name: "maxClaimableAmount", Type: "uint128"},
	},
}

// RefundTypes defines the EIP-712 types for cooperative refund.
// Refund(bytes32 channelId, uint256 nonce, uint128 amount)
var RefundTypes = map[string][]evm.TypedDataField{
	"Refund": {
		{Name: "channelId", Type: "bytes32"},
		{Name: "nonce", Type: "uint256"},
		{Name: "amount", Type: "uint128"},
	},
}

// ClaimBatchTypes defines the EIP-712 types for receiver-authorizer claim batches.
var ClaimBatchTypes = map[string][]evm.TypedDataField{
	"ClaimBatch": {
		{Name: "claims", Type: "ClaimEntry[]"},
	},
	"ClaimEntry": {
		{Name: "channelId", Type: "bytes32"},
		{Name: "maxClaimableAmount", Type: "uint128"},
		{Name: "totalClaimed", Type: "uint128"},
	},
}

// ReceiveAuthorizationTypes defines the EIP-712 types for ERC-3009 ReceiveWithAuthorization.
var ReceiveAuthorizationTypes = map[string][]evm.TypedDataField{
	"ReceiveWithAuthorization": {
		{Name: "from", Type: "address"},
		{Name: "to", Type: "address"},
		{Name: "value", Type: "uint256"},
		{Name: "validAfter", Type: "uint256"},
		{Name: "validBefore", Type: "uint256"},
		{Name: "nonce", Type: "bytes32"},
	},
}

// Permit2Address is the universal Permit2 deployment used across EVM chains.
const Permit2Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3"

// Permit2DomainName is the EIP-712 domain name used by Permit2 typed data.
const Permit2DomainName = "Permit2"

// BatchPermit2WitnessTypes defines the EIP-712 types for the channel-bound
// Permit2 PermitWitnessTransferFrom signed by the payer when the deposit uses
// the permit2 transfer method. The witness binds the transfer to a specific
// batch-settlement channel id so the Permit2DepositCollector can route funds
// on the receiver's behalf.
var BatchPermit2WitnessTypes = map[string][]evm.TypedDataField{
	"PermitWitnessTransferFrom": {
		{Name: "permitted", Type: "TokenPermissions"},
		{Name: "spender", Type: "address"},
		{Name: "nonce", Type: "uint256"},
		{Name: "deadline", Type: "uint256"},
		{Name: "witness", Type: "DepositWitness"},
	},
	"TokenPermissions": {
		{Name: "token", Type: "address"},
		{Name: "amount", Type: "uint256"},
	},
	"DepositWitness": {
		{Name: "channelId", Type: "bytes32"},
	},
}

// DepositWitnessTypeString is the canonical witness type-string fragment that
// must be appended (without the leading `,`) when computing the Permit2
// witness type hash.
const DepositWitnessTypeString = "DepositWitness witness)DepositWitness(bytes32 channelId)TokenPermissions(address token,uint256 amount)"

// ============================================================================
// ABI Definitions
// ============================================================================

// channelConfigComponents is the ABI tuple for ChannelConfig, shared across multiple ABIs.
const channelConfigComponentsJSON = `[
	{"name": "payer", "type": "address"},
	{"name": "payerAuthorizer", "type": "address"},
	{"name": "receiver", "type": "address"},
	{"name": "receiverAuthorizer", "type": "address"},
	{"name": "token", "type": "address"},
	{"name": "withdrawDelay", "type": "uint40"},
	{"name": "salt", "type": "bytes32"}
]`

// BatchSettlementDepositABI for calling deposit(config, amount, collector, collectorData).
var BatchSettlementDepositABI = []byte(`[
	{
		"type": "function",
		"name": "deposit",
		"inputs": [
			{"name": "config", "type": "tuple", "components": ` + channelConfigComponentsJSON + `},
			{"name": "amount", "type": "uint128"},
			{"name": "collector", "type": "address"},
			{"name": "collectorData", "type": "bytes"}
		],
		"outputs": [],
		"stateMutability": "nonpayable"
	}
]`)

// BatchSettlementClaimABI for calling claim(voucherClaims[]).
var BatchSettlementClaimABI = []byte(`[
	{
		"type": "function",
		"name": "claim",
		"inputs": [
			{
				"name": "voucherClaims",
				"type": "tuple[]",
				"components": [
					{
						"name": "voucher",
						"type": "tuple",
						"components": [
							{"name": "channel", "type": "tuple", "components": ` + channelConfigComponentsJSON + `},
							{"name": "maxClaimableAmount", "type": "uint128"}
						]
					},
					{"name": "signature", "type": "bytes"},
					{"name": "totalClaimed", "type": "uint128"}
				]
			}
		],
		"outputs": [],
		"stateMutability": "nonpayable"
	}
]`)

// BatchSettlementClaimWithSignatureABI for calling claimWithSignature(voucherClaims[], authorizerSignature).
var BatchSettlementClaimWithSignatureABI = []byte(`[
	{
		"type": "function",
		"name": "claimWithSignature",
		"inputs": [
			{
				"name": "voucherClaims",
				"type": "tuple[]",
				"components": [
					{
						"name": "voucher",
						"type": "tuple",
						"components": [
							{"name": "channel", "type": "tuple", "components": ` + channelConfigComponentsJSON + `},
							{"name": "maxClaimableAmount", "type": "uint128"}
						]
					},
					{"name": "signature", "type": "bytes"},
					{"name": "totalClaimed", "type": "uint128"}
				]
			},
			{"name": "authorizerSignature", "type": "bytes"}
		],
		"outputs": [],
		"stateMutability": "nonpayable"
	}
]`)

// BatchSettlementSettleABI for calling settle(receiver, token).
var BatchSettlementSettleABI = []byte(`[
	{
		"type": "function",
		"name": "settle",
		"inputs": [
			{"name": "receiver", "type": "address"},
			{"name": "token", "type": "address"}
		],
		"outputs": [],
		"stateMutability": "nonpayable"
	}
]`)

// BatchSettlementRefundABI for calling refund(config, amount).
var BatchSettlementRefundABI = []byte(`[
	{
		"type": "function",
		"name": "refund",
		"inputs": [
			{"name": "config", "type": "tuple", "components": ` + channelConfigComponentsJSON + `},
			{"name": "amount", "type": "uint128"}
		],
		"outputs": [],
		"stateMutability": "nonpayable"
	}
]`)

// BatchSettlementRefundWithSignatureABI for calling refundWithSignature(config, amount, nonce, receiverAuthorizerSignature).
var BatchSettlementRefundWithSignatureABI = []byte(`[
	{
		"type": "function",
		"name": "refundWithSignature",
		"inputs": [
			{"name": "config", "type": "tuple", "components": ` + channelConfigComponentsJSON + `},
			{"name": "amount", "type": "uint128"},
			{"name": "nonce", "type": "uint256"},
			{"name": "receiverAuthorizerSignature", "type": "bytes"}
		],
		"outputs": [],
		"stateMutability": "nonpayable"
	}
]`)

// BatchSettlementMulticallABI for calling multicall(data[]).
var BatchSettlementMulticallABI = []byte(`[
	{
		"type": "function",
		"name": "multicall",
		"inputs": [{"name": "data", "type": "bytes[]"}],
		"outputs": [{"name": "results", "type": "bytes[]"}],
		"stateMutability": "nonpayable"
	}
]`)

// BatchSettlementChannelsABI for reading channels(channelId) -> (balance, totalClaimed).
var BatchSettlementChannelsABI = []byte(`[
	{
		"type": "function",
		"name": "channels",
		"inputs": [{"name": "channelId", "type": "bytes32"}],
		"outputs": [
			{"name": "balance", "type": "uint128"},
			{"name": "totalClaimed", "type": "uint128"}
		],
		"stateMutability": "view"
	}
]`)

// BatchSettlementPendingWithdrawalsABI for reading pendingWithdrawals(channelId).
var BatchSettlementPendingWithdrawalsABI = []byte(`[
	{
		"type": "function",
		"name": "pendingWithdrawals",
		"inputs": [{"name": "channelId", "type": "bytes32"}],
		"outputs": [
			{"name": "amount", "type": "uint128"},
			{"name": "initiatedAt", "type": "uint40"}
		],
		"stateMutability": "view"
	}
]`)

// BatchSettlementRefundNonceABI for reading refundNonce(channelId).
var BatchSettlementRefundNonceABI = []byte(`[
	{
		"type": "function",
		"name": "refundNonce",
		"inputs": [{"name": "channelId", "type": "bytes32"}],
		"outputs": [{"name": "", "type": "uint256"}],
		"stateMutability": "view"
	}
]`)

// BatchSettlementGetChannelIdABI for calling getChannelId(config).
var BatchSettlementGetChannelIdABI = []byte(`[
	{
		"type": "function",
		"name": "getChannelId",
		"inputs": [{"name": "config", "type": "tuple", "components": ` + channelConfigComponentsJSON + `}],
		"outputs": [{"name": "", "type": "bytes32"}],
		"stateMutability": "pure"
	}
]`)

// BatchSettlementReceiversABI for reading receivers(receiver, token).
var BatchSettlementReceiversABI = []byte(`[
	{
		"type": "function",
		"name": "receivers",
		"inputs": [
			{"name": "receiver", "type": "address"},
			{"name": "token", "type": "address"}
		],
		"outputs": [
			{"name": "totalClaimed", "type": "uint128"},
			{"name": "totalSettled", "type": "uint128"}
		],
		"stateMutability": "view"
	}
]`)

// BatchSettlementInitiateWithdrawABI for calling initiateWithdraw(config, amount).
var BatchSettlementInitiateWithdrawABI = []byte(`[
	{
		"type": "function",
		"name": "initiateWithdraw",
		"inputs": [
			{"name": "config", "type": "tuple", "components": ` + channelConfigComponentsJSON + `},
			{"name": "amount", "type": "uint128"}
		],
		"outputs": [],
		"stateMutability": "nonpayable"
	}
]`)

// BatchSettlementFinalizeWithdrawABI for calling finalizeWithdraw(config).
var BatchSettlementFinalizeWithdrawABI = []byte(`[
	{
		"type": "function",
		"name": "finalizeWithdraw",
		"inputs": [{"name": "config", "type": "tuple", "components": ` + channelConfigComponentsJSON + `}],
		"outputs": [],
		"stateMutability": "nonpayable"
	}
]`)
