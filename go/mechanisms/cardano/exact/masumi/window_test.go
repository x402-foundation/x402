package masumi

import (
	"math"
	"strconv"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The binding's expiry must never wrap: a negative expiry would make the
// termsDigest binding evictable while the terms can still pay.
func TestPaymentWindowEndRejectsOverflow(t *testing.T) {
	extra := &Extra{}
	extra.Terms.PayByTime = "1785756000000"
	end, err := paymentWindowEndMs(extra, 600)
	require.NoError(t, err)
	assert.Equal(t, int64(1785756600000), end)
	extra.Terms.PayByTime = strconv.FormatInt(math.MaxInt64-1, 10)
	_, err = paymentWindowEndMs(extra, 600)
	assert.Error(t, err)
	extra.Terms.PayByTime = "1785756000000"
	_, err = paymentWindowEndMs(extra, -1)
	assert.Error(t, err)
}
