package server_test

import (
	"context"
	"errors"
	"testing"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/hedera"
	"github.com/x402-foundation/x402/go/v2/mechanisms/hedera/exact/server"
	"github.com/x402-foundation/x402/go/v2/types"
)

func TestParsePriceAssetAmount(t *testing.T) {
	s := server.NewExactHederaScheme()
	got, err := s.ParsePrice(map[string]interface{}{
		"amount": "1000",
		"asset":  hedera.HederaTestnetUSDC,
	}, x402.Network(hedera.HederaTestnetCAIP2))
	if err != nil {
		t.Fatal(err)
	}
	if got.Amount != "1000" || got.Asset != hedera.HederaTestnetUSDC {
		t.Fatalf("got=%+v", got)
	}
}

func TestPaymentFlowsResolveWithoutWireAssetTransferMethod(t *testing.T) {
	s := server.NewExactHederaScheme()
	if s.Scheme() != hedera.SchemeExact {
		t.Fatalf("scheme=%s", s.Scheme())
	}
	for _, flow := range []x402.PaymentFlowName{"", x402.PaymentFlowUpfront} {
		extra := map[string]interface{}{"feePayer": "0.0.5555"}
		if flow != "" {
			extra["paymentFlow"] = string(flow)
		}
		atm, resolved, err := x402.ResolvePaymentFlow(s, types.PaymentRequirements{Extra: extra})
		if err != nil {
			t.Fatal(err)
		}
		want := flow
		if want == "" {
			want = x402.PaymentFlowAuthorization
		}
		if resolved != want {
			t.Fatalf("flow=%s want %s", resolved, want)
		}
		wire := x402.ApplyPaymentFlowWireExtra(extra, atm, resolved)
		if _, present := wire["assetTransferMethod"]; present {
			t.Fatalf("default cryptoTransfer must not be emitted: %+v", wire)
		}
	}
	if _, _, err := x402.ResolvePaymentFlow(s, types.PaymentRequirements{
		Extra: map[string]interface{}{"paymentFlow": string(x402.PaymentFlowEscrow)},
	}); err == nil {
		t.Fatal("expected escrow flow to be unsupported")
	}
}

func TestParsePriceMoneyDefaultUSDC(t *testing.T) {
	s := server.NewExactHederaScheme()
	for _, price := range []x402.Price{float64(0.10), "$0.10"} {
		got, err := s.ParsePrice(price, x402.Network(hedera.HederaTestnetCAIP2))
		if err != nil {
			t.Fatal(err)
		}
		if got.Asset != hedera.HederaTestnetUSDC {
			t.Fatalf("asset=%s", got.Asset)
		}
		if got.Amount != "100000" { // 0.10 * 1e6
			t.Fatalf("amount=%s", got.Amount)
		}
	}
}

func TestParsePriceInvalidAsset(t *testing.T) {
	s := server.NewExactHederaScheme()
	_, err := s.ParsePrice(map[string]interface{}{
		"amount": "1000",
		"asset":  "bad",
	}, x402.Network(hedera.HederaTestnetCAIP2))
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestEnhancePaymentRequirementsCopiesFeePayer(t *testing.T) {
	s := server.NewExactHederaScheme()
	req := types.PaymentRequirements{
		Scheme:  hedera.SchemeExact,
		Network: hedera.HederaTestnetCAIP2,
		Asset:   hedera.HBARAssetID,
		Amount:  "1",
		PayTo:   "0.0.1",
	}
	out, err := s.EnhancePaymentRequirements(context.Background(), req, types.SupportedKind{
		Extra: map[string]interface{}{"feePayer": "0.0.5001"},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if fee, _ := out.Extra["feePayer"].(string); fee != "0.0.5001" {
		t.Fatalf("extra=%v", out.Extra)
	}
}

func TestParsePriceCustomMoneyParser(t *testing.T) {
	s := server.NewExactHederaScheme().
		RegisterMoneyParser(func(amount string, network x402.Network) (*x402.AssetAmount, error) {
			if amount != "2.50" || network != hedera.HederaTestnetCAIP2 {
				t.Fatalf("amount=%v network=%s", amount, network)
			}
			return &x402.AssetAmount{
				Asset:  "0.0.6001",
				Amount: "250",
			}, nil
		})
	got, err := s.ParsePrice("$2.50", x402.Network(hedera.HederaTestnetCAIP2))
	if err != nil || got.Asset != "0.0.6001" || got.Amount != "250" {
		t.Fatalf("got=%+v err=%v", got, err)
	}

	parserErr := errors.New("parser failed")
	s = server.NewExactHederaScheme().
		RegisterMoneyParser(func(string, x402.Network) (*x402.AssetAmount, error) {
			return nil, parserErr
		})
	if _, err := s.ParsePrice("1", x402.Network(hedera.HederaTestnetCAIP2)); !errors.Is(err, parserErr) {
		t.Fatalf("expected parser error, got %v", err)
	}
}

func TestParsePriceConfiguredDefaultAsset(t *testing.T) {
	const network = hedera.HederaTestnetCAIP2
	s := server.NewExactHederaScheme(&hedera.ServerConfig{
		DefaultAssets: map[string]hedera.DefaultAssetConfig{
			network: {Asset: "0.0.6001", Decimals: 2},
		},
	})
	got, err := s.ParsePrice("1.25", x402.Network(network))
	if err != nil || got.Asset != "0.0.6001" || got.Amount != "125" {
		t.Fatalf("got=%+v err=%v", got, err)
	}
	if decimals, ok := s.GetAssetDecimals("0.0.6001", x402.Network(network)); !ok || decimals != 2 {
		t.Fatalf("configured decimals=%d ok=%v", decimals, ok)
	}
}

func TestGetAssetDecimals(t *testing.T) {
	s := server.NewExactHederaScheme()
	network := x402.Network(hedera.HederaTestnetCAIP2)
	if decimals, ok := s.GetAssetDecimals(hedera.HederaTestnetUSDC, network); !ok || decimals != hedera.HederaUSDCDecimals {
		t.Fatalf("USDC decimals=%d ok=%v", decimals, ok)
	}
	if _, ok := s.GetAssetDecimals(hedera.HederaMainnetUSDC, network); ok {
		t.Fatal("mainnet USDC resolved on testnet")
	}
	if _, ok := s.GetAssetDecimals("0.0.6001", network); ok {
		t.Fatal("unknown token resolved")
	}
}
