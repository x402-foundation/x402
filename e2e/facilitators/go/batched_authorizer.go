package main

import (
	"context"
	"crypto/ecdsa"
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/math"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
	evmmech "github.com/x402-foundation/x402/go/mechanisms/evm"
	"github.com/x402-foundation/x402/go/mechanisms/evm/batch-settlement"
)

// batchedAuthorizerSigner produces ClaimBatch and Refund EIP-712 signatures
// advertised by the batch-settlement scheme under /supported. Mirrors the TS
// e2e facilitator's authorizerSigner and the example facilitator's
// authorizer.go helper.
type batchedAuthorizerSigner struct {
	privateKey *ecdsa.PrivateKey
	address    common.Address
}

func newBatchedAuthorizerSigner(privateKeyHex string) (*batchedAuthorizerSigner, error) {
	pk, err := crypto.HexToECDSA(strings.TrimPrefix(privateKeyHex, "0x"))
	if err != nil {
		return nil, fmt.Errorf("parse private key: %w", err)
	}
	return &batchedAuthorizerSigner{
		privateKey: pk,
		address:    crypto.PubkeyToAddress(pk.PublicKey),
	}, nil
}

func (a *batchedAuthorizerSigner) Address() string { return a.address.Hex() }

func (a *batchedAuthorizerSigner) SignClaimBatch(ctx context.Context, claims []batchsettlement.BatchSettlementVoucherClaim, network string) ([]byte, error) {
	chainId, err := evmmech.GetEvmChainId(network)
	if err != nil {
		return nil, err
	}
	domain := batchsettlement.GetBatchSettlementEip712Domain(chainId)

	allTypes := map[string][]evmmech.TypedDataField{
		"EIP712Domain": eip712DomainFields,
		"ClaimBatch":   batchsettlement.ClaimBatchTypes["ClaimBatch"],
		"ClaimEntry":   batchsettlement.ClaimBatchTypes["ClaimEntry"],
	}

	entries := make([]map[string]interface{}, len(claims))
	for i, claim := range claims {
		channelId, _ := batchsettlement.ComputeChannelId(claim.Voucher.Channel, network)
		channelIdBytes, _ := evmmech.HexToBytes(channelId)
		maxClaimable, _ := new(big.Int).SetString(claim.Voucher.MaxClaimableAmount, 10)
		totalClaimed, _ := new(big.Int).SetString(claim.TotalClaimed, 10)
		entries[i] = map[string]interface{}{
			"channelId":          channelIdBytes,
			"maxClaimableAmount": maxClaimable,
			"totalClaimed":       totalClaimed,
		}
	}
	return a.signTypedData(domain, allTypes, "ClaimBatch", map[string]interface{}{"claims": entries})
}

func (a *batchedAuthorizerSigner) SignRefund(ctx context.Context, channelId string, amount string, nonce string, network string) ([]byte, error) {
	chainId, err := evmmech.GetEvmChainId(network)
	if err != nil {
		return nil, err
	}
	refundAmount, ok := new(big.Int).SetString(amount, 10)
	if !ok {
		return nil, fmt.Errorf("invalid refund amount: %s", amount)
	}
	refundNonce, ok := new(big.Int).SetString(nonce, 10)
	if !ok {
		return nil, fmt.Errorf("invalid nonce: %s", nonce)
	}
	channelIdBytes, err := evmmech.HexToBytes(channelId)
	if err != nil {
		return nil, err
	}

	domain := batchsettlement.GetBatchSettlementEip712Domain(chainId)
	allTypes := map[string][]evmmech.TypedDataField{
		"EIP712Domain": eip712DomainFields,
		"Refund":       batchsettlement.RefundTypes["Refund"],
	}
	message := map[string]interface{}{
		"channelId": channelIdBytes,
		"nonce":     refundNonce,
		"amount":    refundAmount,
	}
	return a.signTypedData(domain, allTypes, "Refund", message)
}

func (a *batchedAuthorizerSigner) signTypedData(
	domain evmmech.TypedDataDomain,
	allTypes map[string][]evmmech.TypedDataField,
	primaryType string,
	message map[string]interface{},
) ([]byte, error) {
	td := apitypes.TypedData{
		Types:       apitypes.Types{},
		PrimaryType: primaryType,
		Domain: apitypes.TypedDataDomain{
			Name:              getStringFromInterface(domain.Name),
			Version:           getStringFromInterface(domain.Version),
			ChainId:           (*math.HexOrDecimal256)(getBigIntFromInterface(domain.ChainID)),
			VerifyingContract: getStringFromInterface(domain.VerifyingContract),
		},
		Message: message,
	}
	for name, fields := range allTypes {
		conv := make([]apitypes.Type, len(fields))
		for i, f := range fields {
			conv[i] = apitypes.Type{Name: f.Name, Type: f.Type}
		}
		td.Types[name] = conv
	}

	dataHash, err := td.HashStruct(td.PrimaryType, td.Message)
	if err != nil {
		return nil, fmt.Errorf("hash struct: %w", err)
	}
	domainSep, err := td.HashStruct("EIP712Domain", td.Domain.Map())
	if err != nil {
		return nil, fmt.Errorf("hash domain: %w", err)
	}
	digest := crypto.Keccak256(append([]byte{0x19, 0x01}, append(domainSep, dataHash...)...))
	sig, err := crypto.Sign(digest, a.privateKey)
	if err != nil {
		return nil, fmt.Errorf("sign: %w", err)
	}
	sig[64] += 27
	return sig, nil
}

// eip712DomainFields is the canonical EIP-712 domain layout (name + version +
// chainId + verifyingContract) used by every batch-settlement signature.
var eip712DomainFields = []evmmech.TypedDataField{
	{Name: "name", Type: "string"},
	{Name: "version", Type: "string"},
	{Name: "chainId", Type: "uint256"},
	{Name: "verifyingContract", Type: "address"},
}
