package cardano

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"math/big"
	"sort"
	"strings"
	"sync"
	"time"

	apollo "github.com/Salvionied/apollo/v2"
	"github.com/Salvionied/apollo/v2/backend"
	"github.com/blinklabs-io/gouroboros/ledger/common"

	x402cardano "github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano/exact/script"
)

// ClientSignerConfig configures NewClientSigner.
type ClientSignerConfig struct {
	Mnemonic     string
	Network      string
	AccountIndex uint32
	// Provider is any Apollo chain backend (Blockfrost, Ogmios/Kupo, UTxO
	// RPC); it is only read, never used to submit.
	Provider backend.ChainContext
	Masumi   MasumiClientConfig
	// ReserveInputs keeps a signed payment's inputs out of later builds until
	// its validity window closes, so concurrent payments from one wallet never
	// spend the same UTxO. A payment that fails before landing then blocks its
	// inputs until its TTL.
	ReserveInputs bool
}

// ClientSigner builds and signs payments from a CIP-1852 wallet. It never broadcasts.
type ClientSigner struct {
	network   string
	networkID uint8
	wallet    *apollo.BursaWallet
	provider  backend.ChainContext
	masumi    MasumiClientConfig
	now       func() time.Time

	// reserved maps the inputs of payments signed but not yet expired to the
	// time their transaction can no longer land, so concurrent payments never
	// spend the same UTxO.
	reserve  bool
	mu       sync.Mutex
	reserved map[string]int64
}

// NewClientSigner creates a client signer for one network.
func NewClientSigner(cfg ClientSignerConfig) (*ClientSigner, error) {
	if cfg.Provider == nil {
		return nil, errors.New("a chain provider is required")
	}
	wallet, err := NewWallet(cfg.Mnemonic, cfg.Network, cfg.AccountIndex)
	if err != nil {
		return nil, err
	}
	networkID, err := x402cardano.NetworkID(cfg.Network)
	if err != nil {
		return nil, err
	}
	return &ClientSigner{
		network:   x402cardano.NormalizeNetwork(cfg.Network),
		networkID: uint8(networkID),
		wallet:    wallet,
		provider:  cfg.Provider,
		masumi:    cfg.Masumi,
		now:       time.Now,
		reserve:   cfg.ReserveInputs,
		reserved:  map[string]int64{},
	}, nil
}

// Address implements x402cardano.ClientCardanoSigner.
func (s *ClientSigner) Address() string { return s.wallet.Address().String() }

// BuildAndSignPaymentTransaction implements x402cardano.ClientCardanoSigner.
func (s *ClientSigner) BuildAndSignPaymentTransaction(ctx context.Context, input x402cardano.ClientSignInput) (*x402cardano.ClientSignResult, error) {
	if x402cardano.NormalizeNetwork(input.Network) != s.network {
		return nil, fmt.Errorf("signer configured for %s but asked to pay on %s", s.network, input.Network)
	}
	amount, ok := new(big.Int).SetString(input.Amount, 10)
	if !ok || !amount.IsUint64() {
		return nil, fmt.Errorf("invalid Cardano amount: %s", input.Amount)
	}
	method, _ := input.Extra["assetTransferMethod"].(string)

	var masumiPlan *masumiPayment
	if method == x402cardano.AssetTransferMethodMasumi {
		plan, err := s.prepareMasumi(ctx, input)
		if err != nil {
			return nil, err
		}
		masumiPlan = plan
	}
	payment, err := paymentOutput(input, method, amount.Uint64())
	if err != nil {
		return nil, err
	}
	params, err := backend.ProtocolParamsContext(ctx, s.provider)
	if err != nil {
		return nil, fmt.Errorf("cannot read protocol parameters: %w", err)
	}
	utxos, err := s.spendableUtxos(ctx)
	if err != nil {
		return nil, err
	}
	// Selecting, building and reserving stay under one lock, so concurrent
	// payments never pick the same inputs.
	if s.reserve {
		s.mu.Lock()
		defer s.mu.Unlock()
		if utxos = s.unreserved(utxos); len(utxos) == 0 {
			return nil, ErrUtxosReserved
		}
	}

	if input.MaxTimeoutSeconds <= 0 || input.MaxTimeoutSeconds > MaxPaymentTimeoutSeconds {
		return nil, fmt.Errorf("maxTimeoutSeconds %d is outside 1..%d", input.MaxTimeoutSeconds, MaxPaymentTimeoutSeconds)
	}
	ttlMs := s.now().UnixMilli() + int64(input.MaxTimeoutSeconds)*1000
	if masumiPlan != nil {
		if err := s.applyMasumi(masumiPlan, amount.Uint64(), uint64(params.CoinsPerUtxoByteValue()), &payment); err != nil {
			return nil, err
		}
		ttlMs = masumiPlan.payByMs
	}
	ttlSlot, err := x402cardano.PosixMsToSlot(s.network, ttlMs)
	if err != nil {
		return nil, err
	}
	built, err := BuildPaymentTx(ctx, PaymentTx{
		Nonce:     utxos[0],
		Utxos:     utxos[1:],
		Wallet:    s.wallet,
		Payment:   payment,
		TTLSlot:   ttlSlot,
		Params:    params,
		NetworkID: s.networkID,
	})
	if err != nil {
		return nil, err
	}
	if masumiPlan != nil && masumiPlan.payByMs <= s.now().UnixMilli() {
		return nil, errors.New("masumi client preflight failed: payByTime has expired")
	}
	if s.reserve {
		if err := s.reserveInputs(built.Inputs, ttlSlot); err != nil {
			return nil, err
		}
	}
	return &x402cardano.ClientSignResult{
		Transaction: base64.StdEncoding.EncodeToString(built.Bytes),
		Nonce:       built.Nonce,
	}, nil
}

// paymentOutput is the output paying input.PayTo: the amount in lovelace or as
// a native token, plus the inline datum of a script payment.
func paymentOutput(input x402cardano.ClientSignInput, method string, amount uint64) (PaymentOutput, error) {
	payment := PaymentOutput{Address: input.PayTo}
	if strings.EqualFold(input.Asset, x402cardano.LovelaceAsset) {
		payment.Coin = amount
	} else {
		policy, name, err := x402cardano.ParseAssetUnit(input.Asset)
		if err != nil {
			return PaymentOutput{}, err
		}
		payment.Assets = map[string]uint64{policy + "." + name: amount}
		payment.RaiseToMinUtxo = true
	}
	if method == x402cardano.AssetTransferMethodScript {
		extra, err := script.ParseExtra(input.Extra)
		if err != nil {
			return PaymentOutput{}, err
		}
		if payment.Datum, err = script.InlineDatum(extra); err != nil {
			return PaymentOutput{}, err
		}
		// A Plutus V1 script cannot see an inline datum, so the lock could
		// never be spent.
		if payment.Datum != nil && extra.Script != nil && extra.Script.Type == "plutusV1" {
			return PaymentOutput{}, errors.New("refusing to lock an inline datum at a Plutus V1 script, which could never spend it")
		}
		payment.RaiseToMinUtxo = payment.RaiseToMinUtxo || payment.Datum != nil
	}
	return payment, nil
}

// reserveInputs holds inputs until the transaction spending them can no
// longer land. The caller holds s.mu.
func (s *ClientSigner) reserveInputs(inputs []string, ttlSlot uint64) error {
	landsUntil, err := x402cardano.SlotToPosixMs(s.network, ttlSlot)
	if err != nil {
		return err
	}
	for _, ref := range inputs {
		s.reserved[ref] = landsUntil
	}
	return nil
}

// MaxPaymentTimeoutSeconds bounds how long a signed payment stays valid, so a
// server cannot hold a signed transaction for later submission.
const MaxPaymentTimeoutSeconds = 24 * 60 * 60

// ErrUtxosReserved means every wallet UTxO funds a payment that may still
// land; retry once it settles or its validity window closes.
var ErrUtxosReserved = errors.New("every wallet UTxO is reserved by a pending payment; retry after it settles or expires")

// unreserved drops UTxOs held by pending payments and forgets reservations
// whose transaction can no longer land. Expiry is by TTL only: a caller's
// snapshot may predate a reserved UTxO, so absence proves nothing. The caller
// holds s.mu.
func (s *ClientSigner) unreserved(utxos []common.Utxo) []common.Utxo {
	nowMs := s.now().UnixMilli()
	for ref, until := range s.reserved {
		if until < nowMs {
			delete(s.reserved, ref)
		}
	}
	free := make([]common.Utxo, 0, len(utxos))
	for _, u := range utxos {
		if _, held := s.reserved[utxoRef(u)]; !held {
			free = append(free, u)
		}
	}
	return free
}

// spendableUtxos are the wallet's UTxOs minus those carrying a reference
// script, whose per-byte reference-script fee the facilitator's fee floor
// does not model, in a stable order so the nonce is deterministic.
func (s *ClientSigner) spendableUtxos(ctx context.Context) ([]common.Utxo, error) {
	all, err := backend.UtxosContext(ctx, s.provider, s.wallet.Address())
	if err != nil {
		return nil, fmt.Errorf("cannot read wallet UTxOs: %w", err)
	}
	spendable := make([]common.Utxo, 0, len(all))
	for _, u := range all {
		if u.Id != nil && u.Output != nil && u.Output.ScriptRef() == nil {
			spendable = append(spendable, u)
		}
	}
	if len(spendable) == 0 {
		return nil, errors.New("funding wallet has no UTxOs available for the payment")
	}
	sort.Slice(spendable, func(i, j int) bool { return utxoRef(spendable[i]) < utxoRef(spendable[j]) })
	return spendable, nil
}

func utxoRef(u common.Utxo) string {
	return x402cardano.FormatUtxoRef(u.Id.Id().String(), u.Id.Index())
}
