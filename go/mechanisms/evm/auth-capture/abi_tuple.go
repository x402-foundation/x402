package authcapture

import (
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
)

// PaymentInfoAbiTuple is the go-ethereum abi-encodable form of the onchain
// PaymentInfo struct (field order and types must match paymentInfoTupleABI
// in constants.go exactly).
type PaymentInfoAbiTuple struct {
	Operator            common.Address
	Payer               common.Address
	Receiver            common.Address
	Token               common.Address
	MaxAmount           *big.Int
	PreApprovalExpiry   *big.Int
	AuthorizationExpiry *big.Int
	RefundExpiry        *big.Int
	MinFeeBps           uint16
	MaxFeeBps           uint16
	FeeReceiver         common.Address
	Salt                *big.Int
}

// ToAbiTuple converts a PaymentInfoStruct (wire/string form) into the
// go-ethereum abi-encodable tuple used for authorize/capture/void contract calls.
func (p PaymentInfoStruct) ToAbiTuple() (PaymentInfoAbiTuple, error) {
	maxAmount, ok := new(big.Int).SetString(p.MaxAmount, 10)
	if !ok {
		return PaymentInfoAbiTuple{}, fmt.Errorf("invalid maxAmount: %s", p.MaxAmount)
	}
	saltBig, err := saltToBigInt(p.Salt)
	if err != nil {
		return PaymentInfoAbiTuple{}, err
	}
	return PaymentInfoAbiTuple{
		Operator:            common.HexToAddress(p.Operator),
		Payer:               common.HexToAddress(p.Payer),
		Receiver:            common.HexToAddress(p.Receiver),
		Token:               common.HexToAddress(p.Token),
		MaxAmount:           maxAmount,
		PreApprovalExpiry:   new(big.Int).SetUint64(p.PreApprovalExpiry),
		AuthorizationExpiry: new(big.Int).SetUint64(p.AuthorizationExpiry),
		RefundExpiry:        new(big.Int).SetUint64(p.RefundExpiry),
		MinFeeBps:           p.MinFeeBps,
		MaxFeeBps:           p.MaxFeeBps,
		FeeReceiver:         common.HexToAddress(p.FeeReceiver),
		Salt:                saltBig,
	}, nil
}
