package facilitator

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	gethtypes "github.com/ethereum/go-ethereum/core/types"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	authcapture "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture"
)

// A custom operator is untrusted contract code that forwards to the escrow, so the facilitator
// does not take its word for what the call did. It simulates the call and, after it confirms,
// checks the escrow's event, the payment state and the balance deltas against what the collect
// must produce.

// outcomeViolation is a custom operator call that did not do what the collect requires.
type outcomeViolation struct {
	reason  string
	message string
}

func (v *outcomeViolation) Error() string { return v.message }

func violation(reason, format string, args ...interface{}) *outcomeViolation {
	return &outcomeViolation{reason: reason, message: fmt.Sprintf(format, args...)}
}

// customSnapshot is a point-in-time read of the payment state and the balances a collect moves.
type customSnapshot struct {
	collected  bool
	capturable *big.Int
	refundable *big.Int
	balances   map[string]*big.Int
}

func (f *AuthCaptureEvmScheme) customGasLimit() uint64 {
	if f.config.CustomOperatorGasLimit > 0 {
		return f.config.CustomOperatorGasLimit
	}
	return authcapture.DefaultCustomOperatorGasLimit
}

func (f *AuthCaptureEvmScheme) submitterAddress() string {
	return f.signer.GetAddresses()[0]
}

func packCall(contractABI []byte, function string, args ...interface{}) ([]byte, error) {
	parsed, err := abi.JSON(bytes.NewReader(contractABI))
	if err != nil {
		return nil, err
	}
	return parsed.Pack(function, args...)
}

func addressKey(address string) string { return strings.ToLower(address) }

// watchedAddresses are the accounts a collect moves tokens between, deduplicated.
func (f *AuthCaptureEvmScheme) watchedAddresses(out *collectOutcome, tokenStore string) []string {
	candidates := []string{out.payer, tokenStore, f.submitterAddress()}
	if out.function == "charge" {
		candidates = append(candidates, out.paymentInfo.Receiver, out.feeReceiver)
	}
	seen := map[string]bool{}
	var unique []string
	for _, address := range candidates {
		if key := addressKey(address); !seen[key] {
			seen[key] = true
			unique = append(unique, key)
		}
	}
	return unique
}

// expectedDeltas are the exact balance changes the collect must cause, per address.
func (f *AuthCaptureEvmScheme) expectedDeltas(out *collectOutcome, tokenStore string) map[string]*big.Int {
	deltas := map[string]*big.Int{}
	add := func(address string, amount *big.Int) {
		key := addressKey(address)
		if deltas[key] == nil {
			deltas[key] = new(big.Int)
		}
		deltas[key].Add(deltas[key], amount)
	}
	add(out.payer, new(big.Int).Neg(out.amount))
	if out.function == "authorize" {
		add(tokenStore, out.amount)
		return deltas
	}
	fee := feeAmountOf(out.fee, out.amount)
	add(out.paymentInfo.Receiver, new(big.Int).Sub(out.amount, fee))
	add(out.feeReceiver, fee)
	return deltas
}

// readCalls are the state reads of a snapshot: the payment state, then each watched balance.
func (f *AuthCaptureEvmScheme) readCalls(out *collectOutcome, addresses []string) ([]SimulatedCall, error) {
	hashBytes, err := evm.HexToBytes(out.paymentInfoHash)
	if err != nil {
		return nil, err
	}
	stateData, err := packCall(authcapture.EscrowABIForDeployment(&out.deployment), "paymentState", common.BytesToHash(hashBytes))
	if err != nil {
		return nil, err
	}
	calls := []SimulatedCall{{To: out.deployment.Escrow, Data: stateData}}
	for _, address := range addresses {
		data, err := packCall(evm.ERC20BalanceOfABI, "balanceOf", common.HexToAddress(address))
		if err != nil {
			return nil, err
		}
		calls = append(calls, SimulatedCall{To: out.paymentInfo.Token, Data: data})
	}
	return calls, nil
}

// newSnapshot builds a snapshot from a decoded paymentState result and the watched balances.
func newSnapshot(addresses []string, state []interface{}, balances []*big.Int) (*customSnapshot, error) {
	if len(state) != 3 {
		return nil, violation(ErrSimulationFailed, "unexpected paymentState result")
	}
	snapshot := &customSnapshot{capturable: asBigInt(state[1]), refundable: asBigInt(state[2]), balances: map[string]*big.Int{}}
	snapshot.collected, _ = state[0].(bool)
	if snapshot.capturable == nil || snapshot.refundable == nil {
		return nil, violation(ErrSimulationFailed, "unexpected paymentState amount types")
	}
	for i, address := range addresses {
		if balances[i] == nil {
			return nil, violation(ErrSimulationFailed, "unexpected balanceOf result")
		}
		snapshot.balances[address] = balances[i]
	}
	return snapshot, nil
}

// decodeSnapshot turns the raw results of readCalls into a snapshot.
func decodeSnapshot(out *collectOutcome, addresses []string, results []SimulatedCallResult) (*customSnapshot, error) {
	for _, result := range results {
		if !result.Success {
			return nil, violation(ErrSimulationFailed, "state read reverted")
		}
	}
	escrowABI, err := abi.JSON(bytes.NewReader(authcapture.EscrowABIForDeployment(&out.deployment)))
	if err != nil {
		return nil, err
	}
	state, err := escrowABI.Unpack("paymentState", results[0].ReturnData)
	if err != nil {
		return nil, violation(ErrSimulationFailed, "undecodable paymentState result")
	}
	erc20ABI, err := abi.JSON(bytes.NewReader(evm.ERC20BalanceOfABI))
	if err != nil {
		return nil, err
	}
	balances := make([]*big.Int, len(addresses))
	for i := range addresses {
		decoded, err := erc20ABI.Unpack("balanceOf", results[i+1].ReturnData)
		if err != nil || len(decoded) != 1 {
			return nil, violation(ErrSimulationFailed, "undecodable balanceOf result")
		}
		balances[i] = asBigInt(decoded[0])
	}
	return newSnapshot(addresses, state, balances)
}

// checkEvents requires the escrow to have emitted exactly the PaymentAuthorized or PaymentCharged
// this collect names.
func (out *collectOutcome) checkEvents(logs []*gethtypes.Log) *outcomeViolation {
	escrowABI, err := abi.JSON(bytes.NewReader(authcapture.EscrowABIForDeployment(&out.deployment)))
	if err != nil {
		return violation(ErrSimulationFailed, "escrow ABI: %v", err)
	}
	eventName := "PaymentAuthorized"
	if out.function == "charge" {
		eventName = "PaymentCharged"
	}
	event := escrowABI.Events[eventName]
	hashBytes, err := evm.HexToBytes(out.paymentInfoHash)
	if err != nil {
		return violation(ErrSimulationFailed, "paymentInfoHash: %v", err)
	}
	for _, log := range logs {
		if !strings.EqualFold(log.Address.Hex(), out.deployment.Escrow) || len(log.Topics) < 2 ||
			log.Topics[0] != event.ID || log.Topics[1] != common.BytesToHash(hashBytes) {
			continue
		}
		fields, err := event.Inputs.NonIndexed().Unpack(log.Data)
		if err != nil {
			return violation(ErrSimulationFailed, "undecodable %s event", eventName)
		}
		if out.eventMatches(fields) {
			return nil
		}
	}
	return violation(ErrSimulationFailed, "custom operator did not emit the expected %s event", eventName)
}

// eventMatches compares the event's non-indexed fields: paymentInfo, amount, tokenCollector and,
// for a charge, the fee and feeReceiver.
func (out *collectOutcome) eventMatches(fields []interface{}) bool {
	want := 3
	if out.function == "charge" {
		want = 5
	}
	if len(fields) != want {
		return false
	}
	amount, collector := asBigInt(fields[1]), fields[2]
	if amount == nil || amount.Cmp(out.amount) != 0 {
		return false
	}
	if collectorAddress, ok := collector.(common.Address); !ok || !strings.EqualFold(collectorAddress.Hex(), out.tokenCollector) {
		return false
	}
	if out.function != "charge" {
		return true
	}
	receiver, ok := fields[4].(common.Address)
	if !ok || !strings.EqualFold(receiver.Hex(), out.feeReceiver) {
		return false
	}
	if out.fee.Bps != nil {
		bps, ok := fields[3].(uint16)
		return ok && bps == *out.fee.Bps
	}
	fee := asBigInt(fields[3])
	return fee != nil && fee.Cmp(out.fee.Amount) == 0
}

// checkState requires the payment to be in the authorize or charge state.
func (out *collectOutcome) checkState(after *customSnapshot) *outcomeViolation {
	wantCapturable, wantRefundable := new(big.Int).Set(out.amount), new(big.Int)
	if out.function == "charge" {
		wantCapturable, wantRefundable = wantRefundable, wantCapturable
	}
	if !after.collected || after.capturable.Cmp(wantCapturable) != 0 || after.refundable.Cmp(wantRefundable) != 0 {
		return violation(ErrUnexpectedPaymentState, "payment state after the custom operator call is not the %s state", out.function)
	}
	return nil
}

// checkTransition requires the authorize or charge state and every watched balance to move by
// exactly the expected delta. The submitter may only gain.
func (f *AuthCaptureEvmScheme) checkTransition(out *collectOutcome, expected map[string]*big.Int, before, after *customSnapshot) *outcomeViolation {
	if v := out.checkState(after); v != nil {
		return v
	}
	submitter := addressKey(f.submitterAddress())
	for address, balanceBefore := range before.balances {
		delta := new(big.Int).Sub(after.balances[address], balanceBefore)
		want := expected[address]
		if want == nil {
			want = new(big.Int)
		}
		if address == submitter {
			if delta.Cmp(want) < 0 {
				return violation(ErrUnexpectedPaymentState, "custom operator call reduced the facilitator's token balance")
			}
		} else if delta.Cmp(want) != 0 {
			return violation(ErrUnexpectedPaymentState, "token balance of %s moved by %s, expected %s", address, delta, want)
		}
	}
	return nil
}

func (f *AuthCaptureEvmScheme) customTokenStore(ctx context.Context, out *collectOutcome) (string, error) {
	result, err := f.signer.ReadContract(ctx, out.deployment.Escrow, authcapture.EscrowABIForDeployment(&out.deployment),
		"getTokenStore", common.HexToAddress(out.paymentInfo.Operator))
	if err != nil {
		return "", x402.NewVerifyError(ErrSimulationFailed, out.payer, "token store lookup failed: "+err.Error())
	}
	switch store := result.(type) {
	case common.Address:
		return store.Hex(), nil
	case string:
		return store, nil
	}
	return "", x402.NewVerifyError(ErrSimulationFailed, out.payer, "unexpected token store result")
}

// simulateCustomCollect runs the collect through the custom operator against one simulated state:
// reads, the gas-capped forwarded call, and the same reads again.
func (f *AuthCaptureEvmScheme) simulateCustomCollect(ctx context.Context, pre *collectPreconditions) error {
	out := &pre.collectOutcome
	simulator, ok := f.signer.(CallSimulator)
	if !ok {
		return x402.NewVerifyError(ErrOperatorNotAdmitted, out.payer, "signer cannot simulate custom operator calls")
	}
	tokenStore, err := f.customTokenStore(ctx, out)
	if err != nil {
		return err
	}
	addresses := f.watchedAddresses(out, tokenStore)
	reads, err := f.readCalls(out, addresses)
	if err != nil {
		return x402.NewVerifyError(ErrSimulationFailed, out.payer, err.Error())
	}
	args, err := pre.escrowArgs()
	if err != nil {
		return err
	}
	forwarded, err := packCall(authcapture.EscrowABIForDeployment(&out.deployment), out.function, args...)
	if err != nil {
		return x402.NewVerifyError(ErrPayloadFormat, out.payer, err.Error())
	}

	gasLimit := f.customGasLimit()
	calls := append(append(append([]SimulatedCall{}, reads...), SimulatedCall{To: out.extra.CaptureAuthorizer, Data: forwarded, Gas: gasLimit}), reads...)
	results, err := simulator.SimulateCalls(ctx, f.submitterAddress(), calls)
	if err != nil {
		return x402.NewVerifyError(ErrSimulationFailed, out.payer, err.Error())
	}
	if len(results) != len(calls) {
		return x402.NewVerifyError(ErrSimulationFailed, out.payer, "simulator returned an unexpected number of results")
	}

	n := len(reads)
	call := results[n]
	if !call.Success {
		return x402.NewVerifyError(revertReason(&out.deployment, call.ReturnData), out.payer, "custom operator call reverted")
	}
	if call.GasUsed > gasLimit {
		return x402.NewVerifyError(ErrSimulationFailed, out.payer, "custom operator call exceeded its gas limit")
	}
	if v := out.checkEvents(call.Logs); v != nil {
		return x402.NewVerifyError(v.reason, out.payer, v.message)
	}
	before, err := decodeSnapshot(out, addresses, results[:n])
	if err != nil {
		return toVerifyViolation(err, out.payer)
	}
	after, err := decodeSnapshot(out, addresses, results[n+1:])
	if err != nil {
		return toVerifyViolation(err, out.payer)
	}
	if before.collected {
		return x402.NewVerifyError(ErrPaymentAlreadyCollected, out.payer, "payment was already collected")
	}
	if v := f.checkTransition(out, f.expectedDeltas(out, tokenStore), before, after); v != nil {
		return x402.NewVerifyError(v.reason, out.payer, v.message)
	}
	return nil
}

func toVerifyViolation(err error, payer string) error {
	var v *outcomeViolation
	if errors.As(err, &v) {
		return x402.NewVerifyError(v.reason, payer, v.message)
	}
	return x402.NewVerifyError(ErrSimulationFailed, payer, err.Error())
}

// customSnapshotFor reads a snapshot from the chain, outside any simulation.
func (f *AuthCaptureEvmScheme) customSnapshotFor(ctx context.Context, out *collectOutcome, addresses []string) (*customSnapshot, error) {
	hashBytes, err := evm.HexToBytes(out.paymentInfoHash)
	if err != nil {
		return nil, err
	}
	calls := []evm.MulticallCall{{
		Address:      out.deployment.Escrow,
		ABI:          authcapture.EscrowABIForDeployment(&out.deployment),
		FunctionName: "paymentState",
		Args:         []interface{}{common.BytesToHash(hashBytes)},
	}}
	for _, address := range addresses {
		calls = append(calls, evm.MulticallCall{
			Address:      out.paymentInfo.Token,
			ABI:          evm.ERC20BalanceOfABI,
			FunctionName: "balanceOf",
			Args:         []interface{}{common.HexToAddress(address)},
		})
	}
	results, err := evm.Multicall(ctx, f.signer, calls)
	if err != nil {
		return nil, err
	}
	if len(results) != len(calls) {
		return nil, violation(ErrSimulationFailed, "unexpected multicall result count")
	}
	for _, result := range results {
		if !result.Success() {
			return nil, violation(ErrSimulationFailed, "state read reverted")
		}
	}
	state, _ := results[0].Result.([]interface{})
	balances := make([]*big.Int, len(addresses))
	for i := range addresses {
		balances[i] = asBigInt(results[i+1].Result)
	}
	return newSnapshot(addresses, state, balances)
}

// staleUncollected is the empty paymentState a node returns before it has the collect,
// even after it has already served the receipt.
func staleUncollected(snap *customSnapshot) bool {
	return snap != nil && !snap.collected && snap.capturable.Sign() == 0 && snap.refundable.Sign() == 0
}

// snapshotAfterCollect reads the confirmed snapshot, retrying while paymentState is still
// the empty pre-collect struct. The node that served the receipt may not show the collect yet.
func (f *AuthCaptureEvmScheme) snapshotAfterCollect(ctx context.Context, out *collectOutcome, addresses []string) (*customSnapshot, error) {
	var snap *customSnapshot
	var err error
	for attempt := 1; ; attempt++ {
		snap, err = f.customSnapshotFor(ctx, out, addresses)
		if err != nil || !staleUncollected(snap) || attempt == collectedReadAttempts {
			return snap, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(collectedReadDelay):
		}
	}
}

// snapshotCustomBalances reads the pre-broadcast state the receipt check compares against.
func (f *AuthCaptureEvmScheme) snapshotCustomBalances(ctx context.Context, out *collectOutcome) (*customSnapshot, error) {
	tokenStore, err := f.customTokenStore(ctx, out)
	if err != nil {
		return nil, err
	}
	snapshot, err := f.customSnapshotFor(ctx, out, f.watchedAddresses(out, tokenStore))
	if err != nil {
		return nil, x402.NewVerifyError(ErrSimulationFailed, out.payer, err.Error())
	}
	return snapshot, nil
}

// customReceiptCheck re-checks a confirmed custom operator collect: the escrow's event, the payment
// state and, when the pre-broadcast snapshot is known, the balance deltas. It is nil for any other
// operator type.
func (f *AuthCaptureEvmScheme) customReceiptCheck(out *collectOutcome, before *customSnapshot) receiptCheck {
	if out.extra.OperatorType != authcapture.OperatorTypeCustom {
		return nil
	}
	return func(ctx context.Context, receipt *evm.TransactionReceipt) (*x402.SettleResponse, error) {
		rejected := func(v *outcomeViolation) (*x402.SettleResponse, error) {
			return &x402.SettleResponse{
				Success:      false,
				ErrorReason:  v.reason,
				ErrorMessage: v.message,
				Transaction:  receipt.TxHash,
				Network:      out.network,
				Payer:        out.payer,
			}, nil
		}
		if v := out.checkEvents(receipt.Logs); v != nil {
			return rejected(v)
		}
		tokenStore, err := f.customTokenStore(ctx, out)
		if err != nil {
			return nil, toSettleError(err, out.network, out.payer)
		}
		after, err := f.snapshotAfterCollect(ctx, out, f.watchedAddresses(out, tokenStore))
		if err != nil {
			return nil, toSettleError(toVerifyViolation(err, out.payer), out.network, out.payer)
		}
		var v *outcomeViolation
		if before == nil {
			v = out.checkState(after)
		} else {
			v = f.checkTransition(out, f.expectedDeltas(out, tokenStore), before, after)
		}
		if v != nil {
			return rejected(v)
		}
		return nil, nil
	}
}
