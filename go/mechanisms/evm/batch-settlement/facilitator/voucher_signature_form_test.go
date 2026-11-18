package facilitator

import (
	"bytes"
	"context"
	"math/big"
	"testing"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
)

// Vectors: TS client signVoucher on eip155:84532; high-s and v=0/1 are the same signature
// rewritten. x402BatchSettlement.claim reverts on both (ECDSAInvalidSignatureS / ECDSAInvalidSignature).
func TestVerifyBatchedVoucherTypedDataRejectsUnrecoverableForms(t *testing.T) {
	const (
		payer     = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
		channelId = "0xdcdc13344de9746cfe666524db81860d28053b2d3fd65d3ee06aabbcd00ef339"
		canonical = "0x0277091def5cdef1b56fbcd377692de74c4b78630cb6a07d6e321f8a934cf9c168ed52e298e0c0ae4fee7f5fa0e818e0fd3585724131b996c59641de467f46dc1b"
		highS     = "0x0277091def5cdef1b56fbcd377692de74c4b78630cb6a07d6e321f8a934cf9c19712ad1d671f3f51b01180a05f17e71dbd7957746e16e6a4fa3c1cae89b6fa651c"
		yParity   = "0x0277091def5cdef1b56fbcd377692de74c4b78630cb6a07d6e321f8a934cf9c168ed52e298e0c0ae4fee7f5fa0e818e0fd3585724131b996c59641de467f46dc00"
	)
	cases := map[string]struct {
		sig  string
		want bool
	}{
		"canonical": {canonical, true},
		"high-s":    {highS, false},
		"v=0/1":     {yParity, false},
	}
	for name, tc := range cases {
		got, err := VerifyBatchedVoucherTypedData(context.Background(), nil, channelId, "2000",
			payer, payer, tc.sig, big.NewInt(84532))
		if err != nil || got != tc.want {
			t.Errorf("%s: got (%v, %v), want %v", name, got, err, tc.want)
		}
		got, err = VerifyBatchedVoucherTypedData(context.Background(), &fakeFacilitatorSigner{},
			channelId, "2000", zeroAddress, payer, tc.sig, big.NewInt(84532))
		if err != nil || got != tc.want {
			t.Errorf("%s: EOA payer got (%v, %v), want %v", name, got, err, tc.want)
		}
		vp := &batchsettlement.BatchSettlementVoucherPayload{
			ChannelConfig: batchsettlement.ChannelConfig{Payer: payer, PayerAuthorizer: payer},
			Voucher:       batchsettlement.BatchSettlementVoucherFields{ChannelId: channelId, MaxClaimableAmount: "2000", Signature: tc.sig},
		}
		if _, reason := eoaClearance(vp, "eip155:84532"); (reason == "") != tc.want {
			t.Errorf("%s: eoaClearance reason %q, want valid=%v", name, reason, tc.want)
		}
	}

	for _, sig := range []string{"0xabc", "invalid hex"} {
		vp := &batchsettlement.BatchSettlementVoucherPayload{
			ChannelConfig: batchsettlement.ChannelConfig{Payer: payer, PayerAuthorizer: payer},
			Voucher:       batchsettlement.BatchSettlementVoucherFields{ChannelId: channelId, MaxClaimableAmount: "2000", Signature: sig},
		}
		if _, reason := eoaClearance(vp, "eip155:84532"); reason != ErrVoucherSignatureInvalid {
			t.Errorf("malformed signature passed clearance: %q", reason)
		}
		claim := sampleClaim()
		claim.Signature = sig
		if args, err := buildVoucherClaimArgs([]batchsettlement.BatchSettlementVoucherClaim{claim}); args != nil || err == nil {
			t.Error("expected claim construction to reject malformed signature")
		}
	}
}

func TestContractVoucherSignatureUsesOneCodeLookup(t *testing.T) {
	codeReads := 0
	signer := &fakeFacilitatorSigner{
		getCode: func(string) ([]byte, error) {
			codeReads++
			return []byte{1}, nil
		},
		readContract: func(fn string, args ...interface{}) (interface{}, error) {
			if fn != "isValidSignature" || !bytes.Equal(args[1].([]byte), []byte{0xab, 0xcd}) {
				t.Fatalf("unexpected contract call: %s %v", fn, args)
			}
			return [4]byte{0x16, 0x26, 0xba, 0x7e}, nil
		},
	}
	valid, err := VerifyBatchedVoucherTypedData(context.Background(), signer, testErc3009ChannelId,
		"100", zeroAddress, "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "0xabcd", chainID())
	if !valid || err != nil || codeReads != 1 {
		t.Fatalf("valid=%v err=%v code reads=%d", valid, err, codeReads)
	}
}
