package unit_test

import "github.com/x402-foundation/x402/go/mechanisms/evm"

// defaultTestWitness returns a standard Permit2Witness fixture for unit tests.
// Tests that need to vary one field should call this and override only that field,
// rather than repeating the full struct literal.
func defaultTestWitness() evm.Permit2Witness {
	return evm.Permit2Witness{
		To:         "0x9876543210987654321098765432109876543210",
		ValidAfter: "0",
	}
}
