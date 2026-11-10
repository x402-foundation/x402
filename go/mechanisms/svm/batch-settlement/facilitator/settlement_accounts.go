package facilitator

import (
	"context"
	"fmt"
	"sync"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/types"
)

// mintOwnerTTLSeconds bounds how long a verified mint owner is trusted. It is
// short enough that a mint closed and recreated under another token program is
// noticed soon, and long enough to take the read off the warm path.
const mintOwnerTTLSeconds int64 = 600

// mintOwnerCache remembers mints whose owner matched the advertised token
// program. Only positive matches are stored; a mismatch or a read error is
// always re-read. The zero value is ready to use.
type mintOwnerCache struct {
	mu       sync.Mutex
	verified map[string]int64
}

func mintOwnerCacheKey(network string, mint, tokenProgram solana.PublicKey) string {
	return network + ":" + mint.String() + ":" + tokenProgram.String()
}

func (c *mintOwnerCache) fresh(key string, now int64) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	expiry, ok := c.verified[key]
	if !ok {
		return false
	}
	if now >= expiry {
		delete(c.verified, key)
		return false
	}
	return true
}

func (c *mintOwnerCache) remember(key string, now int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.verified == nil {
		c.verified = map[string]int64{}
	}
	c.verified[key] = now + mintOwnerTTLSeconds
}

// settlementAccountRead is one payout destination's ATA read.
type settlementAccountRead struct {
	label   string
	owner   solana.PublicKey
	ata     solana.PublicKey
	ataErr  error
	account *rpc.GetAccountInfoResult
	err     error
}

// settlementAccountsRead holds the in-flight reads of the payer, recipient and
// treasury ATAs. The reads run concurrently; result judges them in the fixed
// payer, recipient, treasury order so error precedence does not depend on
// which read returns first.
type settlementAccountsRead struct {
	mint    solana.PublicKey
	program solana.PublicKey
	prepErr error
	reads   []*settlementAccountRead
	done    chan struct{}
}

// startSettlementAccountsRead issues the three ATA reads and returns without
// waiting. Address-parsing failures are held and returned by result, after the
// caller's own checks. Cancelling ctx abandons the reads.
func (f *BatchSvmScheme) startSettlementAccountsRead(ctx context.Context, requirements types.PaymentRequirements, payer, tokenProgram string) *settlementAccountsRead {
	read := &settlementAccountsRead{done: make(chan struct{})}
	mint, err := solana.PublicKeyFromBase58(requirements.Asset)
	if err != nil {
		return read.fail(err)
	}
	program, err := solana.PublicKeyFromBase58(tokenProgram)
	if err != nil {
		return read.fail(err)
	}
	read.mint, read.program = mint, program

	for _, item := range []struct {
		label string
		value string
	}{
		{"payer", payer},
		{"recipient", requirements.PayTo},
		{"payment-channel treasury", paymentchannels.ResolveTreasuryOwner(f.config.PaymentChannelsTreasuryOwner, requirements.Network).String()},
	} {
		owner, err := solana.PublicKeyFromBase58(item.value)
		if err != nil {
			return read.fail(err)
		}
		read.reads = append(read.reads, &settlementAccountRead{label: item.label, owner: owner})
	}

	var wg sync.WaitGroup
	for _, item := range read.reads {
		item.ata, item.ataErr = paymentchannels.FindATA(item.owner, mint, program)
		if item.ataErr != nil {
			continue
		}
		wg.Add(1)
		go func(item *settlementAccountRead) {
			defer wg.Done()
			item.account, item.err = f.signer.GetAccountInfo(ctx, item.ata, requirements.Network, &rpc.GetAccountInfoOpts{
				Encoding:   solana.EncodingBase64,
				Commitment: paymentchannels.StateCommitment,
			})
		}(item)
	}
	go func() {
		wg.Wait()
		close(read.done)
	}()
	return read
}

func (r *settlementAccountsRead) fail(err error) *settlementAccountsRead {
	r.prepErr = err
	close(r.done)
	return r
}

// result waits for the reads and applies the settlement-account checks. It
// returns early if ctx ends first.
func (r *settlementAccountsRead) result(ctx context.Context, deposit uint64) error {
	select {
	case <-r.done:
	default:
		select {
		case <-r.done:
		case <-ctx.Done():
			return fmt.Errorf("%s: read settlement accounts: %w", batchsettlement.ErrSettlementSimulation, ctx.Err())
		}
	}
	if r.prepErr != nil {
		return r.prepErr
	}
	for _, item := range r.reads {
		if item.ataErr != nil {
			return item.ataErr
		}
		if item.err != nil || item.account == nil || item.account.Value == nil {
			return fmt.Errorf("%s: missing %s ATA: %s", batchsettlement.ErrSettlementSimulation, item.label, item.ata)
		}
		var data []byte
		if item.account.Value.Data != nil {
			data = item.account.Value.Data.GetBinary()
		}
		if problem := paymentchannels.UnusableSettlementAccount(item.account.Value.Owner, data, item.owner, r.mint, r.program); problem != "" {
			return fmt.Errorf("%s: %s ATA %s %s", batchsettlement.ErrSettlementSimulation, item.label, item.ata, problem)
		}
		if item.label == "payer" {
			decoded, _ := paymentchannels.DecodeTokenAccount(data)
			if decoded.Amount < deposit {
				return fmt.Errorf("%s: payer ATA %s holds %d, less than the %d deposit", batchsettlement.ErrSettlementSimulation, item.ata, decoded.Amount, deposit)
			}
		}
	}
	return nil
}

// assertSettlementAccounts ensures a deposit can land and the channel can later
// distribute before the sponsor co-signs it: each payout destination (payer
// return, receiver, treasury) must be a usable token account for the mint
// (an unusable one fails distribute only after the escrow is locked and the
// request served), and the payer's must hold the deposit ("It MUST confirm the
// payer has sufficient tokens"). The three reads run concurrently.
func (f *BatchSvmScheme) assertSettlementAccounts(ctx context.Context, requirements types.PaymentRequirements, payer, tokenProgram string, deposit uint64) error {
	readCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	return f.startSettlementAccountsRead(readCtx, requirements, payer, tokenProgram).result(ctx, deposit)
}

// clusterSlotRead is an in-flight cluster slot read.
type clusterSlotRead struct {
	slot uint64
	err  error
	done chan struct{}
}

func (f *BatchSvmScheme) startClusterSlotRead(ctx context.Context, network string) *clusterSlotRead {
	read := &clusterSlotRead{done: make(chan struct{})}
	go func() {
		defer close(read.done)
		read.slot, read.err = f.signer.GetSlot(ctx, network, paymentchannels.SlotCommitment)
	}()
	return read
}

func (r *clusterSlotRead) result(ctx context.Context) (uint64, error) {
	select {
	case <-r.done:
	default:
		select {
		case <-r.done:
		case <-ctx.Done():
			return 0, ctx.Err()
		}
	}
	return r.slot, r.err
}

// recentSlotHint is the challenge's optional extra.recentSlot.
func recentSlotHint(requirements types.PaymentRequirements) (*uint64, error) {
	if requirements.Extra == nil {
		return nil, nil
	}
	return ParseOptionalSlot(requirements.Extra[batchsettlement.ExtraRecentSlot])
}
