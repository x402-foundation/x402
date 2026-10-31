package client

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/types"
)

// splitRPC serves getAccountInfo: the mint as an SPL Token mint, accounts in
// existing as token accounts, failing accounts as an RPC error, and anything
// else as missing.
type splitRPC struct {
	mu       sync.Mutex
	mint     solana.PublicKey
	existing map[solana.PublicKey]bool
	failing  map[solana.PublicKey]bool
}

func newSplitRPC(t *testing.T, mint solana.PublicKey) (*splitRPC, string) {
	t.Helper()
	r := &splitRPC{mint: mint, existing: map[solana.PublicKey]bool{}, failing: map[solana.PublicKey]bool{}}
	mintData := make([]byte, 82)
	mintData[44] = 6 // decimals
	mintData[45] = 1 // initialized
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var request struct {
			ID     json.RawMessage   `json:"id"`
			Method string            `json:"method"`
			Params []json.RawMessage `json:"params"`
		}
		if err := json.NewDecoder(req.Body).Decode(&request); err != nil || request.Method != "getAccountInfo" {
			http.Error(w, "unexpected request", http.StatusBadRequest)
			return
		}
		var address string
		_ = json.Unmarshal(request.Params[0], &address)
		key := solana.MustPublicKeyFromBase58(address)
		r.mu.Lock()
		exists, fails := r.existing[key], r.failing[key]
		r.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		write := func(body string) {
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":` + string(request.ID) + `,` + body + `}`))
		}
		switch {
		case key == r.mint:
			write(`"result":{"context":{"slot":1},"value":{"data":["` + base64.StdEncoding.EncodeToString(mintData) +
				`","base64"],"executable":false,"lamports":1,"owner":"` + solana.TokenProgramID.String() + `","rentEpoch":0}}`)
		case fails:
			write(`"error":{"code":-32000,"message":"node is behind"}`)
		case exists:
			write(`"result":{"context":{"slot":1},"value":{"data":["","base64"],"executable":false,"lamports":1,"owner":"` +
				solana.TokenProgramID.String() + `","rentEpoch":0}}`)
		default:
			write(`"result":{"context":{"slot":1},"value":null}`)
		}
	}))
	t.Cleanup(server.Close)
	return r, server.URL
}

type clientSplitParties struct {
	payer                                  *mockClientSigner
	feePayer, merchant, platform, referrer solana.PublicKey
	mint                                   solana.PublicKey
}

func newClientSplitParties() clientSplitParties {
	return clientSplitParties{
		payer:    &mockClientSigner{keypair: solana.NewWallet().PrivateKey},
		feePayer: solana.NewWallet().PublicKey(),
		merchant: solana.NewWallet().PublicKey(),
		platform: solana.NewWallet().PublicKey(),
		referrer: solana.NewWallet().PublicKey(),
		mint:     solana.NewWallet().PublicKey(),
	}
}

func (p clientSplitParties) requirements(extra map[string]interface{}) types.PaymentRequirements {
	base := map[string]interface{}{
		"feePayer":        p.feePayer.String(),
		"recentBlockhash": fixedBlockhash,
		"splits": []interface{}{
			map[string]interface{}{"payTo": p.platform.String(), "amount": "40000", "memo": "platform fee"},
			map[string]interface{}{"payTo": p.referrer.String(), "amount": "10000", "memo": "referral"},
		},
	}
	for k, v := range extra {
		base[k] = v
	}
	return types.PaymentRequirements{
		Scheme: svm.SchemeExact, Network: svm.SolanaDevnetCAIP2, Asset: p.mint.String(),
		Amount: "1050000", PayTo: p.merchant.String(), MaxTimeoutSeconds: 60, Extra: base,
	}
}

func (p clientSplitParties) ata(t *testing.T, owner solana.PublicKey) solana.PublicKey {
	t.Helper()
	ata, err := svm.DeriveATA(owner, p.mint, solana.TokenProgramID)
	require.NoError(t, err)
	return ata
}

func approveAll(context.Context, []svm.SplitTerms, svm.SplitApprovalInfo) bool { return true }

func decodePayloadTx(t *testing.T, payload types.PaymentPayload) *solana.Transaction {
	t.Helper()
	tx, err := svm.DecodeTransaction(payload.Payload["transaction"].(string))
	require.NoError(t, err)
	return tx
}

func programsOf(t *testing.T, tx *solana.Transaction) []solana.PublicKey {
	t.Helper()
	out := make([]solana.PublicKey, len(tx.Message.Instructions))
	for i, ix := range tx.Message.Instructions {
		program, err := tx.Message.Program(ix.ProgramIDIndex)
		require.NoError(t, err)
		out[i] = program
	}
	return out
}

func accountOf(t *testing.T, tx *solana.Transaction, ix solana.CompiledInstruction, i int) solana.PublicKey {
	t.Helper()
	key, err := tx.Message.Account(ix.Accounts[i])
	require.NoError(t, err)
	return key
}

func TestSplitsRequireConsent(t *testing.T) {
	p := newClientSplitParties()
	_, url := newSplitRPC(t, p.mint)

	_, err := NewExactSvmScheme(p.payer, &svm.ClientConfig{RPCURL: url}).
		CreatePaymentPayload(context.Background(), p.requirements(nil), x402.PaymentPayloadContext{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), ErrSplitsNotApproved)
	assert.Contains(t, err.Error(), "ApproveSplits")

	declining := NewExactSvmScheme(p.payer, &svm.ClientConfig{
		RPCURL:        url,
		ApproveSplits: func(context.Context, []svm.SplitTerms, svm.SplitApprovalInfo) bool { return false },
	})
	_, err = declining.CreatePaymentPayload(context.Background(), p.requirements(nil), x402.PaymentPayloadContext{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not approved")
}

func TestSplitsConsentReceivesSplitsAndPrimaryRemainder(t *testing.T) {
	p := newClientSplitParties()
	_, url := newSplitRPC(t, p.mint)
	var gotSplits []svm.SplitTerms
	var gotInfo svm.SplitApprovalInfo
	client := NewExactSvmScheme(p.payer, &svm.ClientConfig{
		RPCURL: url,
		ApproveSplits: func(_ context.Context, splits []svm.SplitTerms, info svm.SplitApprovalInfo) bool {
			gotSplits, gotInfo = splits, info
			return true
		},
	})
	req := p.requirements(nil)
	_, err := client.CreatePaymentPayload(context.Background(), req, x402.PaymentPayloadContext{})
	require.NoError(t, err)
	assert.Equal(t, []svm.SplitTerms{
		{PayTo: p.platform.String(), Amount: "40000", Memo: "platform fee"},
		{PayTo: p.referrer.String(), Amount: "10000", Memo: "referral"},
	}, gotSplits)
	assert.Equal(t, p.merchant.String(), gotInfo.PayTo)
	assert.Equal(t, "1000000", gotInfo.PrimaryAmount)
	assert.Equal(t, req.Amount, gotInfo.Requirements.Amount)
}

func TestSplitsRejectInvalidTermsBeforeConsent(t *testing.T) {
	p := newClientSplitParties()
	_, url := newSplitRPC(t, p.mint)
	called := false
	client := NewExactSvmScheme(p.payer, &svm.ClientConfig{
		RPCURL: url,
		ApproveSplits: func(context.Context, []svm.SplitTerms, svm.SplitApprovalInfo) bool {
			called = true
			return true
		},
	})
	req := p.requirements(map[string]interface{}{
		"splits": []interface{}{map[string]interface{}{"payTo": p.platform.String(), "amount": "1050000"}},
	})
	_, err := client.CreatePaymentPayload(context.Background(), req, x402.PaymentPayloadContext{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), svm.ErrSplitRemainderNotPositive)
	assert.False(t, called)
}

func TestSplitsBuildOneTransferPerLegInOrder(t *testing.T) {
	p := newClientSplitParties()
	_, url := newSplitRPC(t, p.mint)
	client := NewExactSvmScheme(p.payer, &svm.ClientConfig{RPCURL: url, ApproveSplits: approveAll})
	payload, err := client.CreatePaymentPayload(context.Background(), p.requirements(nil), x402.PaymentPayloadContext{})
	require.NoError(t, err)
	tx := decodePayloadTx(t, payload)

	memo := solana.MustPublicKeyFromBase58(svm.MemoProgramAddress)
	assert.Equal(t, []solana.PublicKey{
		solana.ComputeBudget, solana.ComputeBudget,
		solana.TokenProgramID, solana.TokenProgramID, solana.TokenProgramID,
		memo,
	}, programsOf(t, tx))
	ixs := tx.Message.Instructions
	assert.Equal(t, p.ata(t, p.merchant), accountOf(t, tx, ixs[2], 2))
	assert.Equal(t, p.ata(t, p.platform), accountOf(t, tx, ixs[3], 2))
	assert.Equal(t, p.ata(t, p.referrer), accountOf(t, tx, ixs[4], 2))
	// Compute limit: default plus one transfer allowance per split.
	assert.Equal(t, svm.DefaultComputeUnitLimit+2*svm.SplitTransferComputeUnits,
		uint32(ixs[0].Data[1])|uint32(ixs[0].Data[2])<<8|uint32(ixs[0].Data[3])<<16|uint32(ixs[0].Data[4])<<24)
}

func TestSplitsCreateAtaOnlyForMarkedRecipientsWithoutOne(t *testing.T) {
	p := newClientSplitParties()
	rpcState, url := newSplitRPC(t, p.mint)
	rpcState.existing[p.ata(t, p.merchant)] = true
	client := NewExactSvmScheme(p.payer, &svm.ClientConfig{RPCURL: url, ApproveSplits: approveAll})
	req := p.requirements(map[string]interface{}{
		"ataCreationRequired": true,
		"splits": []interface{}{
			map[string]interface{}{"payTo": p.platform.String(), "amount": "40000", "ataCreationRequired": true},
			map[string]interface{}{"payTo": p.referrer.String(), "amount": "10000"},
		},
	})
	payload, err := client.CreatePaymentPayload(context.Background(), req, x402.PaymentPayloadContext{})
	require.NoError(t, err)
	tx := decodePayloadTx(t, payload)

	programs := programsOf(t, tx)
	var creates []solana.CompiledInstruction
	for i, program := range programs {
		if program.Equals(solana.SPLAssociatedTokenAccountProgramID) {
			creates = append(creates, tx.Message.Instructions[i])
		}
	}
	require.Len(t, creates, 1)
	assert.Equal(t, solana.SPLAssociatedTokenAccountProgramID, programs[2])
	create := creates[0]
	assert.Equal(t, []byte{1}, []byte(create.Data))
	require.Len(t, create.Accounts, 6)
	assert.Equal(t, p.feePayer, accountOf(t, tx, create, 0))
	assert.Equal(t, p.ata(t, p.platform), accountOf(t, tx, create, 1))
	assert.Equal(t, p.platform, accountOf(t, tx, create, 2))
	assert.Equal(t, p.mint, accountOf(t, tx, create, 3))
	assert.Equal(t, solana.SystemProgramID, accountOf(t, tx, create, 4))
	assert.Equal(t, solana.TokenProgramID, accountOf(t, tx, create, 5))
	// The fee payer stays the only extra signer; the client signature verifies.
	assert.Equal(t, uint8(2), tx.Message.Header.NumRequiredSignatures)
	assert.Equal(t, svm.DefaultComputeUnitLimit+2*svm.SplitTransferComputeUnits+svm.AtaCreationComputeUnits,
		uint32(tx.Message.Instructions[0].Data[1])|uint32(tx.Message.Instructions[0].Data[2])<<8|uint32(tx.Message.Instructions[0].Data[3])<<16)
}

func TestSplitsIncludeCreateWhenAccountLookupFails(t *testing.T) {
	p := newClientSplitParties()
	rpcState, url := newSplitRPC(t, p.mint)
	rpcState.failing[p.ata(t, p.merchant)] = true
	client := NewExactSvmScheme(p.payer, &svm.ClientConfig{RPCURL: url})
	req := p.requirements(map[string]interface{}{"splits": []interface{}{}, "ataCreationRequired": true})
	payload, err := client.CreatePaymentPayload(context.Background(), req, x402.PaymentPayloadContext{})
	require.NoError(t, err, "no consent is needed without splits")
	programs := programsOf(t, decodePayloadTx(t, payload))
	require.Len(t, programs, 5)
	assert.Equal(t, solana.SPLAssociatedTokenAccountProgramID, programs[2])
	assert.Equal(t, solana.TokenProgramID, programs[3])
}

func TestSplitsSinglePayeeUnchangedWithoutSplits(t *testing.T) {
	p := newClientSplitParties()
	_, url := newSplitRPC(t, p.mint)
	req := p.requirements(map[string]interface{}{"splits": []interface{}{}})
	payload, err := NewExactSvmScheme(p.payer, &svm.ClientConfig{RPCURL: url}).
		CreatePaymentPayload(context.Background(), req, x402.PaymentPayloadContext{})
	require.NoError(t, err)
	tx := decodePayloadTx(t, payload)
	require.Len(t, tx.Message.Instructions, 4)
	assert.Equal(t, p.ata(t, p.merchant), accountOf(t, tx, tx.Message.Instructions[2], 2))
	assert.Equal(t, svm.DefaultComputeUnitLimit,
		uint32(tx.Message.Instructions[0].Data[1])|uint32(tx.Message.Instructions[0].Data[2])<<8|uint32(tx.Message.Instructions[0].Data[3])<<16)
}

func TestSplitsEightFitAndOversizedChargeIsRefused(t *testing.T) {
	p := newClientSplitParties()
	_, url := newSplitRPC(t, p.mint)
	client := NewExactSvmScheme(p.payer, &svm.ClientConfig{RPCURL: url, ApproveSplits: approveAll})

	recipients := make([]solana.PublicKey, 8)
	plain := make([]interface{}, 8)
	marked := make([]interface{}, 8)
	for i := range recipients {
		recipients[i] = solana.NewWallet().PublicKey()
		plain[i] = map[string]interface{}{"payTo": recipients[i].String(), "amount": "1000"}
		marked[i] = map[string]interface{}{"payTo": recipients[i].String(), "amount": "1000", "ataCreationRequired": true}
	}

	payload, err := client.CreatePaymentPayload(context.Background(), p.requirements(map[string]interface{}{"splits": plain}), x402.PaymentPayloadContext{})
	require.NoError(t, err)
	raw, err := base64.StdEncoding.DecodeString(payload.Payload["transaction"].(string))
	require.NoError(t, err)
	assert.LessOrEqual(t, len(raw), svm.MaxTransactionSizeLegacy)
	decoded := decodePayloadTx(t, payload)
	assert.Len(t, decoded.Message.Instructions, 2+9+1)

	_, err = client.CreatePaymentPayload(context.Background(), p.requirements(map[string]interface{}{
		"ataCreationRequired": true,
		"splits":              marked,
	}), x402.PaymentPayloadContext{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), ErrTransactionTooLarge)
	assert.Contains(t, err.Error(), "1232-byte limit")
}
