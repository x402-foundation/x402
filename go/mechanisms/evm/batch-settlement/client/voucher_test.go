package client

import (
	"context"
	"errors"
	"math/big"
	"testing"

	"github.com/x402-foundation/x402/go/mechanisms/evm"
)

// mockSigner records the last SignTypedData call and returns a canned signature/error.
type mockSigner struct {
	address string
	sig     []byte
	err     error

	// Captured by the most recent SignTypedData call
	lastDomain      evm.TypedDataDomain
	lastTypes       map[string][]evm.TypedDataField
	lastPrimaryType string
	lastMessage     map[string]interface{}
}

func (m *mockSigner) Address() string { return m.address }
func (m *mockSigner) SignTypedData(_ context.Context, domain evm.TypedDataDomain, types map[string][]evm.TypedDataField, primaryType string, message map[string]interface{}) ([]byte, error) {
	m.lastDomain = domain
	m.lastTypes = types
	m.lastPrimaryType = primaryType
	m.lastMessage = message
	return m.sig, m.err
}

func TestSignVoucher_OK(t *testing.T) {
	s := &mockSigner{address: "0xpayer", sig: []byte{0xde, 0xad, 0xbe, 0xef}}
	channelId := "0x" + "ab"
	v, err := SignVoucher(context.Background(), s, channelId, "1000", "eip155:8453")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if v.ChannelId != channelId || v.MaxClaimableAmount != "1000" {
		t.Fatalf("voucher fields = %+v", v)
	}
	if v.Signature != "0xdeadbeef" {
		t.Fatalf("signature = %q", v.Signature)
	}
	if s.lastPrimaryType != "Voucher" {
		t.Fatalf("primaryType = %q", s.lastPrimaryType)
	}
	if s.lastDomain.ChainID == nil || s.lastDomain.ChainID.Cmp(big.NewInt(8453)) != 0 {
		t.Fatalf("domain.ChainID = %v", s.lastDomain.ChainID)
	}
	if s.lastDomain.Name != "x402 Batch Settlement" {
		t.Fatalf("domain.Name = %q", s.lastDomain.Name)
	}
	if s.lastMessage["maxClaimableAmount"].(*big.Int).Cmp(big.NewInt(1000)) != 0 {
		t.Fatalf("message.maxClaimableAmount = %v", s.lastMessage["maxClaimableAmount"])
	}
}

func TestSignVoucher_BadNetwork(t *testing.T) {
	s := &mockSigner{address: "0x"}
	if _, err := SignVoucher(context.Background(), s, "0x01", "100", "not-a-network"); err == nil {
		t.Fatal("expected error")
	}
}

func TestSignVoucher_BadMaxClaimableAmount(t *testing.T) {
	s := &mockSigner{address: "0x"}
	if _, err := SignVoucher(context.Background(), s, "0x01", "not-a-number", "eip155:8453"); err == nil {
		t.Fatal("expected error")
	}
}

func TestSignVoucher_BadChannelId(t *testing.T) {
	s := &mockSigner{address: "0x"}
	if _, err := SignVoucher(context.Background(), s, "not-hex", "100", "eip155:8453"); err == nil {
		t.Fatal("expected error")
	}
}

func TestSignVoucher_SignerError(t *testing.T) {
	s := &mockSigner{address: "0x", err: errors.New("kms down")}
	if _, err := SignVoucher(context.Background(), s, "0x01", "100", "eip155:8453"); err == nil {
		t.Fatal("expected signer error")
	}
}
