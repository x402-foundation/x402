package facilitator

import (
	"context"
	"math/big"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
	"github.com/x402-foundation/x402/go/v2/types"
)

func identityResolver(identity string) ResolveCallerIdentity {
	return func(DelegatedSettleContext) (string, error) { return identity, nil }
}

func TestStripAuthorizerSignatures_ReturnsCopy(t *testing.T) {
	raw := &batchsettlement.BatchSettlementEnrichedRefundPayload{
		Amount:                    "5",
		RefundAuthorizerSignature: "0xaa",
		ClaimAuthorizerSignature:  "0xbb",
	}
	stripped := StripAuthorizerSignatures(raw)
	if stripped.RefundAuthorizerSignature != "" || stripped.ClaimAuthorizerSignature != "" || stripped.Amount != "5" {
		t.Fatalf("stripped = %+v", stripped)
	}
	if raw.RefundAuthorizerSignature != "0xaa" || raw.ClaimAuthorizerSignature != "0xbb" {
		t.Fatalf("input must be left untouched, got %+v", raw)
	}
}

func TestSettleManaged_RefundAuthorizerConsentIsStrippedAndResigned(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	serverEOA := addressOfKey(t, serverRefundKeyHex)
	cfg := managedConfigWithRefundAuthorizer(t, auth.addr, serverEOA)
	channelId := mustChannelId(t, cfg)
	_, sig := signRefundWithKey(t, serverRefundKeyHex, channelId, "1000", "0", managedNetwork)
	// Everything charged is already claimed, so the refund goes out alone as refundWithSignature.
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{ChargedCumulativeAmount: "1000", TotalClaimed: "1000"}))
	reqs := managedRequirements(auth.addr)
	reqs.Extra["refundAuthorizer"] = strings.ToLower(serverEOA)

	signer := newManagedSigner(t, &managedRPC{totalClaimed: big.NewInt(1000)})
	var submitted []byte
	origWrite := signer.writeContract
	signer.writeContract = func(functionName string, args ...interface{}) (string, error) {
		if functionName == "refundWithSignature" {
			submitted, _ = args[len(args)-1].([]byte)
		}
		return origWrite(functionName, args...)
	}

	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, signer),
		refundEnvelope(cfg, voucherFields(channelId, "1000", dummySig), "1000", "", sig),
		reqs, nil, nil)
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	if string(submitted) != "sig" {
		t.Fatalf("submitted refund signature = %x, want the facilitator's re-signature", submitted)
	}
}

func TestSettleManaged_RefundAuthorizerConsentRejections(t *testing.T) {
	serverEOA := addressOfKey(t, serverRefundKeyHex)
	cases := []struct {
		name          string
		announced     string
		signAs        string
		wantReason    string
		omitSignature bool
	}{
		{name: "signature from a different key", announced: serverEOA, signAs: managedAuthKeyHex, wantReason: ErrRefundAuthorizerSignature},
		{name: "missing signature", announced: serverEOA, omitSignature: true, wantReason: ErrRefundAuthorizerSignature},
		{name: "announced refundAuthorizer differs from salt", announced: common.HexToAddress("0x7777777777777777777777777777777777777777").Hex(), signAs: serverRefundKeyHex, wantReason: ErrRefundAuthorizerMismatch},
		{name: "announced refundAuthorizer is not an address", announced: "not-an-address", signAs: serverRefundKeyHex, wantReason: ErrRefundAuthorizerMismatch},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
			auth := managedAuthorizer()
			cfg := managedConfigWithRefundAuthorizer(t, auth.addr, serverEOA)
			channelId := mustChannelId(t, cfg)
			sig := ""
			if !tc.omitSignature {
				_, sig = signRefundWithKey(t, tc.signAs, channelId, "1000", "0", managedNetwork)
			}
			seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{ChargedCumulativeAmount: "1000"}))
			reqs := managedRequirements(auth.addr)
			reqs.Extra["refundAuthorizer"] = tc.announced

			signer := newManagedSigner(t, nil)
			resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, signer),
				refundEnvelope(cfg, voucherFields(channelId, "1000", dummySig), "1000", "", sig), reqs, nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			if resp.Success || resp.ErrorReason != tc.wantReason {
				t.Fatalf("got %+v, want reason %s", resp, tc.wantReason)
			}
			if signer.writeCalls != 0 {
				t.Fatalf("writes = %d, want none", signer.writeCalls)
			}
		})
	}
}

func TestManagedRequirementError_RefundConsentPath(t *testing.T) {
	auth := managedAuthorizer()
	serverEOA := addressOfKey(t, serverRefundKeyHex)
	withIdentity := VoucherStoreDeps{AuthorizerSigner: auth, WithdrawDelay: 900, ResolveCallerIdentity: identityResolver("svc")}
	withoutIdentity := VoucherStoreDeps{AuthorizerSigner: auth, WithdrawDelay: 900}

	packed := managedConfigWithRefundAuthorizer(t, auth.addr, serverEOA).Salt
	raw := managedIdentityConfig(auth.addr).Salt
	owned := managedRequirements(auth.addr)
	owned.Extra["refundAuthorizer"] = serverEOA
	omitted := managedRequirements(auth.addr)

	cases := []struct {
		name string
		deps VoucherStoreDeps
		salt string
		reqs types.PaymentRequirements
		want string
	}{
		{"omitted with caller identity", withIdentity, raw, omitted, ""},
		{"omitted without caller identity", withoutIdentity, raw, omitted, ErrRefundAuthorizerSignature},
		{"server-owned key needs no caller identity", withoutIdentity, packed, owned, ""},
		{"server-owned key must match the packed salt", withoutIdentity, raw, owned, ErrRefundAuthorizerMismatch},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := managedRequirementError(tc.deps, tc.salt, tc.reqs); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestSettleManaged_RefundFailsClosedWithoutConsentPath(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedIdentityConfig(auth.addr)
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{ChargedCumulativeAmount: "1000"}))
	deps := managedDeps(t, store, store, auth, nil)
	deps.ResolveCallerIdentity = nil
	bindManagedIdentity(t, deps.DelegatedAuthStore, channelId, "svc")

	// The 402 omits extra.refundAuthorizer and this facilitator resolves no caller identity,
	// so neither a signature nor an identity can authorize the refund.
	resp, err := SettleManaged(context.Background(), deps,
		refundEnvelope(cfg, voucherFields(channelId, "1000", dummySig), "1000", "", ""),
		managedRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrRefundAuthorizerSignature {
		t.Fatalf("got %+v", resp)
	}
}

func TestCheckDelegatedRefundConsent_IdentityRequiresHooks(t *testing.T) {
	auth := managedAuthorizer()
	cfg := managedIdentityConfig(auth.addr)
	channelId := mustChannelId(t, cfg)
	raw := &batchsettlement.BatchSettlementEnrichedRefundPayload{
		ChannelConfig: cfg,
		Voucher:       voucherFields(channelId, "1000", dummySig),
		Amount:        "1000",
		RefundNonce:   "0",
	}
	reqs := types.PaymentRequirements{Network: managedNetwork, Extra: map[string]interface{}{}}
	amounts := RefundConsentAmounts{Amount: "1000", Nonce: "0"}

	// The 402 omits refundAuthorizer but no hooks are wired: fail closed.
	got := CheckDelegatedRefundConsent(context.Background(), RefundConsentDeps{},
		managedEnvelope(nil), raw, amounts, reqs, nil)
	if got != ErrRefundAuthorizerSignature {
		t.Fatalf("got %q", got)
	}
}
