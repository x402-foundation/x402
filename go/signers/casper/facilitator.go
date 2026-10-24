package casper

import (
	"context"
	"fmt"
	"net/http"
	"time"

	casperSDK "github.com/make-software/casper-go-sdk/v2/casper"
	"github.com/make-software/casper-go-sdk/v2/types"
	"github.com/make-software/casper-go-sdk/v2/types/keypair"

	x402Casper "github.com/x402-foundation/x402/go/v2/mechanisms/casper"
)

const (
	DefaultTransactionWaitTimeout  = 60 * time.Second
	DefaultTransactionPollInterval = 4 * time.Second
)

type FacilitatorSigner struct {
	keys                    map[string]keypair.PrivateKey
	rpcURLs                 map[string]string
	speculativeRpcURLs      map[string]string
	transactionWaitTimeout  time.Duration
	transactionPollInterval time.Duration
}

// FacilitatorSignerConfig is the configuration for constructing a FacilitatorSigner.
// RpcURLs maps each network identifier to its primary JSON-RPC endpoint.
// SpeculativeRpcURLs optionally maps each network identifier to a speculative
// execution endpoint; when set for a network, facilitators can use it to
// in the verify step to validate payments requirements.
// TransactionWaitTimeout bounds how long WaitForTransaction polls for execution
// (default DefaultTransactionWaitTimeout); it should stay below
// x402Casper.SettlementTTL. TransactionPollInterval defaults to
// DefaultTransactionPollInterval.
type FacilitatorSignerConfig struct {
	Keys                    map[string]keypair.PrivateKey
	RpcURLs                 map[string]string
	SpeculativeRpcURLs      map[string]string
	TransactionWaitTimeout  time.Duration
	TransactionPollInterval time.Duration
}

func NewPrivateKeyFromSecret(privateKeyHex string, algo string) (*keypair.PrivateKey, error) {
	switch algo {
	case "ed25519", "":
		key, err := keypair.NewPrivateKeyFromSeedHex(privateKeyHex, keypair.ED25519)
		if err != nil {
			return nil, fmt.Errorf("failed to load ed25519 key: %w", err)
		}
		return &key, nil
	case "secp256k1":
		key, err := keypair.NewPrivateKeyFromHex(privateKeyHex, keypair.SECP256K1)
		if err != nil {
			return nil, fmt.Errorf("failed to load secp256k1 key: %w", err)
		}
		return &key, nil
	default:
		return nil, fmt.Errorf("unsupported key algorithm: %q, must be 'ed25519' or 'secp256k1'", algo)
	}
}

func NewFacilitatorSigner(cfg FacilitatorSignerConfig) *FacilitatorSigner {
	waitTimeout := cfg.TransactionWaitTimeout
	if waitTimeout <= 0 {
		waitTimeout = DefaultTransactionWaitTimeout
	}
	pollInterval := cfg.TransactionPollInterval
	if pollInterval <= 0 {
		pollInterval = DefaultTransactionPollInterval
	}

	return &FacilitatorSigner{
		keys:                    cfg.Keys,
		rpcURLs:                 cfg.RpcURLs,
		speculativeRpcURLs:      cfg.SpeculativeRpcURLs,
		transactionWaitTimeout:  waitTimeout,
		transactionPollInterval: pollInterval,
	}
}

func (s *FacilitatorSigner) GetNetworkConfig(_ context.Context, network string) (x402Casper.NetworkConfig, error) {
	rpcURL := s.rpcURL(network)

	if len(rpcURL) == 0 {
		return x402Casper.NetworkConfig{}, fmt.Errorf("network %s not configured in this signer", network)
	}

	return x402Casper.NetworkConfig{
		ChainName: x402Casper.ChainNameFromNetwork(network),
		RPCURL:    rpcURL,
	}, nil
}

func (s *FacilitatorSigner) GetAddresses(_ context.Context, network string) []string {
	key, ok := s.keys[network]
	if !ok {
		return nil
	}

	pubKey := key.PublicKey()
	return []string{pubKey.AccountHash().ToHex()}
}

func (s *FacilitatorSigner) GetPublicKeyHex(_ context.Context, network string) (string, error) {
	key, ok := s.keys[network]
	if !ok {
		return "", fmt.Errorf("no key registered for network %s", network)
	}

	return key.PublicKey().ToHex(), nil
}

func (s *FacilitatorSigner) VerifyEIP712Signature(digest [32]byte, sig [65]byte, publicKey string) (bool, error) {
	pk, err := keypair.NewPublicKey(publicKey)
	if err != nil {
		return false, err
	}
	if len(publicKey) != pk.SerializedLength()*2 {
		return false, fmt.Errorf("invalid public key length")
	}
	if sig[0] != pk.Bytes()[0] {
		return false, fmt.Errorf("signature algorithm tag %#x does not match public key algorithm tag %#x", sig[0], pk.Bytes()[0])
	}
	if err := x402Casper.ValidateSignatureFormat(sig); err != nil {
		return false, err
	}
	err = pk.VerifySignature(digest[:], sig[:])
	if err != nil {
		return false, err
	}
	return true, nil
}

func (s *FacilitatorSigner) SignTransaction(transaction *types.TransactionV1, network string) error {
	key, ok := s.keys[network]
	if !ok {
		return fmt.Errorf("no key registered for network %s", network)
	}

	return transaction.Sign(key)
}

func (s *FacilitatorSigner) SignDeploy(deploy *types.Deploy, network string) error {
	key, ok := s.keys[network]
	if !ok {
		return fmt.Errorf("no key registered for network %s", network)
	}

	return deploy.Sign(key)
}

func (s *FacilitatorSigner) GetSpeculativeRpcUrl(network string) string {
	url, ok := s.speculativeRpcURLs[network]
	if !ok {
		return ""
	}
	return url
}

func (s *FacilitatorSigner) PutTransaction(ctx context.Context, network string, transaction types.TransactionV1) (string, error) {
	handler := casperSDK.NewRPCHandler(s.rpcURL(network), http.DefaultClient)
	client := casperSDK.NewRPCClient(handler)
	result, err := client.PutTransactionV1(ctx, transaction)
	if err != nil {
		return "", fmt.Errorf("PutTransaction RPC failed: %w", err)
	}

	return result.TransactionHash.String(), nil
}

func (s *FacilitatorSigner) WaitForTransaction(ctx context.Context, network string, transactionHash string) error {
	ctx, cancel := context.WithTimeout(ctx, s.transactionWaitTimeout)
	defer cancel()

	handler := casperSDK.NewRPCHandler(s.rpcURL(network), http.DefaultClient)
	client := casperSDK.NewRPCClient(handler)
	ticker := time.NewTicker(s.transactionPollInterval)
	defer ticker.Stop()

	var lastErr error
	for {
		select {
		case <-ctx.Done():
			if lastErr != nil {
				return fmt.Errorf("transaction %s not confirmed: %w (last RPC error: %v)", transactionHash, ctx.Err(), lastErr)
			}
			return fmt.Errorf("transaction %s not confirmed: %w", transactionHash, ctx.Err())
		case <-ticker.C:
			res, err := client.GetTransactionByTransactionHash(ctx, transactionHash)
			if err != nil {
				if ctx.Err() == nil {
					lastErr = err
				}
				continue
			}
			if res.ExecutionInfo == nil || res.ExecutionInfo.BlockHeight == 0 ||
				res.ExecutionInfo.ExecutionResult == nil {
				continue
			}

			execResult := res.ExecutionInfo.ExecutionResult
			if execResult.ErrorMessage != nil {
				return &x402Casper.TransactionExecutionError{Message: *execResult.ErrorMessage}
			}

			return nil
		}
	}
}

func (s *FacilitatorSigner) rpcURL(network string) string {
	if url, ok := s.rpcURLs[network]; ok && url != "" {
		return url
	}

	if cfg, err := x402Casper.GetNetworkConfig(network); err == nil {
		return cfg.RPCURL
	}

	return ""
}
