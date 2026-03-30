package client

import (
	"context"
	"fmt"
	"math/big"
	"time"

	"github.com/ethereum/go-ethereum/common"

	"github.com/coinbase/x402/go/extensions/eip2612gassponsor"
	"github.com/coinbase/x402/go/extensions/erc20approvalgassponsor"
	"github.com/coinbase/x402/go/mechanisms/evm"
	exactclient "github.com/coinbase/x402/go/mechanisms/evm/exact/client"
	"github.com/coinbase/x402/go/types"
)

// UptoEvmScheme implements SchemeNetworkClient and ExtensionAwareClient for EVM upto payments.
// Always uses Permit2 (no EIP-3009 path).
type UptoEvmScheme struct {
	signer evm.ClientEvmSigner
	config *UptoEvmSchemeConfig
}

func NewUptoEvmScheme(signer evm.ClientEvmSigner, config *UptoEvmSchemeConfig) *UptoEvmScheme {
	return &UptoEvmScheme{
		signer: signer,
		config: config,
	}
}

func (c *UptoEvmScheme) Scheme() string {
	return evm.SchemeUpto
}

// CreatePaymentPayload creates a V2 payment payload for the upto scheme (always Permit2).
func (c *UptoEvmScheme) CreatePaymentPayload(
	ctx context.Context,
	requirements types.PaymentRequirements,
) (types.PaymentPayload, error) {
	return CreateUptoPermit2Payload(ctx, c.signer, requirements)
}

// CreatePaymentPayloadWithExtensions creates a payment payload with extension support.
func (c *UptoEvmScheme) CreatePaymentPayloadWithExtensions(
	ctx context.Context,
	requirements types.PaymentRequirements,
	extensions map[string]interface{},
) (types.PaymentPayload, error) {
	result, err := CreateUptoPermit2Payload(ctx, c.signer, requirements)
	if err != nil {
		return types.PaymentPayload{}, err
	}

	extData, err := c.trySignEip2612Permit(ctx, requirements, result, extensions)
	if extData != nil {
		result.Extensions = extData
	} else if err == nil {
		erc20ExtData, erc20Err := c.trySignErc20Approval(ctx, requirements, extensions)
		if erc20Err == nil && erc20ExtData != nil {
			result.Extensions = erc20ExtData
		}
	}

	return result, nil
}

func (c *UptoEvmScheme) trySignEip2612Permit(
	ctx context.Context,
	requirements types.PaymentRequirements,
	result types.PaymentPayload,
	extensions map[string]interface{},
) (map[string]interface{}, error) {
	if extensions == nil {
		return nil, nil
	}
	if _, ok := extensions[eip2612gassponsor.EIP2612GasSponsoring.Key()]; !ok {
		return nil, nil
	}

	tokenName, _ := requirements.Extra["name"].(string)
	tokenVersion, _ := requirements.Extra["version"].(string)
	if tokenName == "" || tokenVersion == "" {
		return nil, nil
	}

	chainID, err := evm.GetEvmChainId(string(requirements.Network))
	if err != nil {
		return nil, err
	}

	tokenAddress := evm.NormalizeAddress(requirements.Asset)

	readSigner, err := c.resolveReadSigner(ctx, string(requirements.Network))
	if err != nil {
		return nil, err
	}
	if readSigner == nil {
		return nil, nil
	}

	allowanceResult, err := readSigner.ReadContract(
		ctx,
		tokenAddress,
		evm.ERC20AllowanceABI,
		"allowance",
		common.HexToAddress(c.signer.Address()),
		common.HexToAddress(evm.PERMIT2Address),
	)
	if err == nil {
		if allowanceBig, ok := allowanceResult.(*big.Int); ok {
			requiredAmount, ok := new(big.Int).SetString(requirements.Amount, 10)
			if ok && allowanceBig.Cmp(requiredAmount) >= 0 {
				return nil, nil
			}
		}
	}

	deadline := ""
	if result.Payload != nil {
		if auth, ok := result.Payload["permit2Authorization"].(map[string]interface{}); ok {
			if d, ok := auth["deadline"].(string); ok {
				deadline = d
			}
		}
	}
	if deadline == "" {
		deadline = fmt.Sprintf("%d", time.Now().Unix()+int64(requirements.MaxTimeoutSeconds))
	}

	info, err := exactclient.SignEip2612Permit(ctx, readSigner, tokenAddress, tokenName, tokenVersion, chainID, deadline, requirements.Amount)
	if err != nil {
		return nil, err
	}

	return map[string]interface{}{
		eip2612gassponsor.EIP2612GasSponsoring.Key(): map[string]interface{}{
			"info": info,
		},
	}, nil
}

func (c *UptoEvmScheme) trySignErc20Approval(
	ctx context.Context,
	requirements types.PaymentRequirements,
	extensions map[string]interface{},
) (map[string]interface{}, error) {
	if extensions == nil {
		return nil, nil
	}
	if _, ok := extensions[erc20approvalgassponsor.ERC20ApprovalGasSponsoring.Key()]; !ok {
		return nil, nil
	}

	txSigner, err := c.resolveTxSigner(ctx, string(requirements.Network))
	if err != nil {
		return nil, err
	}
	if txSigner == nil {
		return nil, nil
	}

	chainID, err := evm.GetEvmChainId(string(requirements.Network))
	if err != nil {
		return nil, err
	}

	tokenAddress := evm.NormalizeAddress(requirements.Asset)

	if readSigner, hasRead := c.signer.(evm.ClientEvmSignerWithReadContract); hasRead {
		allowanceResult, err := readSigner.ReadContract(
			ctx,
			tokenAddress,
			evm.ERC20AllowanceABI,
			"allowance",
			common.HexToAddress(c.signer.Address()),
			common.HexToAddress(evm.PERMIT2Address),
		)
		if err == nil {
			if allowanceBig, ok := allowanceResult.(*big.Int); ok {
				requiredAmount, ok := new(big.Int).SetString(requirements.Amount, 10)
				if ok && allowanceBig.Cmp(requiredAmount) >= 0 {
					return nil, nil
				}
			}
		}
	}

	info, err := exactclient.SignErc20ApprovalTransaction(ctx, txSigner, tokenAddress, chainID)
	if err != nil {
		return nil, err
	}

	return map[string]interface{}{
		erc20approvalgassponsor.ERC20ApprovalGasSponsoring.Key(): map[string]interface{}{
			"info": info,
		},
	}, nil
}
