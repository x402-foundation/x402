package upto

import (
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/types"
)

func newRequirements(extra map[string]interface{}) types.PaymentRequirements {
	return types.PaymentRequirements{
		Scheme:            "upto",
		Network:           "solana-devnet",
		Amount:            "10000",
		Asset:             "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
		PayTo:             solana.SysVarRentPubkey.String(),
		MaxTimeoutSeconds: 600,
		Extra:             extra,
	}
}

func TestResolvePaymentChannelConfig(t *testing.T) {
	feePayer := solana.SysVarClockPubkey.String()
	authorizer := solana.SystemProgramID.String()
	requirements := newRequirements(map[string]interface{}{
		ExtraFeePayer:           feePayer,
		ExtraReceiverAuthorizer: authorizer,
		ExtraWithdrawDelay:      float64(3600),
	})

	config, err := ResolvePaymentChannelConfig(requirements)
	require.NoError(t, err)

	assert.Equal(t, feePayer, config.FeePayer)
	assert.Equal(t, authorizer, config.ReceiverAuthorizer)
	assert.Equal(t, uint32(3600), config.WithdrawDelay)
	assert.Equal(t, []paymentchannels.Split{
		{Recipient: requirements.PayTo, BPS: paymentchannels.BasisPointsDenominator},
	}, config.Splits, "the whole distribution goes to payTo; the payee seat keeps no implicit remainder")
}

func TestResolvePaymentChannelConfigRejectsIncompleteChallenges(t *testing.T) {
	feePayer := solana.SysVarClockPubkey.String()
	authorizer := solana.SystemProgramID.String()

	tests := []struct {
		name      string
		extra     map[string]interface{}
		wantError string
	}{
		{
			name:      "missing fee payer",
			extra:     map[string]interface{}{ExtraReceiverAuthorizer: authorizer, ExtraWithdrawDelay: float64(1)},
			wantError: "feePayer must be a non-empty string",
		},
		{
			name:      "empty fee payer",
			extra:     map[string]interface{}{ExtraFeePayer: "", ExtraReceiverAuthorizer: authorizer},
			wantError: "feePayer must be a non-empty string",
		},
		{
			name:      "missing receiver authorizer",
			extra:     map[string]interface{}{ExtraFeePayer: feePayer, ExtraWithdrawDelay: float64(1)},
			wantError: "receiverAuthorizer must be a non-empty string",
		},
		{
			name:      "missing withdraw delay",
			extra:     map[string]interface{}{ExtraFeePayer: feePayer, ExtraReceiverAuthorizer: authorizer},
			wantError: "withdrawDelay must be an integer greater than zero",
		},
		{
			name: "fractional withdraw delay",
			extra: map[string]interface{}{
				ExtraFeePayer: feePayer, ExtraReceiverAuthorizer: authorizer, ExtraWithdrawDelay: 12.5,
			},
			wantError: "withdrawDelay must be an integer greater than zero",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := ResolvePaymentChannelConfig(newRequirements(test.extra))

			require.ErrorContains(t, err, test.wantError)
		})
	}
}

func TestParseWithdrawDelay(t *testing.T) {
	tests := []struct {
		name    string
		value   interface{}
		want    uint32
		wantErr bool
	}{
		{name: "json number", value: float64(900), want: 900},
		{name: "int", value: 900, want: 900},
		{name: "int64", value: int64(900), want: 900},
		{name: "uint32", value: uint32(900), want: 900},
		{name: "zero", value: float64(0), wantErr: true},
		{name: "negative", value: float64(-1), wantErr: true},
		{name: "fractional", value: 1.5, wantErr: true},
		{name: "string", value: "900", wantErr: true},
		{name: "absent", value: nil, wantErr: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := ParseWithdrawDelay(test.value)

			if test.wantErr {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, test.want, got)
		})
	}
}

func TestParseExtraUint64(t *testing.T) {
	tests := []struct {
		name   string
		value  interface{}
		want   uint64
		wantOK bool
	}{
		{name: "decimal string", value: "341000000", want: 341_000_000, wantOK: true},
		{name: "json number", value: float64(341000000), want: 341_000_000, wantOK: true},
		{name: "uint64", value: uint64(7), want: 7, wantOK: true},
		{name: "negative", value: -1},
		{name: "fractional", value: 1.5},
		{name: "non-numeric string", value: "soon"},
		{name: "absent", value: nil},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, ok := ParseExtraUint64(test.value)

			assert.Equal(t, test.wantOK, ok)
			if test.wantOK {
				assert.Equal(t, test.want, got)
			}
		})
	}
}

func TestResolveTokenProgram(t *testing.T) {
	tests := []struct {
		name      string
		hint      interface{}
		want      solana.PublicKey
		wantError string
	}{
		{name: "no hint reads the registry", hint: nil, want: solana.TokenProgramID},
		{name: "token-2022 hint", hint: solana.Token2022ProgramID.String(), want: solana.Token2022ProgramID},
		{name: "legacy hint", hint: solana.TokenProgramID.String(), want: solana.TokenProgramID},
		{name: "malformed hint", hint: "not-an-address", wantError: "not a valid base58 address"},
		{
			name:      "unsupported program",
			hint:      solana.SystemProgramID.String(),
			wantError: "is not a supported SPL token program",
		},
		{
			name:      "non-string hint is a broken challenge, not an absent one",
			hint:      float64(12345),
			wantError: "not a valid base58 address",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			extra := map[string]interface{}{}
			if test.hint != nil {
				extra[ExtraTokenProgram] = test.hint
			}

			got, err := ResolveTokenProgram(newRequirements(extra))

			if test.wantError != "" {
				require.ErrorContains(t, err, test.wantError)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, test.want, got)
		})
	}
}

// Without a hint the facilitator must infer the program from the mint, or it would
// expect a legacy SPL Token open for a Token-2022 stablecoin and reject the
// client's correct transaction.
func TestResolveTokenProgramInfersTokenProgramFromTheMint(t *testing.T) {
	tests := []struct {
		name  string
		asset string
		want  solana.PublicKey
	}{
		{name: "USDC is SPL Token", asset: svm.USDCDevnetAddress, want: solana.TokenProgramID},
		{name: "PYUSD is Token-2022", asset: svm.PYUSDDevnetAddress, want: solana.Token2022ProgramID},
		{name: "CASH is Token-2022", asset: svm.CASHMainnetAddress, want: solana.Token2022ProgramID},
		{
			name:  "unregistered mints stay on SPL Token",
			asset: solana.SysVarClockPubkey.String(),
			want:  solana.TokenProgramID,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			requirements := newRequirements(nil)
			requirements.Asset = test.asset

			got, err := ResolveTokenProgram(requirements)

			require.NoError(t, err)
			assert.Equal(t, test.want, got)
		})
	}
}
