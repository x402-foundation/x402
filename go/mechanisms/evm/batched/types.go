package batched

import (
	"context"
	"fmt"
	"math/big"
)

// AuthorizerSigner is the interface for a dedicated key that provides EIP-712
// signatures for claim / refund settle-action payloads.
type AuthorizerSigner interface {
	Address() string
	SignClaimBatch(ctx context.Context, claims []BatchedVoucherClaim, network string) ([]byte, error)
	SignRefund(ctx context.Context, channelId string, amount string, nonce string, network string) ([]byte, error)
}

// ChannelConfig is the immutable configuration for a payment channel.
// channelId = EIP-712 hashTypedData of ChannelConfig with the BatchSettlement domain.
type ChannelConfig struct {
	Payer              string `json:"payer"`
	PayerAuthorizer    string `json:"payerAuthorizer"`
	Receiver           string `json:"receiver"`
	ReceiverAuthorizer string `json:"receiverAuthorizer"`
	Token              string `json:"token"`
	WithdrawDelay      int    `json:"withdrawDelay"`
	Salt               string `json:"salt"`
}

// ChannelState represents on-chain state read from the BatchSettlement contract.
type ChannelState struct {
	Balance             *big.Int
	TotalClaimed        *big.Int
	WithdrawRequestedAt int
	RefundNonce         *big.Int
}

// BatchedErc3009Authorization represents the ERC-3009 ReceiveWithAuthorization params.
type BatchedErc3009Authorization struct {
	ValidAfter  string `json:"validAfter"`
	ValidBefore string `json:"validBefore"`
	Salt        string `json:"salt"`
	Signature   string `json:"signature"`
}

// BatchedVoucherFields holds the cumulative-ceiling voucher.
type BatchedVoucherFields struct {
	ChannelId          string `json:"channelId"`
	MaxClaimableAmount string `json:"maxClaimableAmount"`
	Signature          string `json:"signature"`
}

// BatchedDepositAuthorization wraps asset-transfer authorization data.
type BatchedDepositAuthorization struct {
	Erc3009Authorization *BatchedErc3009Authorization `json:"erc3009Authorization,omitempty"`
}

// BatchedDepositData is the deposit portion of a deposit payload.
type BatchedDepositData struct {
	Amount        string                      `json:"amount"`
	Authorization BatchedDepositAuthorization `json:"authorization"`
}

// BatchedDepositPayload is sent on the first request to fund a channel.
type BatchedDepositPayload struct {
	Type          string               `json:"type"` // "deposit"
	ChannelConfig ChannelConfig        `json:"channelConfig"`
	Voucher       BatchedVoucherFields `json:"voucher"`
	Deposit       BatchedDepositData   `json:"deposit"`
}

// BatchedVoucherPayload is sent on subsequent requests (no new deposit).
type BatchedVoucherPayload struct {
	Type          string               `json:"type"` // "voucher"
	ChannelConfig ChannelConfig        `json:"channelConfig"`
	Voucher       BatchedVoucherFields `json:"voucher"`
}

// BatchedRefundPayload is the client-side cooperative-refund request.
// `Amount` is optional — when absent, it defaults to the full remaining balance.
type BatchedRefundPayload struct {
	Type          string               `json:"type"` // "refund"
	ChannelConfig ChannelConfig        `json:"channelConfig"`
	Voucher       BatchedVoucherFields `json:"voucher"`
	Amount        string               `json:"amount,omitempty"`
}

// BatchedVoucherClaim is used in claim operations on-chain.
type BatchedVoucherClaim struct {
	Voucher struct {
		Channel            ChannelConfig `json:"channel"`
		MaxClaimableAmount string        `json:"maxClaimableAmount"`
	} `json:"voucher"`
	Signature    string `json:"signature"`
	TotalClaimed string `json:"totalClaimed"`
}

// BatchedChannelStateExtra is the public per-channel state snapshot embedded in
// settle/verify response extras. Mirrors TS `BatchSettlementChannelStateExtra`.
type BatchedChannelStateExtra struct {
	ChannelId               string `json:"channelId"`
	Balance                 string `json:"balance"`
	TotalClaimed            string `json:"totalClaimed"`
	WithdrawRequestedAt     int    `json:"withdrawRequestedAt"`
	RefundNonce             string `json:"refundNonce"`
	ChargedCumulativeAmount string `json:"chargedCumulativeAmount,omitempty"`
}

// BatchedVoucherStateExtra is the public latest-voucher snapshot embedded in
// settle/verify response extras. Mirrors TS `BatchSettlementVoucherStateExtra`.
type BatchedVoucherStateExtra struct {
	SignedMaxClaimable string `json:"signedMaxClaimable,omitempty"`
	Signature          string `json:"signature,omitempty"`
}

// BatchedPaymentResponseExtra carries channel state in settle/verify responses.
// Mirrors TS `BatchSettlementPaymentResponseExtra`. The nested shape is the
// canonical wire format; the legacy flat fields are still accepted on parse for
// backward compatibility.
type BatchedPaymentResponseExtra struct {
	ChargedAmount string                    `json:"chargedAmount,omitempty"`
	ChannelState  *BatchedChannelStateExtra `json:"channelState,omitempty"`
	VoucherState  *BatchedVoucherStateExtra `json:"voucherState,omitempty"`

	// Deprecated legacy flat fields. Retained as no-json-tag to avoid emitting
	// them on the wire; populated by parsers when only flat fields are present
	// so callers can transparently read either shape via the helper accessors.
	ChannelId               string `json:"-"`
	ChargedCumulativeAmount string `json:"-"`
	Balance                 string `json:"-"`
	TotalClaimed            string `json:"-"`
	WithdrawRequestedAt     int    `json:"-"`
	RefundNonce             string `json:"-"`
}

// BatchSettlementRequirementsChannelState is the corrective-402 recovery payload
// embedded in PaymentRequirements.extra.ChannelState. Mirrors TS BatchSettlementRequirementsChannelState.
type BatchSettlementRequirementsChannelState struct {
	ChannelId               string `json:"channelId"`
	ChargedCumulativeAmount string `json:"chargedCumulativeAmount,omitempty"`
	SignedMaxClaimable      string `json:"signedMaxClaimable,omitempty"`
	Signature               string `json:"signature,omitempty"`
}

// BatchSettlementPaymentRequirementsExtra is the typed shape of the `extra`
// field on PaymentRequirements for the batch-settlement scheme.
type BatchSettlementPaymentRequirementsExtra struct {
	ReceiverAuthorizer  string                                   `json:"receiverAuthorizer"`
	WithdrawDelay       int                                      `json:"withdrawDelay"`
	Name                string                                   `json:"name"`
	Version             string                                   `json:"version"`
	AssetTransferMethod string                                   `json:"assetTransferMethod,omitempty"` // "eip3009"
	ChannelState        *BatchSettlementRequirementsChannelState `json:"ChannelState,omitempty"`
}

// FileChannelStorageOptions configures file-backed channel storage.
// Channels are stored under {Directory}/{client|server}/{channelId}.json.
type FileChannelStorageOptions struct {
	Directory string
}

// --- Settle Action Payloads (server -> facilitator) ---
// All settle-action payloads use the `type` discriminator (same field as
// client-side payloads), matching TS BatchSettlementFacilitatorSettlePayload.

// BatchedClaimPayload batches claims with receiverAuthorizer signature.
// ClaimAuthorizerSignature is optional — when absent, the facilitator auto-signs
// using its AuthorizerSigner.
type BatchedClaimPayload struct {
	Type                     string                `json:"type"` // "claim"
	Claims                   []BatchedVoucherClaim `json:"claims"`
	ClaimAuthorizerSignature string                `json:"claimAuthorizerSignature,omitempty"`
}

// BatchedSettlePayload transfers claimed funds to receiver.
type BatchedSettlePayload struct {
	Type     string `json:"type"` // "settle"
	Receiver string `json:"receiver"`
	Token    string `json:"token"`
}

// BatchedEnrichedRefundPayload is a refund payload enriched by the server with
// the resolved amount, refundNonce, and any claims that need to be included
// atomically with the refund. RefundAuthorizerSignature and
// ClaimAuthorizerSignature are optional — when absent, the facilitator
// auto-signs via its AuthorizerSigner.
type BatchedEnrichedRefundPayload struct {
	Type                      string                `json:"type"` // "refund"
	ChannelConfig             ChannelConfig         `json:"channelConfig"`
	Voucher                   BatchedVoucherFields  `json:"voucher"`
	Amount                    string                `json:"amount"`
	RefundNonce               string                `json:"refundNonce"`
	Claims                    []BatchedVoucherClaim `json:"claims"`
	RefundAuthorizerSignature string                `json:"refundAuthorizerSignature,omitempty"`
	ClaimAuthorizerSignature  string                `json:"claimAuthorizerSignature,omitempty"`
}

// ============================================================================
// Type Guard Functions
// ============================================================================

// IsDepositPayload checks if a raw payload map is a batched deposit payload.
func IsDepositPayload(data map[string]interface{}) bool {
	typ, _ := data["type"].(string)
	_, hasConfig := data["channelConfig"]
	_, hasVoucher := data["voucher"]
	_, hasDeposit := data["deposit"]
	return typ == "deposit" && hasConfig && hasVoucher && hasDeposit
}

// IsVoucherPayload checks if a raw payload map is a batched voucher-only payload.
func IsVoucherPayload(data map[string]interface{}) bool {
	typ, _ := data["type"].(string)
	_, hasConfig := data["channelConfig"]
	_, hasVoucher := data["voucher"]
	return typ == "voucher" && hasConfig && hasVoucher
}

// IsRefundPayload checks if a raw payload map is a client-side refund payload.
func IsRefundPayload(data map[string]interface{}) bool {
	typ, _ := data["type"].(string)
	_, hasConfig := data["channelConfig"]
	_, hasVoucher := data["voucher"]
	return typ == "refund" && hasConfig && hasVoucher
}

// IsClaimPayload checks if a raw payload map is a claim settle-action payload.
// The claimAuthorizerSignature field is optional (facilitator auto-signs when absent).
func IsClaimPayload(data map[string]interface{}) bool {
	typ, _ := data["type"].(string)
	_, hasClaims := data["claims"]
	return typ == "claim" && hasClaims
}

// IsSettlePayload checks if a raw payload map is a settle action (transfer to receiver).
func IsSettlePayload(data map[string]interface{}) bool {
	typ, _ := data["type"].(string)
	_, hasReceiver := data["receiver"]
	_, hasToken := data["token"]
	return typ == "settle" && hasReceiver && hasToken
}

// IsEnrichedRefundPayload checks if a raw payload is an enriched refund settle-action.
// The amount + refundNonce + claims fields are added by the server's enrichment hook.
func IsEnrichedRefundPayload(data map[string]interface{}) bool {
	if !IsRefundPayload(data) {
		return false
	}
	_, hasAmount := data["amount"]
	_, hasRefundNonce := data["refundNonce"]
	_, hasClaims := data["claims"]
	return hasAmount && hasRefundNonce && hasClaims
}

// IsBatchedPayload checks if a raw payload map is any batched payload type.
func IsBatchedPayload(data map[string]interface{}) bool {
	return IsDepositPayload(data) || IsVoucherPayload(data) || IsRefundPayload(data)
}

// ============================================================================
// FromMap Converters
// ============================================================================

// ChannelConfigFromMap parses a ChannelConfig from a raw map.
func ChannelConfigFromMap(data map[string]interface{}) (ChannelConfig, error) {
	config := ChannelConfig{}
	var ok bool
	if config.Payer, ok = data["payer"].(string); !ok {
		return config, fmt.Errorf("missing or invalid channelConfig.payer")
	}
	if config.PayerAuthorizer, ok = data["payerAuthorizer"].(string); !ok {
		return config, fmt.Errorf("missing or invalid channelConfig.payerAuthorizer")
	}
	if config.Receiver, ok = data["receiver"].(string); !ok {
		return config, fmt.Errorf("missing or invalid channelConfig.receiver")
	}
	if config.ReceiverAuthorizer, ok = data["receiverAuthorizer"].(string); !ok {
		return config, fmt.Errorf("missing or invalid channelConfig.receiverAuthorizer")
	}
	if config.Token, ok = data["token"].(string); !ok {
		return config, fmt.Errorf("missing or invalid channelConfig.token")
	}
	if config.Salt, ok = data["salt"].(string); !ok {
		return config, fmt.Errorf("missing or invalid channelConfig.salt")
	}
	switch v := data["withdrawDelay"].(type) {
	case float64:
		config.WithdrawDelay = int(v)
	case int:
		config.WithdrawDelay = v
	case int64:
		config.WithdrawDelay = int(v)
	default:
		return config, fmt.Errorf("missing or invalid channelConfig.withdrawDelay")
	}
	return config, nil
}

// voucherFieldsFromMap parses BatchedVoucherFields from a raw map.
func voucherFieldsFromMap(data map[string]interface{}) BatchedVoucherFields {
	v := BatchedVoucherFields{}
	v.ChannelId, _ = data["channelId"].(string)
	v.MaxClaimableAmount, _ = data["maxClaimableAmount"].(string)
	v.Signature, _ = data["signature"].(string)
	return v
}

// erc3009AuthFromMap parses an ERC-3009 authorization from a raw map.
func erc3009AuthFromMap(data map[string]interface{}) *BatchedErc3009Authorization {
	auth := &BatchedErc3009Authorization{}
	auth.ValidAfter, _ = data["validAfter"].(string)
	auth.ValidBefore, _ = data["validBefore"].(string)
	auth.Salt, _ = data["salt"].(string)
	auth.Signature, _ = data["signature"].(string)
	return auth
}

// DepositPayloadFromMap creates a BatchedDepositPayload from a raw map.
func DepositPayloadFromMap(data map[string]interface{}) (*BatchedDepositPayload, error) {
	payload := &BatchedDepositPayload{Type: "deposit"}

	configMap, ok := data["channelConfig"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("missing or invalid channelConfig")
	}
	config, err := ChannelConfigFromMap(configMap)
	if err != nil {
		return nil, fmt.Errorf("invalid channelConfig: %w", err)
	}
	payload.ChannelConfig = config

	voucherMap, ok := data["voucher"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("missing or invalid voucher")
	}
	payload.Voucher = voucherFieldsFromMap(voucherMap)

	depositMap, ok := data["deposit"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("missing or invalid deposit field")
	}
	payload.Deposit.Amount, _ = depositMap["amount"].(string)

	if authMap, ok := depositMap["authorization"].(map[string]interface{}); ok {
		if erc3009Map, ok := authMap["erc3009Authorization"].(map[string]interface{}); ok {
			payload.Deposit.Authorization.Erc3009Authorization = erc3009AuthFromMap(erc3009Map)
		}
	}

	return payload, nil
}

// VoucherPayloadFromMap creates a BatchedVoucherPayload from a raw map.
func VoucherPayloadFromMap(data map[string]interface{}) (*BatchedVoucherPayload, error) {
	payload := &BatchedVoucherPayload{Type: "voucher"}

	configMap, ok := data["channelConfig"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("missing or invalid channelConfig")
	}
	config, err := ChannelConfigFromMap(configMap)
	if err != nil {
		return nil, fmt.Errorf("invalid channelConfig: %w", err)
	}
	payload.ChannelConfig = config

	voucherMap, ok := data["voucher"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("missing or invalid voucher")
	}
	payload.Voucher = voucherFieldsFromMap(voucherMap)
	return payload, nil
}

// RefundPayloadFromMap creates a BatchedRefundPayload from a raw map.
func RefundPayloadFromMap(data map[string]interface{}) (*BatchedRefundPayload, error) {
	payload := &BatchedRefundPayload{Type: "refund"}

	configMap, ok := data["channelConfig"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("missing or invalid channelConfig")
	}
	config, err := ChannelConfigFromMap(configMap)
	if err != nil {
		return nil, fmt.Errorf("invalid channelConfig: %w", err)
	}
	payload.ChannelConfig = config

	voucherMap, ok := data["voucher"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("missing or invalid voucher")
	}
	payload.Voucher = voucherFieldsFromMap(voucherMap)
	payload.Amount, _ = data["amount"].(string)
	return payload, nil
}

// VoucherClaimFromMap parses a single BatchedVoucherClaim from a raw map.
func VoucherClaimFromMap(data map[string]interface{}) (*BatchedVoucherClaim, error) {
	claim := &BatchedVoucherClaim{}

	voucherMap, ok := data["voucher"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("missing or invalid voucher field")
	}
	channelMap, ok := voucherMap["channel"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("missing or invalid voucher.channel")
	}
	config, err := ChannelConfigFromMap(channelMap)
	if err != nil {
		return nil, fmt.Errorf("invalid voucher.channel: %w", err)
	}
	claim.Voucher.Channel = config
	claim.Voucher.MaxClaimableAmount, _ = voucherMap["maxClaimableAmount"].(string)
	claim.Signature, _ = data["signature"].(string)
	claim.TotalClaimed, _ = data["totalClaimed"].(string)
	return claim, nil
}

// VoucherClaimsFromList parses a list of BatchedVoucherClaim from a raw slice.
func VoucherClaimsFromList(data []interface{}) ([]BatchedVoucherClaim, error) {
	claims := make([]BatchedVoucherClaim, 0, len(data))
	for i, item := range data {
		itemMap, ok := item.(map[string]interface{})
		if !ok {
			return nil, fmt.Errorf("claims[%d] is not a map", i)
		}
		claim, err := VoucherClaimFromMap(itemMap)
		if err != nil {
			return nil, fmt.Errorf("claims[%d]: %w", i, err)
		}
		claims = append(claims, *claim)
	}
	return claims, nil
}

// ClaimPayloadFromMap creates a BatchedClaimPayload from a raw map.
func ClaimPayloadFromMap(data map[string]interface{}) (*BatchedClaimPayload, error) {
	payload := &BatchedClaimPayload{Type: "claim"}
	claimsList, ok := data["claims"].([]interface{})
	if !ok {
		return nil, fmt.Errorf("missing or invalid claims")
	}
	claims, err := VoucherClaimsFromList(claimsList)
	if err != nil {
		return nil, err
	}
	payload.Claims = claims
	payload.ClaimAuthorizerSignature, _ = data["claimAuthorizerSignature"].(string)
	return payload, nil
}

// SettlePayloadFromMap creates a BatchedSettlePayload from a raw map.
func SettlePayloadFromMap(data map[string]interface{}) (*BatchedSettlePayload, error) {
	payload := &BatchedSettlePayload{Type: "settle"}
	payload.Receiver, _ = data["receiver"].(string)
	payload.Token, _ = data["token"].(string)
	return payload, nil
}

// EnrichedRefundPayloadFromMap creates a BatchedEnrichedRefundPayload from a raw map.
func EnrichedRefundPayloadFromMap(data map[string]interface{}) (*BatchedEnrichedRefundPayload, error) {
	payload := &BatchedEnrichedRefundPayload{Type: "refund"}
	configMap, ok := data["channelConfig"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("missing or invalid channelConfig")
	}
	config, err := ChannelConfigFromMap(configMap)
	if err != nil {
		return nil, err
	}
	payload.ChannelConfig = config

	voucherMap, ok := data["voucher"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("missing or invalid voucher")
	}
	payload.Voucher = voucherFieldsFromMap(voucherMap)

	payload.Amount, _ = data["amount"].(string)
	payload.RefundNonce, _ = data["refundNonce"].(string)
	payload.RefundAuthorizerSignature, _ = data["refundAuthorizerSignature"].(string)
	payload.ClaimAuthorizerSignature, _ = data["claimAuthorizerSignature"].(string)
	if claimsList, ok := data["claims"].([]interface{}); ok {
		claims, err := VoucherClaimsFromList(claimsList)
		if err != nil {
			return nil, err
		}
		payload.Claims = claims
	}
	return payload, nil
}

// ============================================================================
// ToMap Converters
// ============================================================================

// ChannelConfigToMap converts a ChannelConfig to a map.
func ChannelConfigToMap(c ChannelConfig) map[string]interface{} {
	return map[string]interface{}{
		"payer":              c.Payer,
		"payerAuthorizer":    c.PayerAuthorizer,
		"receiver":           c.Receiver,
		"receiverAuthorizer": c.ReceiverAuthorizer,
		"token":              c.Token,
		"withdrawDelay":      c.WithdrawDelay,
		"salt":               c.Salt,
	}
}

func voucherFieldsToMap(v BatchedVoucherFields) map[string]interface{} {
	return map[string]interface{}{
		"channelId":          v.ChannelId,
		"maxClaimableAmount": v.MaxClaimableAmount,
		"signature":          v.Signature,
	}
}

// ToMap converts a BatchedDepositPayload to a map.
func (p *BatchedDepositPayload) ToMap() map[string]interface{} {
	authMap := map[string]interface{}{}
	if p.Deposit.Authorization.Erc3009Authorization != nil {
		a := p.Deposit.Authorization.Erc3009Authorization
		authMap["erc3009Authorization"] = map[string]interface{}{
			"validAfter":  a.ValidAfter,
			"validBefore": a.ValidBefore,
			"salt":        a.Salt,
			"signature":   a.Signature,
		}
	}
	return map[string]interface{}{
		"type":          "deposit",
		"channelConfig": ChannelConfigToMap(p.ChannelConfig),
		"voucher":       voucherFieldsToMap(p.Voucher),
		"deposit": map[string]interface{}{
			"amount":        p.Deposit.Amount,
			"authorization": authMap,
		},
	}
}

// ToMap converts a BatchedVoucherPayload to a map.
func (p *BatchedVoucherPayload) ToMap() map[string]interface{} {
	return map[string]interface{}{
		"type":          "voucher",
		"channelConfig": ChannelConfigToMap(p.ChannelConfig),
		"voucher":       voucherFieldsToMap(p.Voucher),
	}
}

// ToMap converts a BatchedRefundPayload to a map.
func (p *BatchedRefundPayload) ToMap() map[string]interface{} {
	result := map[string]interface{}{
		"type":          "refund",
		"channelConfig": ChannelConfigToMap(p.ChannelConfig),
		"voucher":       voucherFieldsToMap(p.Voucher),
	}
	if p.Amount != "" {
		result["amount"] = p.Amount
	}
	return result
}

// ToMap converts a BatchedClaimPayload to a map.
func (p *BatchedClaimPayload) ToMap() map[string]interface{} {
	result := map[string]interface{}{
		"type":   "claim",
		"claims": VoucherClaimsToList(p.Claims),
	}
	if p.ClaimAuthorizerSignature != "" {
		result["claimAuthorizerSignature"] = p.ClaimAuthorizerSignature
	}
	return result
}

// ToMap converts a BatchedSettlePayload to a map.
func (p *BatchedSettlePayload) ToMap() map[string]interface{} {
	return map[string]interface{}{
		"type":     "settle",
		"receiver": p.Receiver,
		"token":    p.Token,
	}
}

// ToMap converts a BatchedEnrichedRefundPayload to a map.
func (p *BatchedEnrichedRefundPayload) ToMap() map[string]interface{} {
	result := map[string]interface{}{
		"type":          "refund",
		"channelConfig": ChannelConfigToMap(p.ChannelConfig),
		"voucher":       voucherFieldsToMap(p.Voucher),
		"amount":        p.Amount,
		"refundNonce":   p.RefundNonce,
		"claims":        VoucherClaimsToList(p.Claims),
	}
	if p.RefundAuthorizerSignature != "" {
		result["refundAuthorizerSignature"] = p.RefundAuthorizerSignature
	}
	if p.ClaimAuthorizerSignature != "" {
		result["claimAuthorizerSignature"] = p.ClaimAuthorizerSignature
	}
	return result
}

// VoucherClaimToMap converts a BatchedVoucherClaim to a map.
func VoucherClaimToMap(c BatchedVoucherClaim) map[string]interface{} {
	return map[string]interface{}{
		"voucher": map[string]interface{}{
			"channel":            ChannelConfigToMap(c.Voucher.Channel),
			"maxClaimableAmount": c.Voucher.MaxClaimableAmount,
		},
		"signature":    c.Signature,
		"totalClaimed": c.TotalClaimed,
	}
}

// VoucherClaimsToList converts a slice of claims to a raw list.
func VoucherClaimsToList(claims []BatchedVoucherClaim) []interface{} {
	list := make([]interface{}, len(claims))
	for i, c := range claims {
		list[i] = VoucherClaimToMap(c)
	}
	return list
}

// ToMap converts a BatchedPaymentResponseExtra to its canonical nested wire shape.
// Legacy flat fields are populated into the nested ChannelState if no nested
// state is present, ensuring round-tripping of constructions that only set the
// flat fields.
func (e *BatchedPaymentResponseExtra) ToMap() map[string]interface{} {
	out := map[string]interface{}{}
	if e.ChargedAmount != "" {
		out["chargedAmount"] = e.ChargedAmount
	}
	cs := e.ChannelState
	if cs == nil && (e.ChannelId != "" || e.Balance != "" || e.TotalClaimed != "" ||
		e.RefundNonce != "" || e.WithdrawRequestedAt != 0 || e.ChargedCumulativeAmount != "") {
		cs = &BatchedChannelStateExtra{
			ChannelId:               e.ChannelId,
			Balance:                 e.Balance,
			TotalClaimed:            e.TotalClaimed,
			WithdrawRequestedAt:     e.WithdrawRequestedAt,
			RefundNonce:             e.RefundNonce,
			ChargedCumulativeAmount: e.ChargedCumulativeAmount,
		}
	}
	if cs != nil {
		csMap := map[string]interface{}{
			"channelId":           cs.ChannelId,
			"balance":             cs.Balance,
			"totalClaimed":        cs.TotalClaimed,
			"withdrawRequestedAt": cs.WithdrawRequestedAt,
			"refundNonce":         cs.RefundNonce,
		}
		if cs.ChargedCumulativeAmount != "" {
			csMap["chargedCumulativeAmount"] = cs.ChargedCumulativeAmount
		}
		out["channelState"] = csMap
	}
	if vs := e.VoucherState; vs != nil {
		vsMap := map[string]interface{}{}
		if vs.SignedMaxClaimable != "" {
			vsMap["signedMaxClaimable"] = vs.SignedMaxClaimable
		}
		if vs.Signature != "" {
			vsMap["signature"] = vs.Signature
		}
		if len(vsMap) > 0 {
			out["voucherState"] = vsMap
		}
	}
	return out
}

// PaymentResponseExtraFromMap parses a BatchedPaymentResponseExtra from a map.
// Reads the canonical nested shape and falls back to legacy flat keys.
func PaymentResponseExtraFromMap(data map[string]interface{}) (*BatchedPaymentResponseExtra, error) {
	extra := &BatchedPaymentResponseExtra{}
	if data == nil {
		return extra, nil
	}
	if v, ok := data["chargedAmount"].(string); ok {
		extra.ChargedAmount = v
	}

	if csRaw, ok := data["channelState"].(map[string]interface{}); ok && csRaw != nil {
		cs := &BatchedChannelStateExtra{}
		cs.ChannelId, _ = csRaw["channelId"].(string)
		cs.Balance, _ = csRaw["balance"].(string)
		cs.TotalClaimed, _ = csRaw["totalClaimed"].(string)
		cs.RefundNonce, _ = csRaw["refundNonce"].(string)
		cs.ChargedCumulativeAmount, _ = csRaw["chargedCumulativeAmount"].(string)
		switch v := csRaw["withdrawRequestedAt"].(type) {
		case float64:
			cs.WithdrawRequestedAt = int(v)
		case int:
			cs.WithdrawRequestedAt = v
		}
		extra.ChannelState = cs
		// Mirror into flat fields for legacy callers.
		extra.ChannelId = cs.ChannelId
		extra.Balance = cs.Balance
		extra.TotalClaimed = cs.TotalClaimed
		extra.WithdrawRequestedAt = cs.WithdrawRequestedAt
		extra.RefundNonce = cs.RefundNonce
		extra.ChargedCumulativeAmount = cs.ChargedCumulativeAmount
	} else {
		// Legacy flat shape.
		extra.ChannelId, _ = data["channelId"].(string)
		extra.ChargedCumulativeAmount, _ = data["chargedCumulativeAmount"].(string)
		extra.Balance, _ = data["balance"].(string)
		extra.TotalClaimed, _ = data["totalClaimed"].(string)
		extra.RefundNonce, _ = data["refundNonce"].(string)
		switch v := data["withdrawRequestedAt"].(type) {
		case float64:
			extra.WithdrawRequestedAt = int(v)
		case int:
			extra.WithdrawRequestedAt = v
		}
	}

	if vsRaw, ok := data["voucherState"].(map[string]interface{}); ok && vsRaw != nil {
		vs := &BatchedVoucherStateExtra{}
		vs.SignedMaxClaimable, _ = vsRaw["signedMaxClaimable"].(string)
		vs.Signature, _ = vsRaw["signature"].(string)
		extra.VoucherState = vs
	}
	return extra, nil
}

// ChannelStateRequirementsFromMap parses a BatchSettlementRequirementsChannelState
// from PaymentRequirements.extra["ChannelState"]. Returns nil when absent.
func ChannelStateRequirementsFromMap(data map[string]interface{}) *BatchSettlementRequirementsChannelState {
	if data == nil {
		return nil
	}
	cs := &BatchSettlementRequirementsChannelState{}
	cs.ChannelId, _ = data["channelId"].(string)
	cs.ChargedCumulativeAmount, _ = data["chargedCumulativeAmount"].(string)
	cs.SignedMaxClaimable, _ = data["signedMaxClaimable"].(string)
	cs.Signature, _ = data["signature"].(string)
	if cs.ChannelId == "" {
		return nil
	}
	return cs
}

// ToMap converts a BatchSettlementRequirementsChannelState to a map.
func (cs *BatchSettlementRequirementsChannelState) ToMap() map[string]interface{} {
	if cs == nil {
		return nil
	}
	result := map[string]interface{}{
		"channelId": cs.ChannelId,
	}
	if cs.ChargedCumulativeAmount != "" {
		result["chargedCumulativeAmount"] = cs.ChargedCumulativeAmount
	}
	if cs.SignedMaxClaimable != "" {
		result["signedMaxClaimable"] = cs.SignedMaxClaimable
	}
	if cs.Signature != "" {
		result["signature"] = cs.Signature
	}
	return result
}
