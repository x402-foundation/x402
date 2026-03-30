package client

import (
	"context"
	"fmt"
	"math/big"
	"time"

	"github.com/coinbase/x402/go/mechanisms/evm"
	"github.com/coinbase/x402/go/types"
)

// CreateUptoPermit2Payload creates a Permit2 payload using the x402UptoPermit2Proxy witness pattern.
// The upto witness includes a facilitator address, which must be provided in requirements.Extra.
func CreateUptoPermit2Payload(
	ctx context.Context,
	signer evm.ClientEvmSigner,
	requirements types.PaymentRequirements,
) (types.PaymentPayload, error) {
	facilitatorAddress, _ := requirements.Extra["facilitatorAddress"].(string)
	if facilitatorAddress == "" {
		return types.PaymentPayload{}, fmt.Errorf(
			"%s: upto scheme requires facilitatorAddress in paymentRequirements.extra; "+
				"ensure the server is configured with an upto facilitator that provides getExtra()",
			ErrMissingFacilitatorAddress,
		)
	}

	networkStr := string(requirements.Network)

	chainID, err := evm.GetEvmChainId(networkStr)
	if err != nil {
		return types.PaymentPayload{}, err
	}

	nonce, err := evm.CreatePermit2Nonce()
	if err != nil {
		return types.PaymentPayload{}, err
	}

	now := time.Now().Unix()
	validAfter := fmt.Sprintf("%d", now-600)
	deadline := fmt.Sprintf("%d", now+int64(requirements.MaxTimeoutSeconds))

	tokenAddress := evm.NormalizeAddress(requirements.Asset)
	payTo := evm.NormalizeAddress(requirements.PayTo)
	normalizedFacilitator := evm.NormalizeAddress(facilitatorAddress)

	authorization := evm.UptoPermit2Authorization{
		From: signer.Address(),
		Permitted: evm.Permit2TokenPermissions{
			Token:  tokenAddress,
			Amount: requirements.Amount,
		},
		Spender:  evm.X402UptoPermit2ProxyAddress,
		Nonce:    nonce,
		Deadline: deadline,
		Witness: evm.UptoPermit2Witness{
			To:          payTo,
			Facilitator: normalizedFacilitator,
			ValidAfter:  validAfter,
		},
	}

	signature, err := signUptoPermit2Authorization(ctx, signer, authorization, chainID)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrFailedToSignPermit2Authorization+": %w", err)
	}

	uptoPayload := &evm.UptoPermit2Payload{
		Signature:            evm.BytesToHex(signature),
		Permit2Authorization: authorization,
	}

	return types.PaymentPayload{
		X402Version: 2,
		Payload:     uptoPayload.ToMap(),
	}, nil
}

func signUptoPermit2Authorization(
	ctx context.Context,
	signer evm.ClientEvmSigner,
	authorization evm.UptoPermit2Authorization,
	chainID *big.Int,
) ([]byte, error) {
	domain := evm.TypedDataDomain{
		Name:              "Permit2",
		ChainID:           chainID,
		VerifyingContract: evm.PERMIT2Address,
	}

	types := evm.GetUptoPermit2EIP712Types()

	amount, ok := new(big.Int).SetString(authorization.Permitted.Amount, 10)
	if !ok {
		return nil, fmt.Errorf("invalid permitted amount: %s", authorization.Permitted.Amount)
	}
	nonce, ok := new(big.Int).SetString(authorization.Nonce, 10)
	if !ok {
		return nil, fmt.Errorf("invalid nonce: %s", authorization.Nonce)
	}
	deadline, ok := new(big.Int).SetString(authorization.Deadline, 10)
	if !ok {
		return nil, fmt.Errorf("invalid deadline: %s", authorization.Deadline)
	}
	validAfter, ok := new(big.Int).SetString(authorization.Witness.ValidAfter, 10)
	if !ok {
		return nil, fmt.Errorf("invalid validAfter: %s", authorization.Witness.ValidAfter)
	}

	message := map[string]interface{}{
		"permitted": map[string]interface{}{
			"token":  authorization.Permitted.Token,
			"amount": amount,
		},
		"spender":  authorization.Spender,
		"nonce":    nonce,
		"deadline": deadline,
		"witness":  evm.BuildUptoPermit2WitnessMap(authorization.Witness.To, authorization.Witness.Facilitator, validAfter),
	}

	return signer.SignTypedData(ctx, domain, types, "PermitWitnessTransferFrom", message)
}
