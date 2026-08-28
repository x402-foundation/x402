package paymentchannels

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestOpenArgsRoundTrip(t *testing.T) {
	recipient := testKeypair(t).PublicKey().String()
	args := OpenArgs{
		Salt:        7,
		Deposit:     123456,
		GracePeriod: 900,
		OpenSlot:    999,
		Recipients:  []Split{{Recipient: recipient, BPS: BasisPointsDenominator}},
	}

	encoded, err := EncodeOpenArgs(args)
	require.NoError(t, err)
	decoded, err := DecodeOpenArgs(encoded)
	require.NoError(t, err)
	assert.Equal(t, args, decoded)

	_, err = DecodeOpenArgs(append(encoded, 0x00))
	require.ErrorContains(t, err, "recipient section")
}
