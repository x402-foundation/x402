package batchsettlement

import (
	"math/big"
	"reflect"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	goethtypes "github.com/ethereum/go-ethereum/core/types"
)

// ClaimAttestationRow is one claim row joined to its onchain Claimed event.
// A row without the event was a no-op: Claimed is false and the other fields are empty.
type ClaimAttestationRow struct {
	ChannelId       string
	Claimed         bool
	ClaimAmount     string
	NewTotalClaimed string
	// ChargeCount is the attested charge-count delta. It is empty when the row was not
	// claimed or when `m` carries no valid counts for this calldata.
	ChargeCount string
}

// ClaimAttestation is the decoded attestation for a settlement transaction.
// Channels is nil when the transaction carries no claim row. FunctionName is
// "unknown" when the outer calldata cannot be decoded.
type ClaimAttestation struct {
	FunctionName string
	// ChargeCounts are the deltas from m.x402ChargeCounts in claim-row order, set only when
	// their length equals the number of claim rows.
	ChargeCounts []uint64
	Channels     []ClaimAttestationRow
}

// ReceiptLog is the subset of an Ethereum receipt log needed to join Claimed events.
// Address is the emitter; only logs emitted by x402BatchSettlement count.
type ReceiptLog struct {
	Address common.Address
	Topics  []common.Hash
	Data    []byte
}

// claimedLog is one Claimed event. ChannelID and Sender are lowercase.
type claimedLog struct {
	ChannelID       string
	Sender          string
	ClaimAmount     *big.Int
	NewTotalClaimed *big.Int
}

// claimRow is one decoded claim row: its channel config and the totalClaimed it sets.
type claimRow struct {
	Config       ChannelConfig
	TotalClaimed *big.Int
}

// ClaimRowKey is the key an applied claim row shares with its Claimed event: the row's
// totalClaimed is the event's newTotalClaimed. totalClaimed is a decimal uint256 string.
func ClaimRowKey(channelId, totalClaimed string) string {
	if n, ok := new(big.Int).SetString(totalClaimed, 10); ok {
		totalClaimed = n.String()
	}
	return strings.ToLower(channelId) + ":" + totalClaimed
}

var (
	claimedEvent     abi.Event
	batchCallMethods map[string]abi.Method
)

func init() {
	parsed, err := abi.JSON(strings.NewReader(string(BatchSettlementClaimedEventABI)))
	if err != nil {
		panic("Claimed event ABI: " + err.Error())
	}
	claimedEvent = parsed.Events["Claimed"]

	batchCallMethods = make(map[string]abi.Method)
	registerMethods(BatchSettlementClaimABI)
	registerMethods(BatchSettlementClaimWithSignatureABI)
	registerMethods(BatchSettlementMulticallABI)
	registerMethods(BatchSettlementRefundABI)
	registerMethods(BatchSettlementRefundWithSignatureABI)
	registerMethods(BatchSettlementSettleABI)
	registerMethods(BatchSettlementDepositABI)
}

func registerMethods(abiJSON []byte) {
	parsed, err := abi.JSON(strings.NewReader(string(abiJSON)))
	if err != nil {
		panic("batch-settlement ABI: " + err.Error())
	}
	for _, method := range parsed.Methods {
		batchCallMethods[string(method.ID)] = method
	}
}

type decodedBatchCall struct {
	Name   string
	Method abi.Method
	Args   []interface{}
}

func decodeBatchCall(calldata []byte) (decodedBatchCall, bool) {
	if len(calldata) < 4 {
		return decodedBatchCall{}, false
	}
	method, ok := batchCallMethods[string(calldata[:4])]
	if !ok {
		return decodedBatchCall{}, false
	}
	args, err := method.Inputs.Unpack(calldata[4:])
	if err != nil {
		return decodedBatchCall{}, false
	}
	return decodedBatchCall{Name: method.Name, Method: method, Args: args}, true
}

// collectClaimRows collects the claim rows of a transaction in call order. It handles a direct claim / claimWithSignature call and a (possibly nested)
// multicall(bytes[]); non-claim legs such as refund contribute no rows. The second result is
// false when any leg cannot be ABI-decoded.
func collectClaimRows(calldata []byte) ([]claimRow, bool) {
	decoded, ok := decodeBatchCall(calldata)
	if !ok {
		return nil, false
	}
	switch decoded.Name {
	case "claim", "claimWithSignature":
		rows := claimRowsFromClaimArgs(decoded.Args)
		if rows == nil {
			return nil, false
		}
		return rows, true
	case "multicall":
		if len(decoded.Args) == 0 {
			return nil, false
		}
		var out []claimRow
		for _, inner := range bytesSliceArg(decoded.Args[0]) {
			rows, ok := collectClaimRows(inner)
			if !ok {
				return nil, false
			}
			out = append(out, rows...)
		}
		return out, true
	default:
		return nil, true
	}
}

// readClaimedEvents reads the Claimed events emitted by the x402BatchSettlement contract, in log
// order. Logs from other emitters are ignored, so an unrelated contract in the same transaction
// cannot forge a Claimed for a channel.
func readClaimedEvents(logs []ReceiptLog) []claimedLog {
	out := make([]claimedLog, 0, len(logs))
	contract := common.HexToAddress(BatchSettlementAddress)
	for _, log := range logs {
		if log.Address != contract || len(log.Topics) < 3 || log.Topics[0] != claimedEvent.ID {
			continue
		}
		values, err := claimedEvent.Inputs.NonIndexed().Unpack(log.Data)
		if err != nil || len(values) < 2 {
			continue
		}
		claimAmount, okAmount := values[0].(*big.Int)
		newTotal, okTotal := values[1].(*big.Int)
		if !okAmount || !okTotal || claimAmount == nil || newTotal == nil {
			continue
		}
		out = append(out, claimedLog{
			ChannelID:       strings.ToLower(log.Topics[1].Hex()),
			Sender:          strings.ToLower(common.BytesToAddress(log.Topics[2].Bytes()).Hex()),
			ClaimAmount:     claimAmount,
			NewTotalClaimed: newTotal,
		})
	}
	return out
}

// ReceiptLogsFromEvm converts go-ethereum receipt logs to ReceiptLog values.
func ReceiptLogsFromEvm(logs []*goethtypes.Log) []ReceiptLog {
	out := make([]ReceiptLog, 0, len(logs))
	for _, log := range logs {
		if log == nil {
			continue
		}
		out = append(out, ReceiptLog{Address: log.Address, Topics: log.Topics, Data: log.Data})
	}
	return out
}

// ClaimedRowKeys returns the ClaimRowKey of each Claimed event emitted by x402BatchSettlement in a
// receipt. The result is never nil.
//
// Facilitators use it to subtract an attested chargeCount only for rows that were actually
// applied: a row applied when ClaimRowKey(row.channelId, row.totalClaimed) is in the set.
func ClaimedRowKeys(logs []*goethtypes.Log) map[string]struct{} {
	events := readClaimedEvents(ReceiptLogsFromEvm(logs))
	out := make(map[string]struct{}, len(events))
	for _, event := range events {
		out[ClaimRowKey(event.ChannelID, event.NewTotalClaimed.String())] = struct{}{}
	}
	return out
}

// AttestationOption configures DecodeClaimAttestation.
type AttestationOption func(*attestationOptions)

type attestationOptions struct {
	restrictSenders bool
	trustedSenders  map[string]struct{}
}

// trusts reports whether a lowercase Claimed.sender may attest counts.
func (o attestationOptions) trusts(sender string) bool {
	if !o.restrictSenders {
		return true
	}
	_, ok := o.trustedSenders[sender]
	return ok
}

// WithTrustedSenders attributes ChargeCount only for rows whose Claimed.sender is one of senders
// (the facilitator's submitting addresses). The counts are written by whoever submitted the
// transaction and claimWithSignature is permissionless, so callers crediting counts should set
// this. Without the option no sender check is made; with no addresses, no sender is trusted.
func WithTrustedSenders(senders ...string) AttestationOption {
	return func(o *attestationOptions) {
		o.restrictSenders = true
		o.trustedSenders = make(map[string]struct{}, len(senders))
		for _, sender := range senders {
			o.trustedSenders[strings.ToLower(common.HexToAddress(sender).Hex())] = struct{}{}
		}
	}
}

// DecodeClaimAttestation decodes claim attestation from full transaction input, the parsed
// ERC-8021 `m` metadata, and receipt logs.
//
// It handles standalone claim / claimWithSignature transactions and bundled
// multicall([claim, refund]) transactions. metadata is the `m` field of the suffix on the
// top-level input (for example buildercode.ParseBuilderCodeSuffixFromCalldata(input).M). No
// builder code is needed: a suffix carrying only `m` is enough.
//
// Rows are joined to Claimed events by (channelId, totalClaimed), never by position: a row that
// applied emits Claimed with newTotalClaimed equal to the row's totalClaimed, and each event
// matches at most one row. A row without a matching event was a no-op (for example a repeated or
// lower total for a channel already claimed in the same batch) and attests nothing. Counts whose
// length differs from the number of claim rows are ignored.
//
// Counts of rows that share a channel are snapshots of one counter, so a consumer crediting the
// channel should take their maximum, not their sum.
//
// It never returns an error: undecodable input yields FunctionName "unknown" and a nil Channels
// slice, and unparseable receipt logs yield rows with Claimed false.
func DecodeClaimAttestation(calldata []byte, receiptLogs []ReceiptLog, network string, metadata map[string]any, opts ...AttestationOption) ClaimAttestation {
	var options attestationOptions
	for _, opt := range opts {
		opt(&options)
	}
	outer, ok := decodeBatchCall(calldata)
	if !ok {
		return ClaimAttestation{FunctionName: "unknown"}
	}

	rows, ok := collectClaimRows(calldata)
	if !ok || len(rows) == 0 {
		return ClaimAttestation{FunctionName: outer.Name}
	}

	var chargeCounts []uint64
	if parsed := ParseChargeCountsMetadata(metadata); len(parsed) == len(rows) {
		chargeCounts = parsed
	}
	claimed := make(map[string]claimedLog)
	for _, event := range readClaimedEvents(receiptLogs) {
		claimed[ClaimRowKey(event.ChannelID, event.NewTotalClaimed.String())] = event
	}

	channels := make([]ClaimAttestationRow, len(rows))
	for i, row := range rows {
		channelId, err := ComputeChannelId(row.Config, network)
		if err != nil {
			channelId = ""
		}
		out := ClaimAttestationRow{ChannelId: channelId}
		channels[i] = out
		if channelId == "" || row.TotalClaimed == nil {
			continue
		}
		key := ClaimRowKey(channelId, row.TotalClaimed.String())
		event, ok := claimed[key]
		if !ok {
			continue
		}
		delete(claimed, key)
		out.Claimed = true
		out.ClaimAmount = event.ClaimAmount.String()
		out.NewTotalClaimed = event.NewTotalClaimed.String()
		if chargeCounts != nil && options.trusts(event.Sender) {
			out.ChargeCount = new(big.Int).SetUint64(chargeCounts[i]).String()
		}
		channels[i] = out
	}

	return ClaimAttestation{FunctionName: outer.Name, ChargeCounts: chargeCounts, Channels: channels}
}

func bytesSliceArg(v interface{}) [][]byte {
	switch x := v.(type) {
	case [][]byte:
		return x
	case []interface{}:
		out := make([][]byte, 0, len(x))
		for _, item := range x {
			b, ok := item.([]byte)
			if !ok {
				return nil
			}
			out = append(out, b)
		}
		return out
	default:
		return nil
	}
}

func claimRowsFromClaimArgs(args []interface{}) []claimRow {
	if len(args) == 0 {
		return nil
	}
	return claimRowsFromValue(args[0])
}

func claimRowsFromValue(v interface{}) []claimRow {
	switch claims := v.(type) {
	case []struct {
		Voucher struct {
			Channel            contractChannelTuple
			MaxClaimableAmount *big.Int
		}
		Signature    []byte
		TotalClaimed *big.Int
	}:
		out := make([]claimRow, len(claims))
		for i, c := range claims {
			out[i] = claimRow{Config: channelConfigFromTuple(c.Voucher.Channel), TotalClaimed: c.TotalClaimed}
		}
		return out
	case []interface{}:
		out := make([]claimRow, 0, len(claims))
		for _, item := range claims {
			row, ok := claimRowFromClaim(item)
			if !ok {
				return nil
			}
			out = append(out, row)
		}
		return out
	default:
		return claimRowsFromReflectedClaims(v)
	}
}

type contractChannelTuple struct {
	Payer              common.Address
	PayerAuthorizer    common.Address
	Receiver           common.Address
	ReceiverAuthorizer common.Address
	Token              common.Address
	WithdrawDelay      *big.Int
	Salt               [32]byte
}

func channelConfigFromTuple(c contractChannelTuple) ChannelConfig {
	delay := 0
	if c.WithdrawDelay != nil {
		delay = int(c.WithdrawDelay.Int64())
	}
	return ChannelConfig{
		Payer:              c.Payer.Hex(),
		PayerAuthorizer:    c.PayerAuthorizer.Hex(),
		Receiver:           c.Receiver.Hex(),
		ReceiverAuthorizer: c.ReceiverAuthorizer.Hex(),
		Token:              c.Token.Hex(),
		WithdrawDelay:      delay,
		Salt:               "0x" + common.Bytes2Hex(c.Salt[:]),
	}
}

func claimRowFromClaim(item interface{}) (claimRow, bool) {
	fields, ok := structFields(item)
	if !ok {
		return claimRow{}, false
	}
	voucher, ok := fields["voucher"]
	if !ok {
		return claimRow{}, false
	}
	voucherFields, ok := structFields(voucher)
	if !ok {
		return claimRow{}, false
	}
	channel, ok := voucherFields["channel"]
	if !ok {
		return claimRow{}, false
	}
	cfg, ok := channelConfigFromUnpacked(channel)
	if !ok {
		return claimRow{}, false
	}
	totalClaimed, ok := fields["totalClaimed"].(*big.Int)
	if !ok || totalClaimed == nil {
		return claimRow{}, false
	}
	return claimRow{Config: cfg, TotalClaimed: totalClaimed}, true
}

func channelConfigFromUnpacked(v interface{}) (ChannelConfig, bool) {
	if t, ok := v.(contractChannelTuple); ok {
		return channelConfigFromTuple(t), true
	}
	fields, ok := structFields(v)
	if !ok {
		return ChannelConfig{}, false
	}
	payer := addressField(fields, "payer")
	payerAuth := addressField(fields, "payerAuthorizer")
	receiver := addressField(fields, "receiver")
	receiverAuth := addressField(fields, "receiverAuthorizer")
	token := addressField(fields, "token")
	delay := 0
	if raw, ok := fields["withdrawDelay"]; ok {
		switch n := raw.(type) {
		case *big.Int:
			if n != nil {
				delay = int(n.Int64())
			}
		case uint64:
			delay = int(n)
		}
	}
	salt := ""
	if raw, ok := fields["salt"]; ok {
		switch s := raw.(type) {
		case [32]byte:
			salt = "0x" + common.Bytes2Hex(s[:])
		case []byte:
			salt = "0x" + common.Bytes2Hex(s)
		case common.Hash:
			salt = s.Hex()
		}
	}
	if payer == "" || receiver == "" || token == "" || salt == "" {
		return ChannelConfig{}, false
	}
	return ChannelConfig{
		Payer:              payer,
		PayerAuthorizer:    payerAuth,
		Receiver:           receiver,
		ReceiverAuthorizer: receiverAuth,
		Token:              token,
		WithdrawDelay:      delay,
		Salt:               salt,
	}, true
}

func claimRowsFromReflectedClaims(v interface{}) []claimRow {
	rv := reflect.ValueOf(v)
	if rv.Kind() != reflect.Slice {
		return nil
	}
	out := make([]claimRow, 0, rv.Len())
	for i := 0; i < rv.Len(); i++ {
		row, ok := claimRowFromClaim(rv.Index(i).Interface())
		if !ok {
			return nil
		}
		out = append(out, row)
	}
	return out
}

func structFields(v interface{}) (map[string]interface{}, bool) {
	switch x := v.(type) {
	case map[string]interface{}:
		return x, true
	case []interface{}:
		// ABI tuple as positional values: payer, payerAuthorizer, receiver,
		// receiverAuthorizer, token, withdrawDelay, salt.
		if len(x) >= 7 {
			return map[string]interface{}{
				"payer":              x[0],
				"payerAuthorizer":    x[1],
				"receiver":           x[2],
				"receiverAuthorizer": x[3],
				"token":              x[4],
				"withdrawDelay":      x[5],
				"salt":               x[6],
			}, true
		}
		// voucher claim as [voucher, signature, totalClaimed]
		if len(x) >= 3 {
			return map[string]interface{}{"voucher": x[0], "totalClaimed": x[2]}, true
		}
		if len(x) >= 1 {
			return map[string]interface{}{"voucher": x[0]}, true
		}
		return nil, false
	default:
		return reflectedStructFields(v)
	}
}

func reflectedStructFields(v interface{}) (map[string]interface{}, bool) {
	rv := reflect.ValueOf(v)
	if rv.Kind() == reflect.Pointer {
		if rv.IsNil() {
			return nil, false
		}
		rv = rv.Elem()
	}
	if rv.Kind() != reflect.Struct {
		return nil, false
	}
	rt := rv.Type()
	out := make(map[string]interface{}, rt.NumField())
	for i := 0; i < rt.NumField(); i++ {
		field := rt.Field(i)
		if field.PkgPath != "" {
			continue
		}
		name := field.Name
		if tag := field.Tag.Get("abi"); tag != "" {
			name = tag
		}
		out[lowerFirst(name)] = rv.Field(i).Interface()
		out[name] = rv.Field(i).Interface()
	}
	return out, true
}

func lowerFirst(s string) string {
	if s == "" {
		return s
	}
	return strings.ToLower(s[:1]) + s[1:]
}

func addressField(fields map[string]interface{}, key string) string {
	raw, ok := fields[key]
	if !ok {
		return ""
	}
	switch a := raw.(type) {
	case common.Address:
		return a.Hex()
	case string:
		return a
	default:
		return ""
	}
}
