package evm

import (
	"testing"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
)

// TestIsERC6492Signature tests ERC-6492 signature detection
func TestIsERC6492Signature(t *testing.T) {
	tests := []struct {
		name string
		sig  []byte
		want bool
	}{
		{
			name: "valid ERC-6492 signature",
			sig:  append(make([]byte, 100), erc6492MagicBytes...),
			want: true,
		},
		{
			name: "EOA signature (65 bytes)",
			sig:  make([]byte, 65),
			want: false,
		},
		{
			name: "short signature",
			sig:  make([]byte, 10),
			want: false,
		},
		{
			name: "empty signature",
			sig:  []byte{},
			want: false,
		},
		{
			name: "signature with wrong magic",
			sig:  append(make([]byte, 100), make([]byte, 32)...),
			want: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := IsERC6492Signature(tt.sig)
			if got != tt.want {
				t.Errorf("IsERC6492Signature() = %v, want %v", got, tt.want)
			}
		})
	}
}

// createERC6492Signature creates a valid ERC-6492 wrapped signature for testing
func createERC6492Signature(t *testing.T, factory common.Address, factoryData []byte, originalSig []byte) []byte {
	addressTy, err := abi.NewType("address", "", nil)
	if err != nil {
		t.Fatalf("failed to create address type: %v", err)
	}
	bytesTy, err := abi.NewType("bytes", "", nil)
	if err != nil {
		t.Fatalf("failed to create bytes type: %v", err)
	}

	arguments := abi.Arguments{
		{Type: addressTy},
		{Type: bytesTy},
		{Type: bytesTy},
	}

	packed, err := arguments.Pack(factory, factoryData, originalSig)
	if err != nil {
		t.Fatalf("failed to pack ERC-6492 data: %v", err)
	}

	return append(packed, erc6492MagicBytes...)
}

// TestParseERC6492Signature tests ERC-6492 signature parsing
func TestParseERC6492Signature(t *testing.T) {
	factory := common.HexToAddress("0x1234567890123456789012345678901234567890")
	factoryCalldata := []byte("factory calldata")
	originalSig := make([]byte, 65)
	for i := range originalSig {
		originalSig[i] = byte(i)
	}

	tests := []struct {
		name    string
		sig     func() []byte
		wantErr bool
		check   func(*testing.T, *ERC6492SignatureData)
	}{
		{
			name: "valid ERC-6492 signature",
			sig: func() []byte {
				return createERC6492Signature(t, factory, factoryCalldata, originalSig)
			},
			wantErr: false,
			check: func(t *testing.T, result *ERC6492SignatureData) {
				// Check factory address
				if common.BytesToAddress(result.Factory[:]) != factory {
					t.Errorf("Factory = %v, want %v", common.BytesToAddress(result.Factory[:]), factory)
				}
				// Check factory calldata
				if string(result.FactoryCalldata) != string(factoryCalldata) {
					t.Errorf("FactoryCalldata = %v, want %v", result.FactoryCalldata, factoryCalldata)
				}
				// Check inner signature
				if !bytesEqual(result.InnerSignature, originalSig) {
					t.Errorf("InnerSignature length = %d, want %d", len(result.InnerSignature), len(originalSig))
				}
			},
		},
		{
			name: "regular EOA signature (65 bytes)",
			sig: func() []byte {
				return originalSig
			},
			wantErr: false,
			check: func(t *testing.T, result *ERC6492SignatureData) {
				// Should return original signature
				if !bytesEqual(result.InnerSignature, originalSig) {
					t.Errorf("InnerSignature = %v, want original signature", result.InnerSignature)
				}
				// Factory should be zero address
				zeroAddr := [20]byte{}
				if result.Factory != zeroAddr {
					t.Errorf("Factory should be zero address for non-ERC-6492")
				}
				// Factory calldata should be empty
				if len(result.FactoryCalldata) != 0 {
					t.Errorf("FactoryCalldata should be empty for non-ERC-6492")
				}
			},
		},
		{
			name: "ERC-6492 with empty factory data",
			sig: func() []byte {
				return createERC6492Signature(t, factory, []byte{}, originalSig)
			},
			wantErr: false,
			check: func(t *testing.T, result *ERC6492SignatureData) {
				if len(result.FactoryCalldata) != 0 {
					t.Errorf("FactoryCalldata should be empty")
				}
			},
		},
		{
			name: "ERC-6492 with large signature",
			sig: func() []byte {
				largeSig := make([]byte, 200)
				return createERC6492Signature(t, factory, factoryCalldata, largeSig)
			},
			wantErr: false,
			check: func(t *testing.T, result *ERC6492SignatureData) {
				if len(result.InnerSignature) != 200 {
					t.Errorf("InnerSignature length = %d, want 200", len(result.InnerSignature))
				}
			},
		},
		{
			name: "empty signature",
			sig: func() []byte {
				return []byte{}
			},
			wantErr: false,
			check: func(t *testing.T, result *ERC6492SignatureData) {
				if len(result.InnerSignature) != 0 {
					t.Errorf("InnerSignature should be empty")
				}
			},
		},
		{
			name: "invalid ERC-6492 format (malformed ABI)",
			sig: func() []byte {
				// Create invalid data with magic suffix
				invalidData := make([]byte, 0, 10+len(erc6492MagicBytes))
				invalidData = append(invalidData, make([]byte, 10)...)
				return append(invalidData, erc6492MagicBytes...)
			},
			wantErr: true,
		},
		{
			name: "magic value only",
			sig: func() []byte {
				return erc6492MagicBytes
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sig := tt.sig()
			result, err := ParseERC6492Signature(sig)

			if tt.wantErr {
				if err == nil {
					t.Errorf("ParseERC6492Signature() error = nil, wantErr %v", tt.wantErr)
				}
				return
			}

			if err != nil {
				t.Errorf("ParseERC6492Signature() unexpected error = %v", err)
				return
			}

			if tt.check != nil {
				tt.check(t, result)
			}
		})
	}
}

// TestHexToBytes tests hex string to bytes conversion
func TestHexToBytes(t *testing.T) {
	tests := []struct {
		name    string
		hexStr  string
		want    []byte
		wantErr bool
	}{
		{
			name:    "hex with 0x prefix",
			hexStr:  "0x1234",
			want:    []byte{0x12, 0x34},
			wantErr: false,
		},
		{
			name:    "hex without 0x prefix",
			hexStr:  "1234",
			want:    []byte{0x12, 0x34},
			wantErr: false,
		},
		{
			name:    "empty string",
			hexStr:  "",
			want:    []byte{},
			wantErr: false,
		},
		{
			name:    "invalid hex",
			hexStr:  "0xGGGG",
			want:    nil,
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := HexToBytes(tt.hexStr)
			if (err != nil) != tt.wantErr {
				t.Errorf("HexToBytes() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if !tt.wantErr && !bytesEqual(got, tt.want) {
				t.Errorf("HexToBytes() = %v, want %v", got, tt.want)
			}
		})
	}
}

// Helper function to compare byte slices
func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
