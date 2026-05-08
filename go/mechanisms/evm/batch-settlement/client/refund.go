package client

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"regexp"
	"strings"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/types"
)

// nonRecoverableRefundErrors are refund-specific server errors that the client
// cannot recover from automatically. Seeing any of these means the user should
// adjust their request (or accept that the channel has nothing left to refund) —
// retrying will not help. Sourced from the canonical constants in
// `batched/errors.go` so a rename there flows through to the client classifier
// without a separate edit.
var nonRecoverableRefundErrors = map[string]struct{}{
	batchsettlement.ErrRefundNoBalance:            {},
	batchsettlement.ErrRefundAmountInvalid:        {},
	batchsettlement.ErrRefundAmountExceedsBalance: {},
}

// RefundOptions configures a cooperative refund call.
type RefundOptions struct {
	// Amount is the optional partial refund (token base units, decimal string).
	// Omit for a full refund (drains the channel's remaining balance).
	Amount string
	// HTTPClient is an optional HTTP client (defaults to http.DefaultClient).
	HTTPClient *http.Client
}

// RefundContext is the narrow view of the client scheme that the refund flow needs.
// Defining a structural contract here (rather than depending directly on
// *BatchSettlementEvmScheme) keeps refund.go decoupled and enables alternate implementations
// in tests.
type RefundContext interface {
	Storage() ClientChannelStorage
	Signer() evm.ClientEvmSigner
	VoucherSigner() evm.ClientEvmSigner
	BuildChannelConfig(requirements types.PaymentRequirements) (batchsettlement.ChannelConfig, error)
	RecoverSession(ctx context.Context, requirements types.PaymentRequirements) (*BatchSettlementClientContext, error)
	ProcessCorrectivePaymentRequired(ctx context.Context, errorReason string, accepts []types.PaymentRequirements) (bool, error)
}

// RefundChannel sends a cooperative refund request to the channel that backs `url`.
//
// Flow:
//  1. Probe the URL with `GET` (no payment) to obtain the route's payment requirements.
//  2. Build the ChannelConfig and resolve the local session (or recover it).
//  3. Sign a zero-charge voucher (maxClaimableAmount = chargedCumulativeAmount)
//     with refund=true and the optional refundAmount (partial refund).
//  4. Send the voucher via PAYMENT-SIGNATURE. On a corrective 402, run the
//     standard recovery path and retry once.
//  5. Return the parsed SettleResponse from the server.
func RefundChannel(ctx context.Context, scheme RefundContext, url string, options *RefundOptions) (*x402.SettleResponse, error) {
	httpClient := http.DefaultClient
	var refundAmount string
	if options != nil {
		if options.HTTPClient != nil {
			httpClient = options.HTTPClient
		}
		var err error
		refundAmount, err = normalizeRefundAmount(options.Amount)
		if err != nil {
			return nil, err
		}
	}

	requirements, err := probeRefundRequirements(ctx, url, httpClient)
	if err != nil {
		return nil, err
	}

	return executeRefund(ctx, scheme, url, requirements, refundAmount, httpClient)
}

// UpdateSessionAfterRefund reconciles local session state with the outcome of a
// cooperative refund. Deletes the session when the post-refund balance is zero
// (full refund), otherwise updates balance/chargedCumulativeAmount/totalClaimed
// from the server snapshot (partial refund — channel stays open).
func UpdateSessionAfterRefund(storage ClientChannelStorage, channelKey string, settleExtra map[string]interface{}) error {
	parsed, _ := batchsettlement.PaymentResponseExtraFromMap(settleExtra)

	balanceStr := ""
	chargedStr := ""
	totalClaimedStr := ""
	if parsed != nil && parsed.ChannelState != nil {
		balanceStr = parsed.ChannelState.Balance
		chargedStr = parsed.ChannelState.ChargedCumulativeAmount
		totalClaimedStr = parsed.ChannelState.TotalClaimed
	}

	var balanceAfter *big.Int
	if balanceStr != "" {
		if bal, ok := new(big.Int).SetString(balanceStr, 10); ok {
			balanceAfter = bal
		}
	}

	if balanceAfter == nil || balanceAfter.Sign() <= 0 {
		return storage.Delete(channelKey)
	}

	prev, _ := storage.Get(channelKey)
	next := &BatchSettlementClientContext{}
	if prev != nil {
		*next = *prev
	}
	next.Balance = balanceAfter.String()
	if chargedStr != "" {
		next.ChargedCumulativeAmount = chargedStr
	}
	if totalClaimedStr != "" {
		next.TotalClaimed = totalClaimedStr
	}
	return storage.Set(channelKey, next)
}

// probeRefundRequirements probes a URL with an unauthenticated GET to retrieve
// batch-settlement payment requirements via the 402 PAYMENT-REQUIRED header.
func probeRefundRequirements(ctx context.Context, url string, httpClient *http.Client) (types.PaymentRequirements, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return types.PaymentRequirements{}, fmt.Errorf("refund probe: build request: %w", err)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return types.PaymentRequirements{}, fmt.Errorf("refund probe: %w", err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)

	if resp.StatusCode != http.StatusPaymentRequired {
		return types.PaymentRequirements{}, fmt.Errorf("refund probe expected 402, got %d", resp.StatusCode)
	}

	header := resp.Header.Get("PAYMENT-REQUIRED")
	if header == "" {
		return types.PaymentRequirements{}, fmt.Errorf("refund probe response missing PAYMENT-REQUIRED header")
	}

	paymentRequired, err := decodePaymentRequiredHeader(header)
	if err != nil {
		return types.PaymentRequirements{}, fmt.Errorf("refund probe: decode PAYMENT-REQUIRED: %w", err)
	}

	for i := range paymentRequired.Accepts {
		if paymentRequired.Accepts[i].Scheme == batchsettlement.SchemeBatched {
			req := paymentRequired.Accepts[i]
			if req.Extra == nil {
				return types.PaymentRequirements{}, fmt.Errorf("refund requires a configured receiverAuthorizer on the receiver")
			}
			ra, _ := req.Extra["receiverAuthorizer"].(string)
			if ra == "" {
				return types.PaymentRequirements{}, fmt.Errorf("refund requires a configured receiverAuthorizer on the receiver")
			}
			return req, nil
		}
	}
	return types.PaymentRequirements{}, fmt.Errorf("no %s payment option at %s", batchsettlement.SchemeBatched, url)
}

// executeRefund builds and submits the refund voucher, retrying once after a corrective 402.
func executeRefund(
	ctx context.Context,
	scheme RefundContext,
	url string,
	requirements types.PaymentRequirements,
	refundAmount string,
	httpClient *http.Client,
) (*x402.SettleResponse, error) {
	const maxAttempts = 2

	for attempt := 1; attempt <= maxAttempts; attempt++ {
		voucherPayload, err := buildRefundVoucherPayload(ctx, scheme, requirements, refundAmount)
		if err != nil {
			return nil, err
		}

		signatureHeader, err := encodePaymentSignatureHeader(voucherPayload, requirements)
		if err != nil {
			return nil, fmt.Errorf("refund: encode PAYMENT-SIGNATURE: %w", err)
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return nil, fmt.Errorf("refund: build request: %w", err)
		}
		req.Header.Set("PAYMENT-SIGNATURE", signatureHeader)

		resp, err := httpClient.Do(req)
		if err != nil {
			return nil, fmt.Errorf("refund: %w", err)
		}

		if resp.StatusCode == http.StatusPaymentRequired {
			// A 402 may carry either a PAYMENT-RESPONSE (settle aborted with a structured
			// SettleResponse) or a PAYMENT-REQUIRED (verify aborted with corrective hints).
			// Settle-side aborts for refunds are non-recoverable, so fail fast instead of retrying.
			settleHeader := resp.Header.Get("PAYMENT-RESPONSE")
			func() {
				defer resp.Body.Close()
				_, _ = io.Copy(io.Discard, resp.Body)
			}()
			if settleHeader != "" {
				settle, decErr := decodePaymentResponseHeader(settleHeader)
				if decErr != nil {
					return nil, fmt.Errorf("refund: decode PAYMENT-RESPONSE: %w", decErr)
				}
				return nil, fmt.Errorf("%s", formatRefundFailure(settle))
			}

			requiredHeader := resp.Header.Get("PAYMENT-REQUIRED")
			if requiredHeader == "" {
				return nil, fmt.Errorf("refund 402 missing PAYMENT-REQUIRED header")
			}
			paymentRequired, err := decodePaymentRequiredHeader(requiredHeader)
			if err != nil {
				return nil, fmt.Errorf("refund: decode corrective PAYMENT-REQUIRED: %w", err)
			}
			if _, nonRecoverable := nonRecoverableRefundErrors[paymentRequired.Error]; nonRecoverable {
				return nil, fmt.Errorf("refund failed: %s", paymentRequired.Error)
			}
			if attempt >= maxAttempts {
				return nil, fmt.Errorf("refund failed: server returned 402 after %d attempt(s)", attempt)
			}
			recovered, recErr := scheme.ProcessCorrectivePaymentRequired(ctx, paymentRequired.Error, paymentRequired.Accepts)
			if recErr != nil || !recovered {
				reason := paymentRequired.Error
				if reason == "" {
					reason = "unknown"
				}
				return nil, fmt.Errorf("refund failed: %s", reason)
			}
			continue
		}

		settleHeader := resp.Header.Get("PAYMENT-RESPONSE")
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		if settleHeader == "" {
			return nil, fmt.Errorf("refund response missing PAYMENT-RESPONSE header (status %d)", resp.StatusCode)
		}

		settle, err := decodePaymentResponseHeader(settleHeader)
		if err != nil {
			return nil, fmt.Errorf("refund: decode PAYMENT-RESPONSE: %w", err)
		}

		// The caller knows it just initiated a refund, so reconcile directly via
		// UpdateSessionAfterRefund (deletes on full drain). The channelId is read
		// from the nested `channelState` shape.
		if settle != nil && settle.Extra != nil {
			if cs, ok := settle.Extra["channelState"].(map[string]interface{}); ok {
				if channelId, ok := cs["channelId"].(string); ok && channelId != "" {
					_ = UpdateSessionAfterRefund(scheme.Storage(), batchsettlement.NormalizeChannelId(channelId), settle.Extra)
				}
			}
		}
		return settle, nil
	}

	return nil, fmt.Errorf("refund failed: retry budget exhausted")
}

// buildRefundVoucherPayload builds the voucher payload (zero-charge maxClaimableAmount) for a refund.
func buildRefundVoucherPayload(
	ctx context.Context,
	scheme RefundContext,
	requirements types.PaymentRequirements,
	refundAmount string,
) (*types.PaymentPayload, error) {
	config, err := scheme.BuildChannelConfig(requirements)
	if err != nil {
		return nil, fmt.Errorf("refund: build channel config: %w", err)
	}
	channelId, err := batchsettlement.ComputeChannelId(config, requirements.Network)
	if err != nil {
		return nil, fmt.Errorf("refund: compute channel ID: %w", err)
	}
	channelId = batchsettlement.NormalizeChannelId(channelId)

	storage := scheme.Storage()
	session, _ := storage.Get(channelId)
	if session == nil {
		// Try recovery if the signer supports onchain reads.
		if _, ok := scheme.Signer().(evm.ClientEvmSignerWithReadContract); ok {
			session, err = scheme.RecoverSession(ctx, requirements)
			if err != nil {
				return nil, fmt.Errorf("refund: recover session: %w", err)
			}
		}
	}
	if session == nil {
		return nil, fmt.Errorf("refund requires an existing channel session; deposit first or call from a context with an EVM RPC")
	}

	charged := session.ChargedCumulativeAmount
	if charged == "" {
		charged = "0"
	}

	// Skip the network round-trip when our local view of the channel already shows
	// it is fully drained (balance <= chargedCumulativeAmount).
	if session.Balance != "" {
		balance, balOk := new(big.Int).SetString(session.Balance, 10)
		chargedBig, chargedOk := new(big.Int).SetString(charged, 10)
		if balOk && chargedOk && balance.Cmp(chargedBig) <= 0 {
			return nil, fmt.Errorf(
				"refund failed: channel has no remaining balance (balance=%s, chargedCumulativeAmount=%s)",
				session.Balance, charged,
			)
		}
	}

	voucherSigner := scheme.VoucherSigner()
	if voucherSigner == nil {
		voucherSigner = scheme.Signer()
	}

	voucher, err := SignVoucher(ctx, voucherSigner, channelId, charged, string(requirements.Network))
	if err != nil {
		return nil, fmt.Errorf("refund: sign voucher: %w", err)
	}

	refundPayload := &batchsettlement.BatchSettlementRefundPayload{
		Type:          "refund",
		ChannelConfig: config,
		Voucher:       *voucher,
		Amount:        refundAmount,
	}

	return &types.PaymentPayload{
		X402Version: 2,
		Payload:     refundPayload.ToMap(),
	}, nil
}

// formatRefundFailure builds a human-readable error message from a settle
// failure response carried in a refund 402 PAYMENT-RESPONSE header.
func formatRefundFailure(settle *x402.SettleResponse) string {
	if settle == nil {
		return "Refund failed: unknown_settlement_error"
	}
	reason := settle.ErrorReason
	if reason == "" {
		reason = "unknown_settlement_error"
	}
	if settle.ErrorMessage != "" && settle.ErrorMessage != reason {
		return fmt.Sprintf("Refund failed: %s: %s", reason, settle.ErrorMessage)
	}
	return fmt.Sprintf("Refund failed: %s", reason)
}

// normalizeRefundAmount validates the optional refundAmount argument.
func normalizeRefundAmount(amount string) (string, error) {
	if amount == "" {
		return "", nil
	}
	if !regexp.MustCompile(`^\d+$`).MatchString(amount) || amount == "0" {
		return "", fmt.Errorf("invalid refund amount %q: must be a positive integer string", amount)
	}
	return amount, nil
}

// encodePaymentSignatureHeader marshals a payment payload + accepted requirements
// into the base64 PAYMENT-SIGNATURE header value.
func encodePaymentSignatureHeader(payload *types.PaymentPayload, accepted types.PaymentRequirements) (string, error) {
	envelope := map[string]interface{}{
		"x402Version": payload.X402Version,
		"accepted":    accepted,
		"payload":     payload.Payload,
	}
	bytes, err := json.Marshal(envelope)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(bytes), nil
}

// decodePaymentRequiredHeader decodes a PAYMENT-REQUIRED header into a PaymentRequired struct.
func decodePaymentRequiredHeader(header string) (*x402.PaymentRequired, error) {
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(header))
	if err != nil {
		return nil, err
	}
	var pr x402.PaymentRequired
	if err := json.Unmarshal(decoded, &pr); err != nil {
		return nil, err
	}
	return &pr, nil
}

// decodePaymentResponseHeader decodes a PAYMENT-RESPONSE header into a SettleResponse.
func decodePaymentResponseHeader(header string) (*x402.SettleResponse, error) {
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(header))
	if err != nil {
		return nil, err
	}
	var settle x402.SettleResponse
	if err := json.Unmarshal(decoded, &settle); err != nil {
		return nil, err
	}
	return &settle, nil
}
