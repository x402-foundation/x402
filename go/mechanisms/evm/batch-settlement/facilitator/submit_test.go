package facilitator

import (
	"strings"
	"testing"
)

func TestShouldRelaySubmit_RelaysWhenAuthorizerSignaturePresent(t *testing.T) {
	if !ShouldRelaySubmit(SubmitModeDirect, true) {
		t.Fatal("direct + signature should relay")
	}
	if !ShouldRelaySubmit("", true) {
		t.Fatal("omitted mode + signature should relay")
	}
}

func TestShouldRelaySubmit_DirectOnlyWhenConfiguredAndUnsigned(t *testing.T) {
	if ShouldRelaySubmit(SubmitModeDirect, false) {
		t.Fatal("direct + unsigned should not relay")
	}
	if !ShouldRelaySubmit(SubmitModeRelay, false) {
		t.Fatal("relay + unsigned should relay")
	}
	if !ShouldRelaySubmit("", false) {
		t.Fatal("omitted mode + unsigned should relay")
	}
}

func TestAssertDirectAuthorizerSubmitter_NoOpOutsideDirect(t *testing.T) {
	if err := AssertDirectAuthorizerSubmitter(SubmitModeRelay, nil, nil); err != nil {
		t.Fatalf("relay should be a no-op: %v", err)
	}
}

func TestAssertDirectAuthorizerSubmitter_RequiresSignerAndSubmitter(t *testing.T) {
	submitter := &fakeFacilitatorSigner{addresses: []string{"0x70997970C51812dc3A010C7d01b50e0d17dc79C8"}}
	err := AssertDirectAuthorizerSubmitter(SubmitModeDirect, nil, submitter)
	if err == nil || !strings.Contains(err.Error(), `submitMode "direct" requires authorizerSigner`) {
		t.Fatalf("got %v", err)
	}
	authorizer := &fakeAuthorizerSigner{addr: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"}
	err = AssertDirectAuthorizerSubmitter(SubmitModeDirect, authorizer, nil)
	if err == nil || !strings.Contains(err.Error(), `submitMode "direct" requires authorizerSubmitter`) {
		t.Fatalf("got %v", err)
	}
}

func TestAssertDirectAuthorizerSubmitter_RejectsMismatchedSubmitter(t *testing.T) {
	authorizer := &fakeAuthorizerSigner{addr: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"}
	submitter := &fakeFacilitatorSigner{addresses: []string{"0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"}}
	err := AssertDirectAuthorizerSubmitter(SubmitModeDirect, authorizer, submitter)
	if err == nil || !strings.Contains(err.Error(), "authorizerSubmitter.getAddresses() must be exactly [authorizerSigner.address]") {
		t.Fatalf("got %v", err)
	}
}

func TestAssertDirectAuthorizerSubmitter_AcceptsMatchingSingleAddress(t *testing.T) {
	addr := "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
	authorizer := &fakeAuthorizerSigner{addr: addr}
	submitter := &fakeFacilitatorSigner{addresses: []string{addr}}
	if err := AssertDirectAuthorizerSubmitter(SubmitModeDirect, authorizer, submitter); err != nil {
		t.Fatal(err)
	}
}
