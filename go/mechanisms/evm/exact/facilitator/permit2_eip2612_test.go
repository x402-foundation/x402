package facilitator

import (
	"fmt"
	"testing"
	"time"

	"github.com/x402-foundation/x402/go/extensions/eip2612gassponsor"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
)

func TestValidateEip2612PermitForPayment(t *testing.T) {
	payer := "0x857b06519E91e3A54538791bDbb0E22373e36b66"
	tokenAddress := "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
	futureDeadline := fmt.Sprintf("%d", time.Now().Unix()+300)

	t.Run("accepts valid EIP-2612 extension info", func(t *testing.T) {
		info := &eip2612gassponsor.Info{
			From:      payer,
			Asset:     tokenAddress,
			Spender:   evm.PERMIT2Address,
			Amount:    "115792089237316195423570985008687907853269984665640564039457584007913129639935",
			Nonce:     "0",
			Deadline:  futureDeadline,
			Signature: "0x" + "ab" + "cd" + "ef" + "1234567890abcdef1234567890abcdef12345678",
			Version:   "1",
		}
		result := validateEip2612PermitForPayment(info, payer, tokenAddress)
		if result != "" {
			t.Errorf("expected valid, got error: %s", result)
		}
	})

	t.Run("rejects mismatched from/payer", func(t *testing.T) {
		info := &eip2612gassponsor.Info{
			From:      "0x0000000000000000000000000000000000000001",
			Asset:     tokenAddress,
			Spender:   evm.PERMIT2Address,
			Amount:    "100",
			Nonce:     "0",
			Deadline:  futureDeadline,
			Signature: "0xabcdef1234567890abcdef1234567890abcdef12",
			Version:   "1",
		}
		result := validateEip2612PermitForPayment(info, payer, tokenAddress)
		if result != "eip2612_from_mismatch" {
			t.Errorf("expected eip2612_from_mismatch, got: %s", result)
		}
	})

	t.Run("rejects mismatched asset/token", func(t *testing.T) {
		info := &eip2612gassponsor.Info{
			From:      payer,
			Asset:     "0x0000000000000000000000000000000000000001",
			Spender:   evm.PERMIT2Address,
			Amount:    "100",
			Nonce:     "0",
			Deadline:  futureDeadline,
			Signature: "0xabcdef1234567890abcdef1234567890abcdef12",
			Version:   "1",
		}
		result := validateEip2612PermitForPayment(info, payer, tokenAddress)
		if result != "eip2612_asset_mismatch" {
			t.Errorf("expected eip2612_asset_mismatch, got: %s", result)
		}
	})

	t.Run("rejects wrong spender (not Permit2)", func(t *testing.T) {
		info := &eip2612gassponsor.Info{
			From:      payer,
			Asset:     tokenAddress,
			Spender:   "0x0000000000000000000000000000000000000001",
			Amount:    "100",
			Nonce:     "0",
			Deadline:  futureDeadline,
			Signature: "0xabcdef1234567890abcdef1234567890abcdef12",
			Version:   "1",
		}
		result := validateEip2612PermitForPayment(info, payer, tokenAddress)
		if result != "eip2612_spender_not_permit2" {
			t.Errorf("expected eip2612_spender_not_permit2, got: %s", result)
		}
	})

	t.Run("rejects expired deadline", func(t *testing.T) {
		info := &eip2612gassponsor.Info{
			From:      payer,
			Asset:     tokenAddress,
			Spender:   evm.PERMIT2Address,
			Amount:    "100",
			Nonce:     "0",
			Deadline:  "1000000000", // 2001 - well in the past
			Signature: "0xabcdef1234567890abcdef1234567890abcdef12",
			Version:   "1",
		}
		result := validateEip2612PermitForPayment(info, payer, tokenAddress)
		if result != "eip2612_deadline_expired" {
			t.Errorf("expected eip2612_deadline_expired, got: %s", result)
		}
	})
}

func TestSplitEip2612Signature(t *testing.T) {
	t.Run("correctly splits a 65-byte signature", func(t *testing.T) {
		// 32 bytes r + 32 bytes s + 1 byte v
		sig := "0x" +
			"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" + // r (32 bytes)
			"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" + // s (32 bytes)
			"1b" // v = 27

		v, r, s, err := splitEip2612Signature(sig)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}

		if v != 27 {
			t.Errorf("expected v=27, got %d", v)
		}

		// Check r is all 0xaa
		for _, b := range r {
			if b != 0xaa {
				t.Errorf("expected r bytes to be 0xaa, got %x", b)
				break
			}
		}

		// Check s is all 0xbb
		for _, b := range s {
			if b != 0xbb {
				t.Errorf("expected s bytes to be 0xbb, got %x", b)
				break
			}
		}
	})

	t.Run("rejects signature that is not 65 bytes", func(t *testing.T) {
		_, _, _, err := splitEip2612Signature("0xaabb")
		if err == nil {
			t.Fatal("expected error for short signature")
		}
	})
}
