package facilitator

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	computebudget "github.com/gagliardetto/solana-go/programs/compute-budget"
	"github.com/gagliardetto/solana-go/programs/token"
	"github.com/gagliardetto/solana-go/rpc"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	exactclient "github.com/x402-foundation/x402/go/v2/mechanisms/svm/exact/client"
	"github.com/x402-foundation/x402/go/v2/types"
)

var swigV2 = solana.MustPublicKeyFromBase58("swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB")

const splitBlockhash = "5Tx8F3jgSHx21CbtjwmdaKPLM5tWmreWAnPrbqHomSJF"

// ─── fixtures ───────────────────────────────────────────────────────────────

type splitParties struct {
	payer                                  solana.PrivateKey
	feePayer, merchant, platform, referrer solana.PublicKey
	mint                                   solana.PublicKey
	rpcURL                                 string
	existing                               *sync.Map // ATA -> struct{}: accounts the client sees as existing
}

func newSplitParties(t *testing.T) splitParties {
	t.Helper()
	p := splitParties{
		payer:    solana.NewWallet().PrivateKey,
		feePayer: solana.NewWallet().PublicKey(),
		merchant: solana.NewWallet().PublicKey(),
		platform: solana.NewWallet().PublicKey(),
		referrer: solana.NewWallet().PublicKey(),
		mint:     solana.NewWallet().PublicKey(),
		existing: &sync.Map{},
	}
	mintData := make([]byte, 82)
	mintData[44] = 6 // decimals
	mintData[45] = 1 // initialized
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			ID     json.RawMessage   `json:"id"`
			Method string            `json:"method"`
			Params []json.RawMessage `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil || request.Method != "getAccountInfo" {
			http.Error(w, "unexpected request", http.StatusBadRequest)
			return
		}
		var address string
		_ = json.Unmarshal(request.Params[0], &address)
		value := "null"
		if address == p.mint.String() {
			value = `{"data":["` + base64.StdEncoding.EncodeToString(mintData) + `","base64"],"executable":false,"lamports":1,"owner":"` +
				solana.TokenProgramID.String() + `","rentEpoch":0}`
		} else if _, ok := p.existing.Load(address); ok {
			value = `{"data":["","base64"],"executable":false,"lamports":1,"owner":"` + solana.TokenProgramID.String() + `","rentEpoch":0}`
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":` + string(request.ID) + `,"result":{"context":{"slot":1},"value":` + value + `}}`))
	}))
	t.Cleanup(server.Close)
	p.rpcURL = server.URL
	return p
}

func (p splitParties) requirements(extra map[string]interface{}) types.PaymentRequirements {
	base := map[string]interface{}{
		"feePayer":        p.feePayer.String(),
		"recentBlockhash": splitBlockhash,
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

func (p splitParties) ata(t *testing.T, owner solana.PublicKey) solana.PublicKey {
	t.Helper()
	ata, err := svm.DeriveATA(owner, p.mint, solana.TokenProgramID)
	require.NoError(t, err)
	return ata
}

func (p splitParties) transfer(t *testing.T, owner solana.PublicKey, amount uint64) solana.Instruction {
	t.Helper()
	ix, err := token.NewTransferCheckedInstructionBuilder().
		SetAmount(amount).
		SetDecimals(6).
		SetSourceAccount(p.ata(t, p.payer.PublicKey())).
		SetMintAccount(p.mint).
		SetDestinationAccount(p.ata(t, owner)).
		SetOwnerAccount(p.payer.PublicKey()).
		ValidateAndBuild()
	require.NoError(t, err)
	return ix
}

func memoIx(text string) solana.Instruction {
	return solana.NewInstruction(solana.MustPublicKeyFromBase58(svm.MemoProgramAddress), solana.AccountMetaSlice{}, []byte(text))
}

// buildTx assembles compute limit + compute price + ixs, fee payer at index 0,
// signed by the payer and any extra signers.
func (p splitParties) buildTx(t *testing.T, ixs []solana.Instruction, extraSigners ...solana.PrivateKey) (string, *solana.Transaction) {
	t.Helper()
	limit, err := computebudget.NewSetComputeUnitLimitInstructionBuilder().SetUnits(60_000).ValidateAndBuild()
	require.NoError(t, err)
	price, err := computebudget.NewSetComputeUnitPriceInstructionBuilder().SetMicroLamports(1).ValidateAndBuild()
	require.NoError(t, err)
	builder := solana.NewTransactionBuilder().AddInstruction(limit).AddInstruction(price)
	for _, ix := range ixs {
		builder = builder.AddInstruction(ix)
	}
	tx, err := builder.SetRecentBlockHash(solana.MustHashFromBase58(splitBlockhash)).SetFeePayer(p.feePayer).Build()
	require.NoError(t, err)
	signTransaction(t, tx, p.payer)
	for _, key := range extraSigners {
		signTransaction(t, tx, key)
	}
	encoded, err := svm.EncodeTransaction(tx)
	require.NoError(t, err)
	return encoded, tx
}

type splitClientSigner struct{ key solana.PrivateKey }

func (s splitClientSigner) Address() solana.PublicKey { return s.key.PublicKey() }

func (s splitClientSigner) SignTransaction(_ context.Context, tx *solana.Transaction) error {
	message, err := tx.Message.MarshalBinary()
	if err != nil {
		return err
	}
	signature, err := s.key.Sign(message)
	if err != nil {
		return err
	}
	index, err := tx.GetAccountIndex(s.key.PublicKey())
	if err != nil {
		return err
	}
	for len(tx.Signatures) <= int(index) {
		tx.Signatures = append(tx.Signatures, solana.Signature{})
	}
	tx.Signatures[index] = signature
	return nil
}

// clientTransaction builds the payment with the SDK's own exact client.
func (p splitParties) clientTransaction(t *testing.T, req types.PaymentRequirements) string {
	t.Helper()
	client := exactclient.NewExactSvmScheme(splitClientSigner{key: p.payer}, &svm.ClientConfig{
		RPCURL:        p.rpcURL,
		ApproveSplits: func(context.Context, []svm.SplitTerms, svm.SplitApprovalInfo) bool { return true },
	})
	payload, err := client.CreatePaymentPayload(context.Background(), req, x402.PaymentPayloadContext{})
	require.NoError(t, err)
	return payload.Payload["transaction"].(string)
}

func splitPayment(req types.PaymentRequirements, encoded string) types.PaymentPayload {
	return types.PaymentPayload{
		X402Version: 2,
		Payload:     (&svm.ExactSvmPayload{Transaction: encoded}).ToMap(),
		Accepted:    req,
	}
}

func (p splitParties) signer() *mockSmartWalletSigner {
	return &mockSmartWalletSigner{
		mockExactSvmSigner: mockExactSvmSigner{
			addresses:     []solana.PublicKey{p.feePayer},
			sendSignature: solana.SignatureFromBytes(append([]byte{5}, make([]byte, 63)...)),
		},
	}
}

func splitVerifyReason(t *testing.T, resp *x402.VerifyResponse, err error) string {
	t.Helper()
	require.Nil(t, resp)
	var ve *x402.VerifyError
	require.True(t, errors.As(err, &ve), "expected VerifyError, got %v", err)
	return ve.InvalidReason
}

// ─── capabilities ───────────────────────────────────────────────────────────

func TestSplits_AdvertisedOnlyWhenConfigured(t *testing.T) {
	p := newSplitParties(t)
	plain := NewExactSvmScheme(p.signer()).GetExtra(svm.SolanaDevnetCAIP2)
	assert.Equal(t, p.feePayer.String(), plain["feePayer"])
	assert.NotContains(t, plain, "maxSplits")
	assert.NotContains(t, plain, "ataCreationSponsored")

	configured := NewExactSvmScheme(p.signer(), &Config{MaxSplits: 8, AtaCreationSponsored: true}).GetExtra(svm.SolanaDevnetCAIP2)
	assert.Equal(t, 8, configured["maxSplits"])
	assert.Equal(t, true, configured["ataCreationSponsored"])
	assert.Equal(t, svm.SplitCapabilities{MaxSplits: 8, AtaCreationSponsored: true}, svm.GetSplitCapabilities(configured))

	assert.PanicsWithValue(t, "exact svm facilitator: maxSplits must be between 0 and 8, received 9", func() {
		NewExactSvmScheme(p.signer(), &Config{MaxSplits: 9})
	})
	assert.Panics(t, func() { NewExactSvmScheme(p.signer(), &Config{MaxSplits: -1}) })
}

// ─── Path 1 ─────────────────────────────────────────────────────────────────

func TestSplits_Path1AcceptsClientBuiltCharge(t *testing.T) {
	p := newSplitParties(t)
	req := p.requirements(nil)
	signer := p.signer()
	resp, err := NewExactSvmScheme(signer, &Config{MaxSplits: 2}).
		Verify(context.Background(), splitPayment(req, p.clientTransaction(t, req)), req, nil)
	require.NoError(t, err)
	assert.True(t, resp.IsValid)
	assert.Equal(t, p.payer.PublicKey().String(), resp.Payer)
	assert.Equal(t, 1, signer.simulateCalls)
}

func TestSplits_Path1AcceptsSponsoredAtaCreationIncludingPrimary(t *testing.T) {
	p := newSplitParties(t)
	req := p.requirements(map[string]interface{}{
		"ataCreationRequired": true,
		"splits": []interface{}{
			map[string]interface{}{"payTo": p.platform.String(), "amount": "40000", "ataCreationRequired": true},
		},
	})
	encoded := p.clientTransaction(t, req)
	tx, err := svm.DecodeTransaction(encoded)
	require.NoError(t, err)
	require.Len(t, tx.Message.Instructions, 2+2+2+1, "two creates, two transfers, memo")

	resp, err := NewExactSvmScheme(p.signer(), &Config{MaxSplits: 1, AtaCreationSponsored: true}).
		Verify(context.Background(), splitPayment(req, encoded), req, nil)
	require.NoError(t, err)
	assert.True(t, resp.IsValid)
}

func TestSplits_Path1AcceptsVersion1ChargeWithSponsoredCreation(t *testing.T) {
	p := newSplitParties(t)
	req := p.requirements(map[string]interface{}{
		"transactionVersions": []interface{}{0, 1},
		"splits": []interface{}{
			map[string]interface{}{"payTo": p.platform.String(), "amount": "40000", "ataCreationRequired": true},
			map[string]interface{}{"payTo": p.referrer.String(), "amount": "10000"},
		},
	})
	encoded := p.clientTransaction(t, req)
	tx, err := svm.DecodeTransaction(encoded)
	require.NoError(t, err)
	require.Equal(t, solana.MessageVersionV1, tx.Message.GetVersion())
	// Version 1 has no ComputeBudget prefix: one create, three transfers, memo.
	require.Len(t, tx.Message.Instructions, 1+3+1)
	first, err := tx.Message.Program(tx.Message.Instructions[0].ProgramIDIndex)
	require.NoError(t, err)
	assert.Equal(t, solana.SPLAssociatedTokenAccountProgramID, first)

	resp, err := NewExactSvmScheme(p.signer(), &Config{MaxSplits: 2, AtaCreationSponsored: true}).
		Verify(context.Background(), splitPayment(req, encoded), req, nil)
	require.NoError(t, err)
	assert.True(t, resp.IsValid)
}

func TestSplits_Path1AcceptsSponsoredCreationForFeePayerRecipient(t *testing.T) {
	// A split to the sponsor itself for cost recovery: the fee payer is then
	// both the funding payer and the owner of the created ATA (§2.1.1).
	p := newSplitParties(t)
	req := p.requirements(map[string]interface{}{
		"splits": []interface{}{
			map[string]interface{}{"payTo": p.feePayer.String(), "amount": "40000", "ataCreationRequired": true},
		},
	})
	resp, err := NewExactSvmScheme(p.signer(), &Config{MaxSplits: 1, AtaCreationSponsored: true}).
		Verify(context.Background(), splitPayment(req, p.clientTransaction(t, req)), req, nil)
	require.NoError(t, err)
	assert.True(t, resp.IsValid)
}

func TestSplits_RejectsBeyondAdvertisedCapabilities(t *testing.T) {
	p := newSplitParties(t)
	req := p.requirements(nil)
	encoded := p.clientTransaction(t, req)
	signer := p.signer()

	resp, err := NewExactSvmScheme(signer).Verify(context.Background(), splitPayment(req, encoded), req, nil)
	assert.Equal(t, ErrSplitCountExceeded, splitVerifyReason(t, resp, err))

	marked := p.requirements(map[string]interface{}{"ataCreationRequired": true})
	resp, err = NewExactSvmScheme(signer, &Config{MaxSplits: 8}).
		Verify(context.Background(), splitPayment(marked, p.clientTransaction(t, marked)), marked, nil)
	assert.Equal(t, ErrSplitAtaCreationNotAuthorized, splitVerifyReason(t, resp, err))

	invalid := p.requirements(map[string]interface{}{
		"splits": []interface{}{map[string]interface{}{"payTo": p.platform.String(), "amount": "1050000"}},
	})
	resp, err = NewExactSvmScheme(signer, &Config{MaxSplits: 8}).Verify(context.Background(), splitPayment(invalid, encoded), invalid, nil)
	assert.Equal(t, ErrSplitRemainderNotPositive, splitVerifyReason(t, resp, err))
	assert.Equal(t, 0, signer.simulateCalls, "split terms are rejected before the transaction is inspected")
}

func TestSplits_RejectsCreationForUnmarkedRecipient(t *testing.T) {
	p := newSplitParties(t)
	marked := p.requirements(map[string]interface{}{"ataCreationRequired": true})
	encoded := p.clientTransaction(t, marked)
	unmarked := p.requirements(nil)
	resp, err := NewExactSvmScheme(p.signer(), &Config{MaxSplits: 8, AtaCreationSponsored: true}).
		Verify(context.Background(), splitPayment(unmarked, encoded), unmarked, nil)
	assert.Equal(t, ErrSplitAtaCreationNotAuthorized, splitVerifyReason(t, resp, err))
}

func TestSplits_RejectsClientFundedCreation(t *testing.T) {
	p := newSplitParties(t)
	req := p.requirements(map[string]interface{}{"ataCreationRequired": true})
	create := svm.NewCreateIdempotentInstruction(p.payer.PublicKey(), p.ata(t, p.merchant), p.merchant, p.mint, solana.TokenProgramID)
	encoded, _ := p.buildTx(t, []solana.Instruction{
		create,
		p.transfer(t, p.merchant, 1_000_000),
		p.transfer(t, p.platform, 40_000),
		p.transfer(t, p.referrer, 10_000),
		memoIx("nonce"),
	})
	resp, err := NewExactSvmScheme(p.signer(), &Config{MaxSplits: 8, AtaCreationSponsored: true}).
		Verify(context.Background(), splitPayment(req, encoded), req, nil)
	assert.Equal(t, ErrSplitAtaCreationNotAuthorized, splitVerifyReason(t, resp, err))
}

func TestSplits_Path1RejectsLegsOutOfOrderOrWrongCarveOut(t *testing.T) {
	p := newSplitParties(t)
	req := p.requirements(nil)
	scheme := NewExactSvmScheme(p.signer(), &Config{MaxSplits: 8})

	swapped, _ := p.buildTx(t, []solana.Instruction{
		p.transfer(t, p.merchant, 1_000_000),
		p.transfer(t, p.referrer, 10_000),
		p.transfer(t, p.platform, 40_000),
		memoIx("nonce"),
	})
	resp, err := scheme.Verify(context.Background(), splitPayment(req, swapped), req, nil)
	assert.Equal(t, ErrRecipientMismatch, splitVerifyReason(t, resp, err))

	shortSplit, _ := p.buildTx(t, []solana.Instruction{
		p.transfer(t, p.merchant, 1_010_000),
		p.transfer(t, p.platform, 30_000),
		p.transfer(t, p.referrer, 10_000),
		memoIx("nonce"),
	})
	resp, err = scheme.Verify(context.Background(), splitPayment(req, shortSplit), req, nil)
	assert.Equal(t, ErrAmountMismatch, splitVerifyReason(t, resp, err))

	// Path 1 is exact for the primary too; overpayment needs Path 2.
	overpaid, _ := p.buildTx(t, []solana.Instruction{
		p.transfer(t, p.merchant, 1_000_001),
		p.transfer(t, p.platform, 40_000),
		p.transfer(t, p.referrer, 10_000),
	})
	resp, err = scheme.Verify(context.Background(), splitPayment(req, overpaid), req, nil)
	assert.Equal(t, ErrAmountMismatch, splitVerifyReason(t, resp, err))

	missingLeg, _ := p.buildTx(t, []solana.Instruction{
		p.transfer(t, p.merchant, 1_000_000),
		p.transfer(t, p.platform, 40_000),
	})
	resp, err = scheme.Verify(context.Background(), splitPayment(req, missingLeg), req, nil)
	assert.Equal(t, ErrTransactionInstructionsLength, splitVerifyReason(t, resp, err))
}

func TestSplits_Path1RejectsMixedAuthorities(t *testing.T) {
	p := newSplitParties(t)
	req := p.requirements(nil)
	other := splitParties{payer: solana.NewWallet().PrivateKey, mint: p.mint}
	encoded, _ := p.buildTx(t, []solana.Instruction{
		p.transfer(t, p.merchant, 1_000_000),
		other.transfer(t, p.platform, 40_000),
		p.transfer(t, p.referrer, 10_000),
	}, other.payer)
	// Raise the signature ceiling so the authority check, not the signer count, rejects it.
	maxSignatures := uint8(3)
	resp, err := NewExactSvmScheme(p.signer(), &Config{MaxSplits: 8, MaxRequiredSignatures: &maxSignatures}).
		Verify(context.Background(), splitPayment(req, encoded), req, nil)
	assert.Equal(t, ErrSplitAuthorityMismatch, splitVerifyReason(t, resp, err))
}

func TestSplits_Path1RejectsFeePayerOutsideCreateIdempotent(t *testing.T) {
	p := newSplitParties(t)
	req := p.requirements(nil)
	lighthouse := solana.NewInstruction(
		solana.MustPublicKeyFromBase58(svm.LighthouseProgramAddress),
		solana.AccountMetaSlice{solana.NewAccountMeta(p.feePayer, false, false)},
		[]byte{1},
	)
	encoded, _ := p.buildTx(t, []solana.Instruction{
		p.transfer(t, p.merchant, 1_000_000),
		p.transfer(t, p.platform, 40_000),
		p.transfer(t, p.referrer, 10_000),
		lighthouse,
	})
	resp, err := NewExactSvmScheme(p.signer(), &Config{MaxSplits: 8}).
		Verify(context.Background(), splitPayment(req, encoded), req, nil)
	assert.Contains(t, splitVerifyReason(t, resp, err), ErrSmartWalletFeePayerNotIsolated)
}

func TestSplits_Path1EnforcesSellerMemo(t *testing.T) {
	p := newSplitParties(t)
	req := p.requirements(map[string]interface{}{"memo": "inv-42"})
	scheme := NewExactSvmScheme(p.signer(), &Config{MaxSplits: 8})

	resp, err := scheme.Verify(context.Background(), splitPayment(req, p.clientTransaction(t, req)), req, nil)
	require.NoError(t, err)
	assert.True(t, resp.IsValid)

	wrong, _ := p.buildTx(t, []solana.Instruction{
		p.transfer(t, p.merchant, 1_000_000),
		p.transfer(t, p.platform, 40_000),
		p.transfer(t, p.referrer, 10_000),
		memoIx("inv-43"),
	})
	resp, err = scheme.Verify(context.Background(), splitPayment(req, wrong), req, nil)
	assert.Equal(t, ErrMemoMismatch, splitVerifyReason(t, resp, err))
}

func TestSplits_EightSplitsVerify(t *testing.T) {
	p := newSplitParties(t)
	splits := make([]interface{}, 8)
	for i := range splits {
		splits[i] = map[string]interface{}{"payTo": solana.NewWallet().PublicKey().String(), "amount": "1000"}
	}
	req := p.requirements(map[string]interface{}{"splits": splits})
	resp, err := NewExactSvmScheme(p.signer(), &Config{MaxSplits: 8, AtaCreationSponsored: true}).
		Verify(context.Background(), splitPayment(req, p.clientTransaction(t, req)), req, nil)
	require.NoError(t, err)
	assert.True(t, resp.IsValid)
}

func TestSplits_RejectsCreateUnderDifferentTokenProgram(t *testing.T) {
	p := newSplitParties(t)
	req := p.requirements(map[string]interface{}{"ataCreationRequired": true})
	ata2022, err := svm.DeriveATA(p.merchant, p.mint, solana.Token2022ProgramID)
	require.NoError(t, err)
	create := svm.NewCreateIdempotentInstruction(p.feePayer, ata2022, p.merchant, p.mint, solana.Token2022ProgramID)
	encoded, _ := p.buildTx(t, []solana.Instruction{
		create,
		p.transfer(t, p.merchant, 1_000_000),
		p.transfer(t, p.platform, 40_000),
		p.transfer(t, p.referrer, 10_000),
		memoIx("nonce"),
	})
	resp, err := NewExactSvmScheme(p.signer(), &Config{MaxSplits: 8, AtaCreationSponsored: true}).
		Verify(context.Background(), splitPayment(req, encoded), req, nil)
	assert.Equal(t, ErrSplitAtaCreationNotAuthorized, splitVerifyReason(t, resp, err))
}

func TestSplits_RejectsTransferWithTrailingSignerAccounts(t *testing.T) {
	p := newSplitParties(t)
	req := p.requirements(nil)
	extraSigner := solana.NewWallet().PrivateKey
	base := p.transfer(t, p.platform, 40_000)
	data, err := base.Data()
	require.NoError(t, err)
	withSigner := solana.NewInstruction(base.ProgramID(),
		append(append(solana.AccountMetaSlice{}, base.Accounts()...), solana.NewAccountMeta(extraSigner.PublicKey(), false, true)),
		data)
	encoded, _ := p.buildTx(t, []solana.Instruction{
		p.transfer(t, p.merchant, 1_000_000),
		withSigner,
		p.transfer(t, p.referrer, 10_000),
		memoIx("nonce"),
	}, extraSigner)
	// Raise the signature ceiling so the layout check, not the signer count, rejects it.
	maxSignatures := uint8(3)
	resp, err := NewExactSvmScheme(p.signer(), &Config{MaxSplits: 8, MaxRequiredSignatures: &maxSignatures}).
		Verify(context.Background(), splitPayment(req, encoded), req, nil)
	assert.Equal(t, ErrNoTransferInstruction, splitVerifyReason(t, resp, err))
}

// ─── Path 2 ─────────────────────────────────────────────────────────────────

// wrapper is a smart wallet instruction whose CPI performs the transfers. It
// lists every account the CPI trace references so the trace can index them.
func (p splitParties) wrapper(t *testing.T, owners ...solana.PublicKey) solana.Instruction {
	t.Helper()
	accounts := solana.AccountMetaSlice{
		solana.NewAccountMeta(p.ata(t, p.payer.PublicKey()), true, false),
		solana.NewAccountMeta(p.mint, false, false),
		solana.NewAccountMeta(p.payer.PublicKey(), false, true),
		solana.NewAccountMeta(solana.TokenProgramID, false, false),
	}
	for _, owner := range owners {
		accounts = append(accounts, solana.NewAccountMeta(p.ata(t, owner), true, false))
	}
	return solana.NewInstruction(swigV2, accounts, []byte{0})
}

func (p splitParties) cpiTransfer(t *testing.T, tx *solana.Transaction, owner solana.PublicKey, amount uint64) rpc.CompiledInstruction {
	t.Helper()
	index := func(key solana.PublicKey) uint16 {
		idx, err := tx.GetAccountIndex(key)
		require.NoError(t, err)
		return idx
	}
	data := make([]byte, 10)
	data[0] = ixTokenTransferChecked
	binary.LittleEndian.PutUint64(data[1:9], amount)
	data[9] = 6
	return rpc.CompiledInstruction{
		ProgramIDIndex: index(solana.TokenProgramID),
		Accounts:       []uint16{index(p.ata(t, p.payer.PublicKey())), index(p.mint), index(p.ata(t, owner)), index(p.payer.PublicKey())},
		Data:           solana.Base58(data),
	}
}

func trace(index uint16, ixs ...rpc.CompiledInstruction) []rpc.InnerInstruction {
	return []rpc.InnerInstruction{{Index: index, Instructions: ixs}}
}

var path2Config = Config{MaxSplits: 8, EnableSmartWalletVerification: true}

func TestSplits_Path2VerifiesEveryLegInAnyOrder(t *testing.T) {
	p := newSplitParties(t)
	req := p.requirements(nil)
	encoded, tx := p.buildTx(t, []solana.Instruction{p.wrapper(t, p.merchant, p.platform, p.referrer), memoIx("nonce")})
	signer := p.signer()
	signer.inner = trace(2,
		p.cpiTransfer(t, tx, p.referrer, 10_000),
		p.cpiTransfer(t, tx, p.merchant, 1_000_000),
		p.cpiTransfer(t, tx, p.platform, 40_000),
	)
	cfg := path2Config
	resp, err := NewExactSvmScheme(signer, &cfg).Verify(context.Background(), splitPayment(req, encoded), req, nil)
	require.NoError(t, err)
	assert.True(t, resp.IsValid)
	assert.Equal(t, p.payer.PublicKey().String(), resp.Payer)
}

func TestSplits_Path2RejectsUnexpectedTransferUnpaidLegAndDoublePayment(t *testing.T) {
	p := newSplitParties(t)
	req := p.requirements(nil)
	stranger := solana.NewWallet().PublicKey()
	encoded, tx := p.buildTx(t, []solana.Instruction{p.wrapper(t, p.merchant, p.platform, p.referrer, stranger), memoIx("nonce")})
	legs := []rpc.CompiledInstruction{
		p.cpiTransfer(t, tx, p.merchant, 1_000_000),
		p.cpiTransfer(t, tx, p.platform, 40_000),
		p.cpiTransfer(t, tx, p.referrer, 10_000),
	}
	verifyWith := func(inner ...rpc.CompiledInstruction) (*x402.VerifyResponse, error) {
		signer := p.signer()
		signer.inner = trace(2, inner...)
		cfg := path2Config
		return NewExactSvmScheme(signer, &cfg).Verify(context.Background(), splitPayment(req, encoded), req, nil)
	}

	resp, err := verifyWith(append(append([]rpc.CompiledInstruction{}, legs...), p.cpiTransfer(t, tx, stranger, 1))...)
	assert.Equal(t, ErrSplitUnexpectedTransfer, splitVerifyReason(t, resp, err))

	resp, err = verifyWith(legs[:2]...)
	assert.Equal(t, ErrSplitLegUnmatched, splitVerifyReason(t, resp, err))

	resp, err = verifyWith(append(append([]rpc.CompiledInstruction{}, legs...), legs[1])...)
	assert.Equal(t, ErrSmartWalletMultipleMatchingTransfers, splitVerifyReason(t, resp, err))

	// A split overpaid by one base unit pays no leg.
	resp, err = verifyWith(legs[0], p.cpiTransfer(t, tx, p.platform, 40_001), legs[2])
	assert.Equal(t, ErrSplitUnexpectedTransfer, splitVerifyReason(t, resp, err))

	// The primary may be overpaid off the static path.
	resp, err = verifyWith(p.cpiTransfer(t, tx, p.merchant, 1_000_001), legs[1], legs[2])
	require.NoError(t, err)
	assert.True(t, resp.IsValid)
}

func TestSplits_Path2AcceptsSponsoredCreateNextToWalletInstruction(t *testing.T) {
	p := newSplitParties(t)
	req := p.requirements(map[string]interface{}{"ataCreationRequired": true})
	create := svm.NewCreateIdempotentInstruction(p.feePayer, p.ata(t, p.merchant), p.merchant, p.mint, solana.TokenProgramID)
	encoded, tx := p.buildTx(t, []solana.Instruction{create, p.wrapper(t, p.merchant, p.platform, p.referrer), memoIx("nonce")})
	signer := p.signer()
	signer.inner = trace(3,
		p.cpiTransfer(t, tx, p.merchant, 1_000_000),
		p.cpiTransfer(t, tx, p.platform, 40_000),
		p.cpiTransfer(t, tx, p.referrer, 10_000),
	)
	cfg := path2Config
	cfg.AtaCreationSponsored = true
	scheme := NewExactSvmScheme(signer, &cfg)

	resp, err := scheme.Verify(context.Background(), splitPayment(req, encoded), req, nil)
	require.NoError(t, err)
	assert.True(t, resp.IsValid)

	// Same creation, but the requirements do not mark the merchant.
	unmarked := p.requirements(nil)
	resp, err = scheme.Verify(context.Background(), splitPayment(unmarked, encoded), unmarked, nil)
	assert.Equal(t, ErrSplitAtaCreationNotAuthorized, splitVerifyReason(t, resp, err))
}

func TestSplits_Path2RejectsFeePayerInsideWalletInstruction(t *testing.T) {
	p := newSplitParties(t)
	req := p.requirements(nil)
	wrapper := p.wrapper(t, p.merchant, p.platform, p.referrer)
	data, err := wrapper.Data()
	require.NoError(t, err)
	leaky := solana.NewInstruction(swigV2, append(wrapper.Accounts(), solana.NewAccountMeta(p.feePayer, false, false)), data)
	encoded, _ := p.buildTx(t, []solana.Instruction{leaky, memoIx("nonce")})
	cfg := path2Config
	resp, err := NewExactSvmScheme(p.signer(), &cfg).Verify(context.Background(), splitPayment(req, encoded), req, nil)
	assert.Contains(t, splitVerifyReason(t, resp, err), ErrSmartWalletFeePayerNotIsolated)
}

func TestSplits_Path2SettlesOnlyWhenEveryCPILegIsConfirmed(t *testing.T) {
	p := newSplitParties(t)
	req := p.requirements(nil)
	encoded, tx := p.buildTx(t, []solana.Instruction{p.wrapper(t, p.merchant, p.platform, p.referrer), memoIx("nonce")})
	legs := []rpc.CompiledInstruction{
		p.cpiTransfer(t, tx, p.merchant, 1_000_000),
		p.cpiTransfer(t, tx, p.platform, 40_000),
		p.cpiTransfer(t, tx, p.referrer, 10_000),
	}
	settleWith := func(confirmed ...rpc.CompiledInstruction) (*x402.SettleResponse, error) {
		signer := p.signer()
		signer.inner = trace(2, legs...)
		signer.confirmedInner = trace(2, confirmed...)
		signer.confirmedKeys = tx.Message.AccountKeys
		cfg := path2Config
		return NewExactSvmScheme(signer, &cfg).Settle(context.Background(), splitPayment(req, encoded), req, nil)
	}

	settled, err := settleWith(legs...)
	require.NoError(t, err)
	assert.True(t, settled.Success)

	// Simulation showed every leg; the confirmed execution skipped a split.
	_, err = settleWith(legs[:2]...)
	var se *x402.SettleError
	require.True(t, errors.As(err, &se))
	assert.Equal(t, ErrPostSettlementTransferNotConfirmed, se.ErrorReason)
}

func TestSplits_Path2BalanceDeltaFallbackChecksEveryLeg(t *testing.T) {
	p := newSplitParties(t)
	req := p.requirements(nil)
	encoded, tx := p.buildTx(t, []solana.Instruction{p.wrapper(t, p.merchant, p.platform, p.referrer), memoIx("nonce")})
	signer := p.signer()
	signer.inner = trace(2,
		p.cpiTransfer(t, tx, p.merchant, 1_000_000),
		p.cpiTransfer(t, tx, p.platform, 40_000),
		p.cpiTransfer(t, tx, p.referrer, 10_000),
	)
	// The confirmed trace is unavailable, and the token balances never move:
	// the pre- and post-broadcast reads match, so no leg shows its delta.
	signer.tokenBalances = map[string]uint64{
		p.ata(t, p.merchant).String(): 5, p.ata(t, p.platform).String(): 5, p.ata(t, p.referrer).String(): 5,
	}
	cfg := path2Config
	_, err := NewExactSvmScheme(signer, &cfg).Settle(context.Background(), splitPayment(req, encoded), req, nil)
	var se *x402.SettleError
	require.True(t, errors.As(err, &se))
	assert.Equal(t, ErrPostSettlementTransferNotConfirmed, se.ErrorReason)
}

func TestSplits_Path2KeepsAtaProgramOffAllowlistForSinglePayee(t *testing.T) {
	p := newSplitParties(t)
	req := p.requirements(map[string]interface{}{"splits": []interface{}{}})
	create := svm.NewCreateIdempotentInstruction(p.payer.PublicKey(), p.ata(t, p.merchant), p.merchant, p.mint, solana.TokenProgramID)
	encoded, tx := p.buildTx(t, []solana.Instruction{create, p.wrapper(t, p.merchant), memoIx("nonce")})
	signer := p.signer()
	signer.inner = trace(3, p.cpiTransfer(t, tx, p.merchant, 1_050_000))
	cfg := path2Config
	resp, err := NewExactSvmScheme(signer, &cfg).Verify(context.Background(), splitPayment(req, encoded), req, nil)
	assert.Contains(t, splitVerifyReason(t, resp, err), ErrSmartWalletProgramNotAllowed)
}

func TestSplits_PendingReconciliationConfirmsEveryLeg(t *testing.T) {
	p := newSplitParties(t)
	req := p.requirements(nil)
	encoded, tx := p.buildTx(t, []solana.Instruction{p.wrapper(t, p.merchant, p.platform, p.referrer), memoIx("nonce")})
	legs := []rpc.CompiledInstruction{
		p.cpiTransfer(t, tx, p.merchant, 1_000_000),
		p.cpiTransfer(t, tx, p.platform, 40_000),
		p.cpiTransfer(t, tx, p.referrer, 10_000),
	}
	payload := splitPayment(req, encoded)
	txKey := messageHashForPayload(t, payload)
	priorSig := solana.SignatureFromBytes(append([]byte{6}, make([]byte, 63)...))
	reconcile := func(confirmed ...rpc.CompiledInstruction) (*x402.SettleResponse, *mockSmartWalletSigner, error) {
		signer := p.signer()
		signer.confirmedInner = trace(2, confirmed...)
		signer.confirmedKeys = tx.Message.AccountKeys
		cfg := path2Config
		scheme := NewExactSvmScheme(signer, &cfg)
		require.NoError(t, scheme.pendingStore.Set(context.Background(), txKey, priorSig.String()))
		resp, err := scheme.Settle(context.Background(), payload, req, nil)
		return resp, signer, err
	}

	resp, signer, err := reconcile(legs...)
	require.NoError(t, err)
	assert.True(t, resp.Success)
	assert.Equal(t, 0, signer.sendCalls)

	_, _, err = reconcile(legs[0], legs[2])
	var se *x402.SettleError
	require.True(t, errors.As(err, &se))
	assert.Equal(t, ErrPostSettlementTransferNotConfirmed, se.ErrorReason)
}

func TestSplits_PendingReconciliationTrustsTopLevelLegs(t *testing.T) {
	// A Path 1 split charge with a creation does not have the single-payee
	// static layout, so reconciliation treats it as Path 2; its legs are all
	// top-level transfers and need no confirmed trace.
	p := newSplitParties(t)
	req := p.requirements(map[string]interface{}{"ataCreationRequired": true})
	payload := splitPayment(req, p.clientTransaction(t, req))
	txKey := messageHashForPayload(t, payload)
	signer := p.signer()
	cfg := path2Config
	cfg.AtaCreationSponsored = true
	scheme := NewExactSvmScheme(signer, &cfg)
	require.NoError(t, scheme.pendingStore.Set(context.Background(), txKey, solana.SignatureFromBytes(append([]byte{7}, make([]byte, 63)...)).String()))
	resp, err := scheme.Settle(context.Background(), payload, req, nil)
	require.NoError(t, err)
	assert.True(t, resp.Success)
}

// ─── matching and post-settlement units ─────────────────────────────────────

func (p splitParties) legDestinations(t *testing.T, extra map[string]interface{}) []legDestination {
	t.Helper()
	legs, err := svm.ParsePaymentLegs(p.requirements(extra))
	require.NoError(t, err)
	destinations, err := deriveLegDestinations(legs, p.mint)
	require.NoError(t, err)
	return destinations
}

func (p splitParties) observed(t *testing.T, owner solana.PublicKey, amount uint64) transferCheckedInfo {
	t.Helper()
	return transferCheckedInfo{
		programID:   solana.TokenProgramID,
		amount:      amount,
		mint:        p.mint,
		destination: p.ata(t, owner),
		authority:   p.payer.PublicKey(),
	}
}

func requireSplitReason(t *testing.T, err error, reason string) {
	t.Helper()
	var se *svm.SplitsError
	require.True(t, errors.As(err, &se), "expected SplitsError, got %v", err)
	assert.Equal(t, reason, se.Reason)
}

func TestMatchTransfersToLegs(t *testing.T) {
	p := newSplitParties(t)
	legs := p.legDestinations(t, nil)

	t.Run("primary may overpay, splits are exact", func(t *testing.T) {
		matched, err := matchTransfersToLegs([]transferCheckedInfo{
			p.observed(t, p.merchant, 1_000_001), p.observed(t, p.platform, 40_000), p.observed(t, p.referrer, 10_000),
		}, legs, p.mint)
		require.NoError(t, err)
		assert.Equal(t, []uint64{1_000_001, 40_000, 10_000}, []uint64{matched[0].amount, matched[1].amount, matched[2].amount})

		_, err = matchTransfersToLegs([]transferCheckedInfo{
			p.observed(t, p.merchant, 1_000_000), p.observed(t, p.platform, 40_001), p.observed(t, p.referrer, 10_000),
		}, legs, p.mint)
		requireSplitReason(t, err, ErrSplitUnexpectedTransfer)
	})

	t.Run("asset transfer to an undeclared recipient", func(t *testing.T) {
		_, err := matchTransfersToLegs([]transferCheckedInfo{
			p.observed(t, p.merchant, 1_000_000), p.observed(t, p.platform, 40_000), p.observed(t, p.referrer, 10_000),
			p.observed(t, solana.NewWallet().PublicKey(), 1),
		}, legs, p.mint)
		requireSplitReason(t, err, ErrSplitUnexpectedTransfer)
	})

	t.Run("other mints are ignored", func(t *testing.T) {
		otherMint := p.observed(t, solana.NewWallet().PublicKey(), 1)
		otherMint.mint = solana.NewWallet().PublicKey()
		_, err := matchTransfersToLegs([]transferCheckedInfo{
			p.observed(t, p.merchant, 1_000_000), otherMint, p.observed(t, p.platform, 40_000), p.observed(t, p.referrer, 10_000),
		}, legs, p.mint)
		require.NoError(t, err)
	})

	t.Run("missing leg and leg paid twice", func(t *testing.T) {
		_, err := matchTransfersToLegs([]transferCheckedInfo{
			p.observed(t, p.merchant, 1_000_000), p.observed(t, p.platform, 40_000),
		}, legs, p.mint)
		requireSplitReason(t, err, ErrSplitLegUnmatched)

		_, err = matchTransfersToLegs([]transferCheckedInfo{
			p.observed(t, p.merchant, 1_000_000), p.observed(t, p.platform, 40_000),
			p.observed(t, p.platform, 40_000), p.observed(t, p.referrer, 10_000),
		}, legs, p.mint)
		require.Error(t, err)
		assert.Equal(t, ErrSmartWalletMultipleMatchingTransfers, err.Error())
	})
}

func TestVerifyPostSettlementLegs(t *testing.T) {
	sig := solana.SignatureFromBytes(append([]byte{1}, make([]byte, 63)...))
	ctx := context.Background()

	t.Run("top-level legs need no CPI trace", func(t *testing.T) {
		p := newSplitParties(t)
		legs := p.legDestinations(t, nil)
		topLevel := make([]transferCheckedInfo, len(legs))
		for i, leg := range legs {
			topLevel[i] = p.observed(t, leg.Owner, leg.Amount)
		}
		signer := p.signer()
		signer.confirmedErr = errors.New("must not be called")
		verified, method := verifyPostSettlementLegs(ctx, signer, sig, svm.SolanaDevnetCAIP2, legs, p.mint,
			[]string{p.feePayer.String()}, topLevel, nil)
		assert.True(t, verified)
		assert.Equal(t, postSettlementTopLevel, method)
	})

	t.Run("a fee-payer-authorized transfer does not count", func(t *testing.T) {
		p := newSplitParties(t)
		legs := p.legDestinations(t, nil)
		topLevel := make([]transferCheckedInfo, len(legs))
		for i, leg := range legs {
			topLevel[i] = p.observed(t, leg.Owner, leg.Amount)
			topLevel[i].authority = p.feePayer
		}
		signer := p.signer()
		signer.confirmedInner = []rpc.InnerInstruction{}
		verified, method := verifyPostSettlementLegs(ctx, signer, sig, svm.SolanaDevnetCAIP2, legs, p.mint,
			[]string{p.feePayer.String()}, topLevel, nil)
		assert.False(t, verified)
		assert.Equal(t, postSettlementInnerInstructions, method)
	})

	t.Run("a CPI leg missing from the confirmed trace fails", func(t *testing.T) {
		p := newSplitParties(t)
		legs := p.legDestinations(t, nil)
		signer := p.signer()
		signer.confirmedInner = []rpc.InnerInstruction{}
		verified, method := verifyPostSettlementLegs(ctx, signer, sig, svm.SolanaDevnetCAIP2, legs, p.mint,
			[]string{p.feePayer.String()}, nil, nil)
		assert.False(t, verified)
		assert.Equal(t, postSettlementInnerInstructions, method)
	})

	t.Run("per-leg balance deltas, a created ATA starting from zero", func(t *testing.T) {
		p := newSplitParties(t)
		legs := p.legDestinations(t, map[string]interface{}{
			"splits": []interface{}{map[string]interface{}{"payTo": p.platform.String(), "amount": "50000", "ataCreationRequired": true}},
		})
		merchantATA, platformATA := p.ata(t, p.merchant), p.ata(t, p.platform)
		signer := p.signer() // confirmedInner nil: the trace is unavailable
		signer.tokenBalances = map[string]uint64{
			merchantATA.String(): 5_000_000 + 1_000_000,
			platformATA.String(): 50_000,
		}
		before := uint64(5_000_000)
		balances := []legBalance{{ata: merchantATA, before: &before}, {ata: platformATA}}
		verified, method := verifyPostSettlementLegs(ctx, signer, sig, svm.SolanaDevnetCAIP2, legs, p.mint,
			[]string{p.feePayer.String()}, nil, balances)
		assert.True(t, verified)
		assert.Equal(t, postSettlementBalanceDelta, method)

		signer.tokenBalances[platformATA.String()] = 49_999
		verified, method = verifyPostSettlementLegs(ctx, signer, sig, svm.SolanaDevnetCAIP2, legs, p.mint,
			[]string{p.feePayer.String()}, nil, balances)
		assert.False(t, verified)
		assert.Equal(t, postSettlementBalanceDelta, method)
	})

	t.Run("a missing pre-balance on an unmarked leg is unverified", func(t *testing.T) {
		p := newSplitParties(t)
		legs := p.legDestinations(t, map[string]interface{}{
			"splits": []interface{}{map[string]interface{}{"payTo": p.platform.String(), "amount": "50000"}},
		})
		merchantATA, platformATA := p.ata(t, p.merchant), p.ata(t, p.platform)
		signer := p.signer()
		signer.tokenBalances = map[string]uint64{merchantATA.String(): 1_000_000, platformATA.String(): 50_000}
		zero := uint64(0)
		verified, method := verifyPostSettlementLegs(ctx, signer, sig, svm.SolanaDevnetCAIP2, legs, p.mint,
			[]string{p.feePayer.String()}, nil, []legBalance{{ata: merchantATA, before: &zero}, {ata: platformATA}})
		assert.False(t, verified)
		assert.Equal(t, postSettlementUnverified, method)
	})
}
