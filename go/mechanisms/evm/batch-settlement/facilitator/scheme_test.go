package facilitator

import (
	"context"
	"errors"
	"math/big"
	"testing"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/types"
)

// fakeFacilitatorSigner is a no-op FacilitatorEvmSigner used when routing should
// fail before any RPC is required. Methods that depend on RPC return errors.
type fakeFacilitatorSigner struct {
	addresses []string
	chainId   *big.Int

	// Optional overrides for VerifyTypedData and ReadContract.
	verifyTypedData func(address string) (bool, error)
	verifyCalls     int
	verifyAddrs     []string
}

func (f *fakeFacilitatorSigner) GetAddresses() []string { return f.addresses }
func (f *fakeFacilitatorSigner) ReadContract(_ context.Context, _ string, _ []byte, _ string, _ ...interface{}) (interface{}, error) {
	return nil, errors.New("no rpc")
}
func (f *fakeFacilitatorSigner) VerifyTypedData(_ context.Context, address string, _ evm.TypedDataDomain, _ map[string][]evm.TypedDataField, _ string, _ map[string]interface{}, _ []byte) (bool, error) {
	f.verifyCalls++
	f.verifyAddrs = append(f.verifyAddrs, address)
	if f.verifyTypedData != nil {
		return f.verifyTypedData(address)
	}
	return false, errors.New("no rpc")
}
func (f *fakeFacilitatorSigner) WriteContract(_ context.Context, _ string, _ []byte, _ string, _ ...interface{}) (string, error) {
	return "", errors.New("no rpc")
}
func (f *fakeFacilitatorSigner) SendTransaction(_ context.Context, _ string, _ []byte) (string, error) {
	return "", errors.New("no rpc")
}
func (f *fakeFacilitatorSigner) WaitForTransactionReceipt(_ context.Context, _ string) (*evm.TransactionReceipt, error) {
	return nil, errors.New("no rpc")
}
func (f *fakeFacilitatorSigner) GetBalance(_ context.Context, _ string, _ string) (*big.Int, error) {
	return big.NewInt(0), nil
}
func (f *fakeFacilitatorSigner) GetChainID(_ context.Context) (*big.Int, error) {
	if f.chainId != nil {
		return f.chainId, nil
	}
	return big.NewInt(8453), nil
}
func (f *fakeFacilitatorSigner) GetCode(_ context.Context, _ string) ([]byte, error) {
	return nil, nil
}

// fakeAuthorizerSigner is a no-op AuthorizerSigner.
type fakeAuthorizerSigner struct{ addr string }

func (a *fakeAuthorizerSigner) Address() string { return a.addr }
func (a *fakeAuthorizerSigner) SignClaimBatch(_ context.Context, _ []batchsettlement.BatchSettlementVoucherClaim, _ string) ([]byte, error) {
	return []byte("sig"), nil
}
func (a *fakeAuthorizerSigner) SignRefund(_ context.Context, _ string, _ string, _ string, _ string) ([]byte, error) {
	return []byte("sig"), nil
}

func newScheme() *BatchSettlementEvmScheme {
	return NewBatchSettlementEvmScheme(
		&fakeFacilitatorSigner{addresses: []string{"0xfacilitator"}},
		&fakeAuthorizerSigner{addr: "0xauthorizer"},
	)
}

func TestScheme_Identifier(t *testing.T) {
	s := newScheme()
	if s.Scheme() != batchsettlement.SchemeBatched {
		t.Fatalf("scheme = %s", s.Scheme())
	}
	if s.CaipFamily() != "eip155:*" {
		t.Fatalf("caip = %s", s.CaipFamily())
	}
}

func TestScheme_GetExtra(t *testing.T) {
	s := newScheme()
	got := s.GetExtra(x402.Network("eip155:8453"))
	if got["receiverAuthorizer"] != "0xauthorizer" {
		t.Fatalf("extra = %+v", got)
	}
}

func TestScheme_GetSigners(t *testing.T) {
	s := newScheme()
	got := s.GetSigners(x402.Network("eip155:8453"))
	if len(got) != 1 || got[0] != "0xfacilitator" {
		t.Fatalf("signers = %+v", got)
	}
}

func payloadEnvelope(network string, payload map[string]interface{}) types.PaymentPayload {
	return types.PaymentPayload{
		X402Version: 2,
		Payload:     payload,
		Accepted: types.PaymentRequirements{
			Scheme:  batchsettlement.SchemeBatched,
			Network: network,
		},
	}
}

func TestVerify_BadScheme(t *testing.T) {
	s := newScheme()
	pp := payloadEnvelope("eip155:8453", map[string]interface{}{"type": "voucher"})
	pp.Accepted.Scheme = "exact"
	req := types.PaymentRequirements{Scheme: batchsettlement.SchemeBatched, Network: "eip155:8453"}
	resp, err := s.Verify(context.Background(), pp, req, nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if resp.IsValid || resp.InvalidReason != ErrInvalidScheme {
		t.Fatalf("got %+v", resp)
	}
}

func TestVerify_NetworkMismatch(t *testing.T) {
	s := newScheme()
	pp := payloadEnvelope("eip155:1", map[string]interface{}{"type": "voucher"})
	req := types.PaymentRequirements{Scheme: batchsettlement.SchemeBatched, Network: "eip155:8453"}
	resp, err := s.Verify(context.Background(), pp, req, nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if resp.IsValid || resp.InvalidReason != ErrNetworkMismatch {
		t.Fatalf("got %+v", resp)
	}
}

func TestVerify_UnknownPayload(t *testing.T) {
	s := newScheme()
	pp := payloadEnvelope("eip155:8453", map[string]interface{}{"type": "mystery"})
	req := types.PaymentRequirements{Scheme: batchsettlement.SchemeBatched, Network: "eip155:8453"}
	resp, err := s.Verify(context.Background(), pp, req, nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if resp.IsValid || resp.InvalidReason != ErrInvalidPayload {
		t.Fatalf("got %+v", resp)
	}
}

func TestVerify_MalformedDepositPayload(t *testing.T) {
	s := newScheme()
	// IsDepositPayload requires type=deposit + channelConfig + voucher + deposit.
	// Pass them, but with channelConfig as a non-map so DepositPayloadFromMap errors.
	pp := payloadEnvelope("eip155:8453", map[string]interface{}{
		"type":          "deposit",
		"channelConfig": "not-a-map",
		"voucher":       map[string]interface{}{},
		"deposit":       map[string]interface{}{},
	})
	req := types.PaymentRequirements{Scheme: batchsettlement.SchemeBatched, Network: "eip155:8453"}
	_, err := s.Verify(context.Background(), pp, req, nil)
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrInvalidDepositPayload {
		t.Fatalf("got err = %v", err)
	}
}

func TestVerify_MalformedVoucherPayload(t *testing.T) {
	s := newScheme()
	// IsVoucherPayload requires type=voucher + channelConfig + voucher. Pass them,
	// but with channelConfig as a non-map so VoucherPayloadFromMap errors.
	pp := payloadEnvelope("eip155:8453", map[string]interface{}{
		"type":          "voucher",
		"channelConfig": "not-a-map",
		"voucher": map[string]interface{}{
			"channelId":          "0xabc",
			"maxClaimableAmount": "1",
			"signature":          "0xsig",
		},
	})
	req := types.PaymentRequirements{Scheme: batchsettlement.SchemeBatched, Network: "eip155:8453"}
	_, err := s.Verify(context.Background(), pp, req, nil)
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrInvalidVoucherPayload {
		t.Fatalf("got err = %v", err)
	}
}

func TestSettle_UnknownAction(t *testing.T) {
	s := newScheme()
	pp := payloadEnvelope("eip155:8453", map[string]interface{}{"settleAction": "no-such-thing"})
	req := types.PaymentRequirements{Scheme: batchsettlement.SchemeBatched, Network: "eip155:8453"}
	_, err := s.Settle(context.Background(), pp, req, nil)
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrUnknownSettleAction {
		t.Fatalf("got err = %v", err)
	}
}

func TestSettle_MalformedDepositPayload(t *testing.T) {
	s := newScheme()
	pp := payloadEnvelope("eip155:8453", map[string]interface{}{
		"type":          "deposit",
		"channelConfig": "not-a-map",
		"voucher":       map[string]interface{}{},
		"deposit":       map[string]interface{}{},
	})
	req := types.PaymentRequirements{Scheme: batchsettlement.SchemeBatched, Network: "eip155:8453"}
	_, err := s.Settle(context.Background(), pp, req, nil)
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrInvalidDepositPayload {
		t.Fatalf("got err = %v", err)
	}
}

func TestSettle_MalformedClaimPayload(t *testing.T) {
	s := newScheme()
	// IsClaimPayload requires type=claim + claims. Pass a non-list claims so
	// ClaimPayloadFromMap errors.
	pp := payloadEnvelope("eip155:8453", map[string]interface{}{
		"type":   "claim",
		"claims": "not-a-list",
	})
	req := types.PaymentRequirements{Scheme: batchsettlement.SchemeBatched, Network: "eip155:8453"}
	_, err := s.Settle(context.Background(), pp, req, nil)
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrInvalidClaimPayload {
		t.Fatalf("got err = %v", err)
	}
}

// TestVerify_MalformedRefundPayload ensures refund payloads route to
// VerifyRefundVoucher. A malformed refund must surface as
// `invalid_batch_settlement_evm_refund_payload`, not the generic invalid type.
func TestVerify_MalformedRefundPayload(t *testing.T) {
	s := newScheme()
	pp := payloadEnvelope("eip155:8453", map[string]interface{}{
		"type":          "refund",
		"channelConfig": "not-a-map",
		"voucher": map[string]interface{}{
			"channelId":          "0xabc",
			"maxClaimableAmount": "0",
			"signature":          "0xsig",
		},
	})
	req := types.PaymentRequirements{Scheme: batchsettlement.SchemeBatched, Network: "eip155:8453"}
	_, err := s.Verify(context.Background(), pp, req, nil)
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrInvalidRefundPayload {
		t.Fatalf("got err = %v (want %s)", err, ErrInvalidRefundPayload)
	}
}

func TestSettle_MalformedRefundPayload(t *testing.T) {
	s := newScheme()
	// IsEnrichedRefundPayload requires type=refund + channelConfig + voucher +
	// amount + refundNonce + claims. Pass them, but with channelConfig as a
	// non-map so EnrichedRefundPayloadFromMap errors.
	pp := payloadEnvelope("eip155:8453", map[string]interface{}{
		"type":          "refund",
		"channelConfig": "not-a-map",
		"voucher":       map[string]interface{}{},
		"amount":        "1",
		"refundNonce":   "1",
		"claims":        []interface{}{},
	})
	req := types.PaymentRequirements{Scheme: batchsettlement.SchemeBatched, Network: "eip155:8453"}
	_, err := s.Settle(context.Background(), pp, req, nil)
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrInvalidRefundPayload {
		t.Fatalf("got err = %v", err)
	}
}
