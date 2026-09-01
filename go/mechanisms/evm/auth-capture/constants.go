package authcapture

import (
	"strings"

	"github.com/ethereum/go-ethereum/crypto"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
)

const (
	// SchemeAuthCapture is the scheme identifier for auth-capture payments.
	SchemeAuthCapture = "auth-capture"

	// AuthCaptureEscrowV1_0Address is the commerce-payments v1.0 AuthCaptureEscrow deployment.
	AuthCaptureEscrowV1_0Address = "0xBdEA0D1bcC5966192B070Fdf62aB4EF5b4420cff"

	// EIP3009TokenCollectorV1_0Address is the commerce-payments v1.0 EIP-3009 token collector.
	EIP3009TokenCollectorV1_0Address = "0x0E3dF9510de65469C4518D7843919c0b8C7A7757"

	// Permit2TokenCollectorV1_0Address is the commerce-payments v1.0 Permit2 token collector.
	Permit2TokenCollectorV1_0Address = "0x992476B9Ee81d52a5BdA0622C333938D0Af0aB26"

	// OperatorRefundCollectorV1_0Address is the commerce-payments v1.0 operator refund collector.
	OperatorRefundCollectorV1_0Address = "0x934907bffd0901b6A21e398B9C53A4A38F02fa5d"

	// AuthCaptureEscrowV1_1Address is the commerce-payments v1.1 AuthCaptureEscrow deployment (default).
	AuthCaptureEscrowV1_1Address = "0x13AC3b34322D12FE27D5e192D0c2b2266d4F29CB"

	// EIP3009TokenCollectorV1_1Address is the commerce-payments v1.1 EIP-3009 token collector.
	EIP3009TokenCollectorV1_1Address = "0xEA902B37036bcb4944577ec2101ABdEDF56EbD28"

	// Permit2TokenCollectorV1_1Address is the commerce-payments v1.1 Permit2 token collector.
	Permit2TokenCollectorV1_1Address = "0x1aacb38b16a1a8709e80746825E53A0C9Cae9b70"

	// OperatorRefundCollectorV1_1Address is the commerce-payments v1.1 operator refund collector.
	OperatorRefundCollectorV1_1Address = "0x6a1ADdEEb4bD9c5811a613e20c172b6CE61A4aaB"

	// AuthCaptureEscrowAddress is the default AuthCaptureEscrow deployment (v1.1).
	AuthCaptureEscrowAddress = AuthCaptureEscrowV1_1Address

	// EIP3009TokenCollectorAddress is the default EIP-3009 token collector (v1.1).
	EIP3009TokenCollectorAddress = EIP3009TokenCollectorV1_1Address

	// Permit2TokenCollectorAddress is the default Permit2 token collector (v1.1).
	Permit2TokenCollectorAddress = Permit2TokenCollectorV1_1Address

	// OperatorRefundCollectorAddress is the default operator refund collector (v1.1).
	OperatorRefundCollectorAddress = OperatorRefundCollectorV1_1Address

	saltBindingTypeString = "x402AuthCaptureSaltBinding(address receiverAuthorizer,address policy,uint256 saltNonce)"

	paymentInfoTypeString = "PaymentInfo(address operator,address payer,address receiver,address token,uint120 maxAmount,uint48 preApprovalExpiry,uint48 authorizationExpiry,uint48 refundExpiry,uint16 minFeeBps,uint16 maxFeeBps,address feeReceiver,uint256 salt)"
)

// AuthCaptureDeploymentVersion identifies a commerce-payments deployment set.
type AuthCaptureDeploymentVersion string

const (
	AuthCaptureDeploymentV1_0 AuthCaptureDeploymentVersion = "v1.0"
	AuthCaptureDeploymentV1_1 AuthCaptureDeploymentVersion = "v1.1"
)

// AuthCaptureDeployment is a resolved commerce-payments deployment (escrow + collectors).
type AuthCaptureDeployment struct {
	Version                 AuthCaptureDeploymentVersion
	Escrow                  string
	EIP3009Collector        string
	Permit2Collector        string
	OperatorRefundCollector string
}

var (
	authCaptureDeploymentV1_0 = AuthCaptureDeployment{
		Version:                 AuthCaptureDeploymentV1_0,
		Escrow:                  AuthCaptureEscrowV1_0Address,
		EIP3009Collector:        EIP3009TokenCollectorV1_0Address,
		Permit2Collector:        Permit2TokenCollectorV1_0Address,
		OperatorRefundCollector: OperatorRefundCollectorV1_0Address,
	}

	authCaptureDeploymentV1_1 = AuthCaptureDeployment{
		Version:                 AuthCaptureDeploymentV1_1,
		Escrow:                  AuthCaptureEscrowV1_1Address,
		EIP3009Collector:        EIP3009TokenCollectorV1_1Address,
		Permit2Collector:        Permit2TokenCollectorV1_1Address,
		OperatorRefundCollector: OperatorRefundCollectorV1_1Address,
	}
)

// ResolveAuthCaptureDeployment selects the commerce-payments deployment from
// optional extra.authCaptureEscrow. Absent or the v1.1 escrow selects v1.1;
// the v1.0 escrow selects v1.0. Returns nil for unknown or invalid addresses.
func ResolveAuthCaptureDeployment(escrow string) *AuthCaptureDeployment {
	if escrow == "" {
		d := authCaptureDeploymentV1_1
		return &d
	}
	if !evm.IsValidAddress(escrow) {
		return nil
	}
	normalized := strings.ToLower(evm.NormalizeAddress(escrow))
	switch normalized {
	case strings.ToLower(AuthCaptureEscrowV1_1Address), strings.ToLower(AuthCaptureEscrowAddress):
		d := authCaptureDeploymentV1_1
		return &d
	case strings.ToLower(AuthCaptureEscrowV1_0Address):
		d := authCaptureDeploymentV1_0
		return &d
	default:
		return nil
	}
}

// SaltBindingTypeHash is keccak256(SALT_BINDING_TYPEHASH string).
var SaltBindingTypeHash = crypto.Keccak256Hash([]byte(saltBindingTypeString))

// PaymentInfoTypeHash is keccak256(PaymentInfo type string); must match AuthCaptureEscrow.PAYMENT_INFO_TYPEHASH.
var PaymentInfoTypeHash = crypto.Keccak256Hash([]byte(paymentInfoTypeString))

// ReceiveAuthorizationTypes defines EIP-712 types for ERC-3009 ReceiveWithAuthorization.
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

// Permit2TransferFromTypes defines EIP-712 types for Permit2 PermitTransferFrom (no witness).
var Permit2TransferFromTypes = map[string][]evm.TypedDataField{
	"PermitTransferFrom": {
		{Name: "permitted", Type: "TokenPermissions"},
		{Name: "spender", Type: "address"},
		{Name: "nonce", Type: "uint256"},
		{Name: "deadline", Type: "uint256"},
	},
	"TokenPermissions": {
		{Name: "token", Type: "address"},
		{Name: "amount", Type: "uint256"},
	},
}

// GetReceiveAuthorizationEIP712Types returns the complete EIP-712 types map for ERC-3009 signing.
func GetReceiveAuthorizationEIP712Types() map[string][]evm.TypedDataField {
	return map[string][]evm.TypedDataField{
		"EIP712Domain": {
			{Name: "name", Type: "string"},
			{Name: "version", Type: "string"},
			{Name: "chainId", Type: "uint256"},
			{Name: "verifyingContract", Type: "address"},
		},
		"ReceiveWithAuthorization": ReceiveAuthorizationTypes["ReceiveWithAuthorization"],
	}
}

// GetPermit2TransferFromEIP712Types returns the complete EIP-712 types map for Permit2 PermitTransferFrom.
func GetPermit2TransferFromEIP712Types() map[string][]evm.TypedDataField {
	return map[string][]evm.TypedDataField{
		"EIP712Domain":       evm.EIP712DomainTypes,
		"PermitTransferFrom": Permit2TransferFromTypes["PermitTransferFrom"],
		"TokenPermissions":   Permit2TransferFromTypes["TokenPermissions"],
	}
}
