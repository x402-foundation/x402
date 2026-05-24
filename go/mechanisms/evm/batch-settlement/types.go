package batchsettlement

import (
	"context"
	"fmt"
	"math/big"
)

// AuthorizerSigner is the interface for a dedicated key that provides EIP-712
// signatures for claim / refund settle-action payloads.
type AuthorizerSigner interface {
	Address() string
	SignClaimBatch(ctx context.Context, claims []BatchSettlementVoucherClaim, network string) ([]byte, error)
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

// ChannelState represents onchain state read from the BatchSettlement contract.
type ChannelState struct {
	Balance             *big.Int
	TotalClaimed        *big.Int
	WithdrawRequestedAt int
	RefundNonce         *big.Int
}

// AssetTransferMethod identifies how a deposit moves tokens into the channel:
// either an ERC-3009 ReceiveWithAuthorization (default) or a Permit2
// channel-bound PermitWitnessTransferFrom. Servers opt into a non-default
// method by setting `accepts.extra.assetTransferMethod` on payment
// requirements; clients dispatch on the same field.
type AssetTransferMethod string

const (
	// AssetTransferMethodEip3009 is the default — uses USDC's
	// `transferWithAuthorization` (EIP-3009) via the ERC3009DepositCollector.
	AssetTransferMethodEip3009 AssetTransferMethod = "eip3009"

	// AssetTransferMethodPermit2 funds the deposit via a channel-bound
	// `PermitWitnessTransferFrom` against the universal Permit2 contract,
	// brokered by the Permit2DepositCollector.
	AssetTransferMethodPermit2 AssetTransferMethod = "permit2"
)

// BatchSettlementErc3009Authorization represents the ERC-3009 ReceiveWithAuthorization params.
type BatchSettlementErc3009Authorization struct {
	ValidAfter  string `json:"validAfter"`
	ValidBefore string `json:"validBefore"`
	Salt        string `json:"salt"`
	Signature   string `json:"signature"`
}

// BatchSettlementPermit2TokenPermissions is the {token, amount} pair signed inside a
// Permit2 `PermitWitnessTransferFrom` authorization.
type BatchSettlementPermit2TokenPermissions struct {
	Token  string `json:"token"`
	Amount string `json:"amount"`
}

// BatchSettlementPermit2Witness is the channel-bound witness binding a Permit2 transfer
// to a specific batch-settlement channel id.
type BatchSettlementPermit2Witness struct {
	ChannelId string `json:"channelId"`
}

// BatchSettlementPermit2Authorization is the Permit2 PermitWitnessTransferFrom
// authorization signed by the payer when the deposit uses the permit2 transfer
// method.
type BatchSettlementPermit2Authorization struct {
	From      string                                 `json:"from"`
	Permitted BatchSettlementPermit2TokenPermissions `json:"permitted"`
	Spender   string                                 `json:"spender"`
	Nonce     string                                 `json:"nonce"`
	Deadline  string                                 `json:"deadline"`
	Witness   BatchSettlementPermit2Witness          `json:"witness"`
	Signature string                                 `json:"signature"`
}

// BatchSettlementVoucherFields holds the cumulative-ceiling voucher.
type BatchSettlementVoucherFields struct {
	ChannelId          string `json:"channelId"`
	MaxClaimableAmount string `json:"maxClaimableAmount"`
	Signature          string `json:"signature"`
}

// BatchSettlementDepositAuthorization wraps asset-transfer authorization data.
// Exactly one of the fields is populated per deposit (`erc3009Authorization`
// XOR `permit2Authorization`).
type BatchSettlementDepositAuthorization struct {
	Erc3009Authorization *BatchSettlementErc3009Authorization `json:"erc3009Authorization,omitempty"`
	Permit2Authorization *BatchSettlementPermit2Authorization `json:"permit2Authorization,omitempty"`
}

// BatchSettlementDepositData is the deposit portion of a deposit payload.
type BatchSettlementDepositData struct {
	Amount        string                              `json:"amount"`
	Authorization BatchSettlementDepositAuthorization `json:"authorization"`
}

// BatchSettlementDepositPayload is sent on the first request to fund a channel.
type BatchSettlementDepositPayload struct {
	Type          string                       `json:"type"` // "deposit"
	ChannelConfig ChannelConfig                `json:"channelConfig"`
	Voucher       BatchSettlementVoucherFields `json:"voucher"`
	Deposit       BatchSettlementDepositData   `json:"deposit"`
}

// BatchSettlementVoucherPayload is sent on subsequent requests (no new deposit).
type BatchSettlementVoucherPayload struct {
	Type          string                       `json:"type"` // "voucher"
	ChannelConfig ChannelConfig                `json:"channelConfig"`
	Voucher       BatchSettlementVoucherFields `json:"voucher"`
}

// BatchSettlementRefundPayload is the client-side cooperative-refund request.
// `Amount` is optional — when absent, it defaults to the full remaining balance.
type BatchSettlementRefundPayload struct {
	Type          string                       `json:"type"` // "refund"
	ChannelConfig ChannelConfig                `json:"channelConfig"`
	Voucher       BatchSettlementVoucherFields `json:"voucher"`
	Amount        string                       `json:"amount,omitempty"`
}

// BatchSettlementVoucherClaim is used in claim operations onchain.
type BatchSettlementVoucherClaim struct {
	Voucher struct {
		Channel            ChannelConfig `json:"channel"`
		MaxClaimableAmount string        `json:"maxClaimableAmount"`
	} `json:"voucher"`
	Signature    string `json:"signature"`
	TotalClaimed string `json:"totalClaimed"`
}

// BatchSettlementChannelStateExtra is the public per-channel state snapshot embedded in
// settle/verify response extras.
type BatchSettlementChannelStateExtra struct {
	ChannelId               string `json:"channelId"`
	Balance                 string `json:"balance"`
	TotalClaimed            string `json:"totalClaimed"`
	WithdrawRequestedAt     int    `json:"withdrawRequestedAt"`
	RefundNonce             string `json:"refundNonce"`
	ChargedCumulativeAmount string `json:"chargedCumulativeAmount,omitempty"`
}

// BatchSettlementVoucherStateExtra is the public latest-voucher snapshot embedded in
// settle/verify response extras.
type BatchSettlementVoucherStateExtra struct {
	SignedMaxClaimable string `json:"signedMaxClaimable,omitempty"`
	Signature          string `json:"signature,omitempty"`
}

// BatchSettlementPaymentResponseExtra carries channel state in settle/verify responses.
type BatchSettlementPaymentResponseExtra struct {
	ChargedAmount string                            `json:"chargedAmount,omitempty"`
	ChannelState  *BatchSettlementChannelStateExtra `json:"channelState,omitempty"`
	VoucherState  *BatchSettlementVoucherStateExtra `json:"voucherState,omitempty"`
}

// BatchSettlementPaymentRequirementsExtra is the typed shape of the `extra`
// field on PaymentRequirements for the batch-settlement scheme. The
// corrective-402 recovery payload is split across two camelCase keys:
// `channelState` (channel snapshot) and `voucherState` (latest signed voucher
// proof).
type BatchSettlementPaymentRequirementsExtra struct {
	ReceiverAuthorizer  string                            `json:"receiverAuthorizer"`
	WithdrawDelay       int                               `json:"withdrawDelay"`
	Name                string                            `json:"name"`
	Version             string                            `json:"version"`
	AssetTransferMethod string                            `json:"assetTransferMethod,omitempty"` // "eip3009" or "permit2"
	ChannelState        *BatchSettlementChannelStateExtra `json:"channelState,omitempty"`
	VoucherState        *BatchSettlementVoucherStateExtra `json:"voucherState,omitempty"`
}

// FileChannelStorageOptions configures file-backed channel storage.
// Channels are stored under {Directory}/{client|server}/{channelId}.json.
type FileChannelStorageOptions struct {
	Directory string
}

// --- Settle Action Payloads (server -> facilitator) ---
// All settle-action payloads use the `type` discriminator, the same field as
// client-side payloads.

// BatchSettlementClaimPayload batches claims with receiverAuthorizer signature.
// ClaimAuthorizerSignature is optional — when absent, the facilitator auto-signs
// using its AuthorizerSigner.
type BatchSettlementClaimPayload struct {
	Type                     string                        `json:"type"` // "claim"
	Claims                   []BatchSettlementVoucherClaim `json:"claims"`
	ClaimAuthorizerSignature string                        `json:"claimAuthorizerSignature,omitempty"`
}

// BatchSettlementSettlePayload transfers claimed funds to receiver.
type BatchSettlementSettlePayload struct {
	Type     string `json:"type"` // "settle"
	Receiver string `json:"receiver"`
	Token    string `json:"token"`
}

// BatchSettlementEnrichedRefundPayload is a refund payload enriched by the server with
// the resolved amount, refundNonce, and any claims that need to be included
// atomically with the refund. RefundAuthorizerSignature and
// ClaimAuthorizerSignature are optional — when absent, the facilitator
// auto-signs via its AuthorizerSigner.
type BatchSettlementEnrichedRefundPayload struct {
	Type                      string                        `json:"type"` // "refund"
	ChannelConfig             ChannelConfig                 `json:"channelConfig"`
	Voucher                   BatchSettlementVoucherFields  `json:"voucher"`
	Amount                    string                        `json:"amount"`
	RefundNonce               string                        `json:"refundNonce"`
	Claims                    []BatchSettlementVoucherClaim `json:"claims"`
	RefundAuthorizerSignature string                        `json:"refundAuthorizerSignature,omitempty"`
	ClaimAuthorizerSignature  string                        `json:"claimAuthorizerSignature,omitempty"`
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

// voucherFieldsFromMap parses BatchSettlementVoucherFields from a raw map.
func voucherFieldsFromMap(data map[string]interface{}) BatchSettlementVoucherFields {
	v := BatchSettlementVoucherFields{}
	v.ChannelId, _ = data["channelId"].(string)
	v.MaxClaimableAmount, _ = data["maxClaimableAmount"].(string)
	v.Signature, _ = data["signature"].(string)
	return v
}

// erc3009AuthFromMap parses an ERC-3009 authorization from a raw map.
func erc3009AuthFromMap(data map[string]interface{}) *BatchSettlementErc3009Authorization {
	auth := &BatchSettlementErc3009Authorization{}
	auth.ValidAfter, _ = data["validAfter"].(string)
	auth.ValidBefore, _ = data["validBefore"].(string)
	auth.Salt, _ = data["salt"].(string)
	auth.Signature, _ = data["signature"].(string)
	return auth
}

// permit2AuthFromMap parses a Permit2 PermitWitnessTransferFrom authorization
// from a raw map. Returns nil if `permitted` or `witness` are missing.
func permit2AuthFromMap(data map[string]interface{}) *BatchSettlementPermit2Authorization {
	if data == nil {
		return nil
	}
	auth := &BatchSettlementPermit2Authorization{}
	auth.From, _ = data["from"].(string)
	auth.Spender, _ = data["spender"].(string)
	auth.Nonce, _ = data["nonce"].(string)
	auth.Deadline, _ = data["deadline"].(string)
	auth.Signature, _ = data["signature"].(string)
	if permitted, ok := data["permitted"].(map[string]interface{}); ok {
		auth.Permitted.Token, _ = permitted["token"].(string)
		auth.Permitted.Amount, _ = permitted["amount"].(string)
	} else {
		return nil
	}
	if witness, ok := data["witness"].(map[string]interface{}); ok {
		auth.Witness.ChannelId, _ = witness["channelId"].(string)
	} else {
		return nil
	}
	return auth
}

// DepositPayloadFromMap creates a BatchSettlementDepositPayload from a raw map.
func DepositPayloadFromMap(data map[string]interface{}) (*BatchSettlementDepositPayload, error) {
	payload := &BatchSettlementDepositPayload{Type: "deposit"}

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
		if permit2Map, ok := authMap["permit2Authorization"].(map[string]interface{}); ok {
			payload.Deposit.Authorization.Permit2Authorization = permit2AuthFromMap(permit2Map)
		}
	}

	return payload, nil
}

// VoucherPayloadFromMap creates a BatchSettlementVoucherPayload from a raw map.
func VoucherPayloadFromMap(data map[string]interface{}) (*BatchSettlementVoucherPayload, error) {
	payload := &BatchSettlementVoucherPayload{Type: "voucher"}

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

// RefundPayloadFromMap creates a BatchSettlementRefundPayload from a raw map.
func RefundPayloadFromMap(data map[string]interface{}) (*BatchSettlementRefundPayload, error) {
	payload := &BatchSettlementRefundPayload{Type: "refund"}

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

// VoucherClaimFromMap parses a single BatchSettlementVoucherClaim from a raw map.
func VoucherClaimFromMap(data map[string]interface{}) (*BatchSettlementVoucherClaim, error) {
	claim := &BatchSettlementVoucherClaim{}

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

// VoucherClaimsFromList parses a list of BatchSettlementVoucherClaim from a raw slice.
func VoucherClaimsFromList(data []interface{}) ([]BatchSettlementVoucherClaim, error) {
	claims := make([]BatchSettlementVoucherClaim, 0, len(data))
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

// ClaimPayloadFromMap creates a BatchSettlementClaimPayload from a raw map.
func ClaimPayloadFromMap(data map[string]interface{}) (*BatchSettlementClaimPayload, error) {
	payload := &BatchSettlementClaimPayload{Type: "claim"}
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

// SettlePayloadFromMap creates a BatchSettlementSettlePayload from a raw map.
func SettlePayloadFromMap(data map[string]interface{}) (*BatchSettlementSettlePayload, error) {
	payload := &BatchSettlementSettlePayload{Type: "settle"}
	payload.Receiver, _ = data["receiver"].(string)
	payload.Token, _ = data["token"].(string)
	return payload, nil
}

// EnrichedRefundPayloadFromMap creates a BatchSettlementEnrichedRefundPayload from a raw map.
func EnrichedRefundPayloadFromMap(data map[string]interface{}) (*BatchSettlementEnrichedRefundPayload, error) {
	payload := &BatchSettlementEnrichedRefundPayload{Type: "refund"}
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

func voucherFieldsToMap(v BatchSettlementVoucherFields) map[string]interface{} {
	return map[string]interface{}{
		"channelId":          v.ChannelId,
		"maxClaimableAmount": v.MaxClaimableAmount,
		"signature":          v.Signature,
	}
}

// ToMap converts a BatchSettlementDepositPayload to a map.
func (p *BatchSettlementDepositPayload) ToMap() map[string]interface{} {
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
	if p.Deposit.Authorization.Permit2Authorization != nil {
		a := p.Deposit.Authorization.Permit2Authorization
		authMap["permit2Authorization"] = map[string]interface{}{
			"from": a.From,
			"permitted": map[string]interface{}{
				"token":  a.Permitted.Token,
				"amount": a.Permitted.Amount,
			},
			"spender":  a.Spender,
			"nonce":    a.Nonce,
			"deadline": a.Deadline,
			"witness": map[string]interface{}{
				"channelId": a.Witness.ChannelId,
			},
			"signature": a.Signature,
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

// ToMap converts a BatchSettlementVoucherPayload to a map.
func (p *BatchSettlementVoucherPayload) ToMap() map[string]interface{} {
	return map[string]interface{}{
		"type":          "voucher",
		"channelConfig": ChannelConfigToMap(p.ChannelConfig),
		"voucher":       voucherFieldsToMap(p.Voucher),
	}
}

// ToMap converts a BatchSettlementRefundPayload to a map.
func (p *BatchSettlementRefundPayload) ToMap() map[string]interface{} {
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

// ToMap converts a BatchSettlementClaimPayload to a map.
func (p *BatchSettlementClaimPayload) ToMap() map[string]interface{} {
	result := map[string]interface{}{
		"type":   "claim",
		"claims": VoucherClaimsToList(p.Claims),
	}
	if p.ClaimAuthorizerSignature != "" {
		result["claimAuthorizerSignature"] = p.ClaimAuthorizerSignature
	}
	return result
}

// ToMap converts a BatchSettlementSettlePayload to a map.
func (p *BatchSettlementSettlePayload) ToMap() map[string]interface{} {
	return map[string]interface{}{
		"type":     "settle",
		"receiver": p.Receiver,
		"token":    p.Token,
	}
}

// ToMap converts a BatchSettlementEnrichedRefundPayload to a map.
func (p *BatchSettlementEnrichedRefundPayload) ToMap() map[string]interface{} {
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

// VoucherClaimToMap converts a BatchSettlementVoucherClaim to a map.
func VoucherClaimToMap(c BatchSettlementVoucherClaim) map[string]interface{} {
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
func VoucherClaimsToList(claims []BatchSettlementVoucherClaim) []interface{} {
	list := make([]interface{}, len(claims))
	for i, c := range claims {
		list[i] = VoucherClaimToMap(c)
	}
	return list
}

// ToMap converts a BatchSettlementPaymentResponseExtra to its canonical nested wire shape.
func (e *BatchSettlementPaymentResponseExtra) ToMap() map[string]interface{} {
	out := map[string]interface{}{}
	if e.ChargedAmount != "" {
		out["chargedAmount"] = e.ChargedAmount
	}
	if cs := e.ChannelState; cs != nil {
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

// PaymentResponseExtraFromMap parses the canonical nested
// `BatchSettlementPaymentResponseExtra` shape from a map.
func PaymentResponseExtraFromMap(data map[string]interface{}) (*BatchSettlementPaymentResponseExtra, error) {
	extra := &BatchSettlementPaymentResponseExtra{}
	if data == nil {
		return extra, nil
	}
	if v, ok := data["chargedAmount"].(string); ok {
		extra.ChargedAmount = v
	}
	if csRaw, ok := data["channelState"].(map[string]interface{}); ok && csRaw != nil {
		cs := &BatchSettlementChannelStateExtra{}
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
	}
	if vsRaw, ok := data["voucherState"].(map[string]interface{}); ok && vsRaw != nil {
		vs := &BatchSettlementVoucherStateExtra{}
		vs.SignedMaxClaimable, _ = vsRaw["signedMaxClaimable"].(string)
		vs.Signature, _ = vsRaw["signature"].(string)
		extra.VoucherState = vs
	}
	return extra, nil
}

// ChannelStateRequirementsFromMap parses a channelState entry on
// PaymentRequirements.extra. Returns nil when absent or missing channelId.
func ChannelStateRequirementsFromMap(data map[string]interface{}) *BatchSettlementChannelStateExtra {
	if data == nil {
		return nil
	}
	cs := &BatchSettlementChannelStateExtra{}
	cs.ChannelId, _ = data["channelId"].(string)
	cs.Balance, _ = data["balance"].(string)
	cs.TotalClaimed, _ = data["totalClaimed"].(string)
	cs.RefundNonce, _ = data["refundNonce"].(string)
	cs.ChargedCumulativeAmount, _ = data["chargedCumulativeAmount"].(string)
	switch v := data["withdrawRequestedAt"].(type) {
	case float64:
		cs.WithdrawRequestedAt = int(v)
	case int:
		cs.WithdrawRequestedAt = v
	case int64:
		cs.WithdrawRequestedAt = int(v)
	}
	if cs.ChannelId == "" {
		return nil
	}
	return cs
}

// VoucherStateRequirementsFromMap parses a voucherState entry on
// PaymentRequirements.extra. Returns nil when absent or empty.
func VoucherStateRequirementsFromMap(data map[string]interface{}) *BatchSettlementVoucherStateExtra {
	if data == nil {
		return nil
	}
	vs := &BatchSettlementVoucherStateExtra{}
	vs.SignedMaxClaimable, _ = data["signedMaxClaimable"].(string)
	vs.Signature, _ = data["signature"].(string)
	if vs.SignedMaxClaimable == "" && vs.Signature == "" {
		return nil
	}
	return vs
}

// ToMap converts a BatchSettlementChannelStateExtra to a map (used for emitting
// `extra.channelState` on corrective-402 PaymentRequirements).
func (cs *BatchSettlementChannelStateExtra) ToMap() map[string]interface{} {
	if cs == nil {
		return nil
	}
	result := map[string]interface{}{
		"channelId":           cs.ChannelId,
		"balance":             cs.Balance,
		"totalClaimed":        cs.TotalClaimed,
		"withdrawRequestedAt": cs.WithdrawRequestedAt,
		"refundNonce":         cs.RefundNonce,
	}
	if cs.ChargedCumulativeAmount != "" {
		result["chargedCumulativeAmount"] = cs.ChargedCumulativeAmount
	}
	return result
}

// ToMap converts a BatchSettlementVoucherStateExtra to a map (used for emitting
// `extra.voucherState` on corrective-402 PaymentRequirements).
func (vs *BatchSettlementVoucherStateExtra) ToMap() map[string]interface{} {
	if vs == nil {
		return nil
	}
	result := map[string]interface{}{}
	if vs.SignedMaxClaimable != "" {
		result["signedMaxClaimable"] = vs.SignedMaxClaimable
	}
	if vs.Signature != "" {
		result["signature"] = vs.Signature
	}
	if len(result) == 0 {
		return nil
	}
	return result
}
