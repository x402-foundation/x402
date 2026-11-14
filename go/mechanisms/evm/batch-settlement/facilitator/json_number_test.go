package facilitator

import (
	"encoding/json"
	"errors"
	"testing"

	x402 "github.com/x402-foundation/x402/go/v2"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
)

func TestValidateChannelConfigJSONNumberWithdrawDelayMismatch(t *testing.T) {
	cfg := validConfig()
	id, _ := batchsettlement.ComputeChannelId(cfg, "eip155:8453")
	r := reqs(cfg.Receiver, cfg.Token)
	r.Extra = map[string]interface{}{
		"receiverAuthorizer": cfg.ReceiverAuthorizer,
		"withdrawDelay":      json.Number("2000"),
	}
	err := ValidateChannelConfig(cfg, id, r)
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrWithdrawDelayMismatch {
		t.Fatalf("got %v", err)
	}
}

func TestOptionalUintStringJSONNumber(t *testing.T) {
	if got := optionalUintString(json.Number("123456789012345678901")); got == nil || *got != "123456789012345678901" {
		t.Fatalf("got %v", got)
	}
	for _, bad := range []json.Number{"-1", "1.5"} {
		if got := optionalUintString(bad); got != nil {
			t.Fatalf("optionalUintString(%q) = %q, want nil", bad, *got)
		}
	}
}

func TestExtraNumberJSONNumber(t *testing.T) {
	if n, ok := extraNumber(json.Number("42")); !ok || n != 42 {
		t.Fatalf("got (%d, %v)", n, ok)
	}
}
