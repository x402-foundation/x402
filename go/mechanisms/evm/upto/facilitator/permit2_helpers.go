package facilitator

import (
	"context"
	"math/big"

	"github.com/ethereum/go-ethereum/common"

	x402 "github.com/coinbase/x402/go"
	"github.com/coinbase/x402/go/mechanisms/evm"
)

// EIP2612PermitData holds the parsed EIP-2612 permit fields for settleWithPermit() calls.
type EIP2612PermitData struct {
	Value    *big.Int
	Deadline *big.Int
	R        [32]byte
	S        [32]byte
	V        uint8
}

// UptoPermit2SettleArgs holds the parsed and typed arguments for upto settle()/settleWithPermit().
// Differs from exact: witness includes Facilitator, and settle takes a separate Amount.
type UptoPermit2SettleArgs struct {
	Permit struct {
		Permitted struct {
			Token  common.Address
			Amount *big.Int
		}
		Nonce    *big.Int
		Deadline *big.Int
	}
	SettlementAmount *big.Int
	Owner            common.Address
	Witness          struct {
		To          common.Address
		Facilitator common.Address
		ValidAfter  *big.Int
	}
	Signature []byte
}

// BuildUptoPermit2SettleArgs converts a raw UptoPermit2Payload into typed contract-call arguments.
func BuildUptoPermit2SettleArgs(permit2Payload *evm.UptoPermit2Payload, settlementAmount *big.Int) (*UptoPermit2SettleArgs, error) {
	amount, ok := new(big.Int).SetString(permit2Payload.Permit2Authorization.Permitted.Amount, 10)
	if !ok {
		return nil, errParse("permitted amount")
	}
	nonce, ok := new(big.Int).SetString(permit2Payload.Permit2Authorization.Nonce, 10)
	if !ok {
		return nil, errParse("nonce")
	}
	deadline, ok := new(big.Int).SetString(permit2Payload.Permit2Authorization.Deadline, 10)
	if !ok {
		return nil, errParse("deadline")
	}
	validAfter, ok := new(big.Int).SetString(permit2Payload.Permit2Authorization.Witness.ValidAfter, 10)
	if !ok {
		return nil, errParse("validAfter")
	}
	signatureBytes, err := evm.HexToBytes(permit2Payload.Signature)
	if err != nil {
		return nil, err
	}

	args := &UptoPermit2SettleArgs{}
	args.Permit.Permitted.Token = common.HexToAddress(permit2Payload.Permit2Authorization.Permitted.Token)
	args.Permit.Permitted.Amount = amount
	args.Permit.Nonce = nonce
	args.Permit.Deadline = deadline
	args.SettlementAmount = settlementAmount
	args.Owner = common.HexToAddress(permit2Payload.Permit2Authorization.From)
	args.Witness.To = common.HexToAddress(permit2Payload.Permit2Authorization.Witness.To)
	args.Witness.Facilitator = common.HexToAddress(permit2Payload.Permit2Authorization.Witness.Facilitator)
	args.Witness.ValidAfter = validAfter
	args.Signature = signatureBytes
	return args, nil
}

func (a *UptoPermit2SettleArgs) permitStruct() interface{} {
	return struct {
		Permitted struct {
			Token  common.Address
			Amount *big.Int
		}
		Nonce    *big.Int
		Deadline *big.Int
	}{
		Permitted: struct {
			Token  common.Address
			Amount *big.Int
		}{
			Token:  a.Permit.Permitted.Token,
			Amount: a.Permit.Permitted.Amount,
		},
		Nonce:    a.Permit.Nonce,
		Deadline: a.Permit.Deadline,
	}
}

func (a *UptoPermit2SettleArgs) witnessStruct() interface{} {
	return struct {
		To          common.Address
		Facilitator common.Address
		ValidAfter  *big.Int
	}{
		To:          a.Witness.To,
		Facilitator: a.Witness.Facilitator,
		ValidAfter:  a.Witness.ValidAfter,
	}
}

// SimulateUptoPermit2Settle runs settle() via eth_call (ReadContract) on the upto proxy.
func SimulateUptoPermit2Settle(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	permit2Payload *evm.UptoPermit2Payload,
	settlementAmount *big.Int,
) (bool, error) {
	args, err := BuildUptoPermit2SettleArgs(permit2Payload, settlementAmount)
	if err != nil {
		return false, err
	}

	_, err = signer.ReadContract(
		ctx,
		evm.X402UptoPermit2ProxyAddress,
		evm.X402UptoPermit2ProxySettleABI,
		evm.FunctionSettle,
		args.permitStruct(),
		args.SettlementAmount,
		args.Owner,
		args.witnessStruct(),
		args.Signature,
	)
	if err != nil {
		return false, err
	}
	return true, nil
}

// SimulateUptoPermit2SettleWithPermit runs settleWithPermit() via eth_call on the upto proxy.
func SimulateUptoPermit2SettleWithPermit(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	permit2Payload *evm.UptoPermit2Payload,
	settlementAmount *big.Int,
	eip2612Signature, eip2612Amount, eip2612DeadlineStr string,
) (bool, error) {
	args, err := BuildUptoPermit2SettleArgs(permit2Payload, settlementAmount)
	if err != nil {
		return false, err
	}

	v, r, s, splitErr := splitEip2612Signature(eip2612Signature)
	if splitErr != nil {
		return false, splitErr
	}

	eip2612Value, ok := new(big.Int).SetString(eip2612Amount, 10)
	if !ok {
		return false, errParse("eip2612 amount")
	}
	eip2612Deadline, ok := new(big.Int).SetString(eip2612DeadlineStr, 10)
	if !ok {
		return false, errParse("eip2612 deadline")
	}

	permit2612Struct := EIP2612PermitData{
		Value:    eip2612Value,
		Deadline: eip2612Deadline,
		R:        r,
		S:        s,
		V:        v,
	}

	_, err = signer.ReadContract(
		ctx,
		evm.X402UptoPermit2ProxyAddress,
		evm.X402UptoPermit2ProxySettleWithPermitABI,
		evm.FunctionSettleWithPermit,
		permit2612Struct,
		args.permitStruct(),
		args.SettlementAmount,
		args.Owner,
		args.witnessStruct(),
		args.Signature,
	)
	if err != nil {
		return false, err
	}
	return true, nil
}

// uptoPermit2Multicall3 runs the standard 3-call multicall shared by the diagnostic and
// prerequisites helpers: [PERMIT2(), balanceOf(payer), thirdCall]. Returns (results,
// reqAmount, error). results is nil when the multicall itself fails; reqAmount is nil when
// amountRequired cannot be parsed.
func uptoPermit2Multicall3(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	tokenAddress string,
	payer string,
	amountRequired string,
	thirdCall evm.MulticallCall,
) ([]evm.MulticallResult, *big.Int, error) {
	results, err := evm.Multicall(ctx, signer, []evm.MulticallCall{
		{
			Address:      evm.X402UptoPermit2ProxyAddress,
			ABI:          evm.X402UptoPermit2ProxyPermit2ABI,
			FunctionName: "PERMIT2",
		},
		{
			Address:      tokenAddress,
			ABI:          evm.ERC20BalanceOfABI,
			FunctionName: "balanceOf",
			Args:         []interface{}{common.HexToAddress(payer)},
		},
		thirdCall,
	})
	if err != nil || len(results) < 3 {
		return nil, nil, err
	}
	reqAmount, _ := new(big.Int).SetString(amountRequired, 10)
	return results, reqAmount, nil
}

// DiagnoseUptoPermit2SimulationFailure runs a multicall diagnostic to return the most
// specific error reason after an upto simulation failure.
func DiagnoseUptoPermit2SimulationFailure(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	tokenAddress string,
	permit2Payload *evm.UptoPermit2Payload,
	amountRequired string,
) *x402.VerifyResponse {
	payer := permit2Payload.Permit2Authorization.From

	results, reqAmount, _ := uptoPermit2Multicall3(ctx, signer, tokenAddress, payer, amountRequired, evm.MulticallCall{
		Address:      tokenAddress,
		ABI:          evm.ERC20AllowanceABI,
		FunctionName: "allowance",
		Args:         []interface{}{common.HexToAddress(payer), common.HexToAddress(evm.PERMIT2Address)},
	})
	if results == nil {
		return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrPermit2SimulationFailed, Payer: payer}
	}

	if !results[0].Success() {
		return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrPermit2ProxyNotDeployed, Payer: payer}
	}

	if reqAmount == nil {
		return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrPermit2SimulationFailed, Payer: payer}
	}

	if results[1].Success() {
		if balance := asBigInt(results[1].Result); balance != nil && balance.Cmp(reqAmount) < 0 {
			return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrPermit2InsufficientBalance, Payer: payer}
		}
	}

	if results[2].Success() {
		if allowance := asBigInt(results[2].Result); allowance != nil && allowance.Cmp(reqAmount) < 0 {
			return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrPermit2AllowanceRequired, Payer: payer}
		}
	}

	return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrPermit2SimulationFailed, Payer: payer}
}

// CheckUptoPermit2Prerequisites checks proxy deployment, payer token balance and payer ETH balance for gas.
func CheckUptoPermit2Prerequisites(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	tokenAddress string,
	payer string,
	amountRequired string,
) *x402.VerifyResponse {
	results, reqAmount, _ := uptoPermit2Multicall3(ctx, signer, tokenAddress, payer, amountRequired, evm.MulticallCall{
		Address:      evm.MULTICALL3Address,
		ABI:          evm.Multicall3GetEthBalanceABI,
		FunctionName: "getEthBalance",
		Args:         []interface{}{common.HexToAddress(payer)},
	})
	if results == nil {
		return &x402.VerifyResponse{IsValid: true, Payer: payer} // fail-open on multicall error
	}

	if !results[0].Success() {
		return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrPermit2ProxyNotDeployed, Payer: payer}
	}

	if reqAmount != nil && results[1].Success() {
		if balance := asBigInt(results[1].Result); balance != nil && balance.Cmp(reqAmount) < 0 {
			return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrPermit2InsufficientBalance, Payer: payer}
		}
	}

	if results[2].Success() {
		minEthForGas := new(big.Int).Mul(
			big.NewInt(int64(evm.ERC20ApproveGasLimit)),
			big.NewInt(int64(evm.DefaultMaxFeePerGas)),
		)
		if ethBalance := asBigInt(results[2].Result); ethBalance != nil && ethBalance.Cmp(minEthForGas) < 0 {
			return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrErc20ApprovalInsufficientEth, Payer: payer}
		}
	}

	return &x402.VerifyResponse{IsValid: true, Payer: payer}
}

func errParse(field string) error {
	return &parseError{field: field}
}

type parseError struct {
	field string
}

func (e *parseError) Error() string {
	return "invalid " + e.field
}

func asBigInt(value interface{}) *big.Int {
	switch v := value.(type) {
	case *big.Int:
		return v
	case big.Int:
		return &v
	default:
		return nil
	}
}

var splitEip2612Signature = evm.SplitEip2612Signature
