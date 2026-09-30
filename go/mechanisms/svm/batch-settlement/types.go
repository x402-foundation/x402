package batchsettlement

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"

	solana "github.com/gagliardetto/solana-go"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
)

const maxSafeInteger int64 = 1<<53 - 1

var errOutOfRange = errors.New("account index out of range")

// BatchExtra is the wire shape of batch-settlement requirements extra.
type BatchExtra struct {
	PaymentFlow        string             `json:"paymentFlow,omitempty"`
	MinDeposit         string             `json:"minDeposit,omitempty"`
	FeePayer           string             `json:"feePayer"`
	ReceiverAuthorizer string             `json:"receiverAuthorizer"`
	WithdrawDelay      int                `json:"withdrawDelay"`
	TokenProgram       string             `json:"tokenProgram"`
	Memo               string             `json:"memo,omitempty"`
	RecentBlockhash    string             `json:"recentBlockhash,omitempty"`
	RecentSlot         uint64             `json:"recentSlot,omitempty"`
	ChannelState       *BatchChannelState `json:"channelState,omitempty"`
	VoucherState       *BatchVoucherState `json:"voucherState,omitempty"`
	VoucherSigner      string             `json:"voucherSigner,omitempty"`
	Operator           string             `json:"operator,omitempty"`
	MaxIdleSecs        *int               `json:"maxIdleSecs,omitempty"`
}

// BatchVoucherState is the signed cumulative a corrective 402 carries.
type BatchVoucherState struct {
	SignedMaxClaimable string `json:"signedMaxClaimable"`
	ExpiresAt          int64  `json:"expiresAt"`
	Signature          string `json:"signature"`
}

// BatchAuthorization is an expiring payer authorization for server-signed channels.
type BatchAuthorization struct {
	Type             string `json:"type"`
	ChannelID        string `json:"channelId"`
	Payer            string `json:"payer"`
	RequestID        string `json:"requestId"`
	AuthorizedAmount string `json:"authorizedAmount"`
	ExpiresAt        int64  `json:"expiresAt"`
	Signature        string `json:"signature"`
}

// BatchChannelConfig is the immutable channel configuration carried on the wire.
type BatchChannelConfig struct {
	Payer              string `json:"payer"`
	PayerAuthorizer    string `json:"payerAuthorizer"`
	Receiver           string `json:"receiver"`
	ReceiverAuthorizer string `json:"receiverAuthorizer"`
	Token              string `json:"token"`
	WithdrawDelay      int    `json:"withdrawDelay"`
	Salt               string `json:"salt"`
	OpenSlot           int64  `json:"openSlot"`
	VoucherSigner      string `json:"voucherSigner,omitempty"`
}

// BatchVoucher is a cumulative Ed25519 voucher for one channel.
type BatchVoucher struct {
	ChannelID          string `json:"channelId"`
	MaxClaimableAmount string `json:"maxClaimableAmount"`
	ExpiresAt          int64  `json:"expiresAt"`
	Signature          string `json:"signature"`
}

// CloseAuthorization lets the receiver authorizer approve one cooperative close.
type CloseAuthorization struct {
	ValidBefore int64  `json:"validBefore"`
	Signature   string `json:"signature"`
}

// BatchDeposit is the on-chain setup transaction attached to a deposit payload.
type BatchDeposit struct {
	Amount      string `json:"amount"`
	Transaction string `json:"transaction"`
}

// BatchDepositPayload funds a channel and presents the first proof.
type BatchDepositPayload struct {
	Type          string              `json:"type"`
	ChannelConfig BatchChannelConfig  `json:"channelConfig"`
	Voucher       *BatchVoucher       `json:"voucher,omitempty"`
	Authorization *BatchAuthorization `json:"authorization,omitempty"`
	Deposit       BatchDeposit        `json:"deposit"`
}

// BatchVoucherPayload is a client-signed cumulative voucher.
type BatchVoucherPayload struct {
	Type          string             `json:"type"`
	ChannelConfig BatchChannelConfig `json:"channelConfig"`
	Voucher       BatchVoucher       `json:"voucher"`
}

// BatchAuthorizationPayload is a server-mode payer authorization.
type BatchAuthorizationPayload struct {
	Type          string             `json:"type"`
	ChannelConfig BatchChannelConfig `json:"channelConfig"`
	Authorization BatchAuthorization `json:"authorization"`
}

// BatchProof is a client-signed voucher or a server-mode payer authorization.
type BatchProof struct {
	Signer        string
	Voucher       *BatchVoucher
	Authorization *BatchAuthorization
}

// BatchRefundPayload asks the server to close a channel at the accepted cumulative.
type BatchRefundPayload struct {
	Type               string              `json:"type"`
	ChannelConfig      BatchChannelConfig  `json:"channelConfig"`
	Voucher            *BatchVoucher       `json:"voucher,omitempty"`
	Authorization      *BatchAuthorization `json:"authorization,omitempty"`
	Transaction        string              `json:"transaction,omitempty"`
	CloseAuthorization *CloseAuthorization `json:"closeAuthorization,omitempty"`
}

// BatchVoucherClaim is one channel in a server-authored claim.
type BatchVoucherClaim struct {
	ChannelID     string             `json:"channelId"`
	ChannelConfig BatchChannelConfig `json:"channelConfig"`
	Voucher       BatchVoucher       `json:"voucher"`
}

// BatchClaimPayload redeems stored vouchers.
type BatchClaimPayload struct {
	Type   string              `json:"type"`
	Claims []BatchVoucherClaim `json:"claims"`
}

// BatchSettleChannel names one channel in a distribute payload.
type BatchSettleChannel struct {
	ChannelID     string             `json:"channelId"`
	ChannelConfig BatchChannelConfig `json:"channelConfig"`
}

// BatchSettlePayload pays settled value out to payTo.
type BatchSettlePayload struct {
	Type     string               `json:"type"`
	Channels []BatchSettleChannel `json:"channels"`
}

// BatchSealPayload is a cooperative close of a Closing channel.
type BatchSealPayload struct {
	Type               string              `json:"type"`
	ChannelID          string              `json:"channelId"`
	ChannelConfig      BatchChannelConfig  `json:"channelConfig"`
	Voucher            BatchVoucher        `json:"voucher"`
	CloseAuthorization *CloseAuthorization `json:"closeAuthorization,omitempty"`
}

// BatchChannelState is the channel snapshot returned to a client.
type BatchChannelState struct {
	ChannelID               string `json:"channelId"`
	Balance                 string `json:"balance"`
	TotalClaimed            string `json:"totalClaimed"`
	WithdrawRequestedAt     int64  `json:"withdrawRequestedAt"`
	ChargedCumulativeAmount string `json:"chargedCumulativeAmount,omitempty"`
}

// ProofOf returns the client voucher or server authorization a payload spends.
// ParsedBatchPayload values are accepted without re-running wire validation so
// missing proofs surface as voucher-signature errors.
func ProofOf(payload any) (BatchProof, error) {
	if parsed, ok := payload.(ParsedBatchPayload); ok {
		return proofOfParsed(parsed)
	}
	parsed, err := ParseBatchPayload(payload)
	if err != nil {
		return BatchProof{}, err
	}
	return proofOfParsed(parsed)
}

func proofOfParsed(parsed ParsedBatchPayload) (BatchProof, error) {
	switch parsed.Type {
	case PayloadTypeVoucher:
		if parsed.Voucher == nil {
			return BatchProof{}, errors.New(ErrVoucherSignature)
		}
		voucher := *parsed.Voucher
		return BatchProof{Signer: VoucherSignerClient, Voucher: &voucher}, nil
	case PayloadTypeAuthorization:
		if parsed.Authorization == nil {
			return BatchProof{}, errors.New(ErrVoucherSignature)
		}
		authorization := *parsed.Authorization
		return BatchProof{Signer: VoucherSignerServer, Authorization: &authorization}, nil
	case PayloadTypeDeposit:
		if parsed.Voucher != nil {
			voucher := *parsed.Voucher
			return BatchProof{Signer: VoucherSignerClient, Voucher: &voucher}, nil
		}
		if parsed.Authorization != nil {
			authorization := *parsed.Authorization
			return BatchProof{Signer: VoucherSignerServer, Authorization: &authorization}, nil
		}
		return BatchProof{}, errors.New(ErrVoucherSignature)
	default:
		return BatchProof{}, errors.New(ErrVoucherSignature)
	}
}

// ParsedBatchPayload is a client payload after wire validation.
type ParsedBatchPayload struct {
	Type               string
	ChannelConfig      BatchChannelConfig
	Voucher            *BatchVoucher
	Authorization      *BatchAuthorization
	Deposit            *BatchDeposit
	Transaction        string
	HasTransaction     bool
	CloseAuthorization *CloseAuthorization
}

// ParseBatchPayload parses a client deposit, voucher, authorization, or refund payload.
func ParseBatchPayload(value any) (ParsedBatchPayload, error) {
	record, ok := asRecord(value)
	if !ok {
		return ParsedBatchPayload{}, errors.New(ErrPayloadType)
	}
	config, ok := parseChannelConfig(record["channelConfig"])
	if !ok {
		return ParsedBatchPayload{}, errors.New(ErrPayloadType)
	}
	payloadType, _ := record["type"].(string)
	parsed := ParsedBatchPayload{Type: payloadType, ChannelConfig: config}
	if !IsBatchPayload(value) {
		return ParsedBatchPayload{}, errors.New(ErrPayloadType)
	}
	switch payloadType {
	case PayloadTypeDeposit:
		deposit, _ := parseDeposit(record["deposit"])
		parsed.Deposit = &deposit
		if voucher, ok := parseVoucher(record["voucher"]); ok && present(record, "voucher") {
			parsed.Voucher = &voucher
		}
		if authorization, ok := parseAuthorization(record["authorization"]); ok && present(record, "authorization") {
			parsed.Authorization = &authorization
		}
	case PayloadTypeVoucher:
		voucher, _ := parseVoucher(record["voucher"])
		parsed.Voucher = &voucher
	case PayloadTypeAuthorization:
		authorization, _ := parseAuthorization(record["authorization"])
		parsed.Authorization = &authorization
	case PayloadTypeRefund:
		if voucher, ok := parseVoucher(record["voucher"]); ok && present(record, "voucher") {
			parsed.Voucher = &voucher
		}
		if authorization, ok := parseAuthorization(record["authorization"]); ok && present(record, "authorization") {
			parsed.Authorization = &authorization
		}
		if tx, ok := record["transaction"].(string); ok {
			parsed.Transaction = tx
			parsed.HasTransaction = true
		}
		if closeAuth, ok := parseCloseAuthorization(record["closeAuthorization"]); ok && present(record, "closeAuthorization") {
			parsed.CloseAuthorization = &closeAuth
		}
	default:
		return ParsedBatchPayload{}, errors.New(ErrPayloadType)
	}
	return parsed, nil
}

// IsBatchVoucher reports whether value is a voucher object.
func IsBatchVoucher(value any) bool {
	_, ok := parseVoucher(value)
	return ok
}

// IsBatchChannelConfig reports whether value is a channel config object.
func IsBatchChannelConfig(value any) bool {
	_, ok := parseChannelConfig(value)
	return ok
}

// IsBatchPayload reports whether value is a client batch-settlement payload.
func IsBatchPayload(value any) bool {
	record, ok := asRecord(value)
	if !ok {
		return false
	}
	config, ok := parseChannelConfig(record["channelConfig"])
	if !ok {
		return false
	}
	switch record["type"] {
	case PayloadTypeDeposit:
		deposit, ok := asRecord(record["deposit"])
		if !ok {
			return false
		}
		if _, amountOK := deposit["amount"].(string); !amountOK {
			return false
		}
		if _, txOK := deposit["transaction"].(string); !txOK {
			return false
		}
		if config.VoucherSigner == VoucherSignerServer {
			return !present(record, "voucher") &&
				isBatchAuthorization(record["authorization"]) &&
				!present(record, "requestId") &&
				!present(record, "maxClaimableAmount")
		}
		return IsBatchVoucher(record["voucher"]) &&
			!present(record, "authorization") &&
			!present(record, "requestId") &&
			!present(record, "maxClaimableAmount")
	case PayloadTypeVoucher:
		return config.VoucherSigner != VoucherSignerServer && IsBatchVoucher(record["voucher"])
	case PayloadTypeAuthorization:
		return config.VoucherSigner == VoucherSignerServer &&
			isBatchAuthorization(record["authorization"]) &&
			!present(record, "requestId") &&
			!present(record, "maxClaimableAmount")
	case PayloadTypeRefund:
		txOK := !present(record, "transaction") || stringOrEmpty(record["transaction"])
		closeOK := !present(record, "closeAuthorization") || isCloseAuthorization(record["closeAuthorization"])
		if !txOK || !closeOK {
			return false
		}
		signer := config.VoucherSigner
		if signer == "" {
			signer = VoucherSignerClient
		}
		if signer == VoucherSignerServer {
			authOK := !present(record, "authorization") ||
				(isBatchAuthorization(record["authorization"]) && authorizationAmount(record["authorization"]) == "0")
			if IsBatchVoucher(record["voucher"]) {
				return authOK
			}
			return !present(record, "voucher") &&
				isBatchAuthorization(record["authorization"]) &&
				authorizationAmount(record["authorization"]) == "0"
		}
		return IsBatchVoucher(record["voucher"]) && !present(record, "authorization")
	default:
		return false
	}
}

// IsBatchFacilitatorPayload reports whether value is a client payload or a facilitator claim, settle, or seal.
func IsBatchFacilitatorPayload(value any) bool {
	if IsBatchPayload(value) {
		return true
	}
	record, ok := asRecord(value)
	if !ok {
		return false
	}
	switch record["type"] {
	case PayloadTypeClaim:
		claims, ok := asSlice(record["claims"])
		if !ok || len(claims) == 0 || len(claims) > 4 {
			return false
		}
		for _, claim := range claims {
			if !isBatchVoucherClaim(claim) {
				return false
			}
		}
		return true
	case PayloadTypeSeal:
		return stringField(record, "channelId") &&
			IsBatchChannelConfig(record["channelConfig"]) &&
			IsBatchVoucher(record["voucher"]) &&
			(!present(record, "closeAuthorization") || isCloseAuthorization(record["closeAuthorization"]))
	case PayloadTypeSettle:
		channels, ok := asSlice(record["channels"])
		if !ok || len(channels) == 0 {
			return false
		}
		for _, item := range channels {
			channel, ok := asRecord(item)
			if !ok || !stringField(channel, "channelId") || !IsBatchChannelConfig(channel["channelConfig"]) {
				return false
			}
		}
		return true
	default:
		return false
	}
}

func isBatchVoucherClaim(value any) bool {
	record, ok := asRecord(value)
	return ok && stringField(record, "channelId") && IsBatchChannelConfig(record["channelConfig"]) && IsBatchVoucher(record["voucher"])
}

func isBatchAuthorization(value any) bool {
	_, ok := parseAuthorization(value)
	return ok
}

func isCloseAuthorization(value any) bool {
	_, ok := parseCloseAuthorization(value)
	return ok
}

func parseVoucher(value any) (BatchVoucher, bool) {
	record, ok := asRecord(value)
	if !ok || !stringField(record, "channelId") || !stringField(record, "maxClaimableAmount") || !stringField(record, "signature") {
		return BatchVoucher{}, false
	}
	expiresAt, ok := asInt64(record["expiresAt"])
	if !ok {
		return BatchVoucher{}, false
	}
	return BatchVoucher{
		ChannelID:          record["channelId"].(string),
		MaxClaimableAmount: record["maxClaimableAmount"].(string),
		ExpiresAt:          expiresAt,
		Signature:          record["signature"].(string),
	}, true
}

func parseChannelConfig(value any) (BatchChannelConfig, bool) {
	record, ok := asRecord(value)
	if !ok {
		return BatchChannelConfig{}, false
	}
	for _, field := range []string{"payer", "payerAuthorizer", "receiver", "receiverAuthorizer", "token", "salt"} {
		if !stringField(record, field) {
			return BatchChannelConfig{}, false
		}
	}
	withdrawDelay, ok := asInt64(record["withdrawDelay"])
	if !ok {
		return BatchChannelConfig{}, false
	}
	openSlot, ok := asInt64(record["openSlot"])
	if !ok {
		return BatchChannelConfig{}, false
	}
	signer, signerPresent := record["voucherSigner"]
	voucherSigner := ""
	if signerPresent && signer != nil {
		text, ok := signer.(string)
		if !ok || (text != VoucherSignerClient && text != VoucherSignerServer) {
			return BatchChannelConfig{}, false
		}
		voucherSigner = text
	}
	return BatchChannelConfig{
		Payer:              record["payer"].(string),
		PayerAuthorizer:    record["payerAuthorizer"].(string),
		Receiver:           record["receiver"].(string),
		ReceiverAuthorizer: record["receiverAuthorizer"].(string),
		Token:              record["token"].(string),
		WithdrawDelay:      int(withdrawDelay),
		Salt:               record["salt"].(string),
		OpenSlot:           openSlot,
		VoucherSigner:      voucherSigner,
	}, true
}

func parseAuthorization(value any) (BatchAuthorization, bool) {
	record, ok := asRecord(value)
	if !ok || record["type"] != AuthorizationTypeProof {
		return BatchAuthorization{}, false
	}
	for _, field := range []string{"channelId", "payer", "requestId", "authorizedAmount", "signature"} {
		if !stringField(record, field) {
			return BatchAuthorization{}, false
		}
	}
	requestID := record["requestId"].(string)
	amount := record["authorizedAmount"].(string)
	if requestID == "" || !IsDigits(amount) {
		return BatchAuthorization{}, false
	}
	expiresAt, ok := asSafePositiveInt(record["expiresAt"])
	if !ok {
		return BatchAuthorization{}, false
	}
	return BatchAuthorization{
		Type:             AuthorizationTypeProof,
		ChannelID:        record["channelId"].(string),
		Payer:            record["payer"].(string),
		RequestID:        requestID,
		AuthorizedAmount: amount,
		ExpiresAt:        expiresAt,
		Signature:        record["signature"].(string),
	}, true
}

func parseCloseAuthorization(value any) (CloseAuthorization, bool) {
	record, ok := asRecord(value)
	if !ok || !stringField(record, "signature") {
		return CloseAuthorization{}, false
	}
	validBefore, ok := asSafePositiveInt(record["validBefore"])
	if !ok {
		return CloseAuthorization{}, false
	}
	return CloseAuthorization{ValidBefore: validBefore, Signature: record["signature"].(string)}, true
}

func parseDeposit(value any) (BatchDeposit, bool) {
	record, ok := asRecord(value)
	if !ok || !stringField(record, "amount") || !stringField(record, "transaction") {
		return BatchDeposit{}, false
	}
	return BatchDeposit{Amount: record["amount"].(string), Transaction: record["transaction"].(string)}, true
}

func asRecord(value any) (map[string]any, bool) {
	record, ok := value.(map[string]any)
	return record, ok
}

func asSlice(value any) ([]any, bool) {
	items, ok := value.([]any)
	return items, ok
}

func present(record map[string]any, field string) bool {
	value, ok := record[field]
	return ok && value != nil
}

func stringField(record map[string]any, field string) bool {
	_, ok := record[field].(string)
	return ok
}

func stringOrEmpty(value any) bool {
	_, ok := value.(string)
	return ok
}

func authorizationAmount(value any) string {
	record, ok := asRecord(value)
	if !ok {
		return ""
	}
	amount, _ := record["authorizedAmount"].(string)
	return amount
}

func asInt64(value any) (int64, bool) {
	switch typed := value.(type) {
	case int:
		return int64(typed), true
	case int32:
		return int64(typed), true
	case int64:
		return typed, true
	case uint32:
		return int64(typed), true
	case uint64:
		if typed > math.MaxInt64 {
			return 0, false
		}
		return int64(typed), true
	case float64:
		if typed != math.Trunc(typed) || typed > float64(math.MaxInt64) || typed < float64(math.MinInt64) {
			return 0, false
		}
		return int64(typed), true
	case json.Number:
		parsed, err := typed.Int64()
		return parsed, err == nil
	default:
		return 0, false
	}
}

func asSafePositiveInt(value any) (int64, bool) {
	parsed, ok := asInt64(value)
	if !ok || parsed <= 0 || parsed > maxSafeInteger {
		return 0, false
	}
	return parsed, true
}

func mustKey(address string) []byte {
	key, err := solana.PublicKeyFromBase58(address)
	if err != nil {
		return nil
	}
	return key.Bytes()
}

func mustSig(signature string) []byte {
	parsed, err := solana.SignatureFromBase58(signature)
	if err != nil {
		return nil
	}
	return parsed[:]
}

// PositiveAmount parses a non-zero decimal atomic amount.
func PositiveAmount(value, field string) (uint64, error) {
	amount, err := paymentchannels.ParseU64(value, field)
	if err != nil {
		return 0, err
	}
	if amount == 0 {
		return 0, fmt.Errorf("%s must resolve to a positive integer", field)
	}
	return amount, nil
}

// BigU64 returns value as a non-negative big.Int.
func BigU64(value uint64) *big.Int {
	return new(big.Int).SetUint64(value)
}
