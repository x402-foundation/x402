package hedera

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	sdkproto "github.com/hiero-ledger/hiero-sdk-go/v2/proto/sdk"
	"github.com/hiero-ledger/hiero-sdk-go/v2/proto/services"
	hiero "github.com/hiero-ledger/hiero-sdk-go/v2/sdk"
	"google.golang.org/grpc"
	"google.golang.org/protobuf/proto"
)

type testCryptoService struct {
	services.UnimplementedCryptoServiceServer
	code services.ResponseCodeEnum
}

func (s testCryptoService) CryptoTransfer(context.Context, *services.Transaction) (*services.TransactionResponse, error) {
	return &services.TransactionResponse{NodeTransactionPrecheckCode: s.code}, nil
}

func TestAddOperatorSignaturesPreservesBodyBytes(t *testing.T) {
	client := hiero.ClientForTestnet()
	defer client.Close()

	payer, _ := hiero.AccountIDFromString("0.0.9001")
	payTo, _ := hiero.AccountIDFromString("0.0.7001")
	feePayer, _ := hiero.AccountIDFromString("0.0.5001")

	tx := hiero.NewTransferTransaction().
		AddHbarTransfer(payer, hiero.HbarFromTinybar(-50)).
		AddHbarTransfer(payTo, hiero.HbarFromTinybar(50)).
		SetTransactionID(hiero.TransactionIDGenerate(feePayer))
	frozen, err := tx.FreezeWith(client)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := frozen.ToBytes()
	if err != nil {
		t.Fatal(err)
	}

	beforeBodies := collectBodyBytes(t, raw)

	opKey, err := hiero.PrivateKeyGenerateEd25519()
	if err != nil {
		t.Fatal(err)
	}
	signed, _, err := addOperatorSignatures(raw, opKey)
	if err != nil {
		t.Fatal(err)
	}
	if len(signed) == 0 {
		t.Fatal("expected signed transactions")
	}
	nodeID, err := nodeAccountIDFromSigned(signed[0])
	if err != nil || nodeID.String() == "" {
		t.Fatalf("node id=%s err=%v", nodeID.String(), err)
	}

	afterBodies := make([][]byte, 0, len(signed))
	for _, wire := range signed {
		st := &services.SignedTransaction{}
		if err := proto.Unmarshal(wire.GetSignedTransactionBytes(), st); err != nil {
			t.Fatal(err)
		}
		afterBodies = append(afterBodies, append([]byte(nil), st.GetBodyBytes()...))
		if len(st.GetSigMap().GetSigPair()) == 0 {
			t.Fatal("expected operator signature pair")
		}
	}
	if len(beforeBodies) != len(afterBodies) {
		t.Fatalf("body count %d != %d", len(beforeBodies), len(afterBodies))
	}
	for i := range beforeBodies {
		if !bytes.Equal(beforeBodies[i], afterBodies[i]) {
			t.Fatalf("BodyBytes changed at index %d", i)
		}
	}

	_ = base64.StdEncoding.EncodeToString(raw)
}

func TestRejectsMismatchedTransactionVariants(t *testing.T) {
	client := hiero.ClientForTestnet()
	defer client.Close()

	payer, _ := hiero.AccountIDFromString("0.0.9001")
	payTo, _ := hiero.AccountIDFromString("0.0.7001")
	feePayer, _ := hiero.AccountIDFromString("0.0.5001")
	payerKey, err := hiero.PrivateKeyGenerateEd25519()
	if err != nil {
		t.Fatal(err)
	}
	frozen, err := hiero.NewTransferTransaction().
		AddHbarTransfer(payer, hiero.HbarFromTinybar(-50)).
		AddHbarTransfer(payTo, hiero.HbarFromTinybar(50)).
		SetTransactionID(hiero.TransactionIDGenerate(feePayer)).
		FreezeWith(client)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := frozen.Sign(payerKey).ToBytes()
	if err != nil {
		t.Fatal(err)
	}

	list := &sdkproto.TransactionList{}
	if err := proto.Unmarshal(raw, list); err != nil {
		t.Fatal(err)
	}
	if len(list.GetTransactionList()) < 2 {
		t.Fatal("expected multiple node variants")
	}
	wire := list.GetTransactionList()[1]
	signed := &services.SignedTransaction{}
	if err := proto.Unmarshal(wire.GetSignedTransactionBytes(), signed); err != nil {
		t.Fatal(err)
	}
	body := &services.TransactionBody{}
	if err := proto.Unmarshal(signed.GetBodyBytes(), body); err != nil {
		t.Fatal(err)
	}
	amounts := body.GetCryptoTransfer().GetTransfers().GetAccountAmounts()
	if len(amounts) != 2 {
		t.Fatalf("account amounts=%d want 2", len(amounts))
	}
	amounts[0].Amount = -49
	amounts[1].Amount = 49
	signed.BodyBytes, err = proto.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	signed.SigMap = &services.SignatureMap{
		SigPair: []*services.SignaturePair{
			signaturePairFor(payerKey.PublicKey(), payerKey.Sign(signed.GetBodyBytes())),
		},
	}
	wire.SignedTransactionBytes, err = proto.Marshal(signed)
	if err != nil {
		t.Fatal(err)
	}
	raw, err = proto.Marshal(list)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := hiero.TransactionFromBytes(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !payerKey.PublicKey().VerifyTransaction(tx) {
		t.Fatal("expected payer signatures to be valid on every variant")
	}

	opKey, err := hiero.PrivateKeyGenerateEd25519()
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := addOperatorSignatures(raw, opKey); err == nil {
		t.Fatal("expected mismatched variants to be rejected before co-signing")
	}
	if _, err := InspectTransaction(base64.StdEncoding.EncodeToString(raw)); err == nil {
		t.Fatal("expected mismatched variants to be rejected during verification")
	}
}

func TestResolveNodeAddresses(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("account.id") != "0.0.3" {
			http.Error(w, "unexpected node", http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"nodes": []map[string]interface{}{{
				"node_account_id": "0.0.3",
				"service_endpoints": []map[string]interface{}{
					{"domain_name": "node.example", "port": 50211},
					{"domain_name": "ignored.example", "port": 50212},
				},
			}},
		})
	}))
	defer server.Close()
	signer := &PrivateKeyFacilitatorSigner{
		mirrorNodeURL: server.URL,
		http:          &mirrorHTTP{client: server.Client()},
	}
	addresses, err := signer.resolveNodeAddresses(
		context.Background(),
		HederaTestnetCAIP2,
		"0.0.3",
	)
	if err != nil || len(addresses) != 1 || addresses[0] != "node.example:50211" {
		t.Fatalf("addresses=%v err=%v", addresses, err)
	}
}

func TestSignAndSubmitTransactionRejectsInvalidInputs(t *testing.T) {
	key, err := hiero.PrivateKeyGenerateEd25519()
	if err != nil {
		t.Fatal(err)
	}
	operatorID, _ := hiero.AccountIDFromString("0.0.5001")
	signer := &PrivateKeyFacilitatorSigner{
		operators: []operatorKey{{id: operatorID, key: key}},
		http:      newMirrorHTTP(),
	}

	if _, err := signer.SignAndSubmitTransaction(context.Background(), "", "0.0.5001", "hedera:previewnet"); err == nil {
		t.Fatal("expected unsupported network error")
	}
	if _, err := signer.SignAndSubmitTransaction(context.Background(), "", "0.0.9999", HederaTestnetCAIP2); err == nil {
		t.Fatal("expected unmanaged fee payer error")
	}
	if _, err := signer.SignAndSubmitTransaction(context.Background(), "%%%", "0.0.5001", HederaTestnetCAIP2); err == nil {
		t.Fatal("expected transaction decode error")
	}
}

func TestGRPCCryptoTransferPrecheck(t *testing.T) {
	tests := []struct {
		name    string
		code    services.ResponseCodeEnum
		wantErr bool
	}{
		{name: "accepted", code: services.ResponseCodeEnum_OK},
		{name: "rejected", code: services.ResponseCodeEnum_INVALID_SIGNATURE, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			server := grpc.NewServer()
			services.RegisterCryptoServiceServer(server, testCryptoService{code: tt.code})
			go func() {
				_ = server.Serve(listener)
			}()
			t.Cleanup(func() {
				server.Stop()
				_ = listener.Close()
			})

			err = grpcCryptoTransfer(context.Background(), listener.Addr().String(), &services.Transaction{})
			if (err != nil) != tt.wantErr {
				t.Fatalf("err=%v wantErr=%v", err, tt.wantErr)
			}
		})
	}
}

func TestGRPCCryptoTransferTransportErrorIsAmbiguous(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	_ = listener.Close()

	err = grpcCryptoTransfer(context.Background(), address, &services.Transaction{})
	var unknown *submissionOutcomeUnknownError
	if !errors.As(err, &unknown) {
		t.Fatalf("expected ambiguous transport error, got %T %v", err, err)
	}
}

func TestReceiptErrorOutcome(t *testing.T) {
	for _, tt := range []struct {
		name        string
		err         error
		wantUnknown bool
	}{
		{name: "failed_status", err: hiero.ErrHederaReceiptStatus{Status: hiero.StatusInsufficientTokenBalance}},
		{name: "unknown_status", err: hiero.ErrHederaReceiptStatus{Status: hiero.StatusUnknown}, wantUnknown: true},
		{name: "receipt_not_found", err: hiero.ErrHederaPreCheckStatus{Status: hiero.StatusReceiptNotFound}, wantUnknown: true},
		{name: "deadline", err: context.DeadlineExceeded, wantUnknown: true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			got := receiptError("0.0.5001@1700000001.000000000", tt.err)
			if got.OutcomeUnknown != tt.wantUnknown || got.Error() != tt.err.Error() {
				t.Fatalf("receiptError=%+v", got)
			}
		})
	}
}

func TestAwaitTransactionRejectsInvalidInputs(t *testing.T) {
	key, err := hiero.PrivateKeyGenerateEd25519()
	if err != nil {
		t.Fatal(err)
	}
	operatorID, _ := hiero.AccountIDFromString("0.0.5001")
	signer := &PrivateKeyFacilitatorSigner{
		operators: []operatorKey{{id: operatorID, key: key}},
		http:      newMirrorHTTP(),
	}
	ctx := context.Background()
	if err := signer.AwaitTransaction(ctx, "0.0.5001@1700000001.000000000", "hedera:previewnet"); err == nil {
		t.Fatal("expected unsupported network error")
	}
	if err := signer.AwaitTransaction(ctx, "not-a-transaction-id", HederaTestnetCAIP2); err == nil {
		t.Fatal("expected transaction id parse error")
	}
	err = signer.AwaitTransaction(ctx, "0.0.5002@1700000001.000000000", HederaTestnetCAIP2)
	if err == nil || err.Error() != "fee_payer_not_managed_by_facilitator" {
		t.Fatalf("expected unmanaged operator error, got %v", err)
	}
}

type fakeConsensusNode struct {
	services.UnimplementedCryptoServiceServer
	precheck      services.ResponseCodeEnum
	receiptStatus services.ResponseCodeEnum

	mu        sync.Mutex
	submitted []*services.Transaction
}

func (n *fakeConsensusNode) CryptoTransfer(_ context.Context, tx *services.Transaction) (*services.TransactionResponse, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.submitted = append(n.submitted, tx)
	return &services.TransactionResponse{NodeTransactionPrecheckCode: n.precheck}, nil
}

func (n *fakeConsensusNode) GetTransactionReceipts(context.Context, *services.Query) (*services.Response, error) {
	return &services.Response{Response: &services.Response_TransactionGetReceipt{
		TransactionGetReceipt: &services.TransactionGetReceiptResponse{
			Header:  &services.ResponseHeader{NodeTransactionPrecheckCode: services.ResponseCodeEnum_OK},
			Receipt: &services.TransactionReceipt{Status: n.receiptStatus},
		},
	}}, nil
}

func (n *fakeConsensusNode) submissions() []*services.Transaction {
	n.mu.Lock()
	defer n.mu.Unlock()
	return append([]*services.Transaction(nil), n.submitted...)
}

// fakeNodeNetwork serves node as consensus node 0.0.3 on a plaintext local port.
func fakeNodeNetwork(t *testing.T, node *fakeConsensusNode) map[string]hiero.AccountID {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := grpc.NewServer()
	services.RegisterCryptoServiceServer(server, node)
	go func() {
		_ = server.Serve(listener)
	}()
	t.Cleanup(server.Stop)
	return map[string]hiero.AccountID{listener.Addr().String(): {Account: 3}}
}

func fakeNodeSigner(t *testing.T, network map[string]hiero.AccountID) (*PrivateKeyFacilitatorSigner, hiero.PrivateKey) {
	t.Helper()
	key, err := hiero.PrivateKeyGenerateEcdsa()
	if err != nil {
		t.Fatal(err)
	}
	operatorID, _ := hiero.AccountIDFromString("0.0.5001")
	mirror := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(mirror.Close)
	return &PrivateKeyFacilitatorSigner{
		operators:     []operatorKey{{id: operatorID, key: key}},
		mirrorNodeURL: mirror.URL,
		http:          &mirrorHTTP{client: mirror.Client()},
		newClient:     func(string) (*hiero.Client, error) { return hiero.ClientForNetwork(network), nil },
	}, key
}

func payerSignedTransfer(t *testing.T, network map[string]hiero.AccountID) (string, string) {
	t.Helper()
	payerKey, err := hiero.PrivateKeyGenerateEd25519()
	if err != nil {
		t.Fatal(err)
	}
	client := hiero.ClientForNetwork(network)
	defer client.Close()
	txB64 := signHbarTransferWith(t, client, payerKey)
	inspected, err := InspectTransaction(txB64)
	if err != nil {
		t.Fatal(err)
	}
	return txB64, inspected.TransactionID
}

func TestSignAndSubmitTransactionSettles(t *testing.T) {
	node := &fakeConsensusNode{receiptStatus: services.ResponseCodeEnum_SUCCESS}
	network := fakeNodeNetwork(t, node)
	signer, operatorKey := fakeNodeSigner(t, network)
	txB64, wantID := payerSignedTransfer(t, network)

	txID, err := signer.SignAndSubmitTransaction(context.Background(), txB64, "0.0.5001", HederaTestnetCAIP2)
	if err != nil || txID != wantID {
		t.Fatalf("txID=%s want %s err=%v", txID, wantID, err)
	}
	submitted := node.submissions()
	if len(submitted) != 1 {
		t.Fatalf("submissions=%d, want 1", len(submitted))
	}
	signed := &services.SignedTransaction{}
	if err := proto.Unmarshal(submitted[0].GetSignedTransactionBytes(), signed); err != nil {
		t.Fatal(err)
	}
	if !signatureMapHasKey(signed.GetSigMap(), operatorKey.PublicKey().BytesRaw()) || len(signed.GetSigMap().GetSigPair()) != 2 {
		t.Fatalf("expected payer and fee payer signatures, got %d pairs", len(signed.GetSigMap().GetSigPair()))
	}
	if err := signer.AwaitTransaction(context.Background(), txID, HederaTestnetCAIP2); err != nil {
		t.Fatalf("AwaitTransaction: %v", err)
	}
}

func TestSignAndSubmitTransactionOutcomes(t *testing.T) {
	tests := []struct {
		name          string
		precheck      services.ResponseCodeEnum
		receiptStatus services.ResponseCodeEnum
		timeout       time.Duration
		wantSubmitted bool
		wantUnknown   bool
	}{
		{name: "precheck_rejected", precheck: services.ResponseCodeEnum_INVALID_SIGNATURE},
		{name: "receipt_failed", receiptStatus: services.ResponseCodeEnum_INSUFFICIENT_ACCOUNT_BALANCE, wantSubmitted: true},
		{name: "receipt_pending", receiptStatus: services.ResponseCodeEnum_UNKNOWN, timeout: 500 * time.Millisecond, wantSubmitted: true, wantUnknown: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			network := fakeNodeNetwork(t, &fakeConsensusNode{precheck: tt.precheck, receiptStatus: tt.receiptStatus})
			signer, _ := fakeNodeSigner(t, network)
			txB64, wantID := payerSignedTransfer(t, network)
			ctx := context.Background()
			if tt.timeout > 0 {
				var cancel context.CancelFunc
				ctx, cancel = context.WithTimeout(ctx, tt.timeout)
				defer cancel()
			}

			txID, err := signer.SignAndSubmitTransaction(ctx, txB64, "0.0.5001", HederaTestnetCAIP2)
			var submitted *TransactionSubmittedError
			if !tt.wantSubmitted {
				if err == nil || errors.As(err, &submitted) || txID != "" {
					t.Fatalf("expected pre-consensus rejection, got txID=%q err=%v", txID, err)
				}
				return
			}
			if !errors.As(err, &submitted) || txID != wantID || submitted.TransactionID != wantID {
				t.Fatalf("txID=%q err=%v", txID, err)
			}
			if submitted.OutcomeUnknown != tt.wantUnknown {
				t.Fatalf("OutcomeUnknown=%v, want %v", submitted.OutcomeUnknown, tt.wantUnknown)
			}
			err = signer.AwaitTransaction(ctx, txID, HederaTestnetCAIP2)
			if !errors.As(err, &submitted) || submitted.OutcomeUnknown != tt.wantUnknown {
				t.Fatalf("AwaitTransaction err=%v", err)
			}
		})
	}
}

func TestAwaitTransactionPrefersMirrorConsensusResult(t *testing.T) {
	const txID = "0.0.5001@1700000001.000000042"
	tests := []struct {
		name          string
		mirrorStatus  int
		results       []map[string]interface{}
		receiptStatus services.ResponseCodeEnum
		wantErr       bool
		wantUnknown   bool
	}{
		{
			name:          "mirror_success_after_receipt_expired",
			mirrorStatus:  http.StatusOK,
			results:       []map[string]interface{}{{"result": "SUCCESS", "nonce": 0, "scheduled": false}},
			receiptStatus: services.ResponseCodeEnum_RECEIPT_NOT_FOUND,
		},
		{
			name:         "mirror_failure_is_terminal",
			mirrorStatus: http.StatusOK,
			results: []map[string]interface{}{
				{"result": "DUPLICATE_TRANSACTION", "nonce": 0, "scheduled": false},
				{"result": "INSUFFICIENT_ACCOUNT_BALANCE", "nonce": 0, "scheduled": false},
			},
			receiptStatus: services.ResponseCodeEnum_SUCCESS,
			wantErr:       true,
		},
		{
			name:          "mirror_not_indexed_uses_receipt",
			mirrorStatus:  http.StatusNotFound,
			receiptStatus: services.ResponseCodeEnum_SUCCESS,
		},
		{
			name:         "only_duplicate_and_child_records_use_receipt",
			mirrorStatus: http.StatusOK,
			results: []map[string]interface{}{
				{"result": "DUPLICATE_TRANSACTION", "nonce": 0, "scheduled": false},
				{"result": "SUCCESS", "nonce": 1, "scheduled": false},
			},
			receiptStatus: services.ResponseCodeEnum_INSUFFICIENT_ACCOUNT_BALANCE,
			wantErr:       true,
		},
		{
			name:          "mirror_unavailable_uses_receipt",
			mirrorStatus:  http.StatusServiceUnavailable,
			receiptStatus: services.ResponseCodeEnum_SUCCESS,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var requested string
			mirror := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requested = r.URL.Path
				w.WriteHeader(tt.mirrorStatus)
				_ = json.NewEncoder(w).Encode(map[string]interface{}{"transactions": tt.results})
			}))
			defer mirror.Close()
			signer, _ := fakeNodeSigner(t, fakeNodeNetwork(t, &fakeConsensusNode{receiptStatus: tt.receiptStatus}))
			signer.mirrorNodeURL = mirror.URL
			signer.http = &mirrorHTTP{client: mirror.Client()}

			ctx := context.Background()
			if tt.receiptStatus == services.ResponseCodeEnum_RECEIPT_NOT_FOUND {
				// A receipt query would retry indefinitely; only the mirror result can resolve this.
				var cancel context.CancelFunc
				ctx, cancel = context.WithTimeout(ctx, 2*time.Second)
				defer cancel()
			}
			err := signer.AwaitTransaction(ctx, txID, HederaTestnetCAIP2)
			if requested != "/api/v1/transactions/0.0.5001-1700000001-000000042" {
				t.Fatalf("mirror path=%q", requested)
			}
			if !tt.wantErr {
				if err != nil {
					t.Fatalf("AwaitTransaction: %v", err)
				}
				return
			}
			var submitted *TransactionSubmittedError
			if !errors.As(err, &submitted) || submitted.OutcomeUnknown != tt.wantUnknown || submitted.TransactionID != txID {
				t.Fatalf("err=%v", err)
			}
		})
	}
}

func TestSignAndSubmitTransactionUnreachableNodeIsAmbiguous(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	network := map[string]hiero.AccountID{listener.Addr().String(): {Account: 3}}
	_ = listener.Close()
	signer, _ := fakeNodeSigner(t, network)
	txB64, wantID := payerSignedTransfer(t, network)

	txID, err := signer.SignAndSubmitTransaction(context.Background(), txB64, "0.0.5001", HederaTestnetCAIP2)
	var submitted *TransactionSubmittedError
	if !errors.As(err, &submitted) || !submitted.OutcomeUnknown || txID != wantID {
		t.Fatalf("expected ambiguous submission, got txID=%q err=%v", txID, err)
	}
}

func collectBodyBytes(t *testing.T, raw []byte) [][]byte {
	t.Helper()
	list := &sdkproto.TransactionList{}
	if err := proto.Unmarshal(raw, list); err != nil {
		single := &services.Transaction{}
		if err2 := proto.Unmarshal(raw, single); err2 != nil {
			t.Fatalf("decode: %v / %v", err, err2)
		}
		list.TransactionList = []*services.Transaction{single}
	}
	out := make([][]byte, 0, len(list.GetTransactionList()))
	for _, wire := range list.GetTransactionList() {
		st := &services.SignedTransaction{}
		if err := proto.Unmarshal(wire.GetSignedTransactionBytes(), st); err != nil {
			t.Fatal(err)
		}
		out = append(out, append([]byte(nil), st.GetBodyBytes()...))
	}
	return out
}
