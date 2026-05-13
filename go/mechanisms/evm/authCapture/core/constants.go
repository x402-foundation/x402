package core

// PaymentInfoTypehash is the EIP-712 type string for the on-chain PaymentInfo struct (from AuthCaptureEscrow).
const PaymentInfoTypehash = "PaymentInfo(address operator,address payer,address receiver,address token,uint120 maxAmount,uint48 preApprovalExpiry,uint48 authorizationExpiry,uint48 refundExpiry,uint16 minFeeBps,uint16 maxFeeBps,address feeReceiver,uint256 salt)"

// EscrowAuthorizeABI is the AuthCaptureEscrow contract ABI for authorize.
var EscrowAuthorizeABI = []byte(`[
	{
		"inputs": [
			{
				"name": "paymentInfo",
				"type": "tuple",
				"components": [
					{"name": "operator", "type": "address"},
					{"name": "payer", "type": "address"},
					{"name": "receiver", "type": "address"},
					{"name": "token", "type": "address"},
					{"name": "maxAmount", "type": "uint120"},
					{"name": "preApprovalExpiry", "type": "uint48"},
					{"name": "authorizationExpiry", "type": "uint48"},
					{"name": "refundExpiry", "type": "uint48"},
					{"name": "minFeeBps", "type": "uint16"},
					{"name": "maxFeeBps", "type": "uint16"},
					{"name": "feeReceiver", "type": "address"},
					{"name": "salt", "type": "uint256"}
				]
			},
			{"name": "amount", "type": "uint256"},
			{"name": "tokenCollector", "type": "address"},
			{"name": "collectorData", "type": "bytes"}
		],
		"name": "authorize",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	}
]`)

// EscrowChargeABI is the AuthCaptureEscrow contract ABI for charge.
var EscrowChargeABI = []byte(`[
	{
		"inputs": [
			{
				"name": "paymentInfo",
				"type": "tuple",
				"components": [
					{"name": "operator", "type": "address"},
					{"name": "payer", "type": "address"},
					{"name": "receiver", "type": "address"},
					{"name": "token", "type": "address"},
					{"name": "maxAmount", "type": "uint120"},
					{"name": "preApprovalExpiry", "type": "uint48"},
					{"name": "authorizationExpiry", "type": "uint48"},
					{"name": "refundExpiry", "type": "uint48"},
					{"name": "minFeeBps", "type": "uint16"},
					{"name": "maxFeeBps", "type": "uint16"},
					{"name": "feeReceiver", "type": "address"},
					{"name": "salt", "type": "uint256"}
				]
			},
			{"name": "amount", "type": "uint256"},
			{"name": "tokenCollector", "type": "address"},
			{"name": "collectorData", "type": "bytes"},
			{"name": "feeBps", "type": "uint16"},
			{"name": "feeReceiver", "type": "address"}
		],
		"name": "charge",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	}
]`)

// EscrowGetHashABI is the AuthCaptureEscrow contract ABI for getHash (view).
var EscrowGetHashABI = []byte(`[
	{
		"inputs": [
			{
				"name": "paymentInfo",
				"type": "tuple",
				"components": [
					{"name": "operator", "type": "address"},
					{"name": "payer", "type": "address"},
					{"name": "receiver", "type": "address"},
					{"name": "token", "type": "address"},
					{"name": "maxAmount", "type": "uint120"},
					{"name": "preApprovalExpiry", "type": "uint48"},
					{"name": "authorizationExpiry", "type": "uint48"},
					{"name": "refundExpiry", "type": "uint48"},
					{"name": "minFeeBps", "type": "uint16"},
					{"name": "maxFeeBps", "type": "uint16"},
					{"name": "feeReceiver", "type": "address"},
					{"name": "salt", "type": "uint256"}
				]
			}
		],
		"name": "getHash",
		"outputs": [{"name": "", "type": "bytes32"}],
		"stateMutability": "view",
		"type": "function"
	}
]`)
