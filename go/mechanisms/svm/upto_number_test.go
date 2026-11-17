package svm

import (
	"testing"

	"github.com/x402-foundation/x402/go/v2/types"
)

func uptoPayloadFromJSON(t *testing.T, expiresAt string) (*UptoSvmPayload, error) {
	t.Helper()
	body := `{"x402Version":2,"accepted":{"scheme":"upto","network":"solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1","amount":"1","asset":"a","payTo":"b","maxTimeoutSeconds":60},` +
		`"payload":{"from":"f","maxAmount":"1","expiresAt":` + expiresAt + `,"validAfter":1.0e0,"nonce":"1","openSlot":"5","channelId":"c","deposit":"1","authorizedSigner":"s","openTransaction":"dGVzdA=="}}`
	p, err := types.ToPaymentPayload([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	return UptoPayloadFromMap(p.Payload)
}

func TestUptoPayloadFromMapIntegralDecimals(t *testing.T) {
	for _, in := range []string{"1900000000", "1900000000.0", "1.9e9"} {
		p, err := uptoPayloadFromJSON(t, in)
		if err != nil {
			t.Fatalf("expiresAt %s: %v", in, err)
		}
		if p.ExpiresAt != 1900000000 || p.ValidAfter != 1 {
			t.Fatalf("expiresAt %s decoded as %d / %d", in, p.ExpiresAt, p.ValidAfter)
		}
	}
	if _, err := uptoPayloadFromJSON(t, "1900000000.5"); err == nil {
		t.Fatal("fractional expiresAt accepted")
	}
}
