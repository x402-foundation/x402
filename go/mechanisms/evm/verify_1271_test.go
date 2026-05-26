package evm

import (
	"context"
	"errors"
	"math/big"
	"testing"
)

// mockFacilitatorSigner implements FacilitatorEvmSigner for testing
type mockFacilitatorSigner struct {
	readContractResult interface{}
	readContractError  error
	getCodeResult      []byte
	getCodeError       error
}

func (m *mockFacilitatorSigner) GetAddresses() []string {
	return []string{"0x0000000000000000000000000000000000000000"}
}

func (m *mockFacilitatorSigner) ReadContract(
	ctx context.Context,
	address string,
	abi []byte,
	functionName string,
	args ...interface{},
) (interface{}, error) {
	if m.readContractError != nil {
		return nil, m.readContractError
	}
	return m.readContractResult, nil
}

func (m *mockFacilitatorSigner) VerifyTypedData(
	ctx context.Context,
	address string,
	domain TypedDataDomain,
	types map[string][]TypedDataField,
	primaryType string,
	message map[string]interface{},
	signature []byte,
) (bool, error) {
	return false, errors.New("not implemented")
}

func (m *mockFacilitatorSigner) WriteContract(
	ctx context.Context,
	address string,
	abi []byte,
	functionName string,
	args ...interface{},
) (string, error) {
	return "", errors.New("not implemented")
}

func (m *mockFacilitatorSigner) SendTransaction(
	ctx context.Context,
	to string,
	data []byte,
) (string, error) {
	return "", errors.New("not implemented")
}

func (m *mockFacilitatorSigner) WaitForTransactionReceipt(
	ctx context.Context,
	txHash string,
) (*TransactionReceipt, error) {
	return nil, errors.New("not implemented")
}

func (m *mockFacilitatorSigner) GetBalance(
	ctx context.Context,
	address string,
	tokenAddress string,
) (*big.Int, error) {
	return big.NewInt(0), nil
}

func (m *mockFacilitatorSigner) GetChainID(ctx context.Context) (*big.Int, error) {
	return big.NewInt(1), nil
}

func (m *mockFacilitatorSigner) GetCode(
	ctx context.Context,
	address string,
) ([]byte, error) {
	if m.getCodeError != nil {
		return nil, m.getCodeError
	}
	return m.getCodeResult, nil
}

func TestVerifyEIP1271Signature(t *testing.T) {
	ctx := context.Background()
	wallet := "0x1234567890123456789012345678901234567890"
	testHash := [32]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32}
	testSignature := []byte("test signature")

	tests := []struct {
		name               string
		readContractResult interface{}
		readContractError  error
		want               bool
		wantErr            bool
	}{
		{
			name:               "valid EIP-1271 signature",
			readContractResult: []byte{0x16, 0x26, 0xba, 0x7e}, // Valid magic value
			readContractError:  nil,
			want:               true,
			wantErr:            false,
		},
		{
			name:               "invalid magic value",
			readContractResult: []byte{0x00, 0x00, 0x00, 0x00},
			readContractError:  nil,
			want:               false,
			wantErr:            false,
		},
		{
			name:               "contract call fails",
			readContractResult: nil,
			readContractError:  errors.New("contract call failed"),
			want:               false,
			wantErr:            true,
		},
		{
			name:               "invalid return type",
			readContractResult: "not bytes",
			readContractError:  nil,
			want:               false,
			wantErr:            true,
		},
		{
			name:               "return value too short",
			readContractResult: []byte{0x16},
			readContractError:  nil,
			want:               false,
			wantErr:            true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mock := &mockFacilitatorSigner{
				readContractResult: tt.readContractResult,
				readContractError:  tt.readContractError,
			}

			got, err := VerifyEIP1271Signature(ctx, mock, wallet, testHash, testSignature)

			if (err != nil) != tt.wantErr {
				t.Errorf("VerifyEIP1271Signature() error = %v, wantErr %v", err, tt.wantErr)
				return
			}

			if !tt.wantErr && got != tt.want {
				t.Errorf("VerifyEIP1271Signature() = %v, want %v", got, tt.want)
			}
		})
	}
}
