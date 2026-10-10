package server

import (
	"context"
	"strings"
	"testing"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/types"
)

// managedSupportedKind is a facilitator /supported kind that advertises delegatedRefund: true.
func managedSupportedKind(extra map[string]interface{}) types.SupportedKind {
	out := map[string]interface{}{
		"receiverAuthorizer": "0x1111111111111111111111111111111111111111",
		"withdrawDelay":      900,
		"voucherManager":     []interface{}{"server", "facilitator"},
		"delegatedRefund":    true,
	}
	for k, v := range extra {
		if v == nil {
			delete(out, k)
			continue
		}
		out[k] = v
	}
	return types.SupportedKind{
		X402Version: 2,
		Scheme:      batchsettlement.SchemeBatched,
		Network:     "eip155:8453",
		Extra:       out,
	}
}

func managedEnhanceRequest() types.PaymentRequirements {
	return types.PaymentRequirements{
		Network: "eip155:8453",
		Asset:   "0x1234567890abcdef1234567890abcdef12345678",
		Amount:  "1000",
	}
}

func managedScheme(refundSigner AuthorizerSigner) *BatchSettlementEvmScheme {
	return NewBatchSettlementEvmScheme("0xreceiver", &BatchSettlementEvmSchemeServerConfig{
		VoucherStoreMode:       VoucherStoreModeFacilitator,
		RefundAuthorizerSigner: refundSigner,
	})
}

func TestEnhancePaymentRequirements_ManagedRequiresFacilitatorVoucherManager(t *testing.T) {
	s := managedScheme(&mockAuthorizerSigner{address: "0xrefund"})
	for name, advertised := range map[string]interface{}{
		"server only": []interface{}{"server"},
		"malformed":   "facilitator",
	} {
		t.Run(name, func(t *testing.T) {
			kind := managedSupportedKind(map[string]interface{}{"voucherManager": advertised})
			_, err := s.EnhancePaymentRequirements(context.Background(), managedEnhanceRequest(), kind, nil)
			if err == nil || !strings.Contains(err.Error(), `include "facilitator"`) {
				t.Fatalf("got %v", err)
			}
		})
	}
	kind := managedSupportedKind(nil)
	delete(kind.Extra, "voucherManager")
	if _, err := s.EnhancePaymentRequirements(context.Background(), managedEnhanceRequest(), kind, nil); err == nil {
		t.Fatal("omitted voucherManager means server only and must be rejected")
	}
}

func TestEnhancePaymentRequirements_ManagedSetsVoucherManagerAndOwnRefundAuthorizer(t *testing.T) {
	s := managedScheme(&mockAuthorizerSigner{address: "0x2222222222222222222222222222222222222222"})
	out, err := s.EnhancePaymentRequirements(context.Background(), managedEnhanceRequest(), managedSupportedKind(map[string]interface{}{"withdrawDelay": 1200}), nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if out.Extra["voucherManager"] != "facilitator" {
		t.Fatalf("voucherManager = %v", out.Extra["voucherManager"])
	}
	if out.Extra["withdrawDelay"] != 1200 {
		t.Fatalf("withdrawDelay = %v", out.Extra["withdrawDelay"])
	}
	// The server-owned refund key is announced so the client packs it into the salt.
	if out.Extra["refundAuthorizer"] != "0x2222222222222222222222222222222222222222" {
		t.Fatalf("refundAuthorizer = %v", out.Extra["refundAuthorizer"])
	}
}

func TestEnhancePaymentRequirements_ManagedOwnRefundKeyNeedsNoDelegatedRefund(t *testing.T) {
	s := managedScheme(&mockAuthorizerSigner{address: "0x2222222222222222222222222222222222222222"})
	for name, supported := range map[string]types.SupportedKind{
		"explicit false": managedSupportedKind(map[string]interface{}{"delegatedRefund": false}),
		"absent":         managedSupportedKind(map[string]interface{}{"delegatedRefund": nil}),
	} {
		t.Run(name, func(t *testing.T) {
			out, err := s.EnhancePaymentRequirements(context.Background(), managedEnhanceRequest(), supported, nil)
			if err != nil {
				t.Fatalf("err: %v", err)
			}
			if out.Extra["refundAuthorizer"] != "0x2222222222222222222222222222222222222222" {
				t.Fatalf("refundAuthorizer = %v", out.Extra["refundAuthorizer"])
			}
		})
	}
}

func TestEnhancePaymentRequirements_ManagedOmitsRefundAuthorizerWhenDelegated(t *testing.T) {
	s := managedScheme(nil)
	out, err := s.EnhancePaymentRequirements(context.Background(), managedEnhanceRequest(), managedSupportedKind(nil), nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if _, has := out.Extra["refundAuthorizer"]; has {
		t.Fatalf("402 must omit refundAuthorizer when relying on delegatedRefund, got %v", out.Extra["refundAuthorizer"])
	}
	if out.Extra["voucherManager"] != "facilitator" {
		t.Fatalf("voucherManager = %v", out.Extra["voucherManager"])
	}
}

func TestEnhancePaymentRequirements_ManagedWithoutAnyConsentPathFails(t *testing.T) {
	s := managedScheme(nil)
	for name, supported := range map[string]types.SupportedKind{
		"explicit false": managedSupportedKind(map[string]interface{}{"delegatedRefund": false}),
		// Managed mode has no legacy deployments, so an absent field counts as unsupported.
		"absent": managedSupportedKind(map[string]interface{}{"delegatedRefund": nil}),
	} {
		t.Run(name, func(t *testing.T) {
			_, err := s.EnhancePaymentRequirements(context.Background(), managedEnhanceRequest(), supported, nil)
			if err == nil || !strings.Contains(err.Error(), "delegatedRefund") {
				t.Fatalf("got %v", err)
			}
		})
	}
}

func TestValidateFacilitatorSupport_Managed(t *testing.T) {
	t.Run("requires a refund consent path", func(t *testing.T) {
		for name, extra := range map[string]map[string]interface{}{
			"explicit false": {"delegatedRefund": false},
			"absent":         {"delegatedRefund": nil},
		} {
			t.Run(name, func(t *testing.T) {
				err := managedScheme(nil).ValidateFacilitatorSupport("eip155:8453", managedSupportedKind(extra), nil)
				if err == nil || !strings.Contains(err.Error(), "delegatedRefund") {
					t.Fatalf("got %v", err)
				}
			})
		}
	})
	t.Run("accepts delegatedRefund true", func(t *testing.T) {
		if err := managedScheme(nil).ValidateFacilitatorSupport("eip155:8453", managedSupportedKind(nil), nil); err != nil {
			t.Fatalf("err: %v", err)
		}
	})
	t.Run("accepts an own refund signer without delegatedRefund", func(t *testing.T) {
		s := managedScheme(&mockAuthorizerSigner{address: "0xrefund"})
		if err := s.ValidateFacilitatorSupport("eip155:8453", managedSupportedKind(map[string]interface{}{"delegatedRefund": false}), nil); err != nil {
			t.Fatalf("err: %v", err)
		}
	})
	t.Run("requires voucherManager facilitator", func(t *testing.T) {
		s := managedScheme(&mockAuthorizerSigner{address: "0xrefund"})
		err := s.ValidateFacilitatorSupport("eip155:8453", managedSupportedKind(map[string]interface{}{"voucherManager": []interface{}{"server"}}), nil)
		if err == nil || !strings.Contains(err.Error(), `advertise voucherManager "facilitator"`) {
			t.Fatalf("got %v", err)
		}
	})
}

func TestValidateFacilitatorSupport_SelfManagedDelegation(t *testing.T) {
	delegating := NewBatchSettlementEvmScheme("0xreceiver", nil)
	supported := func(delegatedRefund interface{}) types.SupportedKind {
		extra := map[string]interface{}{"receiverAuthorizer": "0xCFA51eEAF6B2831d2A7e09829477E88154647cbB"}
		if delegatedRefund != nil {
			extra["delegatedRefund"] = delegatedRefund
		}
		return types.SupportedKind{Extra: extra}
	}

	t.Run("delegatedRefund true starts", func(t *testing.T) {
		if err := delegating.ValidateFacilitatorSupport("eip155:8453", supported(true), nil); err != nil {
			t.Fatalf("err: %v", err)
		}
	})
	t.Run("absent field (legacy facilitator) starts", func(t *testing.T) {
		if err := delegating.ValidateFacilitatorSupport("eip155:8453", supported(nil), nil); err != nil {
			t.Fatalf("err: %v", err)
		}
	})
	t.Run("explicit false fails startup", func(t *testing.T) {
		err := delegating.ValidateFacilitatorSupport("eip155:8453", supported(false), nil)
		if err == nil || !strings.Contains(err.Error(), "delegatedRefund: false") {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("local receiverAuthorizerSigner skips the check", func(t *testing.T) {
		s := NewBatchSettlementEvmScheme("0xreceiver", &BatchSettlementEvmSchemeServerConfig{
			ReceiverAuthorizerSigner: &mockAuthorizerSigner{address: "0x3333333333333333333333333333333333333333"},
		})
		if err := s.ValidateFacilitatorSupport("eip155:8453", supported(false), nil); err != nil {
			t.Fatalf("err: %v", err)
		}
	})
}

func TestSelfManaged_VoucherManagerTolerance(t *testing.T) {
	signer := &mockAuthorizerSigner{address: "0x3333333333333333333333333333333333333333"}
	s := NewBatchSettlementEvmScheme("0xreceiver", &BatchSettlementEvmSchemeServerConfig{ReceiverAuthorizerSigner: signer})
	withManagers := func(managers ...interface{}) types.SupportedKind {
		return types.SupportedKind{Extra: map[string]interface{}{"voucherManager": managers}}
	}

	if err := s.ValidateFacilitatorSupport("eip155:8453", withManagers("server", "facilitator"), nil); err != nil {
		t.Fatalf("server advertised: %v", err)
	}
	err := s.ValidateFacilitatorSupport("eip155:8453", withManagers("facilitator"), nil)
	if err == nil || !strings.Contains(err.Error(), `without "server"`) {
		t.Fatalf("got %v", err)
	}
	_, err = s.EnhancePaymentRequirements(context.Background(), managedEnhanceRequest(), withManagers("facilitator"), nil)
	if err == nil || !strings.Contains(err.Error(), `include "server"`) {
		t.Fatalf("got %v", err)
	}
}

func TestSelfManaged_DoesNotAnnounceRefundOrVoucherManager(t *testing.T) {
	s := NewBatchSettlementEvmScheme("0xreceiver", &BatchSettlementEvmSchemeServerConfig{
		RefundAuthorizerSigner: &mockAuthorizerSigner{address: "0x2222222222222222222222222222222222222222"},
	})
	supported := types.SupportedKind{Extra: map[string]interface{}{
		"receiverAuthorizer": "0xCFA51eEAF6B2831d2A7e09829477E88154647cbB",
		"delegatedRefund":    true,
		"voucherManager":     []interface{}{"server", "facilitator"},
	}}
	if err := s.ValidateFacilitatorSupport("eip155:8453", supported, nil); err != nil {
		t.Fatalf("err: %v", err)
	}
	out, err := s.EnhancePaymentRequirements(context.Background(), managedEnhanceRequest(), supported, nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	for _, key := range []string{"refundAuthorizer", "voucherManager"} {
		if _, has := out.Extra[key]; has {
			t.Fatalf("self-managed 402 must not carry %s, got %v", key, out.Extra[key])
		}
	}
	if s.GetRefundAuthorizerSigner() != nil {
		t.Fatal("RefundAuthorizerSigner is ignored in self-managed mode")
	}
}
