package authcapture

import (
	"math/big"
	"testing"
)

func TestResolveAuthCaptureDeployment(t *testing.T) {
	v11 := ResolveAuthCaptureDeployment("")
	if v11 == nil || v11.Version != AuthCaptureDeploymentV1_1 {
		t.Fatalf("default deployment = %+v", v11)
	}
	if v11.Escrow != AuthCaptureEscrowV1_1Address {
		t.Fatalf("default escrow = %q", v11.Escrow)
	}

	pinnedV11 := ResolveAuthCaptureDeployment(AuthCaptureEscrowV1_1Address)
	if pinnedV11 == nil || pinnedV11.Version != AuthCaptureDeploymentV1_1 {
		t.Fatalf("v1.1 pin = %+v", pinnedV11)
	}

	v10 := ResolveAuthCaptureDeployment(AuthCaptureEscrowV1_0Address)
	if v10 == nil || v10.Version != AuthCaptureDeploymentV1_0 {
		t.Fatalf("v1.0 pin = %+v", v10)
	}
	if v10.EIP3009Collector != EIP3009TokenCollectorV1_0Address {
		t.Fatalf("v1.0 collector = %q", v10.EIP3009Collector)
	}

	if ResolveAuthCaptureDeployment("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef") != nil {
		t.Fatal("expected unknown escrow to be rejected")
	}
	if ResolveAuthCaptureDeployment("not-an-address") != nil {
		t.Fatal("expected invalid address to be rejected")
	}
}

func mockPaymentInfo() PaymentInfoStruct {
	return PaymentInfoStruct{
		Operator:            "0x1111111111111111111111111111111111111111",
		Payer:               "0xpppppppppppppppppppppppppppppppppppppppp",
		Receiver:            "0x2222222222222222222222222222222222222222",
		Token:               "0x3333333333333333333333333333333333333333",
		MaxAmount:           "1000000",
		PreApprovalExpiry:   281474976710655,
		AuthorizationExpiry: 281474976710655,
		RefundExpiry:        281474976710655,
		MinFeeBps:           0,
		MaxFeeBps:           100,
		FeeReceiver:         "0x4444444444444444444444444444444444444444",
		Salt:                "0x0000000000000000000000000000000000000000000000000000000000000001",
	}
}

func TestComputePayerAgnosticPaymentInfoHash_Golden84532(t *testing.T) {
	hash, err := ComputePayerAgnosticPaymentInfoHash(big.NewInt(84532), mockPaymentInfo())
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	want := "0x341988b065a5131b3a82818eb7aba9010135f326af1af7695fce4d2bbebd0b76"
	if hash != want {
		t.Fatalf("hash = %q, want %q", hash, want)
	}
}

func TestComputePayerAgnosticPaymentInfoHash_Golden8453(t *testing.T) {
	hash, err := ComputePayerAgnosticPaymentInfoHash(big.NewInt(8453), mockPaymentInfo())
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	want := "0xa393f8f76a2327a7678488b2d504bda611b7586bb3f334b255a11bb5a75e79ca"
	if hash != want {
		t.Fatalf("hash = %q, want %q", hash, want)
	}
}

func TestComputePayerAgnosticPaymentInfoHash_Golden84532_V1_0(t *testing.T) {
	hash, err := ComputePayerAgnosticPaymentInfoHash(big.NewInt(84532), mockPaymentInfo(), AuthCaptureEscrowV1_0Address)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	want := "0x19de8ffcb747e5caadb3dda7435cf54992e87cdf0c90e5315ffa129dbb22461e"
	if hash != want {
		t.Fatalf("hash = %q, want %q", hash, want)
	}
}

func TestComputePayerAgnosticPaymentInfoHash_Golden8453_V1_0(t *testing.T) {
	hash, err := ComputePayerAgnosticPaymentInfoHash(big.NewInt(8453), mockPaymentInfo(), AuthCaptureEscrowV1_0Address)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	want := "0x198bbfeaab2f8e36302c662ae41bceaef47a1eb4bf2549cb87aa8daa7f7bb43a"
	if hash != want {
		t.Fatalf("hash = %q, want %q", hash, want)
	}
}

func TestComputePayerAgnosticPaymentInfoHash_Format(t *testing.T) {
	hash, err := ComputePayerAgnosticPaymentInfoHash(big.NewInt(84532), mockPaymentInfo())
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(hash) != 66 || hash[:2] != "0x" {
		t.Fatalf("unexpected hash format: %q", hash)
	}
}

func TestComputePayerAgnosticPaymentInfoHash_Deterministic(t *testing.T) {
	info := mockPaymentInfo()
	a, err := ComputePayerAgnosticPaymentInfoHash(big.NewInt(84532), info)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	b, err := ComputePayerAgnosticPaymentInfoHash(big.NewInt(84532), info)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if a != b {
		t.Fatalf("hashes differ: %q vs %q", a, b)
	}
}

func TestComputePayerAgnosticPaymentInfoHash_DifferentChainID(t *testing.T) {
	info := mockPaymentInfo()
	a, _ := ComputePayerAgnosticPaymentInfoHash(big.NewInt(84532), info)
	b, _ := ComputePayerAgnosticPaymentInfoHash(big.NewInt(8453), info)
	if a == b {
		t.Fatal("expected different hashes for different chain IDs")
	}
}

func TestComputePayerAgnosticPaymentInfoHash_DifferentPaymentInfo(t *testing.T) {
	info := mockPaymentInfo()
	other := info
	other.MaxAmount = "2000000"
	a, _ := ComputePayerAgnosticPaymentInfoHash(big.NewInt(84532), info)
	b, _ := ComputePayerAgnosticPaymentInfoHash(big.NewInt(84532), other)
	if a == b {
		t.Fatal("expected different hashes for different maxAmount")
	}
}

func TestComputePayerAgnosticPaymentInfoHash_DifferentSalt(t *testing.T) {
	info := mockPaymentInfo()
	other := info
	other.Salt = "0x0000000000000000000000000000000000000000000000000000000000000002"
	a, _ := ComputePayerAgnosticPaymentInfoHash(big.NewInt(84532), info)
	b, _ := ComputePayerAgnosticPaymentInfoHash(big.NewInt(84532), other)
	if a == b {
		t.Fatal("expected different hashes for different salt")
	}
}

func TestComputePayerAgnosticPaymentInfoHash_PayerAgnostic(t *testing.T) {
	base := mockPaymentInfo()
	a := base
	a.Payer = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	b := base
	b.Payer = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	c := base
	c.Payer = "0x0000000000000000000000000000000000000000"

	hashA, _ := ComputePayerAgnosticPaymentInfoHash(big.NewInt(84532), a)
	hashB, _ := ComputePayerAgnosticPaymentInfoHash(big.NewInt(84532), b)
	hashC, _ := ComputePayerAgnosticPaymentInfoHash(big.NewInt(84532), c)
	if hashA != hashB || hashA != hashC {
		t.Fatalf("expected payer-agnostic hashes to match: %q %q %q", hashA, hashB, hashC)
	}
}

func TestGenerateSalt(t *testing.T) {
	s1, err := GenerateSalt()
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	s2, err := GenerateSalt()
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(s1) != 66 || s1[:2] != "0x" {
		t.Fatalf("bad salt format: %q", s1)
	}
	if s1 == s2 {
		t.Fatal("expected unique salts")
	}
}

func TestSaltBinding(t *testing.T) {
	authorizer := "0x1111111111111111111111111111111111111111"
	zero := "0x0000000000000000000000000000000000000000"
	nonce := "0x0000000000000000000000000000000000000000000000000000000000000abc"

	if IsSaltBindingOn(AuthCaptureExtra{}) {
		t.Fatal("expected binding off for empty extra")
	}
	if IsSaltBindingOn(AuthCaptureExtra{ReceiverAuthorizer: zero, Policy: zero}) {
		t.Fatal("expected binding off for zero addresses")
	}
	if !IsSaltBindingOn(AuthCaptureExtra{ReceiverAuthorizer: authorizer}) {
		t.Fatal("expected binding on for non-zero receiverAuthorizer")
	}

	a, err := DeriveBoundSalt(authorizer, zero, nonce)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	b, err := DeriveBoundSalt(authorizer, zero, nonce)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if a != b {
		t.Fatalf("expected deterministic bound salt, got %q vs %q", a, b)
	}
	want := "0xd0967e09b6c8fccf96277d95a03e98583e8605ab10858b1349aa50ea6d78132c"
	if a != want {
		t.Fatalf("bound salt = %q, want %q", a, want)
	}

	base := a
	changedAuthorizer, _ := DeriveBoundSalt("0x2222222222222222222222222222222222222222", zero, nonce)
	if changedAuthorizer == base {
		t.Fatal("expected bound salt to change when receiverAuthorizer changes")
	}
	changedNonce, _ := DeriveBoundSalt(authorizer, zero, "0x0000000000000000000000000000000000000000000000000000000000000abd")
	if changedNonce == base {
		t.Fatal("expected bound salt to change when saltNonce changes")
	}
}

func TestTypeHashConstants(t *testing.T) {
	if SaltBindingTypeHash.Hex() != "0x8a2a7e41a0bda000ded071ff38b79401d2603e1826516ff2635b11fe9e30877f" {
		t.Fatalf("SaltBindingTypeHash = %s", SaltBindingTypeHash.Hex())
	}
	if PaymentInfoTypeHash.Hex() != "0xae68ac7ce30c86ece8196b61a7c486d8f0061f575037fbd34e7fe4e2820c6591" {
		t.Fatalf("PaymentInfoTypeHash = %s", PaymentInfoTypeHash.Hex())
	}
}
