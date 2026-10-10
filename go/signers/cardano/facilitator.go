package cardano

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	x402cardano "github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
)

const protocolParametersCacheTTL = 10 * time.Minute

// FacilitatorSignerConfig configures NewFacilitatorSigner.
type FacilitatorSignerConfig struct {
	Network  string
	Provider *Blockfrost
	// Addresses are advertised in /supported; each must be a valid address on
	// Network. The facilitator never signs, so it needs no key.
	Addresses []string
	// ValidatePhase1 optionally runs complete ledger phase-1 validation.
	ValidatePhase1 func(ctx context.Context, transaction string, network string) error
}

// FacilitatorSigner is a Blockfrost-backed x402cardano.FacilitatorCardanoSigner
// that also implements evidence, protocol-parameter and evaluation reads.
type FacilitatorSigner struct {
	network        string
	provider       *Blockfrost
	addresses      []string
	validatePhase1 func(ctx context.Context, transaction string, network string) error
	now            func() time.Time

	mu           sync.Mutex
	params       *x402cardano.ProtocolParameters
	paramsLoaded time.Time
}

// NewFacilitatorSigner creates a facilitator signer for one network.
func NewFacilitatorSigner(cfg FacilitatorSignerConfig) (*FacilitatorSigner, error) {
	if !x402cardano.IsCardanoNetwork(cfg.Network) {
		return nil, fmt.Errorf("unsupported Cardano network: %s", cfg.Network)
	}
	if cfg.Provider == nil {
		return nil, fmt.Errorf("a Blockfrost provider is required")
	}
	signer := &FacilitatorSigner{
		network:        x402cardano.NormalizeNetwork(cfg.Network),
		provider:       cfg.Provider,
		addresses:      []string{},
		validatePhase1: cfg.ValidatePhase1,
		now:            time.Now,
	}
	networkID, _ := x402cardano.NetworkID(cfg.Network)
	for _, address := range cfg.Addresses {
		id, err := x402cardano.AddressNetworkID(address)
		if _, credErr := x402cardano.PaymentCredential(address); err != nil || credErr != nil || id != networkID {
			return nil, fmt.Errorf("facilitator address %q is not a valid %s address", address, signer.network)
		}
		signer.addresses = append(signer.addresses, address)
	}
	return signer, nil
}

func (s *FacilitatorSigner) checkNetwork(network string) error {
	if x402cardano.NormalizeNetwork(network) != s.network {
		return fmt.Errorf("signer configured for %s but asked about %s", s.network, network)
	}
	return nil
}

// GetAddresses implements x402cardano.FacilitatorCardanoSigner.
func (s *FacilitatorSigner) GetAddresses() []string { return s.addresses }

// GetUtxo implements x402cardano.FacilitatorCardanoSigner. The owner address is
// reported for spent outputs too, so settlement retries can resolve the payer.
func (s *FacilitatorSigner) GetUtxo(ctx context.Context, ref string, network string) (*x402cardano.UtxoSnapshot, error) {
	if err := s.checkNetwork(network); err != nil {
		return nil, err
	}
	txHash, index, err := x402cardano.ParseUtxoRef(ref)
	if err != nil {
		return nil, err
	}
	output, err := s.provider.TxOutput(ctx, txHash, index)
	if err != nil {
		return nil, err
	}
	if output == nil {
		return &x402cardano.UtxoSnapshot{Exists: false}, nil
	}
	snapshot := &x402cardano.UtxoSnapshot{Address: output.Address}
	if credential, err := x402cardano.PaymentCredential(output.Address); err == nil && !credential.IsScript {
		snapshot.PaymentKeyHash = credential.HashHex()
	}
	spent, err := s.outputSpent(ctx, output, txHash, index)
	if err != nil {
		return nil, err
	}
	if spent {
		return snapshot, nil
	}
	coin := output.Coin
	snapshot.Exists = true
	snapshot.Coin = &coin
	snapshot.Assets = output.Assets
	return snapshot, nil
}

func (s *FacilitatorSigner) outputSpent(ctx context.Context, output *TxOutputInfo, txHash string, index uint32) (bool, error) {
	if output.ConsumedBy != nil {
		return *output.ConsumedBy != "", nil
	}
	unspent, err := s.provider.UtxosAt(ctx, output.Address)
	if err != nil {
		return false, err
	}
	for _, u := range unspent {
		if u.TxHash == txHash && u.Index == index {
			return false, nil
		}
	}
	return true, nil
}

// GetCurrentSlot implements x402cardano.FacilitatorCardanoSigner from the wall clock.
func (s *FacilitatorSigner) GetCurrentSlot(_ context.Context, network string) (uint64, error) {
	if err := s.checkNetwork(network); err != nil {
		return 0, err
	}
	return x402cardano.PosixMsToSlot(network, s.now().UnixMilli())
}

// SubmitTransaction implements x402cardano.FacilitatorCardanoSigner. The
// client's bytes are submitted unchanged; confirmation is observed separately.
func (s *FacilitatorSigner) SubmitTransaction(ctx context.Context, transaction string, network string) (*x402cardano.SubmissionResult, error) {
	if err := s.checkNetwork(network); err != nil {
		return nil, err
	}
	raw, err := x402cardano.DecodeTransactionBytes(transaction)
	if err != nil {
		return nil, err
	}
	txHash, err := s.provider.Submit(ctx, raw)
	if err != nil {
		return nil, err
	}
	return &x402cardano.SubmissionResult{TxHash: txHash, Status: x402cardano.EvidenceMempool}, nil
}

// IsDefinitiveSubmissionRejection implements
// x402cardano.SubmissionRejectionClassifier: Blockfrost answers 400 when the
// node rejected the transaction.
func (s *FacilitatorSigner) IsDefinitiveSubmissionRejection(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Path == submitPath && apiErr.StatusCode == http.StatusBadRequest
}

// IsSubmissionNotSent implements x402cardano.SubmissionNotSentClassifier:
// connection failures and requests Blockfrost refused before forwarding
// (auth, quota, rate limit, full mempool) never reached a node.
func (s *FacilitatorSigner) IsSubmissionNotSent(err error) bool {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		switch apiErr.StatusCode {
		case http.StatusPaymentRequired, http.StatusForbidden, http.StatusTooEarly, http.StatusTooManyRequests:
			return true
		}
		return false
	}
	var dnsErr *net.DNSError
	var opErr *net.OpError
	return errors.As(err, &dnsErr) || (errors.As(err, &opErr) && opErr.Op == "dial")
}

// GetTransactionEvidence implements x402cardano.TransactionEvidenceReader.
func (s *FacilitatorSigner) GetTransactionEvidence(ctx context.Context, txHash string, network string) (*x402cardano.SettlementEvidence, error) {
	if err := s.checkNetwork(network); err != nil {
		return nil, err
	}
	return s.provider.Evidence(ctx, strings.ToLower(txHash))
}

// GetProtocolParameters implements x402cardano.ProtocolParametersReader with a short cache.
func (s *FacilitatorSigner) GetProtocolParameters(ctx context.Context, network string) (*x402cardano.ProtocolParameters, error) {
	if err := s.checkNetwork(network); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.params != nil && s.now().Sub(s.paramsLoaded) < protocolParametersCacheTTL {
		return s.params, nil
	}
	params, err := s.provider.ProtocolParameters(ctx)
	if err != nil {
		return nil, err
	}
	s.params = &x402cardano.ProtocolParameters{
		CoinsPerUtxoByte:  params.CoinsPerUtxoByte,
		MinFeeCoefficient: params.MinFeeA,
		MinFeeConstant:    params.MinFeeB,
	}
	s.paramsLoaded = s.now()
	return s.params, nil
}

// EvaluateTransaction implements x402cardano.TransactionEvaluator. A
// transaction without redeemers runs no scripts and needs no evaluation.
func (s *FacilitatorSigner) EvaluateTransaction(ctx context.Context, transaction string, network string) error {
	if err := s.checkNetwork(network); err != nil {
		return err
	}
	decoded, err := x402cardano.DecodeTransaction(transaction)
	if err != nil {
		return err
	}
	if decoded.RedeemerCount == 0 {
		return nil
	}
	raw, _ := base64.StdEncoding.DecodeString(transaction)
	return s.provider.Evaluate(ctx, raw)
}

// Phase1Facilitator wraps a FacilitatorSigner whose config sets ValidatePhase1,
// exposing x402cardano.Phase1Validator.
type Phase1Facilitator struct{ *FacilitatorSigner }

// ValidatePhase1Transaction implements x402cardano.Phase1Validator.
func (s Phase1Facilitator) ValidatePhase1Transaction(ctx context.Context, transaction string, network string) error {
	if err := s.checkNetwork(network); err != nil {
		return err
	}
	return s.validatePhase1(ctx, transaction, network)
}

// AsFacilitatorSigner returns the signer to pass to the facilitator scheme:
// with ValidatePhase1 configured it also satisfies x402cardano.Phase1Validator.
func (s *FacilitatorSigner) AsFacilitatorSigner() x402cardano.FacilitatorCardanoSigner {
	if s.validatePhase1 != nil {
		return Phase1Facilitator{s}
	}
	return s
}
