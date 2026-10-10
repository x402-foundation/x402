package client_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	sdkproto "github.com/hiero-ledger/hiero-sdk-go/v2/proto/sdk"
	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/hedera"
	"github.com/x402-foundation/x402/go/v2/mechanisms/hedera/exact/client"
	"github.com/x402-foundation/x402/go/v2/types"
	"google.golang.org/protobuf/proto"
)

type fakeClientSigner struct {
	accountID string
	txB64     string
	err       error
}

func (f *fakeClientSigner) AccountID() string { return f.accountID }
func (f *fakeClientSigner) CreatePartiallySignedTransferTransaction(
	_ context.Context, _ types.PaymentRequirements,
) (string, error) {
	return f.txB64, f.err
}

func TestClientCreatePaymentPayload(t *testing.T) {
	tx := base64.StdEncoding.EncodeToString([]byte("fake-tx"))
	scheme := client.NewExactHederaScheme(&fakeClientSigner{
		accountID: "0.0.9001",
		txB64:     tx,
	})
	req := types.PaymentRequirements{
		Scheme:            hedera.SchemeExact,
		Network:           hedera.HederaTestnetCAIP2,
		Asset:             hedera.HBARAssetID,
		Amount:            "50",
		PayTo:             "0.0.7001",
		MaxTimeoutSeconds: 180,
		Extra:             map[string]interface{}{"feePayer": "0.0.5001"},
	}
	payload, err := scheme.CreatePaymentPayload(context.Background(), req, x402.PaymentPayloadContext{})
	if err != nil {
		t.Fatal(err)
	}
	if payload.X402Version != 2 {
		t.Fatalf("version=%d", payload.X402Version)
	}
	got, _ := payload.Payload["transaction"].(string)
	if got != tx {
		t.Fatalf("transaction=%q", got)
	}
	if payload.Accepted.Extra["feePayer"] != "0.0.5001" {
		t.Fatalf("accepted=%+v", payload.Accepted)
	}
}

func TestClientRequiresFeePayer(t *testing.T) {
	scheme := client.NewExactHederaScheme(&fakeClientSigner{accountID: "0.0.9001"})
	_, err := scheme.CreatePaymentPayload(context.Background(), types.PaymentRequirements{
		Scheme:  hedera.SchemeExact,
		Network: hedera.HederaTestnetCAIP2,
	}, x402.PaymentPayloadContext{})
	if err == nil || !strings.Contains(err.Error(), client.ErrMissingFeePayer) {
		t.Fatalf("err=%v, want %s", err, client.ErrMissingFeePayer)
	}
}

func TestClientAssetTransferMethods(t *testing.T) {
	tx := base64.StdEncoding.EncodeToString([]byte("fake-tx"))
	tests := []struct {
		name    string
		method  interface{}
		wantErr bool
	}{
		{name: "cryptoTransfer", method: hedera.AssetTransferMethodCryptoTransfer},
		{name: "transferExecutor", method: hedera.AssetTransferMethodTransferExecutor, wantErr: true},
		{name: "unknown", method: "eip3009", wantErr: true},
		{name: "non-string", method: 1, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			scheme := client.NewExactHederaScheme(&fakeClientSigner{accountID: "0.0.9001", txB64: tx})
			_, err := scheme.CreatePaymentPayload(context.Background(), types.PaymentRequirements{
				Scheme:  hedera.SchemeExact,
				Network: hedera.HederaTestnetCAIP2,
				Extra:   map[string]interface{}{"feePayer": "0.0.5001", "assetTransferMethod": tt.method},
			}, x402.PaymentPayloadContext{})
			if tt.wantErr {
				if err == nil || !strings.Contains(err.Error(), client.ErrUnsupportedAssetTransferMethod) {
					t.Fatalf("err=%v, want %s", err, client.ErrUnsupportedAssetTransferMethod)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestClientFindDefaultAsset(t *testing.T) {
	scheme := client.NewExactHederaScheme(&fakeClientSigner{})
	got := scheme.FindDefaultAsset(hedera.HederaTestnetUSDC, x402.Network(hedera.HederaTestnetCAIP2))
	want := hedera.DefaultAssets[hedera.HederaTestnetCAIP2][0]
	if got == nil || got.Asset != want.Asset || got.Decimals != want.Decimals || got.Symbol != want.Symbol {
		t.Fatalf("FindDefaultAsset=%+v, want %+v", got, want)
	}
	if got := scheme.FindDefaultAsset(hedera.HederaTestnetUSDC, x402.Network(hedera.HederaMainnetCAIP2)); got != nil {
		t.Fatalf("testnet token resolved on mainnet: %+v", got)
	}
	if got := scheme.FindDefaultAsset(hedera.HBARAssetID, x402.Network(hedera.HederaTestnetCAIP2)); got != nil {
		t.Fatalf("HBAR resolved as default asset: %+v", got)
	}
}

func TestClientBuildRealPartialTransfer(t *testing.T) {
	// Deterministic ED25519 DER key (SDK test vector style).
	const ed25519DER = "302e020100300506032b657004220420a869f4c6191b9c8c99933e7f6b6611711737e4b1a1a5a4cb5370e719a1f6df98"
	signer, err := hedera.NewPrivateKeyClientSigner("0.0.9001", ed25519DER, hedera.HederaTestnetCAIP2)
	if err != nil {
		t.Fatal(err)
	}
	scheme := client.NewExactHederaScheme(signer)
	req := types.PaymentRequirements{
		Scheme:            hedera.SchemeExact,
		Network:           hedera.HederaTestnetCAIP2,
		Asset:             hedera.HBARAssetID,
		Amount:            "50",
		PayTo:             "0.0.7001",
		MaxTimeoutSeconds: 180,
		Extra:             map[string]interface{}{"feePayer": "0.0.5001"},
	}
	payload, err := scheme.CreatePaymentPayload(context.Background(), req, x402.PaymentPayloadContext{})
	if err != nil {
		t.Fatal(err)
	}
	txB64, _ := payload.Payload["transaction"].(string)
	inspected, err := hedera.InspectTransaction(txB64)
	if err != nil {
		t.Fatal(err)
	}
	if inspected.TransactionType != "TransferTransaction" {
		t.Fatalf("type=%s", inspected.TransactionType)
	}
	if inspected.TransactionIDAccount != "0.0.5001" {
		t.Fatalf("fee payer account=%s", inspected.TransactionIDAccount)
	}
}

func TestClientBuildRealPartialTokenTransfer(t *testing.T) {
	const ed25519DER = "302e020100300506032b657004220420a869f4c6191b9c8c99933e7f6b6611711737e4b1a1a5a4cb5370e719a1f6df98"
	signer, err := hedera.NewPrivateKeyClientSigner("0.0.9001", ed25519DER, hedera.HederaTestnetCAIP2)
	if err != nil {
		t.Fatal(err)
	}
	req := types.PaymentRequirements{
		Scheme:            hedera.SchemeExact,
		Network:           hedera.HederaTestnetCAIP2,
		Asset:             hedera.HederaTestnetUSDC,
		Amount:            "50",
		PayTo:             "0.0.7001",
		MaxTimeoutSeconds: 180,
		Extra:             map[string]interface{}{"feePayer": "0.0.5001"},
	}
	payload, err := client.NewExactHederaScheme(signer).CreatePaymentPayload(context.Background(), req, x402.PaymentPayloadContext{})
	if err != nil {
		t.Fatal(err)
	}
	txB64, _ := payload.Payload["transaction"].(string)
	inspected, err := hedera.InspectTransaction(txB64)
	if err != nil {
		t.Fatal(err)
	}
	transfers, err := hedera.AssetTransfers(inspected, req.Asset)
	if err != nil {
		t.Fatal(err)
	}
	if len(transfers) != 2 || hedera.SumTransfers(transfers).Sign() != 0 {
		t.Fatalf("transfers=%+v", transfers)
	}
	if !hedera.HasNegativeTransfer(transfers, "0.0.9001") {
		t.Fatalf("payer debit missing: %+v", transfers)
	}
}

func TestClientLimitsNodeVariantsAndPaymentHeaderSize(t *testing.T) {
	// Deterministic ED25519 DER key (SDK test vector style).
	const ed25519DER = "302e020100300506032b657004220420a869f4c6191b9c8c99933e7f6b6611711737e4b1a1a5a4cb5370e719a1f6df98"
	signer, err := hedera.NewPrivateKeyClientSigner("0.0.9001", ed25519DER, hedera.HederaMainnetCAIP2)
	if err != nil {
		t.Fatal(err)
	}
	scheme := client.NewExactHederaScheme(signer)
	req := types.PaymentRequirements{
		Scheme:            hedera.SchemeExact,
		Network:           hedera.HederaMainnetCAIP2,
		Asset:             hedera.HederaMainnetUSDC,
		Amount:            "100000",
		PayTo:             "0.0.10787907",
		MaxTimeoutSeconds: 300,
		Extra:             map[string]interface{}{"feePayer": "0.0.10789914"},
	}
	xClient := x402.Newx402Client()
	xClient.Register(x402.Network(hedera.HederaMainnetCAIP2), scheme)
	payload, err := xClient.CreatePaymentPayload(
		context.Background(),
		req,
		&types.ResourceInfo{
			URL:         "https://example.com/premium",
			Description: "Premium resource",
			MimeType:    "application/json",
		},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}

	txB64, _ := payload.Payload["transaction"].(string)
	raw, err := base64.StdEncoding.DecodeString(txB64)
	if err != nil {
		t.Fatal(err)
	}
	var txList sdkproto.TransactionList
	if err := proto.Unmarshal(raw, &txList); err != nil {
		t.Fatal(err)
	}
	if got := len(txList.GetTransactionList()); got != 3 {
		t.Fatalf("node transaction variants=%d, want 3", got)
	}

	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	header := base64.StdEncoding.EncodeToString(payloadJSON)
	if len(header) >= 4096 {
		t.Fatalf("PAYMENT-SIGNATURE length=%d, want less than 4096", len(header))
	}
}
