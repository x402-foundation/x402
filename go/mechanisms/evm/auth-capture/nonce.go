package authcapture

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
)

var (
	paymentInfoHashABI  abi.Arguments
	paymentInfoOuterABI abi.Arguments
	saltBindingABI      abi.Arguments
)

func init() {
	bytes32Ty, _ := abi.NewType("bytes32", "", nil)
	addressTy, _ := abi.NewType("address", "", nil)
	uint120Ty, _ := abi.NewType("uint120", "", nil)
	uint48Ty, _ := abi.NewType("uint48", "", nil)
	uint16Ty, _ := abi.NewType("uint16", "", nil)
	uint256Ty, _ := abi.NewType("uint256", "", nil)

	paymentInfoHashABI = abi.Arguments{
		{Type: bytes32Ty},
		{Type: addressTy},
		{Type: addressTy},
		{Type: addressTy},
		{Type: addressTy},
		{Type: uint120Ty},
		{Type: uint48Ty},
		{Type: uint48Ty},
		{Type: uint48Ty},
		{Type: uint16Ty},
		{Type: uint16Ty},
		{Type: addressTy},
		{Type: uint256Ty},
	}

	paymentInfoOuterABI = abi.Arguments{
		{Type: uint256Ty},
		{Type: addressTy},
		{Type: bytes32Ty},
	}

	saltBindingABI = abi.Arguments{
		{Type: bytes32Ty},
		{Type: addressTy},
		{Type: addressTy},
		{Type: uint256Ty},
	}
}

func hashPaymentInfo(chainID *big.Int, paymentInfo PaymentInfoStruct, payer string, escrowAddress string) (string, error) {
	maxAmount, ok := new(big.Int).SetString(paymentInfo.MaxAmount, 10)
	if !ok {
		return "", fmt.Errorf("invalid maxAmount: %s", paymentInfo.MaxAmount)
	}
	saltBig, err := saltToBigInt(paymentInfo.Salt)
	if err != nil {
		return "", err
	}

	encoded, err := paymentInfoHashABI.Pack(
		PaymentInfoTypeHash,
		common.HexToAddress(paymentInfo.Operator),
		common.HexToAddress(payer),
		common.HexToAddress(paymentInfo.Receiver),
		common.HexToAddress(paymentInfo.Token),
		maxAmount,
		new(big.Int).SetUint64(paymentInfo.PreApprovalExpiry),
		new(big.Int).SetUint64(paymentInfo.AuthorizationExpiry),
		new(big.Int).SetUint64(paymentInfo.RefundExpiry),
		paymentInfo.MinFeeBps,
		paymentInfo.MaxFeeBps,
		common.HexToAddress(paymentInfo.FeeReceiver),
		saltBig,
	)
	if err != nil {
		return "", fmt.Errorf("failed to ABI-encode PaymentInfo: %w", err)
	}
	paymentInfoHash := crypto.Keccak256Hash(encoded)

	outerEncoded, err := paymentInfoOuterABI.Pack(
		chainID,
		common.HexToAddress(escrowAddress),
		paymentInfoHash,
	)
	if err != nil {
		return "", fmt.Errorf("failed to ABI-encode payment info outer hash: %w", err)
	}
	return evm.BytesToHex(crypto.Keccak256(outerEncoded)), nil
}

// ComputePayerAgnosticPaymentInfoHash returns the payer-agnostic PaymentInfo hash
// used as the ERC-3009 nonce and Permit2 nonce (as uint256).
func ComputePayerAgnosticPaymentInfoHash(chainID *big.Int, paymentInfo PaymentInfoStruct, escrowAddress ...string) (string, error) {
	escrow := AuthCaptureEscrowAddress
	if len(escrowAddress) > 0 && escrowAddress[0] != "" {
		escrow = escrowAddress[0]
	}
	zero := "0x0000000000000000000000000000000000000000"
	return hashPaymentInfo(chainID, paymentInfo, zero, escrow)
}

// ComputePaymentInfoHash returns the escrow's getHash(paymentInfo): the
// real-payer PaymentInfo hash used as the lifecycle paymentInfoHash (Capture,
// Void, Refund digests) and as the paymentState lookup key.
func ComputePaymentInfoHash(chainID *big.Int, paymentInfo PaymentInfoStruct, payer string, escrowAddress ...string) (string, error) {
	escrow := AuthCaptureEscrowAddress
	if len(escrowAddress) > 0 && escrowAddress[0] != "" {
		escrow = escrowAddress[0]
	}
	return hashPaymentInfo(chainID, paymentInfo, payer, escrow)
}

// eip3009Domain returns the EIP-712 domain for ReceiveWithAuthorization (the token contract).
func eip3009Domain(extra AuthCaptureExtra, tokenAddress string, chainID *big.Int) evm.TypedDataDomain {
	return evm.TypedDataDomain{
		Name:              extra.Name,
		Version:           extra.Version,
		ChainID:           chainID,
		VerifyingContract: evm.NormalizeAddress(tokenAddress),
	}
}

// eip3009Message builds the ReceiveWithAuthorization message, shared by SignERC3009 and
// HashERC3009Authorization so the signed and verified digests can never drift apart.
func eip3009Message(authorization Eip3009Authorization) (map[string]interface{}, error) {
	value, ok := new(big.Int).SetString(authorization.Value, 10)
	if !ok {
		return nil, fmt.Errorf("invalid authorization value: %s", authorization.Value)
	}
	validAfter, ok := new(big.Int).SetString(authorization.ValidAfter, 10)
	if !ok {
		return nil, fmt.Errorf("invalid validAfter: %s", authorization.ValidAfter)
	}
	validBefore, ok := new(big.Int).SetString(authorization.ValidBefore, 10)
	if !ok {
		return nil, fmt.Errorf("invalid validBefore: %s", authorization.ValidBefore)
	}
	nonceBytes, err := evm.HexToBytes(authorization.Nonce)
	if err != nil {
		return nil, fmt.Errorf("invalid authorization nonce: %w", err)
	}

	return map[string]interface{}{
		"from":        evm.NormalizeAddress(authorization.From),
		"to":          evm.NormalizeAddress(authorization.To),
		"value":       value,
		"validAfter":  validAfter,
		"validBefore": validBefore,
		"nonce":       nonceBytes,
	}, nil
}

// SignERC3009 signs ReceiveWithAuthorization with the token EIP-712 domain from extra.
func SignERC3009(
	ctx context.Context,
	signer evm.ClientEvmSigner,
	authorization Eip3009Authorization,
	extra AuthCaptureExtra,
	tokenAddress string,
	chainID *big.Int,
) ([]byte, error) {
	message, err := eip3009Message(authorization)
	if err != nil {
		return nil, err
	}

	return signer.SignTypedData(
		ctx,
		eip3009Domain(extra, tokenAddress, chainID),
		GetReceiveAuthorizationEIP712Types(),
		"ReceiveWithAuthorization",
		message,
	)
}

// HashERC3009Authorization returns the EIP-712 digest that SignERC3009 signs, for
// facilitator-side signature verification.
func HashERC3009Authorization(
	authorization Eip3009Authorization,
	extra AuthCaptureExtra,
	tokenAddress string,
	chainID *big.Int,
) ([32]byte, error) {
	message, err := eip3009Message(authorization)
	if err != nil {
		return [32]byte{}, err
	}
	return evm.HashEIP712TypedData(
		eip3009Domain(extra, tokenAddress, chainID),
		GetReceiveAuthorizationEIP712Types(),
		"ReceiveWithAuthorization",
		message,
	)
}

// permit2Domain returns the canonical Permit2 EIP-712 domain (no witness, no version field).
func permit2Domain(chainID *big.Int) evm.TypedDataDomain {
	return evm.TypedDataDomain{
		Name:              "Permit2",
		ChainID:           chainID,
		VerifyingContract: evm.PERMIT2Address,
	}
}

// permit2Message builds the PermitTransferFrom message, shared by SignPermit2 and
// HashPermit2Authorization so the signed and verified digests can never drift apart.
func permit2Message(permit Permit2Authorization) (map[string]interface{}, error) {
	amount, ok := new(big.Int).SetString(permit.Permitted.Amount, 10)
	if !ok {
		return nil, fmt.Errorf("invalid permitted amount: %s", permit.Permitted.Amount)
	}
	nonce, ok := new(big.Int).SetString(permit.Nonce, 10)
	if !ok {
		return nil, fmt.Errorf("invalid permit nonce: %s", permit.Nonce)
	}
	deadline, ok := new(big.Int).SetString(permit.Deadline, 10)
	if !ok {
		return nil, fmt.Errorf("invalid permit deadline: %s", permit.Deadline)
	}

	return map[string]interface{}{
		"permitted": map[string]interface{}{
			"token":  evm.NormalizeAddress(permit.Permitted.Token),
			"amount": amount,
		},
		"spender":  evm.NormalizeAddress(permit.Spender),
		"nonce":    nonce,
		"deadline": deadline,
	}, nil
}

// SignPermit2 signs PermitTransferFrom against the canonical Permit2 domain (no witness).
func SignPermit2(
	ctx context.Context,
	signer evm.ClientEvmSigner,
	permit Permit2Authorization,
	chainID *big.Int,
) ([]byte, error) {
	message, err := permit2Message(permit)
	if err != nil {
		return nil, err
	}

	return signer.SignTypedData(
		ctx,
		permit2Domain(chainID),
		GetPermit2TransferFromEIP712Types(),
		"PermitTransferFrom",
		message,
	)
}

// HashPermit2Authorization returns the EIP-712 digest that SignPermit2 signs, for
// facilitator-side signature verification. Distinct from evm.HashPermit2Authorization,
// which hashes exact's witness-bearing PermitTransferFrom variant.
func HashPermit2Authorization(permit Permit2Authorization, chainID *big.Int) ([32]byte, error) {
	message, err := permit2Message(permit)
	if err != nil {
		return [32]byte{}, err
	}
	return evm.HashEIP712TypedData(
		permit2Domain(chainID),
		GetPermit2TransferFromEIP712Types(),
		"PermitTransferFrom",
		message,
	)
}

// GenerateSalt returns a fresh cryptographically-random 32-byte salt (0x-prefixed hex).
func GenerateSalt() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("failed to generate salt: %w", err)
	}
	return evm.BytesToHex(buf), nil
}

// ExtraAddress treats absent or invalid values as the zero address.
func ExtraAddress(value string) string {
	if value == "" || !evm.IsValidAddress(value) {
		return ZeroAddress
	}
	return evm.NormalizeAddress(value)
}

// IsNonZeroAddress reports whether value is a valid non-zero EVM address.
func IsNonZeroAddress(value string) bool {
	if value == "" || !evm.IsValidAddress(value) {
		return false
	}
	return !strings.EqualFold(evm.NormalizeAddress(value), ZeroAddress)
}

// IsSaltBindingOn is true when receiverAuthorizer or policy is non-zero.
func IsSaltBindingOn(extra AuthCaptureExtra) bool {
	return IsNonZeroAddress(extra.ReceiverAuthorizer) || IsNonZeroAddress(extra.Policy)
}

// DeriveBoundSalt returns keccak256(abi.encode(SALT_BINDING_TYPEHASH, receiverAuthorizer, policy, saltNonce)).
func DeriveBoundSalt(receiverAuthorizer, policy, saltNonce string) (string, error) {
	saltNonceBig, err := saltToBigInt(saltNonce)
	if err != nil {
		return "", err
	}
	encoded, err := saltBindingABI.Pack(
		SaltBindingTypeHash,
		common.HexToAddress(receiverAuthorizer),
		common.HexToAddress(policy),
		saltNonceBig,
	)
	if err != nil {
		return "", fmt.Errorf("failed to ABI-encode bound salt: %w", err)
	}
	return evm.BytesToHex(crypto.Keccak256(encoded)), nil
}

func saltToBigInt(salt string) (*big.Int, error) {
	hexPart := strings.TrimPrefix(strings.TrimPrefix(salt, "0x"), "0X")
	if hexPart == "" {
		return nil, fmt.Errorf("invalid salt: %s", salt)
	}
	if _, err := hex.DecodeString(hexPart); err != nil {
		return nil, fmt.Errorf("invalid salt: %s", salt)
	}
	saltBig, ok := new(big.Int).SetString(hexPart, 16)
	if !ok {
		return nil, fmt.Errorf("invalid salt: %s", salt)
	}
	return saltBig, nil
}

// NonceHexToDecimalString interprets a 32-byte nonce hash as a uint256 decimal string.
func NonceHexToDecimalString(nonceHex string) (string, error) {
	nonceBytes, err := evm.HexToBytes(nonceHex)
	if err != nil {
		return "", err
	}
	return new(big.Int).SetBytes(nonceBytes).String(), nil
}
