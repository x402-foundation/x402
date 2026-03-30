package facilitator

import (
	"context"
	"math/big"

	"github.com/ethereum/go-ethereum/common"

	x402 "github.com/coinbase/x402/go"
	"github.com/coinbase/x402/go/mechanisms/evm"
)

// Permit2SettleArgs holds the parsed and typed arguments for settle() / settleWithPermit().
type Permit2SettleArgs struct {
	Permit struct {
		Permitted struct {
			Token  common.Address
			Amount *big.Int
		}
		Nonce    *big.Int
		Deadline *big.Int
	}
	Owner   common.Address
	Witness struct {
		To         common.Address
		ValidAfter *big.Int
	}
	Signature []byte
}

// BuildPermit2SettleArgs converts a raw ExactPermit2Payload into typed contract-call
// arguments, deduplicating the struct construction shared by verify simulation and settle.
func BuildPermit2SettleArgs(permit2Payload *evm.ExactPermit2Payload) (*Permit2SettleArgs, error) {
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

	args := &Permit2SettleArgs{}
	args.Permit.Permitted.Token = common.HexToAddress(permit2Payload.Permit2Authorization.Permitted.Token)
	args.Permit.Permitted.Amount = amount
	args.Permit.Nonce = nonce
	args.Permit.Deadline = deadline
	args.Owner = common.HexToAddress(permit2Payload.Permit2Authorization.From)
	args.Witness.To = common.HexToAddress(permit2Payload.Permit2Authorization.Witness.To)
	args.Witness.ValidAfter = validAfter
	args.Signature = signatureBytes
	return args, nil
}

// SimulatePermit2Settle runs settle() via eth_call (ReadContract).
// Returns true if the simulation succeeded.
func SimulatePermit2Settle(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	permit2Payload *evm.ExactPermit2Payload,
) (bool, error) {
	args, err := BuildPermit2SettleArgs(permit2Payload)
	if err != nil {
		return false, err
	}

	permitStruct := args.permitStruct()
	witnessStruct := args.witnessStruct()

	_, err = signer.ReadContract(
		ctx,
		evm.X402ExactPermit2ProxyAddress,
		evm.X402ExactPermit2ProxySettleABI,
		evm.FunctionSettle,
		permitStruct,
		args.Owner,
		witnessStruct,
		args.Signature,
	)
	if err != nil {
		return false, err
	}
	return true, nil
}

// SimulatePermit2SettleWithPermit runs settleWithPermit() via eth_call.
// The contract atomically calls token.permit() then PERMIT2.permitTransferFrom(),
// so simulation covers allowance + balance + nonces.
func SimulatePermit2SettleWithPermit(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	permit2Payload *evm.ExactPermit2Payload,
	eip2612Signature, eip2612Amount, eip2612DeadlineStr string,
) (bool, error) {
	args, err := BuildPermit2SettleArgs(permit2Payload)
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

	permit2612Struct := struct {
		Value    *big.Int
		Deadline *big.Int
		R        [32]byte
		S        [32]byte
		V        uint8
	}{
		Value:    eip2612Value,
		Deadline: eip2612Deadline,
		R:        r,
		S:        s,
		V:        v,
	}

	permitStruct := args.permitStruct()
	witnessStruct := args.witnessStruct()

	_, err = signer.ReadContract(
		ctx,
		evm.X402ExactPermit2ProxyAddress,
		evm.X402ExactPermit2ProxySettleWithPermitABI,
		evm.FunctionSettleWithPermit,
		permit2612Struct,
		permitStruct,
		args.Owner,
		witnessStruct,
		args.Signature,
	)
	if err != nil {
		return false, err
	}
	return true, nil
}

// DiagnosePermit2SimulationFailure runs a multicall diagnostic to return the most
// specific error reason after a simulation failure.
func DiagnosePermit2SimulationFailure(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	tokenAddress string,
	permit2Payload *evm.ExactPermit2Payload,
	amountRequired string,
) *x402.VerifyResponse {
	payer := permit2Payload.Permit2Authorization.From

	results, err := evm.Multicall(ctx, signer, []evm.MulticallCall{
		{
			Address:      evm.X402ExactPermit2ProxyAddress,
			ABI:          evm.X402ExactPermit2ProxyPermit2ABI,
			FunctionName: "PERMIT2",
		},
		{
			Address:      tokenAddress,
			ABI:          evm.ERC20BalanceOfABI,
			FunctionName: "balanceOf",
			Args:         []interface{}{common.HexToAddress(payer)},
		},
		{
			Address:      tokenAddress,
			ABI:          evm.ERC20AllowanceABI,
			FunctionName: "allowance",
			Args:         []interface{}{common.HexToAddress(payer), common.HexToAddress(evm.PERMIT2Address)},
		},
	})
	if err != nil || len(results) < 3 {
		return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrPermit2SimulationFailed, Payer: payer}
	}

	if !results[0].Success() {
		return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrPermit2ProxyNotDeployed, Payer: payer}
	}

	reqAmount, ok := new(big.Int).SetString(amountRequired, 10)
	if !ok {
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

// CheckPermit2Prerequisites checks proxy deployment and payer token balance.
func CheckPermit2Prerequisites(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	tokenAddress string,
	payer string,
	amountRequired string,
) *x402.VerifyResponse {
	results, err := evm.Multicall(ctx, signer, []evm.MulticallCall{
		{
			Address:      evm.X402ExactPermit2ProxyAddress,
			ABI:          evm.X402ExactPermit2ProxyPermit2ABI,
			FunctionName: "PERMIT2",
		},
		{
			Address:      tokenAddress,
			ABI:          evm.ERC20BalanceOfABI,
			FunctionName: "balanceOf",
			Args:         []interface{}{common.HexToAddress(payer)},
		},
	})
	if err != nil || len(results) < 2 {
		// Fail open for prerequisites-only check
		return &x402.VerifyResponse{IsValid: true, Payer: payer}
	}

	if !results[0].Success() {
		return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrPermit2ProxyNotDeployed, Payer: payer}
	}

	reqAmount, ok := new(big.Int).SetString(amountRequired, 10)
	if ok && results[1].Success() {
		if balance := asBigInt(results[1].Result); balance != nil && balance.Cmp(reqAmount) < 0 {
			return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrPermit2InsufficientBalance, Payer: payer}
		}
	}

	return &x402.VerifyResponse{IsValid: true, Payer: payer}
}

// permitStruct returns the ABI-compatible tuple for the permit parameter.
func (a *Permit2SettleArgs) permitStruct() interface{} {
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

// witnessStruct returns the ABI-compatible tuple for the witness parameter.
func (a *Permit2SettleArgs) witnessStruct() interface{} {
	return struct {
		To         common.Address
		ValidAfter *big.Int
	}{
		To:         a.Witness.To,
		ValidAfter: a.Witness.ValidAfter,
	}
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
