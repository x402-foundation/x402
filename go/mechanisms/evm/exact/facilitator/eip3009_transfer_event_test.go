package facilitator

import (
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	goethtypes "github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
)

var transferEventTopic = crypto.Keccak256Hash([]byte("Transfer(address,address,uint256)"))

func makeTransferLog(token common.Address, from common.Address, to common.Address, value *big.Int) *goethtypes.Log {
	return &goethtypes.Log{
		Address: token,
		Topics: []common.Hash{
			transferEventTopic,
			common.BytesToHash(common.LeftPadBytes(from.Bytes(), 32)),
			common.BytesToHash(common.LeftPadBytes(to.Bytes(), 32)),
		},
		Data: common.LeftPadBytes(value.Bytes(), 32),
	}
}

func TestVerifyEIP3009TransferEvent(t *testing.T) {
	token := common.HexToAddress("0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29")
	otherToken := common.HexToAddress("0x0000000000000000000000000000000000000bad")
	payer := common.HexToAddress("0x1111111111111111111111111111111111111111")
	receiver := common.HexToAddress("0x2222222222222222222222222222222222222222")
	attacker := common.HexToAddress("0x3333333333333333333333333333333333333333")
	value := big.NewInt(1000)

	tests := []struct {
		name string
		logs []*goethtypes.Log
		want bool
	}{
		{
			name: "matches canonical Transfer event",
			logs: []*goethtypes.Log{
				makeTransferLog(token, payer, receiver, value),
			},
			want: true,
		},
		{
			name: "ignores unrelated logs",
			logs: []*goethtypes.Log{
				makeTransferLog(otherToken, attacker, receiver, big.NewInt(999)),
				makeTransferLog(token, payer, receiver, value),
			},
			want: true,
		},
		{
			name: "rejects different value",
			logs: []*goethtypes.Log{
				makeTransferLog(token, payer, receiver, big.NewInt(1)),
			},
		},
		{
			name: "rejects different recipient",
			logs: []*goethtypes.Log{
				makeTransferLog(token, payer, attacker, value),
			},
		},
		{
			name: "rejects different sender",
			logs: []*goethtypes.Log{
				makeTransferLog(token, attacker, receiver, value),
			},
		},
		{
			name: "rejects different token",
			logs: []*goethtypes.Log{
				makeTransferLog(otherToken, payer, receiver, value),
			},
		},
		{
			name: "rejects empty logs",
			logs: []*goethtypes.Log{},
		},
		{
			name: "address comparison is normalized",
			logs: []*goethtypes.Log{
				makeTransferLog(common.HexToAddress("0xe7c3d8c9a439fede00d2600032d5db0be71c3c29"), payer, receiver, value),
			},
			want: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := verifyEIP3009TransferEvent(tt.logs, token, expectedTransferEvent{
				From:  payer,
				To:    receiver,
				Value: value,
			})
			if err != nil {
				t.Fatalf("verifyEIP3009TransferEvent() error: %v", err)
			}
			if got != tt.want {
				t.Fatalf("verifyEIP3009TransferEvent() = %v, want %v", got, tt.want)
			}
		})
	}
}
