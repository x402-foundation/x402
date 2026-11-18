package facilitator

import (
	"math/big"
	"testing"

	"github.com/stretchr/testify/assert"

	authcapture "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture"
)

func TestValidateSubmittedFee(t *testing.T) {
	extra := authcapture.AuthCaptureExtra{FeeRecipient: facFeeRecipient, MinFeeBps: 10, MaxFeeBps: 100}
	amount := big.NewInt(1_000_000)
	bps := func(v uint16) authcapture.CaptureFee { return authcapture.CaptureFee{Bps: &v} }
	flat := func(v int64) authcapture.CaptureFee { return authcapture.CaptureFee{Amount: big.NewInt(v)} }

	tests := []struct {
		name     string
		extra    authcapture.AuthCaptureExtra
		fee      authcapture.CaptureFee
		receiver string
		want     string
	}{
		{name: "bps at the lower bound", extra: extra, fee: bps(10), receiver: facFeeRecipient},
		{name: "bps at the upper bound", extra: extra, fee: bps(100), receiver: facFeeRecipient},
		{name: "amount at the lower bound", extra: extra, fee: flat(1000), receiver: facFeeRecipient},
		{name: "amount at the upper bound", extra: extra, fee: flat(10000), receiver: facFeeRecipient},
		{name: "receiver compared case-insensitively", extra: extra, fee: bps(50), receiver: "0x" + "3333333333333333333333333333333333333333"},
		{name: "bps below the range", extra: extra, fee: bps(9), receiver: facFeeRecipient, want: ErrFeeBpsOutOfRange},
		{name: "bps above the range", extra: extra, fee: bps(101), receiver: facFeeRecipient, want: ErrFeeBpsOutOfRange},
		{name: "amount below the range", extra: extra, fee: flat(999), receiver: facFeeRecipient, want: ErrFeeBpsOutOfRange},
		{name: "amount above the range", extra: extra, fee: flat(10001), receiver: facFeeRecipient, want: ErrFeeBpsOutOfRange},
		{name: "receiver differs from feeRecipient", extra: extra, fee: bps(50), receiver: "0x" + "8888888888888888888888888888888888888888", want: ErrFeeReceiver},
		{name: "receiver is not an address", extra: extra, fee: bps(50), receiver: "nope", want: ErrFeeReceiver},
		{
			name:     "an open feeRecipient accepts any receiver",
			extra:    authcapture.AuthCaptureExtra{FeeRecipient: authcapture.ZeroAddress, MaxFeeBps: 100},
			fee:      bps(50),
			receiver: "0x" + "8888888888888888888888888888888888888888",
		},
		{
			name:     "a fee needs a receiver",
			extra:    authcapture.AuthCaptureExtra{FeeRecipient: authcapture.ZeroAddress, MaxFeeBps: 100},
			fee:      bps(50),
			receiver: authcapture.ZeroAddress,
			want:     ErrZeroFeeReceiver,
		},
		{
			name:     "no fee needs no receiver",
			extra:    authcapture.AuthCaptureExtra{FeeRecipient: authcapture.ZeroAddress, MaxFeeBps: 100},
			fee:      bps(0),
			receiver: authcapture.ZeroAddress,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			assert.Equal(t, test.want, validateSubmittedFee(test.extra, amount, test.fee, test.receiver))
		})
	}
}

func TestParseSubmittedFee(t *testing.T) {
	v1_0 := authcapture.ResolveAuthCaptureDeployment(authcapture.AuthCaptureEscrowV1_0Address)
	v1_1 := authcapture.ResolveAuthCaptureDeployment("")
	bps := uint16(25)

	fee, ok := parseSubmittedFee(&bps, "", v1_0)
	assert.True(t, ok)
	assert.Equal(t, bps, *fee.Bps)

	_, ok = parseSubmittedFee(&bps, "5", v1_0)
	assert.False(t, ok, "v1.0 carries only feeBps")
	_, ok = parseSubmittedFee(nil, "", v1_0)
	assert.False(t, ok)

	fee, ok = parseSubmittedFee(nil, "5", v1_1)
	assert.True(t, ok)
	assert.Equal(t, int64(5), fee.Amount.Int64())

	_, ok = parseSubmittedFee(&bps, "5", v1_1)
	assert.False(t, ok, "v1.1 carries only feeAmount")
	_, ok = parseSubmittedFee(nil, "-5", v1_1)
	assert.False(t, ok)
}

func TestFeeAmountOf(t *testing.T) {
	amount := big.NewInt(1_000_000)
	bps := uint16(50)

	assert.Equal(t, int64(5000), feeAmountOf(authcapture.CaptureFee{Bps: &bps}, amount).Int64())
	assert.Equal(t, int64(42), feeAmountOf(authcapture.CaptureFee{Amount: big.NewInt(42)}, amount).Int64())
}
