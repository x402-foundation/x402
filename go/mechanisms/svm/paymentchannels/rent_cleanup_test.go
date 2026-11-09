package paymentchannels

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// orderRentCleanupScan resumes a budget-limited backlog from where the previous
// pass stopped, so a backlog bigger than MaxTxsPerRun eventually reaches every
// record instead of only ever reprocessing the same earliest ones. Storage
// promises no ordering, so the manager sorts first: otherwise the cursor would
// mean something different on every storage implementation.
func TestOrderRentCleanupScan(t *testing.T) {
	sorted := []PaymentChannelRecord{{ChannelID: "a"}, {ChannelID: "b"}, {ChannelID: "c"}}
	unordered := []PaymentChannelRecord{{ChannelID: "c"}, {ChannelID: "a"}, {ChannelID: "b"}}

	assert.Equal(t, sorted, orderRentCleanupScan(unordered, ""), "no cursor scans from the start, in order")
	assert.Equal(t,
		[]PaymentChannelRecord{{ChannelID: "b"}, {ChannelID: "c"}, {ChannelID: "a"}},
		orderRentCleanupScan(unordered, "b"),
	)
	assert.Equal(t,
		[]PaymentChannelRecord{{ChannelID: "c"}, {ChannelID: "a"}, {ChannelID: "b"}},
		orderRentCleanupScan(unordered, "c"),
	)
	assert.Equal(t, sorted, orderRentCleanupScan(unordered, "gone"),
		"a cursor no longer present scans from the start")
	assert.Equal(t,
		[]PaymentChannelRecord{{ChannelID: "c"}, {ChannelID: "a"}, {ChannelID: "b"}},
		unordered,
		"the caller's slice is left alone",
	)
}
