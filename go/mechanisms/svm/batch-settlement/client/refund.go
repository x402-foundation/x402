package client

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	x402 "github.com/x402-foundation/x402/go/v2"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/types"
)

// ErrNoBatchChannelToRefund means this scheme has no open batch-settlement channel
// for the route (for example EVM-only payments in a dual-network client).
var ErrNoBatchChannelToRefund = errors.New("no batch-settlement channel to refund")

// HTTPDoer performs one HTTP request. *http.Client implements it.
type HTTPDoer interface {
	Do(req *http.Request) (*http.Response, error)
}

// refundHTTPClient is the fetch used when a refund does not supply its own.
// Tests set it to nil to cover a missing transport.
var refundHTTPClient HTTPDoer = http.DefaultClient

// BatchRefundOptions configures a channel close.
type BatchRefundOptions struct {
	HTTPClient *http.Client
	// Requirements skips the unpaid probe when the caller already has them.
	Requirements *types.PaymentRequirements
}

// RefundPayloadOptions selects whether the close includes a payer-signed request_close.
type RefundPayloadOptions struct {
	WithTransaction bool
}

// RefundPayloadBuilder builds the payer-signed close payload.
type RefundPayloadBuilder func(
	ctx context.Context,
	x402Version int,
	requirements types.PaymentRequirements,
	options RefundPayloadOptions,
) (types.PaymentPayload, error)

type probedRequirements struct {
	accepts      []types.PaymentRequirements
	requirements types.PaymentRequirements
	x402Version  int
}

// AlignRefundRequirements matches probed requirements to the channel's voucher-signer mode.
func AlignRefundRequirements(
	probed types.PaymentRequirements,
	channelConfig batchsettlement.BatchChannelConfig,
) types.PaymentRequirements {
	mode := channelConfig.VoucherSigner
	if mode == "" {
		mode = batchsettlement.VoucherSignerClient
	}
	probedMode := batchsettlement.VoucherSignerClient
	if probed.Extra != nil {
		if signer, ok := probed.Extra[batchsettlement.ExtraVoucherSigner].(string); ok && signer != "" {
			probedMode = signer
		}
	}
	if probedMode == mode {
		return probed
	}
	extra := map[string]any{}
	for key, value := range probed.Extra {
		extra[key] = value
	}
	if mode == batchsettlement.VoucherSignerServer {
		extra[batchsettlement.ExtraOperator] = channelConfig.PayerAuthorizer
		extra[batchsettlement.ExtraVoucherSigner] = batchsettlement.VoucherSignerServer
		probed.Extra = extra
		return probed
	}
	delete(extra, batchsettlement.ExtraOperator)
	extra[batchsettlement.ExtraVoucherSigner] = batchsettlement.VoucherSignerClient
	probed.Extra = extra
	return probed
}

// ClientSignedRefundRequirements strips server-signed probe fields so refund
// discovery and "no channel" checks are not blocked by serverSignedChannelsPolicy
// when this wallet never opened a server-signed channel on the route.
func ClientSignedRefundRequirements(probed types.PaymentRequirements) types.PaymentRequirements {
	return AlignRefundRequirements(probed, batchsettlement.BatchChannelConfig{
		VoucherSigner: batchsettlement.VoucherSignerClient,
	})
}

// SelectRefundAccept picks the advertised accept that matches the channel being closed.
func SelectRefundAccept(
	accepts []types.PaymentRequirements,
	channelConfig batchsettlement.BatchChannelConfig,
	probed *types.PaymentRequirements,
) (types.PaymentRequirements, error) {
	mode := channelConfig.VoucherSigner
	if mode == "" {
		mode = batchsettlement.VoucherSignerClient
	}
	for _, accept := range batchSolanaAccepts(accepts) {
		signer := batchsettlement.VoucherSignerClient
		if accept.Extra != nil {
			if value, ok := accept.Extra[batchsettlement.ExtraVoucherSigner].(string); ok && value != "" {
				signer = value
			}
		}
		if signer != mode {
			continue
		}
		if mode == batchsettlement.VoucherSignerServer {
			operator, _ := accept.Extra[batchsettlement.ExtraOperator].(string)
			if operator != channelConfig.PayerAuthorizer {
				continue
			}
		} else if accept.Extra != nil {
			if _, present := accept.Extra[batchsettlement.ExtraOperator]; present {
				continue
			}
		}
		return accept, nil
	}
	if probed != nil {
		return AlignRefundRequirements(*probed, channelConfig), nil
	}
	return types.PaymentRequirements{}, fmt.Errorf("no %s-signed batch-settlement accept advertised for refund", mode)
}

func batchSolanaAccepts(accepts []types.PaymentRequirements) []types.PaymentRequirements {
	matched := make([]types.PaymentRequirements, 0, len(accepts))
	for _, accept := range accepts {
		if accept.Scheme == batchsettlement.Scheme && strings.HasPrefix(accept.Network, "solana:") {
			matched = append(matched, accept)
		}
	}
	return matched
}

// ProbeBatchRequirements reads the Solana batch-settlement accept advertised by url.
func ProbeBatchRequirements(ctx context.Context, url string, httpClient HTTPDoer) (probedRequirements, error) {
	probe, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return probedRequirements{}, err
	}
	response, err := httpClient.Do(probe)
	if err != nil {
		return probedRequirements{}, err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, response.Body)
	if response.StatusCode != http.StatusPaymentRequired {
		return probedRequirements{}, fmt.Errorf("refund probe expected 402 from %s, got %d", url, response.StatusCode)
	}
	header := response.Header.Get("PAYMENT-REQUIRED")
	if header == "" {
		return probedRequirements{}, fmt.Errorf("refund probe response has no PAYMENT-REQUIRED header")
	}
	paymentRequired, err := decodePaymentRequiredHeader(header)
	if err != nil {
		return probedRequirements{}, err
	}
	for _, accept := range paymentRequired.Accepts {
		if accept.Scheme == batchsettlement.Scheme && strings.HasPrefix(accept.Network, "solana:") {
			return probedRequirements{
				accepts:      paymentRequired.Accepts,
				requirements: accept,
				x402Version:  paymentRequired.X402Version,
			}, nil
		}
	}
	return probedRequirements{}, fmt.Errorf("%s does not offer %s", url, batchsettlement.Scheme)
}

// RefundBatchChannel closes the channel backing url and refunds its unused escrow.
func RefundBatchChannel(
	ctx context.Context,
	build RefundPayloadBuilder,
	url string,
	options *BatchRefundOptions,
) (*x402.SettleResponse, error) {
	httpClient, err := refundClient(options)
	if err != nil {
		return nil, err
	}
	var probed probedRequirements
	if options != nil && options.Requirements != nil {
		probed = probedRequirements{
			accepts:      []types.PaymentRequirements{*options.Requirements},
			requirements: *options.Requirements,
			x402Version:  2,
		}
	} else {
		probed, err = ProbeBatchRequirements(ctx, url, httpClient)
		if err != nil {
			return nil, err
		}
	}

	send := func(withTransaction bool) (reason string, settled *x402.SettleResponse, status int, err error) {
		payload, err := build(ctx, probed.x402Version, probed.requirements, RefundPayloadOptions{WithTransaction: withTransaction})
		if err != nil {
			return "", nil, 0, err
		}
		if !batchsettlement.IsBatchPayload(payload.Payload) {
			return "", nil, 0, fmt.Errorf("refund builder must return a batch-settlement refund payload")
		}
		parsed, err := batchsettlement.ParseBatchPayload(payload.Payload)
		if err != nil || parsed.Type != batchsettlement.PayloadTypeRefund {
			return "", nil, 0, fmt.Errorf("refund builder must return a batch-settlement refund payload")
		}
		accepted, err := SelectRefundAccept(probed.accepts, parsed.ChannelConfig, &probed.requirements)
		if err != nil {
			return "", nil, 0, err
		}
		header, err := encodePaymentSignatureHeader(payload, accepted)
		if err != nil {
			return "", nil, 0, err
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return "", nil, 0, err
		}
		request.Header.Set("PAYMENT-SIGNATURE", header)
		response, err := httpClient.Do(request)
		if err != nil {
			return "", nil, 0, err
		}
		defer response.Body.Close()
		_, _ = io.Copy(io.Discard, response.Body)
		var settledHeader *x402.SettleResponse
		if encoded := response.Header.Get("PAYMENT-RESPONSE"); encoded != "" {
			decoded, decErr := decodePaymentResponseHeader(encoded)
			if decErr != nil {
				return "", nil, response.StatusCode, decErr
			}
			settledHeader = decoded
		}
		reason = ""
		if settledHeader != nil {
			reason = settledHeader.ErrorReason
		} else if response.StatusCode == http.StatusPaymentRequired {
			if encoded := response.Header.Get("PAYMENT-REQUIRED"); encoded != "" {
				required, decErr := decodePaymentRequiredHeader(encoded)
				if decErr != nil {
					return "", nil, response.StatusCode, decErr
				}
				reason = required.Error
			}
		}
		return reason, settledHeader, response.StatusCode, nil
	}

	reason, settled, status, err := send(false)
	if err != nil {
		return nil, err
	}
	if reason == batchsettlement.ErrReceiverBindingUnavailable {
		reason, settled, status, err = send(true)
		if err != nil {
			return nil, err
		}
	}
	if settled != nil {
		return settled, nil
	}
	if status == http.StatusPaymentRequired {
		if reason == "" {
			reason = "no reason given"
		}
		return nil, fmt.Errorf("refund refused: %s", reason)
	}
	return nil, fmt.Errorf("refund response has no PAYMENT-RESPONSE header (status %d)", status)
}

func refundClient(options *BatchRefundOptions) (HTTPDoer, error) {
	if options != nil && options.HTTPClient != nil {
		return options.HTTPClient, nil
	}
	if refundHTTPClient == nil {
		return nil, fmt.Errorf("refund requires a fetch implementation (http.DefaultClient unavailable)")
	}
	return refundHTTPClient, nil
}

func encodePaymentSignatureHeader(payload types.PaymentPayload, accepted types.PaymentRequirements) (string, error) {
	envelope := map[string]any{
		"x402Version": payload.X402Version,
		"accepted":    accepted,
		"payload":     payload.Payload,
	}
	encoded, err := json.Marshal(envelope)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(encoded), nil
}

func decodePaymentRequiredHeader(header string) (x402.PaymentRequired, error) {
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(header))
	if err != nil {
		return x402.PaymentRequired{}, err
	}
	var required x402.PaymentRequired
	if err := json.Unmarshal(decoded, &required); err != nil {
		return x402.PaymentRequired{}, err
	}
	return required, nil
}

func decodePaymentResponseHeader(header string) (*x402.SettleResponse, error) {
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(header))
	if err != nil {
		return nil, err
	}
	var settled x402.SettleResponse
	if err := json.Unmarshal(decoded, &settled); err != nil {
		return nil, err
	}
	return &settled, nil
}
