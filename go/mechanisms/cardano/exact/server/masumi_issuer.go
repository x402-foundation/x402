package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	x402 "github.com/x402-foundation/x402/go/v2"
	x402http "github.com/x402-foundation/x402/go/v2/http"
	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano/exact/masumi"
	"github.com/x402-foundation/x402/go/v2/types"
)

// MasumiSeller is the selling wallet: its key-credential address and terms signer.
type MasumiSeller struct {
	Address   string
	SignTerms masumi.TermsSigner
}

// MasumiDeadlineOffsets are escrow deadlines relative to payByTime. The
// defaults clear Masumi's minimum intervals with headroom.
type MasumiDeadlineOffsets struct {
	SubmitResultAfterPayBy          time.Duration
	UnlockAfterPayBy                time.Duration
	ExternalDisputeUnlockAfterPayBy time.Duration
}

// DefaultMasumiDeadlineOffsets matches the TypeScript issuer.
var DefaultMasumiDeadlineOffsets = MasumiDeadlineOffsets{
	SubmitResultAfterPayBy:          15 * time.Minute,
	UnlockAfterPayBy:                35 * time.Minute,
	ExternalDisputeUnlockAfterPayBy: 55 * time.Minute,
}

// MasumiIssueContext is what a commitment builder knows about the request.
type MasumiIssueContext struct {
	Requirements types.PaymentRequirements
	Resource     *types.ResourceInfo
	// Transport is the go/http HTTPRequestContext or the MCP tool request.
	Transport interface{}
}

// MasumiIssuerConfig configures quote issuance.
type MasumiIssuerConfig struct {
	// Seller returns the selling wallet for a network.
	Seller              func(ctx context.Context, network string) (MasumiSeller, error)
	SellerReturnAddress *string
	AgentIdentifier     masumi.AgentIdentifier
	// Deployment overrides the canonical Masumi deployment (required on preview).
	Deployment *masumi.Deployment
	// Commitment builds the request commitment. The default commits the
	// resource plus the method and URL of a bodiless GET/HEAD request (other
	// requests are refused) or the MCP tool arguments.
	Commitment           func(ctx context.Context, ic MasumiIssueContext) ([]masumi.CommitmentInput, error)
	Deadlines            *MasumiDeadlineOffsets
	MaxDeadlineHorizonMs *int64
}

// MasumiRoute is one Masumi-priced route. PayTo is the escrow address derived
// from the deployment, so the signed terms cannot drift from the option.
type MasumiRoute struct {
	Network            string
	Asset              string
	Amount             string
	MaxTimeoutSeconds  int
	ConfirmationPolicy *cardano.ConfirmationPolicy
	Deployment         *masumi.Deployment
	// Resource is the resource URL the commitment covers; it must equal the
	// 402's resource. Empty uses the request URL (HTTP) or mcp://tool/<name>.
	Resource string
}

var errNoIssuer = errors.New("cardano server has no Masumi issuer configured")

// template returns the requirements every quote of this route is issued from.
func (s *ExactCardanoScheme) template(route MasumiRoute) (types.PaymentRequirements, error) {
	network := cardano.NormalizeNetwork(route.Network)
	if !cardano.IsCardanoNetwork(network) {
		return types.PaymentRequirements{}, fmt.Errorf("unsupported Cardano network: %s", route.Network)
	}
	if route.MaxTimeoutSeconds <= 0 {
		return types.PaymentRequirements{}, errors.New("masumi routes need a positive MaxTimeoutSeconds")
	}
	if _, err := validateAssetAmount(x402.AssetAmount{Asset: route.Asset, Amount: route.Amount}, "Masumi route"); err != nil {
		return types.PaymentRequirements{}, err
	}
	declared := route.Deployment
	if declared == nil && s.issuer != nil {
		declared = s.issuer.Deployment
	}
	deployment, ok := masumi.ResolveDeployment(network, declared)
	if !ok {
		return types.PaymentRequirements{}, fmt.Errorf("network %s has no canonical Masumi deployment; supply a deployment", network)
	}
	escrow, err := masumi.EscrowAddress(network, deployment)
	if err != nil {
		return types.PaymentRequirements{}, err
	}
	extra := map[string]interface{}{"assetTransferMethod": cardano.AssetTransferMethodMasumi}
	if route.ConfirmationPolicy != nil {
		extra["confirmationPolicy"] = map[string]interface{}{"l1Confirmations": route.ConfirmationPolicy.L1Confirmations}
	}
	if route.Deployment != nil {
		raw, _ := json.Marshal(route.Deployment)
		var asMap map[string]interface{}
		_ = json.Unmarshal(raw, &asMap)
		extra["deployment"] = asMap
	}
	offsets := s.offsets()
	horizon := int64(masumi.MaxDeadlineHorizonMs)
	if s.issuer != nil && s.issuer.MaxDeadlineHorizonMs != nil {
		horizon = *s.issuer.MaxDeadlineHorizonMs
	}
	if int64(route.MaxTimeoutSeconds)*1000+offsets.ExternalDisputeUnlockAfterPayBy.Milliseconds() > horizon {
		return types.PaymentRequirements{}, fmt.Errorf("masumi maxTimeoutSeconds %d pushes externalDisputeUnlockTime past the %dms horizon", route.MaxTimeoutSeconds, horizon)
	}
	return types.PaymentRequirements{
		Scheme:            cardano.SchemeExact,
		Network:           network,
		Asset:             route.Asset,
		Amount:            route.Amount,
		PayTo:             escrow,
		MaxTimeoutSeconds: route.MaxTimeoutSeconds,
		Extra:             extra,
	}, nil
}

func (s *ExactCardanoScheme) offsets() MasumiDeadlineOffsets {
	if s.issuer != nil && s.issuer.Deadlines != nil {
		return *s.issuer.Deadlines
	}
	return DefaultMasumiDeadlineOffsets
}

// quoteFor returns the stored quote the paid retry carries, or a fresh one.
// A stored quote is resumed only for the request it committed to; unknown,
// altered or foreign quotes get a fresh one, so core answers with a corrective
// 402. Only server faults are errors.
func (s *ExactCardanoScheme) quoteFor(ctx context.Context, template types.PaymentRequirements, paid *types.PaymentPayload, ic MasumiIssueContext) (types.PaymentRequirements, error) {
	if s.issuer == nil || s.issuer.Seller == nil {
		return types.PaymentRequirements{}, errNoIssuer
	}
	ic.Requirements = template
	parts, err := s.commitment(ctx, ic)
	if err != nil {
		return types.PaymentRequirements{}, err
	}
	commitment, err := masumi.BuildInputCommitment(parts)
	if err != nil {
		return types.PaymentRequirements{}, err
	}
	// A quote resumes only for the resource actually being served; the
	// facilitator also validates registry claims against payload.resource.
	if paid != nil && paid.Resource != nil && ic.Resource != nil && paid.Resource.URL == ic.Resource.URL {
		if stored, err := s.storedQuoteFor(ctx, paid.Accepted, template, commitment.Digest); err != nil {
			return types.PaymentRequirements{}, err
		} else if stored != nil {
			return *stored, nil
		}
	}
	return s.issue(ctx, template, parts)
}

// storedQuoteFor returns the stored quote accepted names when it still matches
// the route template and commits to inputHash, or nil.
func (s *ExactCardanoScheme) storedQuoteFor(ctx context.Context, accepted, template types.PaymentRequirements, inputHash string) (*types.PaymentRequirements, error) {
	if accepted.Scheme != template.Scheme || cardano.NormalizeNetwork(accepted.Network) != template.Network || !isMasumiExtra(accepted.Extra) {
		return nil, nil
	}
	digest, ok := termsDigestOf(accepted)
	if !ok {
		return nil, nil
	}
	stored, err := s.storage.Get(ctx, digest)
	if err != nil {
		return nil, err
	}
	if stored == nil {
		return nil, nil
	}
	quote := stored.Requirements
	if quote.Scheme != template.Scheme || quote.Network != template.Network || quote.PayTo != template.PayTo ||
		quote.Amount != template.Amount || quote.Asset != template.Asset || quote.MaxTimeoutSeconds != template.MaxTimeoutSeconds {
		return nil, nil
	}
	for key, value := range template.Extra {
		if !x402.DeepEqual(quote.Extra[key], value) {
			return nil, nil
		}
	}
	if quoteInputHash(quote) != inputHash {
		return nil, nil
	}
	return &quote, nil
}

// quoteInputHash is the request commitment a quote was issued for, or "".
func quoteInputHash(quote types.PaymentRequirements) string {
	extra, err := masumi.ValidateExtra(quote.Extra, quote.Network)
	if err != nil {
		return ""
	}
	return extra.Terms.InputHash
}

func (s *ExactCardanoScheme) issue(ctx context.Context, template types.PaymentRequirements, commitment []masumi.CommitmentInput) (types.PaymentRequirements, error) {
	seller, err := s.issuer.Seller(ctx, template.Network)
	if err != nil {
		return types.PaymentRequirements{}, err
	}
	offsets := s.offsets()
	payBy := time.Now().UnixMilli() + int64(template.MaxTimeoutSeconds)*1000
	ms := func(offset time.Duration) string { return strconv.FormatInt(payBy+offset.Milliseconds(), 10) }
	input := masumi.IssueInput{
		Network:                   template.Network,
		Asset:                     template.Asset,
		Amount:                    template.Amount,
		MaxTimeoutSeconds:         template.MaxTimeoutSeconds,
		SellerAddress:             seller.Address,
		SignTerms:                 seller.SignTerms,
		Commitment:                commitment,
		PayByTime:                 strconv.FormatInt(payBy, 10),
		SubmitResultTime:          ms(offsets.SubmitResultAfterPayBy),
		UnlockTime:                ms(offsets.UnlockAfterPayBy),
		ExternalDisputeUnlockTime: ms(offsets.ExternalDisputeUnlockAfterPayBy),
		AgentIdentifier:           s.issuer.AgentIdentifier,
		SellerReturnAddress:       s.issuer.SellerReturnAddress,
		MaxDeadlineHorizonMs:      s.issuer.MaxDeadlineHorizonMs,
	}
	if policy, ok := template.Extra["confirmationPolicy"]; ok {
		resolved, valid := cardano.NormalizeConfirmationPolicy(policy)
		if !valid {
			return types.PaymentRequirements{}, errors.New("masumi route carries an invalid confirmation policy")
		}
		input.ConfirmationPolicy = &resolved
	}
	if raw, ok := template.Extra["deployment"]; ok {
		encoded, _ := json.Marshal(raw)
		var deployment masumi.Deployment
		if err := json.Unmarshal(encoded, &deployment); err != nil {
			return types.PaymentRequirements{}, fmt.Errorf("invalid Masumi deployment: %w", err)
		}
		input.Deployment = &deployment
	} else if s.issuer.Deployment != nil {
		input.Deployment = s.issuer.Deployment
	}
	issued, err := masumi.IssueRequirements(ctx, input)
	if err != nil {
		return types.PaymentRequirements{}, err
	}
	if issued.PayTo != template.PayTo {
		return types.PaymentRequirements{}, fmt.Errorf("masumi route payTo must be the escrow address %s on %s; got %s", issued.PayTo, template.Network, template.PayTo)
	}
	return issued, nil
}

func (s *ExactCardanoScheme) commitment(ctx context.Context, ic MasumiIssueContext) ([]masumi.CommitmentInput, error) {
	if s.issuer.Commitment != nil {
		return s.issuer.Commitment(ctx, ic)
	}
	return defaultCommitment(ic)
}

// errUnboundBody refuses requests whose body the default commitment cannot see.
var errUnboundBody = errors.New("masumi request may carry a body the default commitment cannot bind; configure MasumiIssuerConfig.Commitment")

// defaultCommitment binds the quote to the request it answers: the resource,
// plus the HTTP method and URL (path and query) or the MCP tool arguments.
// Go core exposes neither HTTP bodies nor reliable body presence, so only
// GET and HEAD are accepted; other methods need a custom commitment builder.
func defaultCommitment(ic MasumiIssueContext) ([]masumi.CommitmentInput, error) {
	url := ""
	if ic.Resource != nil {
		url = ic.Resource.URL
	}
	jsonPart := func(name string, content interface{}) masumi.CommitmentInput {
		mediaType := "application/json"
		return masumi.CommitmentInput{Name: name, Canonicalization: "jcs", MediaType: &mediaType, Content: content}
	}
	parts := []masumi.CommitmentInput{jsonPart("resource", map[string]interface{}{"url": url})}
	switch transport := ic.Transport.(type) {
	case x402http.HTTPRequestContext:
		if transport.Adapter == nil {
			break
		}
		if mayHaveBody(transport.Adapter) {
			return nil, errUnboundBody
		}
		parts = append(parts, jsonPart("request", map[string]interface{}{
			"method": transport.Adapter.GetMethod(),
			"url":    transport.Adapter.GetURL(),
		}))
	case *mcp.CallToolRequest:
		arguments := interface{}(map[string]interface{}{})
		if transport != nil && transport.Params != nil && len(transport.Params.Arguments) > 0 {
			if err := json.Unmarshal(transport.Params.Arguments, &arguments); err != nil {
				return nil, fmt.Errorf("invalid MCP tool arguments: %w", err)
			}
		}
		parts = append(parts, jsonPart("arguments", arguments))
	}
	return parts, nil
}

func mayHaveBody(adapter x402http.HTTPAdapter) bool {
	switch strings.ToUpper(adapter.GetMethod()) {
	case http.MethodGet, http.MethodHead:
	default:
		return true
	}
	length := adapter.GetHeader("Content-Length")
	return (length != "" && length != "0") || adapter.GetHeader("Transfer-Encoding") != ""
}

// storeQuote records a served quote under its termsDigest unless one exists.
func (s *ExactCardanoScheme) storeQuote(ctx context.Context, requirements types.PaymentRequirements) error {
	digest, err := masumi.TermsDigest(requirements)
	if err != nil {
		return err
	}
	stored := cloneRequirements(requirements)
	_, err = s.storage.UpdateTerms(ctx, digest, func(current *masumi.StoredTerms) *masumi.StoredTerms {
		if current != nil {
			return current
		}
		return &masumi.StoredTerms{TermsDigest: digest, Requirements: stored}
	})
	return err
}

// AfterVerifyHook binds a verified Masumi payment to the quote it pays: the
// first transaction claims the termsDigest, and only that transaction may
// resume it.
func (s *ExactCardanoScheme) AfterVerifyHook() x402.AfterVerifyHook {
	return func(ctx x402.VerifyResultContext) (*x402.AfterVerifyResult, error) {
		if ctx.Result == nil || !ctx.Result.IsValid {
			return nil, nil
		}
		payload, ok := masumiPayloadOf(ctx.PayloadBytes)
		if !ok {
			return nil, nil
		}
		return s.bindMasumiTerms(ctx.Ctx, payload)
	}
}

func (s *ExactCardanoScheme) bindMasumiTerms(ctx context.Context, payload types.PaymentPayload) (*x402.AfterVerifyResult, error) {
	accepted := payload.Accepted
	abort := func(reason, message string) (*x402.AfterVerifyResult, error) {
		return &x402.AfterVerifyResult{Abort: true, Reason: reason, Message: message}, nil
	}
	digest, err := masumi.TermsDigest(accepted)
	if err != nil {
		return abort(cardano.ErrInvalidPayload, err.Error())
	}
	transaction, _ := payload.Payload["transaction"].(string)
	decoded, err := cardano.DecodeTransaction(transaction)
	if err != nil {
		return abort(cardano.ErrInvalidPayload, err.Error())
	}
	result, err := s.storage.UpdateTerms(ctx, digest, func(current *masumi.StoredTerms) *masumi.StoredTerms {
		if current == nil || current.ClaimedTxHash != "" || !x402.DeepEqual(accepted, current.Requirements) {
			return current
		}
		next := *current
		next.ClaimedTxHash = decoded.TxHash
		return &next
	})
	if err != nil {
		// Core ignores hook errors, so a storage failure must abort to fail closed.
		return abort(cardano.ErrMasumiTermsUnknown, "Masumi terms storage is unavailable: "+err.Error())
	}
	switch stored := result.Terms; {
	case stored == nil:
		return abort(cardano.ErrMasumiTermsUnknown, "Masumi payment quotes terms this server did not issue")
	case !x402.DeepEqual(accepted, stored.Requirements):
		return abort(cardano.ErrMasumiTermsMismatch, "Masumi payment altered the issued payment requirements")
	case stored.ClaimedTxHash != decoded.TxHash:
		return abort(cardano.ErrDuplicateSettlement, "Masumi terms are already bound to a different Cardano transaction")
	}
	return nil, nil
}

// termsDigestOf is the digest of a quote, or false when it is not a valid Masumi quote.
func termsDigestOf(requirements types.PaymentRequirements) (string, bool) {
	digest, err := masumi.TermsDigest(requirements)
	return digest, err == nil
}

// masumiPayloadOf decodes a verified payload, or false when it is not a Masumi payment.
func masumiPayloadOf(raw []byte) (types.PaymentPayload, bool) {
	var payload types.PaymentPayload
	if json.Unmarshal(raw, &payload) != nil {
		return payload, false
	}
	return payload, isMasumiExtra(payload.Accepted.Extra)
}

func cloneRequirements(r types.PaymentRequirements) types.PaymentRequirements {
	raw, _ := json.Marshal(r)
	var clone types.PaymentRequirements
	_ = json.Unmarshal(raw, &clone)
	return clone
}
