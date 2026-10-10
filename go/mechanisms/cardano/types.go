package cardano

import (
	"context"

	"github.com/x402-foundation/x402/go/v2/types"
)

// ConfirmationPolicy is the requirements' extra.confirmationPolicy block.
// L1Confirmations is -1 (mempool), 0 (canonical block) or 1..20 (depth).
type ConfirmationPolicy struct {
	L1Confirmations int `json:"l1Confirmations"`
}

// ExactCardanoPayload is the scheme payload: a base64 signed transaction and
// the UTxO reference (txHash#index) it spends as replay nonce.
type ExactCardanoPayload struct {
	Transaction string `json:"transaction"`
	Nonce       string `json:"nonce"`
}

// ToMap converts the payload to the generic payload map.
func (p ExactCardanoPayload) ToMap() map[string]interface{} {
	return map[string]interface{}{"transaction": p.Transaction, "nonce": p.Nonce}
}

// ClientSignInput is what a client signer receives to build one payment.
type ClientSignInput struct {
	Network           string
	PayTo             string
	Asset             string
	Amount            string
	MaxTimeoutSeconds int
	Extra             map[string]interface{}
	Resource          *types.ResourceInfo
}

// ClientSignResult is a signed, not yet broadcast transaction and its nonce input.
type ClientSignResult struct {
	Transaction string
	Nonce       string
}

// ClientCardanoSigner builds and signs payment transactions for a client.
type ClientCardanoSigner interface {
	Address() string
	BuildAndSignPaymentTransaction(ctx context.Context, input ClientSignInput) (*ClientSignResult, error)
}

// Settlement evidence statuses.
const (
	EvidenceUnknown   = "unknown"
	EvidenceMempool   = "mempool"
	EvidenceConfirmed = "confirmed"
)

// SettlementEvidence is authenticated evidence for one transaction. Confirmations
// is -1 for mempool, 0 for inclusion and n for n newer blocks; it is meaningless
// while Status is unknown.
type SettlementEvidence struct {
	Status        string
	Confirmations int
}

// SubmissionResult is what the chain layer reports after accepting a transaction.
// Status is EvidenceConfirmed or EvidenceMempool.
type SubmissionResult struct {
	TxHash string
	Status string
}

// ProtocolParameters are the live parameters the built-in phase-1 checks need.
type ProtocolParameters struct {
	CoinsPerUtxoByte  uint64
	MinFeeCoefficient uint64
	MinFeeConstant    uint64
}

// UtxoSnapshot describes one UTxO. Address should be reported even when the
// output is spent: settlement retries resolve the payer from it. Coin is nil
// when the chain layer cannot report the value.
type UtxoSnapshot struct {
	Exists  bool
	Address string
	Coin    *uint64
	Assets  map[string]uint64
	// PaymentKeyHash is the key hash owning a key-locked output, when the chain
	// layer reports it; otherwise it is derived from Address.
	PaymentKeyHash string
}

// FacilitatorCardanoSigner is the facilitator's chain access. Lookups return
// Exists=false for spent or unknown outputs and an error only when the lookup
// itself fails.
type FacilitatorCardanoSigner interface {
	GetAddresses() []string
	GetUtxo(ctx context.Context, ref string, network string) (*UtxoSnapshot, error)
	GetCurrentSlot(ctx context.Context, network string) (uint64, error)
	SubmitTransaction(ctx context.Context, transaction string, network string) (*SubmissionResult, error)
}

// TransactionEvidenceReader reads settlement evidence. It must report
// EvidenceUnknown for unknown and phase-2 invalid transactions. Required for
// confirmation depths above 0 and for resuming pending settlements.
type TransactionEvidenceReader interface {
	GetTransactionEvidence(ctx context.Context, txHash string, network string) (*SettlementEvidence, error)
}

// ProtocolParametersReader enables the min-UTxO and fee-floor checks.
type ProtocolParametersReader interface {
	GetProtocolParameters(ctx context.Context, network string) (*ProtocolParameters, error)
}

// TransactionEvaluator dry-runs Plutus scripts of a signed transaction.
type TransactionEvaluator interface {
	EvaluateTransaction(ctx context.Context, transaction string, network string) error
}

// Phase1Validator runs the complete ledger phase-1 rules. It is the only way to
// accept balance-changing operations (mint, withdrawals, certificates, ...).
type Phase1Validator interface {
	ValidatePhase1Transaction(ctx context.Context, transaction string, network string) error
}

// SubmissionRejectionClassifier reports whether a submit error proves the node
// rejected the transaction. Ambiguous errors must return false.
type SubmissionRejectionClassifier interface {
	IsDefinitiveSubmissionRejection(err error) bool
}

// SubmissionNotSentClassifier reports whether a submit error proves the
// transaction never reached a node (connection refused, rate limited, ...),
// so the claim can be released and a retry may submit again. Ambiguous errors
// such as timeouts must return false: their claim is kept and never rebroadcast.
type SubmissionNotSentClassifier interface {
	IsSubmissionNotSent(err error) bool
}
