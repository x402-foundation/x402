package batched

import (
	"fmt"
	"math/big"
)

// ChannelConfig is the immutable configuration for a payment channel.
// channelId = keccak256(abi.encode(channelConfig))
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

// BatchedVoucherFields holds common voucher fields (cumulative ceiling).
type BatchedVoucherFields struct {
	ChannelId          string `json:"channelId"`
	MaxClaimableAmount string `json:"maxClaimableAmount"`
	Signature          string `json:"signature"`
	Refund             bool   `json:"refund,omitempty"`
}

// BatchedDepositAuthorization wraps asset-transfer authorization data.
type BatchedDepositAuthorization struct {
	Erc3009Authorization *BatchedErc3009Authorization `json:"erc3009Authorization,omitempty"`
}

// BatchedDepositData is the deposit portion of a deposit payload.
type BatchedDepositData struct {
	ChannelConfig ChannelConfig               `json:"channelConfig"`
	Amount        string                      `json:"amount"`
	Authorization BatchedDepositAuthorization `json:"authorization"`
}

// BatchedDepositPayload is sent on the first request to fund a channel.
type BatchedDepositPayload struct {
	Type          string               `json:"type"` // "deposit"
	Deposit       BatchedDepositData   `json:"deposit"`
	Voucher       BatchedVoucherFields `json:"voucher"`
	ResponseExtra map[string]interface{} `json:"responseExtra,omitempty"`
}

// BatchedVoucherPayload is sent on subsequent requests (no new deposit).
type BatchedVoucherPayload struct {
	Type               string        `json:"type"` // "voucher"
	ChannelConfig      ChannelConfig `json:"channelConfig"`
	ChannelId          string        `json:"channelId"`
	MaxClaimableAmount string        `json:"maxClaimableAmount"`
	Signature          string        `json:"signature"`
	Refund             bool          `json:"refund,omitempty"`
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

// BatchedPaymentResponseExtra carries channel state in settle/verify responses.
type BatchedPaymentResponseExtra struct {
	ChannelId               string `json:"channelId"`
	ChargedCumulativeAmount string `json:"chargedCumulativeAmount"`
	Balance                 string `json:"balance"`
	TotalClaimed            string `json:"totalClaimed"`
	WithdrawRequestedAt     int    `json:"withdrawRequestedAt"`
	RefundNonce             string `json:"refundNonce"`
	Refund                  bool   `json:"refund,omitempty"`
}

// --- Settle Action Payloads (server -> facilitator) ---

// BatchedClaimPayload batches multiple voucher claims.
type BatchedClaimPayload struct {
	SettleAction string                `json:"settleAction"` // "claim"
	Claims       []BatchedVoucherClaim `json:"claims"`
}

// BatchedClaimWithSignaturePayload batches claims with receiverAuthorizer signature.
type BatchedClaimWithSignaturePayload struct {
	SettleAction        string                `json:"settleAction"` // "claimWithSignature"
	Claims              []BatchedVoucherClaim `json:"claims"`
	AuthorizerSignature string                `json:"authorizerSignature"`
}

// BatchedSettleActionPayload transfers claimed funds to receiver.
type BatchedSettleActionPayload struct {
	SettleAction string `json:"settleAction"` // "settle"
	Receiver     string `json:"receiver"`
	Token        string `json:"token"`
}

// BatchedDepositSettlePayload wraps a deposit for settlement.
type BatchedDepositSettlePayload struct {
	SettleAction string             `json:"settleAction"` // "deposit"
	Deposit      BatchedDepositData `json:"deposit"`
}

// BatchedRefundPayload is a msg.sender-gated cooperative refund.
type BatchedRefundPayload struct {
	SettleAction  string                        `json:"settleAction"` // "refund"
	Config        ChannelConfig                 `json:"config"`
	Amount        string                        `json:"amount"`
	Claims        []BatchedVoucherClaim         `json:"claims"`
	ResponseExtra *BatchedPaymentResponseExtra  `json:"responseExtra,omitempty"`
}

// BatchedRefundWithSignaturePayload is a signature-based cooperative refund.
type BatchedRefundWithSignaturePayload struct {
	SettleAction                string                       `json:"settleAction"` // "refundWithSignature"
	Config                      ChannelConfig                `json:"config"`
	Amount                      string                       `json:"amount"`
	Nonce                       string                       `json:"nonce"`
	Claims                      []BatchedVoucherClaim        `json:"claims"`
	ReceiverAuthorizerSignature string                       `json:"receiverAuthorizerSignature"`
	ClaimAuthorizerSignature    string                       `json:"claimAuthorizerSignature,omitempty"`
	ResponseExtra               *BatchedPaymentResponseExtra `json:"responseExtra,omitempty"`
}

// ============================================================================
// Type Guard Functions
// ============================================================================

// IsDepositPayload checks if a raw payload map is a batched deposit payload.
func IsDepositPayload(data map[string]interface{}) bool {
	typ, _ := data["type"].(string)
	_, hasDeposit := data["deposit"]
	_, hasVoucher := data["voucher"]
	return typ == "deposit" && hasDeposit && hasVoucher
}

// IsVoucherPayload checks if a raw payload map is a batched voucher-only payload.
func IsVoucherPayload(data map[string]interface{}) bool {
	typ, _ := data["type"].(string)
	_, hasConfig := data["channelConfig"]
	_, hasId := data["channelId"]
	_, hasAmount := data["maxClaimableAmount"]
	_, hasSig := data["signature"]
	return typ == "voucher" && hasConfig && hasId && hasAmount && hasSig
}

// IsClaimPayload checks if a raw payload map is a batch claim settle action.
func IsClaimPayload(data map[string]interface{}) bool {
	action, _ := data["settleAction"].(string)
	_, hasClaims := data["claims"]
	return action == "claim" && hasClaims
}

// IsClaimWithSignaturePayload checks if a raw payload map is a claim-with-signature settle action.
func IsClaimWithSignaturePayload(data map[string]interface{}) bool {
	action, _ := data["settleAction"].(string)
	_, hasClaims := data["claims"]
	_, hasSig := data["authorizerSignature"]
	return action == "claimWithSignature" && hasClaims && hasSig
}

// IsSettleActionPayload checks if a raw payload map is a settle action (transfer to receiver).
func IsSettleActionPayload(data map[string]interface{}) bool {
	action, _ := data["settleAction"].(string)
	_, hasReceiver := data["receiver"]
	_, hasToken := data["token"]
	return action == "settle" && hasReceiver && hasToken
}

// IsDepositSettlePayload checks if a raw payload map is a deposit-only settle payload.
func IsDepositSettlePayload(data map[string]interface{}) bool {
	action, _ := data["settleAction"].(string)
	_, hasDeposit := data["deposit"]
	return action == "deposit" && hasDeposit
}

// IsRefundPayload checks if a raw payload map is a msg.sender-gated refund.
func IsRefundPayload(data map[string]interface{}) bool {
	action, _ := data["settleAction"].(string)
	_, hasConfig := data["config"]
	_, hasSig := data["receiverAuthorizerSignature"]
	return action == "refund" && hasConfig && !hasSig
}

// IsRefundWithSignaturePayload checks if a raw payload map is a signature-based refund.
func IsRefundWithSignaturePayload(data map[string]interface{}) bool {
	action, _ := data["settleAction"].(string)
	_, hasConfig := data["config"]
	_, hasSig := data["receiverAuthorizerSignature"]
	return action == "refundWithSignature" && hasConfig && hasSig
}

// IsBatchedPayload checks if a raw payload map is any batched payload type.
func IsBatchedPayload(data map[string]interface{}) bool {
	return IsDepositPayload(data) || IsVoucherPayload(data)
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

// DepositPayloadFromMap creates a BatchedDepositPayload from a raw map.
func DepositPayloadFromMap(data map[string]interface{}) (*BatchedDepositPayload, error) {
	payload := &BatchedDepositPayload{Type: "deposit"}

	depositMap, ok := data["deposit"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("missing or invalid deposit field")
	}
	configMap, ok := depositMap["channelConfig"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("missing or invalid deposit.channelConfig")
	}
	config, err := ChannelConfigFromMap(configMap)
	if err != nil {
		return nil, fmt.Errorf("invalid deposit.channelConfig: %w", err)
	}
	payload.Deposit.ChannelConfig = config
	payload.Deposit.Amount, _ = depositMap["amount"].(string)

	if authMap, ok := depositMap["authorization"].(map[string]interface{}); ok {
		if erc3009Map, ok := authMap["erc3009Authorization"].(map[string]interface{}); ok {
			auth := &BatchedErc3009Authorization{}
			auth.ValidAfter, _ = erc3009Map["validAfter"].(string)
			auth.ValidBefore, _ = erc3009Map["validBefore"].(string)
			auth.Salt, _ = erc3009Map["salt"].(string)
			auth.Signature, _ = erc3009Map["signature"].(string)
			payload.Deposit.Authorization.Erc3009Authorization = auth
		}
	}

	if voucherMap, ok := data["voucher"].(map[string]interface{}); ok {
		payload.Voucher.ChannelId, _ = voucherMap["channelId"].(string)
		payload.Voucher.MaxClaimableAmount, _ = voucherMap["maxClaimableAmount"].(string)
		payload.Voucher.Signature, _ = voucherMap["signature"].(string)
		if refund, ok := voucherMap["refund"].(bool); ok {
			payload.Voucher.Refund = refund
		}
	}

	if extra, ok := data["responseExtra"].(map[string]interface{}); ok {
		payload.ResponseExtra = extra
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
	payload.ChannelId, _ = data["channelId"].(string)
	payload.MaxClaimableAmount, _ = data["maxClaimableAmount"].(string)
	payload.Signature, _ = data["signature"].(string)
	if refund, ok := data["refund"].(bool); ok {
		payload.Refund = refund
	}
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
	payload := &BatchedClaimPayload{SettleAction: "claim"}
	claimsList, ok := data["claims"].([]interface{})
	if !ok {
		return nil, fmt.Errorf("missing or invalid claims")
	}
	claims, err := VoucherClaimsFromList(claimsList)
	if err != nil {
		return nil, err
	}
	payload.Claims = claims
	return payload, nil
}

// ClaimWithSignaturePayloadFromMap creates a BatchedClaimWithSignaturePayload from a raw map.
func ClaimWithSignaturePayloadFromMap(data map[string]interface{}) (*BatchedClaimWithSignaturePayload, error) {
	payload := &BatchedClaimWithSignaturePayload{SettleAction: "claimWithSignature"}
	claimsList, ok := data["claims"].([]interface{})
	if !ok {
		return nil, fmt.Errorf("missing or invalid claims")
	}
	claims, err := VoucherClaimsFromList(claimsList)
	if err != nil {
		return nil, err
	}
	payload.Claims = claims
	payload.AuthorizerSignature, _ = data["authorizerSignature"].(string)
	return payload, nil
}

// SettleActionPayloadFromMap creates a BatchedSettleActionPayload from a raw map.
func SettleActionPayloadFromMap(data map[string]interface{}) (*BatchedSettleActionPayload, error) {
	payload := &BatchedSettleActionPayload{SettleAction: "settle"}
	payload.Receiver, _ = data["receiver"].(string)
	payload.Token, _ = data["token"].(string)
	return payload, nil
}

// DepositSettlePayloadFromMap creates a BatchedDepositSettlePayload from a raw map.
func DepositSettlePayloadFromMap(data map[string]interface{}) (*BatchedDepositSettlePayload, error) {
	payload := &BatchedDepositSettlePayload{SettleAction: "deposit"}
	depositMap, ok := data["deposit"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("missing or invalid deposit")
	}
	configMap, ok := depositMap["channelConfig"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("missing or invalid deposit.channelConfig")
	}
	config, err := ChannelConfigFromMap(configMap)
	if err != nil {
		return nil, err
	}
	payload.Deposit.ChannelConfig = config
	payload.Deposit.Amount, _ = depositMap["amount"].(string)

	if authMap, ok := depositMap["authorization"].(map[string]interface{}); ok {
		if erc3009Map, ok := authMap["erc3009Authorization"].(map[string]interface{}); ok {
			auth := &BatchedErc3009Authorization{}
			auth.ValidAfter, _ = erc3009Map["validAfter"].(string)
			auth.ValidBefore, _ = erc3009Map["validBefore"].(string)
			auth.Salt, _ = erc3009Map["salt"].(string)
			auth.Signature, _ = erc3009Map["signature"].(string)
			payload.Deposit.Authorization.Erc3009Authorization = auth
		}
	}

	return payload, nil
}

// RefundPayloadFromMap creates a BatchedRefundPayload from a raw map.
func RefundPayloadFromMap(data map[string]interface{}) (*BatchedRefundPayload, error) {
	payload := &BatchedRefundPayload{SettleAction: "refund"}
	configMap, ok := data["config"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("missing or invalid config")
	}
	config, err := ChannelConfigFromMap(configMap)
	if err != nil {
		return nil, err
	}
	payload.Config = config
	payload.Amount, _ = data["amount"].(string)
	if claimsList, ok := data["claims"].([]interface{}); ok {
		claims, err := VoucherClaimsFromList(claimsList)
		if err != nil {
			return nil, err
		}
		payload.Claims = claims
	}
	return payload, nil
}

// RefundWithSignaturePayloadFromMap creates a BatchedRefundWithSignaturePayload from a raw map.
func RefundWithSignaturePayloadFromMap(data map[string]interface{}) (*BatchedRefundWithSignaturePayload, error) {
	payload := &BatchedRefundWithSignaturePayload{SettleAction: "refundWithSignature"}
	configMap, ok := data["config"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("missing or invalid config")
	}
	config, err := ChannelConfigFromMap(configMap)
	if err != nil {
		return nil, err
	}
	payload.Config = config
	payload.Amount, _ = data["amount"].(string)
	payload.Nonce, _ = data["nonce"].(string)
	payload.ReceiverAuthorizerSignature, _ = data["receiverAuthorizerSignature"].(string)
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

// DepositPayloadToMap converts a BatchedDepositPayload to a map.
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

	result := map[string]interface{}{
		"type": "deposit",
		"deposit": map[string]interface{}{
			"channelConfig": ChannelConfigToMap(p.Deposit.ChannelConfig),
			"amount":        p.Deposit.Amount,
			"authorization": authMap,
		},
		"voucher": map[string]interface{}{
			"channelId":          p.Voucher.ChannelId,
			"maxClaimableAmount": p.Voucher.MaxClaimableAmount,
			"signature":          p.Voucher.Signature,
		},
	}
	if p.Voucher.Refund {
		result["voucher"].(map[string]interface{})["refund"] = true
	}
	if p.ResponseExtra != nil {
		result["responseExtra"] = p.ResponseExtra
	}
	return result
}

// VoucherPayloadToMap converts a BatchedVoucherPayload to a map.
func (p *BatchedVoucherPayload) ToMap() map[string]interface{} {
	result := map[string]interface{}{
		"type":               "voucher",
		"channelConfig":      ChannelConfigToMap(p.ChannelConfig),
		"channelId":          p.ChannelId,
		"maxClaimableAmount": p.MaxClaimableAmount,
		"signature":          p.Signature,
	}
	if p.Refund {
		result["refund"] = true
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

// PaymentResponseExtraToMap converts a BatchedPaymentResponseExtra to a map.
func (e *BatchedPaymentResponseExtra) ToMap() map[string]interface{} {
	result := map[string]interface{}{
		"channelId":               e.ChannelId,
		"chargedCumulativeAmount": e.ChargedCumulativeAmount,
		"balance":                 e.Balance,
		"totalClaimed":            e.TotalClaimed,
		"withdrawRequestedAt":     e.WithdrawRequestedAt,
		"refundNonce":             e.RefundNonce,
	}
	if e.Refund {
		result["refund"] = true
	}
	return result
}

// PaymentResponseExtraFromMap parses a BatchedPaymentResponseExtra from a map.
func PaymentResponseExtraFromMap(data map[string]interface{}) (*BatchedPaymentResponseExtra, error) {
	extra := &BatchedPaymentResponseExtra{}
	extra.ChannelId, _ = data["channelId"].(string)
	extra.ChargedCumulativeAmount, _ = data["chargedCumulativeAmount"].(string)
	extra.Balance, _ = data["balance"].(string)
	extra.TotalClaimed, _ = data["totalClaimed"].(string)
	switch v := data["withdrawRequestedAt"].(type) {
	case float64:
		extra.WithdrawRequestedAt = int(v)
	case int:
		extra.WithdrawRequestedAt = v
	}
	extra.RefundNonce, _ = data["refundNonce"].(string)
	if refund, ok := data["refund"].(bool); ok {
		extra.Refund = refund
	}
	return extra, nil
}
