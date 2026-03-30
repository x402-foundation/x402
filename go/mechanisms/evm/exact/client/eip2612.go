package client

import (
	"context"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/common"

	"github.com/coinbase/x402/go/extensions/eip2612gassponsor"
	"github.com/coinbase/x402/go/mechanisms/evm"
)

// SignEip2612Permit signs an EIP-2612 permit authorizing the Permit2 contract
// to spend tokens. This creates a gasless off-chain signature that the
// facilitator can submit on-chain via x402Permit2Proxy.settleWithPermit().
//
// The permittedAmount must match the Permit2 permitted.amount exactly, as the
// proxy contract enforces permit2612.value == permittedAmount.
func SignEip2612Permit(
	ctx context.Context,
	signer evm.ClientEvmSignerWithReadContract,
	tokenAddress string,
	tokenName string,
	tokenVersion string,
	chainID *big.Int,
	deadline string,
	permittedAmount string,
) (*eip2612gassponsor.Info, error) {
	owner := signer.Address()
	spender := evm.PERMIT2Address
	normalizedToken := evm.NormalizeAddress(tokenAddress)

	// Query the current EIP-2612 nonce from the token contract
	nonceResult, err := signer.ReadContract(
		ctx,
		normalizedToken,
		evm.EIP2612NoncesABI,
		"nonces",
		common.HexToAddress(owner),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to read EIP-2612 nonce: %w", err)
	}

	nonce, ok := nonceResult.(*big.Int)
	if !ok {
		return nil, fmt.Errorf("unexpected nonce type: %T", nonceResult)
	}

	// Parse deadline
	deadlineBig, ok := new(big.Int).SetString(deadline, 10)
	if !ok {
		return nil, fmt.Errorf("invalid deadline: %s", deadline)
	}

	// Construct EIP-712 domain for the token's permit function
	domain := evm.TypedDataDomain{
		Name:              tokenName,
		Version:           tokenVersion,
		ChainID:           chainID,
		VerifyingContract: normalizedToken,
	}

	types := evm.GetEIP2612EIP712Types()

	approvalAmount, ok := new(big.Int).SetString(permittedAmount, 10)
	if !ok {
		return nil, fmt.Errorf("invalid permitted amount: %s", permittedAmount)
	}

	message := map[string]interface{}{
		"owner":    owner,
		"spender":  spender,
		"value":    approvalAmount,
		"nonce":    nonce,
		"deadline": deadlineBig,
	}

	// Sign the EIP-2612 permit
	signatureBytes, err := signer.SignTypedData(ctx, domain, types, "Permit", message)
	if err != nil {
		return nil, fmt.Errorf("failed to sign EIP-2612 permit: %w", err)
	}

	return &eip2612gassponsor.Info{
		From:      owner,
		Asset:     normalizedToken,
		Spender:   spender,
		Amount:    approvalAmount.String(),
		Nonce:     nonce.String(),
		Deadline:  deadline,
		Signature: evm.BytesToHex(signatureBytes),
		Version:   "1",
	}, nil
}
