package casper

import (
	"context"

	caspertypes "github.com/make-software/casper-go-sdk/v2/types"
)

type NetworkConfig struct {
	ChainName string
	RPCURL    string
}

type AssetInfo struct {
	Asset    string
	Symbol   string
	Decimals int
}

type ClientCasperSigner interface {
	AccountAddress() string
	PublicKey() string
	SignEIP712(digest [32]byte) ([65]byte, error)
}

type FacilitatorCasperSigner interface {
	GetNetworkConfig(ctx context.Context, network string) (NetworkConfig, error)
	GetAddresses(ctx context.Context, network string) []string
	GetPublicKeyHex(ctx context.Context, network string) (string, error)
	VerifyEIP712Signature(digest [32]byte, sig [65]byte, publicKey string) (bool, error)
	SignTransaction(transaction *caspertypes.TransactionV1, network string) error
	SignDeploy(deploy *caspertypes.Deploy, network string) error
	GetSpeculativeRpcUrl(network string) string
	PutTransaction(ctx context.Context, network string, transaction caspertypes.TransactionV1) (string, error)
	WaitForTransaction(ctx context.Context, network string, transactionHash string) error
}

type ExactCasperAuthorization struct {
	From        string `json:"from"`
	To          string `json:"to"`
	Value       string `json:"value"`
	ValidAfter  string `json:"validAfter"`
	ValidBefore string `json:"validBefore"`
	Nonce       string `json:"nonce"`
}

type ExactCasperPayload struct {
	Signature     string                   `json:"signature"`
	PublicKey     string                   `json:"publicKey"`
	Authorization ExactCasperAuthorization `json:"authorization"`
}

func (p *ExactCasperPayload) ToMap() map[string]interface{} {
	return map[string]interface{}{
		"signature": p.Signature,
		"publicKey": p.PublicKey,
		"authorization": map[string]interface{}{
			"from":        p.Authorization.From,
			"to":          p.Authorization.To,
			"value":       p.Authorization.Value,
			"validAfter":  p.Authorization.ValidAfter,
			"validBefore": p.Authorization.ValidBefore,
			"nonce":       p.Authorization.Nonce,
		},
	}
}
