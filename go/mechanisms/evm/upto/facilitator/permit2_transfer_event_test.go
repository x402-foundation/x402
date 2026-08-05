package facilitator

import (
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	goethtypes "github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
)

var uptoTransferEventTopic = crypto.Keccak256Hash([]byte("Transfer(address,address,uint256)"))

func makeUptoTransferLog(token common.Address, from common.Address, to common.Address, value *big.Int) *goethtypes.Log {
	return &goethtypes.Log{
		Address: token,
		Topics: []common.Hash{
			uptoTransferEventTopic,
			common.BytesToHash(common.LeftPadBytes(from.Bytes(), 32)),
			common.BytesToHash(common.LeftPadBytes(to.Bytes(), 32)),
		},
		Data: common.LeftPadBytes(value.Bytes(), 32),
	}
}

func TestVerifyUptoTransferEvent(t *testing.T) {
	token := common.HexToAddress("0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29")
	otherToken := common.HexToAddress("0x0000000000000000000000000000000000000bad")
	payer := common.HexToAddress("0x1111111111111111111111111111111111111111")
	receiver := common.HexToAddress("0x2222222222222222222222222222222222222222")
	attacker := common.HexToAddress("0x3333333333333333333333333333333333333333")
	settlement := big.NewInt(600)

	tests := []struct {
		name string
		logs []*goethtypes.Log
		want bool
	}{
		{
			name: "matches canonical Transfer event of the settlement amount",
			logs: []*goethtypes.Log{
				makeUptoTransferLog(token, payer, receiver, settlement),
			},
			want: true,
		},
		{
			name: "rejects deflationary amount below settlement",
			logs: []*goethtypes.Log{
				makeUptoTransferLog(token, payer, receiver, big.NewInt(599)),
			},
			want: false,
		},
		{
			name: "rejects permitted-max amount instead of settlement amount",
			logs: []*goethtypes.Log{
				makeUptoTransferLog(token, payer, receiver, big.NewInt(1000)),
			},
			want: false,
		},
		{
			name: "rejects funds sent to a different recipient",
			logs: []*goethtypes.Log{
				makeUptoTransferLog(token, payer, attacker, settlement),
			},
			want: false,
		},
		{
			name: "ignores Transfer events from a different token contract",
			logs: []*goethtypes.Log{
				makeUptoTransferLog(otherToken, payer, receiver, settlement),
			},
			want: false,
		},
		{
			name: "no logs at all does not match",
			logs: []*goethtypes.Log{},
			want: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := verifyUptoTransferEvent(tt.logs, token, expectedUptoTransferEvent{
				From:  payer,
				To:    receiver,
				Value: settlement,
			})
			if err != nil {
				t.Fatalf("verifyUptoTransferEvent returned error: %v", err)
			}
			if got != tt.want {
				t.Fatalf("verifyUptoTransferEvent = %v, want %v", got, tt.want)
			}
		})
	}
}
