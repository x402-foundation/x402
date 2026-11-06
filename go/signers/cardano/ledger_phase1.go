package cardano

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"time"

	"github.com/blinklabs-io/gouroboros/cbor"
	"github.com/blinklabs-io/gouroboros/ledger/babbage"
	"github.com/blinklabs-io/gouroboros/ledger/common"
	"github.com/blinklabs-io/gouroboros/ledger/conway"
	"github.com/blinklabs-io/gouroboros/ledger/mary"
	"github.com/blinklabs-io/gouroboros/ledger/shelley"

	x402cardano "github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
)

// ErrLedgerStateUnavailable means a phase-1 rule needed ledger state the
// provider cannot supply (stake, pool, reward, governance or script state, or
// a full input output). The validator refuses such a transaction.
var ErrLedgerStateUnavailable = errors.New("ledger phase-1 validation needs state the provider does not supply")

// validateLedgerPhase1 runs gouroboros's Conway phase-1 ledger rules against
// the transaction's inputs as the provider reports them.
func (s *FacilitatorSigner) validateLedgerPhase1(ctx context.Context, transaction string) error {
	raw, err := x402cardano.DecodeTransactionBytes(transaction)
	if err != nil {
		return err
	}
	tx, err := conway.NewConwayTransactionFromCbor(raw)
	if err != nil {
		return fmt.Errorf("invalid Conway transaction: %w", err)
	}
	// These need stake, reward, governance or cost-model state that the
	// provider does not supply; refuse them outright rather than rely on a
	// rule failing for want of it.
	switch {
	case len(tx.Certificates()) > 0:
		return fmt.Errorf("%w: certificates", ErrLedgerStateUnavailable)
	case len(tx.Withdrawals()) > 0:
		return fmt.Errorf("%w: withdrawals", ErrLedgerStateUnavailable)
	case len(tx.VotingProcedures()) > 0 || len(tx.ProposalProcedures()) > 0:
		return fmt.Errorf("%w: governance actions", ErrLedgerStateUnavailable)
	case tx.CurrentTreasuryValue() != nil:
		return fmt.Errorf("%w: current treasury value", ErrLedgerStateUnavailable)
	case tx.WitnessSet.WsRedeemers.Len() > 0 || len(tx.WitnessSet.WsPlutusV1Scripts.Items())+len(tx.WitnessSet.WsPlutusV2Scripts.Items())+len(tx.WitnessSet.WsPlutusV3Scripts.Items()) > 0:
		return fmt.Errorf("%w: Plutus scripts", ErrLedgerStateUnavailable)
	}
	params, err := s.fullProtocolParameters(ctx)
	if err != nil {
		return err
	}
	if params.MaxValueSize == 0 || params.ProtocolMajor == 0 {
		return fmt.Errorf("%w: the provider reports no max value size or protocol version", ErrLedgerStateUnavailable)
	}
	networkID, err := x402cardano.NetworkID(s.network)
	if err != nil {
		return err
	}
	state := &ledgerState{network: s.network, networkID: uint(networkID), utxos: map[string]common.Utxo{}}
	inputs := append(append(append([]common.TransactionInput{}, tx.Inputs()...), tx.Collateral()...), tx.ReferenceInputs()...)
	for _, in := range inputs {
		if _, seen := state.utxos[in.String()]; seen {
			continue
		}
		utxo, err := s.ledgerUtxo(ctx, in)
		if err != nil {
			return err
		}
		if utxo != nil {
			state.utxos[in.String()] = *utxo
		}
	}
	slot, err := x402cardano.PosixMsToSlot(s.network, s.now().UnixMilli())
	if err != nil {
		return err
	}
	pp := &conway.ConwayProtocolParameters{
		MinFeeA:              uint(params.MinFeeA),
		MinFeeB:              uint(params.MinFeeB),
		MaxTxSize:            uint(params.MaxTxSize),
		MaxValueSize:         uint(params.MaxValueSize),
		CollateralPercentage: uint(params.CollateralPercentage),
		MaxCollateralInputs:  uint(params.MaxCollateralInputs),
		AdaPerUtxoByte:       params.CoinsPerUtxoByte,
	}
	pp.ProtocolVersion.Major, pp.ProtocolVersion.Minor = uint(params.ProtocolMajor), uint(params.ProtocolMinor)
	for i, rule := range conway.UtxoValidationRules {
		if err := runRule(rule, tx, slot, state, pp); err != nil {
			return fmt.Errorf("phase-1 rule %d: %w", i, err)
		}
	}
	return nil
}

// runRule turns a rule that reaches for state ledgerState leaves unset, and
// so panics, into a refusal rather than a crash or an acceptance.
func runRule(rule common.UtxoValidationRuleFunc, tx common.Transaction, slot uint64, state common.LedgerState, pp common.ProtocolParameters) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("%w: %v", ErrLedgerStateUnavailable, r)
		}
	}()
	return rule(tx, slot, state, pp)
}

// ledgerUtxo rebuilds an unspent input from the provider, or returns nil for
// a spent or unknown one so the bad-inputs rule rejects it. Only key-locked
// outputs without a reference script are rebuilt faithfully from what
// Blockfrost reports, so anything else is refused.
func (s *FacilitatorSigner) ledgerUtxo(ctx context.Context, in common.TransactionInput) (*common.Utxo, error) {
	txHash := in.Id().String()
	output, err := s.provider.TxOutput(ctx, txHash, in.Index())
	if err != nil {
		return nil, err
	}
	if output == nil {
		return nil, nil
	}
	if spent, err := s.outputSpent(ctx, output, txHash, in.Index()); err != nil || spent {
		return nil, err
	}
	if output.HasReferenceScript {
		return nil, fmt.Errorf("%w: input %s carries a reference script", ErrLedgerStateUnavailable, in.String())
	}
	if credential, err := x402cardano.PaymentCredential(output.Address); err != nil || credential.IsScript {
		return nil, fmt.Errorf("%w: input %s is not key-locked", ErrLedgerStateUnavailable, in.String())
	}
	addr, err := common.NewAddress(output.Address)
	if err != nil {
		return nil, err
	}
	value := mary.MaryTransactionOutputValue{Amount: output.Coin}
	if len(output.Assets) > 0 {
		assets := map[common.Blake2b224]map[cbor.ByteString]*big.Int{}
		for unit, quantity := range output.Assets {
			policy, name, err := x402cardano.ParseAssetUnit(unit)
			if err != nil || policy == "" {
				return nil, fmt.Errorf("invalid asset unit %q", unit)
			}
			id, nameBytes, err := assetKey(policy, name)
			if err != nil {
				return nil, err
			}
			if assets[id] == nil {
				assets[id] = map[cbor.ByteString]*big.Int{}
			}
			assets[id][cbor.NewByteString(nameBytes)] = new(big.Int).SetUint64(quantity)
		}
		multi := common.NewMultiAsset[common.MultiAssetTypeOutput](assets)
		value.Assets = &multi
	}
	id, err := shelley.NewShelleyTransactionInput(txHash, int(in.Index()))
	if err != nil {
		return nil, err
	}
	return &common.Utxo{Id: id, Output: &babbage.BabbageTransactionOutput{OutputAddress: addr, OutputAmount: value}}, nil
}

// ledgerState is the smallest state the rules a payment reaches need: its
// inputs, slot and time conversion, and the network id. The rest of the
// interface is deliberately nil, so a rule that wants more panics and the
// transaction is refused instead of judged on missing state.
type ledgerState struct {
	common.LedgerState
	network   string
	networkID uint
	utxos     map[string]common.Utxo
}

func (l *ledgerState) UtxoById(in common.TransactionInput) (common.Utxo, error) {
	if u, ok := l.utxos[in.String()]; ok {
		return u, nil
	}
	return common.Utxo{}, fmt.Errorf("utxo %s not found or already spent", in.String())
}

func (l *ledgerState) NetworkId() uint { return l.networkID }

func (l *ledgerState) SlotToTime(slot uint64) (time.Time, error) {
	ms, err := x402cardano.SlotToPosixMs(l.network, slot)
	return time.UnixMilli(ms), err
}

func (l *ledgerState) TimeToSlot(t time.Time) (uint64, error) {
	return x402cardano.PosixMsToSlot(l.network, t.UnixMilli())
}
