package facilitator

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	goethtypes "github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
	"github.com/x402-foundation/x402/go/v2/types"
)

const (
	managedNetwork     = "eip155:84532"
	managedPayer       = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
	managedReceiver    = "0x9876543210987654321098765432109876543210"
	managedToken       = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
	managedFacilitator = "0xFAC11174700123456789012345678901234aBCDe"
	managedAuthKeyHex  = "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
	// serverRefundKeyHex is a server-owned refund authorizer EOA, distinct from the facilitator's.
	serverRefundKeyHex = "5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
	dummySig           = "0xfeedface"
	successTxHash      = "0xabababababababababababababababababababababababababababababababab"
)

func managedSalt(suffix string) string {
	if suffix == "" {
		suffix = "00"
	}
	if len(suffix) == 1 {
		suffix = "0" + suffix
	}
	return "0x" + strings.Repeat("00", 31) + suffix
}

func managedAuthorizer() *fakeAuthorizerSigner {
	key, err := crypto.HexToECDSA(managedAuthKeyHex)
	if err != nil {
		panic(err)
	}
	return &fakeAuthorizerSigner{addr: crypto.PubkeyToAddress(key.PublicKey).Hex()}
}

func managedConfig(authorizer string, saltSuffix string) batchsettlement.ChannelConfig {
	if saltSuffix == "" {
		saltSuffix = "00"
	}
	return batchsettlement.ChannelConfig{
		Payer:              managedPayer,
		PayerAuthorizer:    zeroAddress,
		Receiver:           managedReceiver,
		ReceiverAuthorizer: authorizer,
		Token:              managedToken,
		WithdrawDelay:      900,
		Salt:               managedSalt(saltSuffix),
	}
}

// managedConfigWithRefundAuthorizer is managedConfig with refundAuthorizer packed into the salt.
func managedConfigWithRefundAuthorizer(t *testing.T, authorizer, refundAuthorizer string) batchsettlement.ChannelConfig {
	t.Helper()
	cfg := managedConfig(authorizer, "00")
	salt, err := batchsettlement.PackRefundAuthorizerSalt("0x"+strings.Repeat("ab", 12), refundAuthorizer)
	if err != nil {
		t.Fatal(err)
	}
	cfg.Salt = salt
	return cfg
}

func mustChannelId(t *testing.T, cfg batchsettlement.ChannelConfig) string {
	t.Helper()
	id, err := batchsettlement.ComputeChannelId(cfg, managedNetwork)
	if err != nil {
		t.Fatalf("channel id: %v", err)
	}
	return id
}

func managedRequirements(authorizer string) types.PaymentRequirements {
	return types.PaymentRequirements{
		Scheme:            batchsettlement.SchemeBatched,
		Network:           managedNetwork,
		Amount:            "1000",
		Asset:             managedToken,
		PayTo:             managedReceiver,
		MaxTimeoutSeconds: 3600,
		Extra: map[string]interface{}{
			"name":                "USDC",
			"version":             "2",
			"receiverAuthorizer":  authorizer,
			"assetTransferMethod": "eip3009",
			"withdrawDelay":       900,
			"voucherManager":      "facilitator",
		},
	}
}

// managedIdentityConfig is a channel config with a raw (unpacked) salt: the server brings no
// refund key, so refunds are authorized by caller identity.
func managedIdentityConfig(authorizer string) batchsettlement.ChannelConfig {
	cfg := managedConfig(authorizer, "00")
	cfg.Salt = "0x" + strings.Repeat("ab", 32)
	return cfg
}

// managedIdentityRequirements is managedRequirements without extra.refundAuthorizer, so a
// refund is authorized by caller identity.
func managedIdentityRequirements(authorizer string) types.PaymentRequirements {
	return managedRequirements(authorizer)
}

func managedEnvelope(payload map[string]interface{}) types.PaymentPayload {
	return types.PaymentPayload{
		X402Version: 2,
		Payload:     payload,
		Accepted: types.PaymentRequirements{
			Scheme:  batchsettlement.SchemeBatched,
			Network: managedNetwork,
			Amount:  managedRequirements(zeroAddress).Amount,
		},
	}
}

func voucherEnvelope(cfg batchsettlement.ChannelConfig, voucher batchsettlement.BatchSettlementVoucherFields, pendingId string) types.PaymentPayload {
	p := &batchsettlement.BatchSettlementVoucherPayload{
		Type:          "voucher",
		ChannelConfig: cfg,
		Voucher:       voucher,
		PendingId:     pendingId,
	}
	return managedEnvelope(p.ToMap())
}

func refundEnvelope(cfg batchsettlement.ChannelConfig, voucher batchsettlement.BatchSettlementVoucherFields, amount, pendingId, refundSig string) types.PaymentPayload {
	p := &batchsettlement.BatchSettlementRefundPayload{
		Type:          "refund",
		ChannelConfig: cfg,
		Voucher:       voucher,
		Amount:        amount,
		PendingId:     pendingId,
	}
	m := p.ToMap()
	if refundSig != "" {
		m["refundAuthorizerSignature"] = refundSig
	}
	return managedEnvelope(m)
}

func cancelEnvelope(cfg batchsettlement.ChannelConfig, voucher batchsettlement.BatchSettlementVoucherFields, pendingId string) types.PaymentPayload {
	m := voucherEnvelope(cfg, voucher, pendingId).Payload
	m["cancel"] = true
	return managedEnvelope(m)
}

func seedManagedChannel(t *testing.T, store *storage.InMemoryChannelStorage[*FacilitatorChannel], channel *FacilitatorChannel) {
	t.Helper()
	if _, err := store.UpdateChannel(context.Background(), channel.ChannelId, func(*FacilitatorChannel) *FacilitatorChannel {
		return channel.Clone()
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
}

func bindManagedIdentity(t *testing.T, store storage.DelegatedAuthStore, channelId, identity string) {
	t.Helper()
	if _, err := store.Bind(context.Background(), storage.DelegatedAuthBinding{
		ChannelId: channelId, Network: managedNetwork, CallerIdentity: identity,
	}); err != nil {
		t.Fatal(err)
	}
}

type channelFields struct {
	ChargedCumulativeAmount string
	SignedMaxClaimable      string
	Signature               string
	Balance                 string
	TotalClaimed            string
	WithdrawRequestedAt     int
	RefundNonce             int
	LastRequestTimestamp    int64
	OnchainSyncedAt         int64
	Network                 string
	ChargeCount             int
}

func storedManagedChannel(cfg batchsettlement.ChannelConfig, channelId string, overrides *channelFields) *FacilitatorChannel {
	ch := &FacilitatorChannel{
		Channel: storage.Channel{
			ChannelId:               channelId,
			ChannelConfig:           cfg,
			ChargedCumulativeAmount: "1000",
			SignedMaxClaimable:      "1000",
			Signature:               dummySig,
			Balance:                 "10000",
			TotalClaimed:            "0",
			LastRequestTimestamp:    time.Now().UnixMilli(),
			Network:                 managedNetwork,
		},
		ChargeCount: 0,
	}
	if overrides == nil {
		return ch
	}
	if overrides.ChargedCumulativeAmount != "" {
		ch.ChargedCumulativeAmount = overrides.ChargedCumulativeAmount
	}
	if overrides.SignedMaxClaimable != "" {
		ch.SignedMaxClaimable = overrides.SignedMaxClaimable
	}
	if overrides.Signature != "" {
		ch.Signature = overrides.Signature
	}
	if overrides.Balance != "" {
		ch.Balance = overrides.Balance
	}
	if overrides.TotalClaimed != "" {
		ch.TotalClaimed = overrides.TotalClaimed
	}
	if overrides.WithdrawRequestedAt != 0 {
		ch.WithdrawRequestedAt = overrides.WithdrawRequestedAt
	}
	if overrides.RefundNonce != 0 {
		ch.RefundNonce = overrides.RefundNonce
	}
	if overrides.LastRequestTimestamp != 0 {
		ch.LastRequestTimestamp = overrides.LastRequestTimestamp
	}
	if overrides.OnchainSyncedAt != 0 {
		ch.OnchainSyncedAt = overrides.OnchainSyncedAt
	}
	if overrides.Network != "" {
		ch.Network = overrides.Network
	}
	if overrides.ChargeCount != 0 {
		ch.ChargeCount = overrides.ChargeCount
	}
	return ch
}

func acquireBound(t *testing.T, store *storage.InMemoryChannelStorage[*FacilitatorChannel], pendingId string, voucher batchsettlement.BatchSettlementVoucherFields) {
	t.Helper()
	ok, err := store.Acquire(context.Background(), voucher.ChannelId, storage.AdmissionOwner(pendingId, voucher), 60_000)
	if err != nil || !ok {
		t.Fatalf("acquire bound: ok=%v err=%v", ok, err)
	}
}

func voucherFields(channelId, maxClaimable, signature string) batchsettlement.BatchSettlementVoucherFields {
	return batchsettlement.BatchSettlementVoucherFields{
		ChannelId:          channelId,
		MaxClaimableAmount: maxClaimable,
		Signature:          signature,
	}
}

type managedChainView struct {
	Balance      *big.Int
	TotalClaimed *big.Int
	WithdrawAt   int64
}

type managedRPC struct {
	t               *testing.T
	balance         *big.Int
	totalClaimed    *big.Int
	refundNonce     *big.Int
	withdrawAt      int64
	receiverClaimed *big.Int
	receiverSettled *big.Int
	tryAggregate    int
	invalidSig      bool
	simFail         string
	readFail        bool
	// chainViews overrides channels() and pendingWithdrawals() by channel id.
	chainViews map[string]managedChainView
	// failReads marks channel ids whose preflight subcalls revert.
	failReads map[string]struct{}
	// failReceivers marks receiver addresses whose receivers() subcalls revert.
	failReceivers map[string]struct{}
	// receiverSettledByAddr overrides receiverSettled for one receiver address.
	receiverSettledByAddr map[string]*big.Int
	// resyncView overrides the 3-call channel-state read used after a failed claim.
	resyncView *managedChainView
	// noopChannels marks lowercase channel ids whose claim row emits no Claimed event.
	noopChannels map[string]struct{}
	// suppressClaimed makes every claim row a no-op (for example a retried batch that already landed).
	suppressClaimed bool
}

// claimedEventABI is the Claimed event used to build receipt logs.
var claimedEventABI = func() abi.Event {
	parsed, err := abi.JSON(strings.NewReader(string(batchsettlement.BatchSettlementClaimedEventABI)))
	if err != nil {
		panic(err)
	}
	return parsed.Events["Claimed"]
}()

// claimedReceiptLog builds a Claimed log emitted by x402BatchSettlement. newTotalClaimed is the
// totalClaimed of the row that applied.
func claimedReceiptLog(t *testing.T, channelId string, newTotalClaimed *big.Int) *goethtypes.Log {
	t.Helper()
	data, err := claimedEventABI.Inputs.NonIndexed().Pack(big.NewInt(1), newTotalClaimed)
	if err != nil {
		t.Fatalf("pack Claimed data: %v", err)
	}
	return &goethtypes.Log{
		Address: common.HexToAddress(batchsettlement.BatchSettlementAddress),
		Topics: []common.Hash{
			claimedEventABI.ID,
			common.HexToHash(channelId),
			common.BytesToHash(common.LeftPadBytes(common.HexToAddress(managedFacilitator).Bytes(), 32)),
		},
		Data: data,
	}
}

// managedClaimedLogs returns the receipt logs the contract would emit for a claim, claim with
// signature, or multicall write: one Claimed per claim row unless the row is marked a no-op.
func managedClaimedLogs(t *testing.T, rpc *managedRPC, functionName string, args []interface{}) []*goethtypes.Log {
	t.Helper()
	if rpc.suppressClaimed {
		return nil
	}
	var legs [][]byte
	switch functionName {
	case "claim", "claimWithSignature":
		abiJSON := batchsettlement.BatchSettlementClaimABI
		if functionName == "claimWithSignature" {
			abiJSON = batchsettlement.BatchSettlementClaimWithSignatureABI
		}
		parsed, err := abi.JSON(strings.NewReader(string(abiJSON)))
		if err != nil {
			t.Fatalf("abi: %v", err)
		}
		calldata, err := parsed.Pack(functionName, args...)
		if err != nil {
			t.Fatalf("pack %s: %v", functionName, err)
		}
		legs = [][]byte{calldata}
	case "multicall":
		if len(args) > 0 {
			legs, _ = args[0].([][]byte)
		}
	default:
		return nil
	}
	var logs []*goethtypes.Log
	for _, leg := range legs {
		rows := batchsettlement.DecodeClaimAttestation(leg, nil, managedNetwork, nil).Channels
		totals := claimRowTotals(t, leg)
		if len(totals) != len(rows) {
			t.Fatalf("claim leg has %d totals for %d rows", len(totals), len(rows))
		}
		for i, row := range rows {
			if _, noop := rpc.noopChannels[strings.ToLower(row.ChannelId)]; noop {
				continue
			}
			logs = append(logs, claimedReceiptLog(t, row.ChannelId, totals[i]))
		}
	}
	return logs
}

// claimRowTotals returns the totalClaimed of each row of a claim / claimWithSignature leg, in row
// order. Other legs (for example refund) have no rows.
func claimRowTotals(t *testing.T, leg []byte) []*big.Int {
	t.Helper()
	if len(leg) < 4 {
		return nil
	}
	for _, abiJSON := range [][]byte{batchsettlement.BatchSettlementClaimABI, batchsettlement.BatchSettlementClaimWithSignatureABI} {
		parsed, err := abi.JSON(strings.NewReader(string(abiJSON)))
		if err != nil {
			t.Fatalf("abi: %v", err)
		}
		for _, method := range parsed.Methods {
			if !bytes.Equal(method.ID, leg[:4]) {
				continue
			}
			values, err := method.Inputs.Unpack(leg[4:])
			if err != nil {
				t.Fatalf("unpack %s: %v", method.Name, err)
			}
			claims := reflect.ValueOf(values[0])
			totals := make([]*big.Int, claims.Len())
			for i := range totals {
				totals[i] = claims.Index(i).FieldByName("TotalClaimed").Interface().(*big.Int)
			}
			return totals
		}
	}
	return nil
}

func newManagedSigner(t *testing.T, rpc *managedRPC) *fakeFacilitatorSigner {
	t.Helper()
	if rpc == nil {
		rpc = &managedRPC{t: t}
	}
	rpc.t = t
	if rpc.balance == nil {
		rpc.balance = big.NewInt(10000)
	}
	if rpc.totalClaimed == nil {
		rpc.totalClaimed = big.NewInt(0)
	}
	if rpc.refundNonce == nil {
		rpc.refundNonce = big.NewInt(0)
	}
	if rpc.receiverClaimed == nil {
		rpc.receiverClaimed = big.NewInt(1000)
	}
	if rpc.receiverSettled == nil {
		rpc.receiverSettled = big.NewInt(0)
	}
	var lastLogs []*goethtypes.Log
	return &fakeFacilitatorSigner{
		addresses: []string{managedFacilitator},
		chainId:   big.NewInt(84532),
		getCode: func(string) ([]byte, error) {
			return []byte{0x60, 0x80, 0x60, 0x40, 0x52}, nil
		},
		readContract: func(functionName string, args ...interface{}) (interface{}, error) {
			if rpc.readFail {
				return nil, fmt.Errorf("rpc down")
			}
			if functionName == "isValidSignature" {
				if rpc.invalidSig {
					return [4]byte{0xff, 0xff, 0xff, 0xff}, nil
				}
				return [4]byte{0x16, 0x26, 0xba, 0x7e}, nil
			}
			if functionName == evm.FunctionTryAggregate {
				rpc.tryAggregate++
				return multicallTryAggregateStub(t, rpc, args...), nil
			}
			if functionName == "receivers" {
				return []interface{}{rpc.receiverClaimed, rpc.receiverSettled}, nil
			}
			if rpc.simFail != "" && functionName == rpc.simFail {
				return nil, fmt.Errorf("execution reverted")
			}
			return nil, nil
		},
		writeContract: func(functionName string, args ...interface{}) (string, error) {
			lastLogs = managedClaimedLogs(t, rpc, functionName, args)
			if functionName == "refundWithSignature" || functionName == "refund" || functionName == "multicall" {
				if rpc.balance.Sign() > 0 && rpc.totalClaimed != nil {
					remain := new(big.Int).Sub(rpc.balance, rpc.totalClaimed)
					if remain.Sign() > 0 {
						rpc.balance = new(big.Int).Set(rpc.totalClaimed)
					}
				}
				rpc.refundNonce = new(big.Int).Add(rpc.refundNonce, big.NewInt(1))
			}
			if functionName == "claimWithSignature" || functionName == "claim" {
				rpc.receiverClaimed = new(big.Int).Set(rpc.receiverClaimed)
			}
			return successTxHash, nil
		},
		waitForReceipt: func(txHash string) (*evm.TransactionReceipt, error) {
			return &evm.TransactionReceipt{Status: evm.TxStatusSuccess, TxHash: txHash, Logs: lastLogs}, nil
		},
	}
}

func managedDeps(t *testing.T, store storage.ChannelStorage[*FacilitatorChannel], lock storage.ChannelLockStorage, authorizer *fakeAuthorizerSigner, signer evm.FacilitatorEvmSigner) VoucherStoreDeps {
	t.Helper()
	if signer == nil {
		signer = newManagedSigner(t, nil)
	}
	if lock == nil {
		if ls, ok := store.(storage.ChannelLockStorage); ok {
			lock = ls
		}
	}
	return VoucherStoreDeps{
		Signer:             signer,
		AuthorizerSigner:   authorizer,
		Storage:            store,
		LockStorage:        lock,
		WithdrawDelay:      900,
		PendingStore:       x402.NewInMemoryPendingSettlementStore(),
		DelegatedAuthStore: storage.NewInMemoryDelegatedAuthStore(),
		// Default consent path for 402s that omit extra.refundAuthorizer.
		ResolveCallerIdentity: identityResolver("svc"),
	}
}

func pendingIdFrom(resp *x402.VerifyResponse) string {
	if resp == nil || resp.Extra == nil {
		return ""
	}
	id, _ := resp.Extra["pendingId"].(string)
	return id
}

func extraInt(resp *x402.SettleResponse, key string) int {
	if resp == nil || resp.Extra == nil {
		return 0
	}
	n, ok := extraNumber(resp.Extra[key])
	if !ok {
		return 0
	}
	return n
}

func extraString(m map[string]interface{}, key string) string {
	if m == nil {
		return ""
	}
	s, _ := m[key].(string)
	return s
}

func signRefundConsent(t *testing.T, channelId, amount, nonce, network string) (authorizer string, signature string) {
	t.Helper()
	return signRefundWithKey(t, managedAuthKeyHex, channelId, amount, nonce, network)
}

// addressOfKey returns the checksummed address of a hex private key.
func addressOfKey(t *testing.T, keyHex string) string {
	t.Helper()
	key, err := crypto.HexToECDSA(keyHex)
	if err != nil {
		t.Fatal(err)
	}
	return crypto.PubkeyToAddress(key.PublicKey).Hex()
}

// signRefundWithKey signs the EIP-712 Refund digest with the given key.
func signRefundWithKey(t *testing.T, keyHex, channelId, amount, nonce, network string) (authorizer string, signature string) {
	t.Helper()
	key, err := crypto.HexToECDSA(keyHex)
	if err != nil {
		t.Fatal(err)
	}
	authorizer = crypto.PubkeyToAddress(key.PublicKey).Hex()
	chainID, err := evm.GetEvmChainId(network)
	if err != nil {
		t.Fatal(err)
	}
	refundAmount, ok := new(big.Int).SetString(amount, 10)
	if !ok {
		t.Fatalf("amount %s", amount)
	}
	refundNonce, ok := new(big.Int).SetString(nonce, 10)
	if !ok {
		t.Fatalf("nonce %s", nonce)
	}
	hash, err := evm.HashTypedData(
		batchsettlement.GetBatchSettlementEip712Domain(chainID),
		batchsettlement.RefundTypes,
		"Refund",
		map[string]interface{}{
			"channelId": channelId,
			"nonce":     refundNonce,
			"amount":    refundAmount,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	sig, err := crypto.Sign(hash, key)
	if err != nil {
		t.Fatal(err)
	}
	sig[64] += 27
	return authorizer, "0x" + hex.EncodeToString(sig)
}

func signedManagedDeposit(t *testing.T, cfg batchsettlement.ChannelConfig, channelId string) types.PaymentPayload {
	t.Helper()
	const amount, maxClaimable = "1000", "1000"
	key, err := crypto.HexToECDSA(managedAuthKeyHex)
	if err != nil {
		t.Fatal(err)
	}
	chainID, err := evm.GetEvmChainId(managedNetwork)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().Unix()
	salt := "0x" + strings.Repeat("aa", 32)
	erc3009Nonce, err := batchsettlement.BuildErc3009DepositNonce(channelId, salt)
	if err != nil {
		t.Fatal(err)
	}
	nonceBytes, err := evm.HexToBytes(erc3009Nonce)
	if err != nil {
		t.Fatal(err)
	}
	hash, err := evm.HashTypedData(
		evm.TypedDataDomain{
			Name:              "USDC",
			Version:           "2",
			ChainID:           chainID,
			VerifyingContract: cfg.Token,
		},
		batchsettlement.ReceiveAuthorizationTypes,
		"ReceiveWithAuthorization",
		map[string]interface{}{
			"from":        cfg.Payer,
			"to":          batchsettlement.ERC3009DepositCollectorAddress,
			"value":       big.NewInt(1000),
			"validAfter":  big.NewInt(0),
			"validBefore": big.NewInt(now + 3600),
			"nonce":       nonceBytes,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	sig, err := crypto.Sign(hash, key)
	if err != nil {
		t.Fatal(err)
	}
	sig[64] += 27
	p := &batchsettlement.BatchSettlementDepositPayload{
		Type:          "deposit",
		ChannelConfig: cfg,
		Voucher:       voucherFields(channelId, maxClaimable, eoaVoucherSignature(t, channelId, maxClaimable, managedNetwork)),
		Deposit: batchsettlement.BatchSettlementDepositData{
			Amount: amount,
			Authorization: batchsettlement.BatchSettlementDepositAuthorization{
				Erc3009Authorization: &batchsettlement.BatchSettlementErc3009Authorization{
					ValidAfter:  "0",
					ValidBefore: fmt.Sprintf("%d", now+3600),
					Salt:        salt,
					Signature:   "0x" + hex.EncodeToString(sig),
				},
			},
		},
	}
	return managedEnvelope(p.ToMap())
}

func eoaVoucherSignature(t *testing.T, channelId, maxClaimable, network string) string {
	t.Helper()
	key, err := crypto.HexToECDSA(managedAuthKeyHex)
	if err != nil {
		t.Fatal(err)
	}
	chainID, err := evm.GetEvmChainId(network)
	if err != nil {
		t.Fatal(err)
	}
	amt, ok := new(big.Int).SetString(maxClaimable, 10)
	if !ok {
		t.Fatalf("maxClaimable %s", maxClaimable)
	}
	hash, err := evm.HashTypedData(
		batchsettlement.GetBatchSettlementEip712Domain(chainID),
		batchsettlement.VoucherTypes,
		"Voucher",
		map[string]interface{}{
			"channelId":          channelId,
			"maxClaimableAmount": amt,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	sig, err := crypto.Sign(hash, key)
	if err != nil {
		t.Fatal(err)
	}
	sig[64] += 27
	return "0x" + hex.EncodeToString(sig)
}

type hookStore struct {
	inner          *storage.InMemoryChannelStorage[*FacilitatorChannel]
	getErr         error
	acquireErr     error
	acquireCalls   int
	releaseErr     error
	isHeldErr      error
	updateErr      error
	updateConflict bool
	queryItems     []*FacilitatorChannel
	queryCalls     int
	queryFilter    storage.ChannelQuery
	useQuery       bool
}

func (s *hookStore) Get(ctx context.Context, channelId string) (*FacilitatorChannel, error) {
	if s.getErr != nil {
		return nil, s.getErr
	}
	return s.inner.Get(ctx, channelId)
}
func (s *hookStore) List(ctx context.Context) ([]*FacilitatorChannel, error) {
	return s.inner.List(ctx)
}
func (s *hookStore) UpdateChannel(ctx context.Context, channelId string, update func(*FacilitatorChannel) *FacilitatorChannel) (*storage.ChannelUpdateResult[*FacilitatorChannel], error) {
	if s.updateErr != nil {
		return nil, s.updateErr
	}
	if s.updateConflict {
		return &storage.ChannelUpdateResult[*FacilitatorChannel]{Status: storage.ChannelConflict}, nil
	}
	return s.inner.UpdateChannel(ctx, channelId, update)
}
func (s *hookStore) Acquire(ctx context.Context, channelId, pendingId string, ttlMs int64) (bool, error) {
	s.acquireCalls++
	if s.acquireErr != nil {
		return false, s.acquireErr
	}
	return s.inner.Acquire(ctx, channelId, pendingId, ttlMs)
}
func (s *hookStore) Release(ctx context.Context, channelId, pendingId string) error {
	if s.releaseErr != nil {
		return s.releaseErr
	}
	return s.inner.Release(ctx, channelId, pendingId)
}
func (s *hookStore) IsHeld(ctx context.Context, channelId, pendingId string) (bool, error) {
	if s.isHeldErr != nil {
		return false, s.isHeldErr
	}
	return s.inner.IsHeld(ctx, channelId, pendingId)
}
func (s *hookStore) Query(ctx context.Context, filter storage.ChannelQuery, opts *storage.ChannelStoreOptions) (*storage.QueryPage[*FacilitatorChannel], error) {
	s.queryCalls++
	s.queryFilter = filter
	if !s.useQuery {
		return nil, nil
	}
	_ = filter
	_ = opts
	return &storage.QueryPage[*FacilitatorChannel]{Items: s.queryItems}, nil
}

type recordingSettleTargets struct {
	calls int
	items []storage.SettleTarget
}

func (s *recordingSettleTargets) ListSettleTargets(context.Context, storage.SettleQuery) (*storage.QueryPage[storage.SettleTarget], error) {
	s.calls++
	return &storage.QueryPage[storage.SettleTarget]{Items: s.items}, nil
}

func (s *recordingSettleTargets) RecordClaimed(context.Context, storage.SettleTargetClaimDelta) error {
	return nil
}

func (s *recordingSettleTargets) RemoveSettleTarget(context.Context, storage.SettleTarget, int64) error {
	return nil
}

// stubBuilderCode stands in for the builder-code facilitator extension. It returns a fixed suffix
// (nil for none) and records the metadata of every context so tests can assert what the
// facilitator would encode into ERC-8021 `m`.
type stubBuilderCode struct {
	suffix   []byte
	metadata []map[string]any
}

func (s *stubBuilderCode) Key() string { return evm.BuilderCodeKey }
func (s *stubBuilderCode) BuildDataSuffix(ctx evm.DataSuffixContext) ([]byte, error) {
	s.metadata = append(s.metadata, ctx.Metadata)
	return s.suffix, nil
}

// chargeCounts returns the counts of the most recent context that carried any.
func (s *stubBuilderCode) chargeCounts() []uint64 {
	for i := len(s.metadata) - 1; i >= 0; i-- {
		if counts := batchsettlement.ParseChargeCountsMetadata(s.metadata[i]); counts != nil {
			return counts
		}
	}
	return nil
}

func builderContext(suffix []byte) *x402.FacilitatorContext {
	return recordingContext(&stubBuilderCode{suffix: suffix})
}

func recordingContext(stub *stubBuilderCode) *x402.FacilitatorContext {
	return x402.NewFacilitatorContext(map[string]x402.FacilitatorExtension{
		evm.BuilderCodeKey: stub,
	})
}

// contextStub returns the recording builder-code stub registered on fctx.
func contextStub(t *testing.T, fctx *x402.FacilitatorContext) *stubBuilderCode {
	t.Helper()
	stub, ok := fctx.GetExtension(evm.BuilderCodeKey).(*stubBuilderCode)
	if !ok {
		t.Fatal("facilitator context has no recording builder-code stub")
	}
	return stub
}

func syntaxLockErr() error {
	return &json.SyntaxError{Offset: 1}
}

func bigInt(n int64) *big.Int { return big.NewInt(n) }

var _ storage.ChannelQuerier[*FacilitatorChannel] = (*hookStore)(nil)
var _ storage.SettleTargetStorage = (*recordingSettleTargets)(nil)
var _ storage.ChannelLockStorage = (*hookStore)(nil)
var _ evm.BuilderCodeFacilitatorExtension = (*stubBuilderCode)(nil)
