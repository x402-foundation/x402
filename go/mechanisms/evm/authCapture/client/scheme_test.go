package client

import (
	"math/big"
	"testing"
)

func TestParseUint120Amount(t *testing.T) {
	maxUint120 := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 120), big.NewInt(1)).String()
	overflowUint120 := new(big.Int).Lsh(big.NewInt(1), 120).String()

	tests := []struct {
		name    string
		amount  string
		wantErr bool
	}{
		{name: "zero", amount: "0"},
		{name: "one", amount: "1"},
		{name: "max uint120", amount: maxUint120},
		{name: "negative", amount: "-1", wantErr: true},
		{name: "overflow uint120", amount: overflowUint120, wantErr: true},
		{name: "decimal", amount: "1.5", wantErr: true},
		{name: "empty", amount: "", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := parseUint120Amount(tt.amount)
			if tt.wantErr && err == nil {
				t.Fatalf("expected error for amount %q", tt.amount)
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("unexpected error for amount %q: %v", tt.amount, err)
			}
		})
	}
}
