package facilitator

import (
	"context"
	"errors"
	"fmt"
	"time"

	solana "github.com/gagliardetto/solana-go"
	computebudget "github.com/gagliardetto/solana-go/programs/compute-budget"
	"github.com/gagliardetto/solana-go/rpc"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/upto"
)

// simPlaceholderBlockhash is compiled into deposit composite sims; the RPC
// replaces it before simulation.
var simPlaceholderBlockhash = solana.Hash{}

// simComputeUnitLimit is the Solana per-transaction compute maximum. Only used
// for facilitator-built simulations: the composite open + settle + distribute
// exceeds the 400,000 CU ceiling the client open is capped at.
const (
	simComputeUnitLimit = 1_400_000

	// Channel reads can briefly lag a confirmed open when an RPC provider
	// serves transaction status and account state from different replicas.
	//
	// The backoff is linear, not exponential: replica lag is a small multiple of
	// Solana's ~400ms slot time, so doubling spends the budget on single waits
	// far longer than the lag being absorbed. The defaults sleep
	// 200/400/600/800/1000ms across 6 reads, totalling 3.0s.
	DefaultChannelReadMaxAttempts = 6
	DefaultChannelReadBackoffStep = 200 * time.Millisecond

	// DefaultSettleComputeUnitLimit is the default SetComputeUnitLimit for
	// facilitator-submitted settlement transactions: claim (settle_and_seal +
	// optional Ed25519 precompile + distribute), the zero-charge cancel, and
	// rent-cleanup close/distribute. A measured claim with a warm recipient
	// ATA consumes ~21.6k CU; a distribute that must recreate a closed
	// recipient ATA adds ~25k. 100k keeps >2x headroom over that worst case.
	// Assumes standard SPL Token (or Token-2022 without execution extensions)
	// behavior — mints with transfer hooks or other compute-heavy extensions
	// need an explicit submitSettleOptions.ComputeUnitLimit override.
	DefaultSettleComputeUnitLimit uint32 = 100_000

	// ReclaimComputeUnitBase is the base SetComputeUnitLimit for a reclaim
	// batch transaction.
	ReclaimComputeUnitBase uint32 = 25_000

	// ReclaimComputeUnitPerChannel is the additional compute units budgeted
	// per reclaim instruction in a batch. A measured reclaim consumes ~320 CU
	// per channel and is mint-independent (the escrow ATA is already closed
	// by that point — reclaim only closes the channel PDA and returns
	// lamports), so 5k per channel is >15x margin.
	ReclaimComputeUnitPerChannel uint32 = 5_000
)

// ReclaimComputeUnitLimit returns the SetComputeUnitLimit for a reclaim batch
// of channelCount channels, clamped to the per-transaction maximum.
func ReclaimComputeUnitLimit(channelCount int) uint32 {
	limit := ReclaimComputeUnitBase + ReclaimComputeUnitPerChannel*uint32(channelCount)
	if limit > simComputeUnitLimit {
		return simComputeUnitLimit
	}
	return limit
}

// expectedOpenChannel are the challenge-bound terms a confirmed channel account
// must match before the facilitator settles against it. They arrive as strings
// because that is how the challenge and payload carry them.
type expectedOpenChannel struct {
	AuthorizedSigner string
	Mint             string
	Payee            string
	Payer            string
	RentPayer        string
	Deposit          uint64
	GracePeriod      uint32
	Splits           []paymentchannels.Split
}

// channelKeys are a channel's onchain addresses as decoded from the account, so
// settlement builds instructions without parsing them back out of strings.
type channelKeys struct {
	ChannelID        solana.PublicKey
	AuthorizedSigner solana.PublicKey
	Mint             solana.PublicKey
	Payee            solana.PublicKey
	Payer            solana.PublicKey
	RentPayer        solana.PublicKey
}

// verifiedOpenChannel are the onchain channel facts retained from verification
// through settlement.
type verifiedOpenChannel struct {
	channelKeys
	Splits []paymentchannels.Split
}

// settlement projects a verified channel onto the settle+distribute inputs.
func (c *verifiedOpenChannel) settlement(tokenProgram solana.PublicKey, network string) settlementChannel {
	return settlementChannel{
		ChannelID:    c.ChannelID,
		Mint:         c.Mint,
		Payee:        c.Payee,
		Payer:        c.Payer,
		RentPayer:    c.RentPayer,
		TokenProgram: tokenProgram,
		Network:      network,
		Splits:       c.Splits,
	}
}

// fetchChannelAccount reads and decodes a channel account. The second return
// value reports whether the account exists at all.
func fetchChannelAccount(
	ctx context.Context,
	signer UptoFacilitatorSigner,
	network string,
	channelID solana.PublicKey,
) (*paymentchannels.Channel, bool, error) {
	account, err := getChannelAccount(ctx, signer, network, channelID)
	if err != nil {
		if errors.Is(err, rpc.ErrNotFound) {
			return nil, false, nil
		}
		return nil, false, fmt.Errorf("failed to fetch channel %s: %w", channelID, err)
	}
	if account == nil || account.Value == nil {
		return nil, false, nil
	}

	channel, err := paymentchannels.DecodeChannel(account.Value.Data.GetBinary())
	if err != nil {
		return nil, true, err
	}
	return channel, true, nil
}

// getChannelAccount reads a channel account at the commitment the facilitator
// confirms its own transactions at, so an open broadcast on a previous request
// is visible to this one.
func getChannelAccount(
	ctx context.Context,
	signer UptoFacilitatorSigner,
	network string,
	channelID solana.PublicKey,
) (*rpc.GetAccountInfoResult, error) {
	return signer.GetAccountInfo(ctx, channelID, network, &rpc.GetAccountInfoOpts{
		Encoding:   solana.EncodingBase64,
		Commitment: upto.StateCommitment,
	})
}

// channelExists reports whether the channel PDA is already allocated onchain.
func channelExists(
	ctx context.Context,
	signer UptoFacilitatorSigner,
	network string,
	channelID solana.PublicKey,
) (bool, error) {
	account, err := getChannelAccount(ctx, signer, network, channelID)
	if err != nil {
		if errors.Is(err, rpc.ErrNotFound) {
			return false, nil
		}
		return false, fmt.Errorf("failed to fetch channel %s: %w", channelID, err)
	}
	return account != nil && account.Value != nil, nil
}

// channelReadPolicy bounds how long fetchAndVerifyOpenChannel waits for a confirmed open to
// become visible. The zero value resolves to the package defaults.
type channelReadPolicy struct {
	maxAttempts int
	backoffStep time.Duration
}

// resolveChannelReadPolicy builds the policy from the scheme's configured overrides.
func (f *UptoSvmScheme) resolveChannelReadPolicy() channelReadPolicy {
	policy := channelReadPolicy{}
	if f.config.ChannelReadMaxAttempts != nil {
		policy.maxAttempts = *f.config.ChannelReadMaxAttempts
	}
	if f.config.ChannelReadBackoffStep != nil {
		policy.backoffStep = *f.config.ChannelReadBackoffStep
	}
	return policy
}

// resolve fills unset fields with the package defaults, so callers can pass a zero value.
func (p channelReadPolicy) resolve() channelReadPolicy {
	if p.maxAttempts <= 0 {
		p.maxAttempts = DefaultChannelReadMaxAttempts
	}
	if p.backoffStep <= 0 {
		p.backoffStep = DefaultChannelReadBackoffStep
	}
	return p
}

// delayAfterAttempt returns how long to wait before the read following the given 1-based attempt.
func (p channelReadPolicy) delayAfterAttempt(attempt int) time.Duration {
	return p.backoffStep * time.Duration(attempt)
}

// fetchAndVerifyOpenChannel refetches the confirmed channel and rebinds it to
// the challenge terms before the facilitator settles against it.
func fetchAndVerifyOpenChannel(
	ctx context.Context,
	signer UptoFacilitatorSigner,
	network string,
	channelID solana.PublicKey,
	expected expectedOpenChannel,
	policy channelReadPolicy,
) (*verifiedOpenChannel, error) {
	policy = policy.resolve()

	for attempt := 1; attempt <= policy.maxAttempts; attempt++ {
		channel, exists, err := fetchChannelAccount(ctx, signer, network, channelID)
		if err != nil {
			return nil, err
		}
		if exists {
			// Existing but invalid state is terminal: only account absence can
			// be caused by replica visibility lag.
			return verifyOpenChannelAccount(channelID, channel, expected)
		}
		if attempt == policy.maxAttempts {
			break
		}

		timer := time.NewTimer(policy.delayAfterAttempt(attempt))
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}

	return nil, fmt.Errorf("channel %s does not exist", channelID)
}

// verifyOpenChannelAccount binds a decoded channel account to the terms the
// facilitator verified in the submitted open. The onchain account — not the
// client payload — is the source of truth for settlement.
func verifyOpenChannelAccount(
	channelID solana.PublicKey,
	channel *paymentchannels.Channel,
	expected expectedOpenChannel,
) (*verifiedOpenChannel, error) {
	if channel.Status != paymentchannels.StatusOpen {
		return nil, fmt.Errorf("channel %s is not open (status %s)", channelID, channel.Status)
	}

	bindings := []struct {
		label  string
		actual string
		wanted string
	}{
		{"mint", channel.Mint.String(), expected.Mint},
		{"payee", channel.Payee.String(), expected.Payee},
		{"authorized signer", channel.AuthorizedSigner.String(), expected.AuthorizedSigner},
		{"rent payer", channel.RentPayer.String(), expected.RentPayer},
		{"payer", channel.Payer.String(), expected.Payer},
	}
	for _, binding := range bindings {
		if binding.actual != binding.wanted {
			return nil, fmt.Errorf("channel %s %s != expected %s", binding.label, binding.actual, binding.wanted)
		}
	}

	if channel.GracePeriod != expected.GracePeriod {
		return nil, fmt.Errorf("channel grace period %d != expected %d", channel.GracePeriod, expected.GracePeriod)
	}
	if channel.Deposit != expected.Deposit {
		return nil, fmt.Errorf("channel deposit %d != expected %d", channel.Deposit, expected.Deposit)
	}

	expectedHash, err := paymentchannels.DistributionHash(expected.Splits)
	if err != nil {
		return nil, err
	}
	if channel.DistributionHash != expectedHash {
		return nil, fmt.Errorf("channel distribution does not match the expected recipient split")
	}

	return &verifiedOpenChannel{
		channelKeys: channelKeys{
			ChannelID:        channelID,
			AuthorizedSigner: channel.AuthorizedSigner,
			Mint:             channel.Mint,
			Payee:            channel.Payee,
			Payer:            channel.Payer,
			RentPayer:        channel.RentPayer,
		},
		Splits: expected.Splits,
	}, nil
}

// broadcastOpen co-signs the fee-payer slot of the client's partially signed
// open, broadcasts it, and waits for confirmation.
//
// On a ConfirmTransaction failure the broadcast signature is still returned
// alongside the error (unlike a SignTransaction/SendTransaction failure,
// which returns "") so the caller can distinguish "never landed, safe to
// retry with a fresh broadcast" from "broadcast successfully but unconfirmed,
// must reconcile against this signature instead of re-broadcasting."
func broadcastOpen(
	ctx context.Context,
	signer svm.FacilitatorSvmSigner,
	feePayer solana.PublicKey,
	network string,
	openTransactionBase64 string,
) (string, error) {
	tx, err := svm.DecodeTransaction(openTransactionBase64)
	if err != nil {
		return "", err
	}
	if err := signer.SignTransaction(ctx, tx, feePayer, network); err != nil {
		return "", err
	}
	signature, err := signer.SendTransaction(ctx, tx, network)
	if err != nil {
		return "", err
	}
	if err := signer.ConfirmTransaction(ctx, signature, network); err != nil {
		return signature.String(), err
	}
	return signature.String(), nil
}

// settlementChannel are the channel facts needed to build settle+distribute,
// for both the pre-broadcast simulation and the real claim. The authorized
// signer is absent because it travels with the voucher, which the simulation
// does not carry.
type settlementChannel struct {
	ChannelID    solana.PublicKey
	Mint         solana.PublicKey
	Payee        solana.PublicKey
	Payer        solana.PublicKey
	RentPayer    solana.PublicKey
	TokenProgram solana.PublicKey
	Network      string
	Splits       []paymentchannels.Split
}

// simulateOpenSettleDistribute simulates open + settle_and_seal(has_voucher=0)
// + distribute against live state before broadcasting the open, so settlement
// account failures reject the payment without escrowing the client's deposit.
//
// The simulated transaction is facilitator-owned and never broadcast: the
// client's instructions are kept verbatim, the compute-unit limit is raised to
// the per-transaction max, and the payer's signature is absent (simulation runs
// with signature verification off).
func simulateOpenSettleDistribute(
	ctx context.Context,
	signer UptoFacilitatorSigner,
	feePayer solana.PublicKey,
	openTransactionBase64 string,
	channel settlementChannel,
) error {
	openTx, err := svm.DecodeTransaction(openTransactionBase64)
	if err != nil {
		return err
	}

	computeLimitIx, err := computebudget.NewSetComputeUnitLimitInstructionBuilder().
		SetUnits(simComputeUnitLimit).
		ValidateAndBuild()
	if err != nil {
		return fmt.Errorf("failed to build compute limit instruction: %w", err)
	}
	instructions := []solana.Instruction{computeLimitIx}

	for _, compiled := range openTx.Message.Instructions {
		program, err := openTx.Message.Program(compiled.ProgramIDIndex)
		if err != nil {
			return fmt.Errorf("failed to resolve open instruction program: %w", err)
		}
		// Keep the client's priority fee; its compute-unit limit is replaced above.
		isPriorityFee := len(compiled.Data) > 0 && compiled.Data[0] == paymentchannels.ComputeBudgetSetUnitPrice
		if program.Equals(solana.ComputeBudget) && !isPriorityFee {
			continue
		}
		accounts, err := compiled.ResolveInstructionAccounts(&openTx.Message)
		if err != nil {
			return fmt.Errorf("failed to resolve open instruction accounts: %w", err)
		}
		instructions = append(instructions, solana.NewInstruction(program, accounts, compiled.Data))
	}

	settleInstructions, err := buildSettleAndDistribute(channel, nil)
	if err != nil {
		return err
	}
	instructions = append(instructions, settleInstructions...)

	return simulateInstructions(ctx, signer, feePayer, channel.Network, instructions)
}

// voucherArgs carry a signed voucher into settle_and_seal via the Ed25519
// precompile. A nil voucher seals the channel at zero (full refund).
type voucherArgs struct {
	AuthorizedSigner solana.PublicKey
	SignatureBase58  string
	CumulativeAmount uint64
	ExpiresAt        int64
}

// buildSettleAndDistribute builds the settlement instruction sequence:
// an optional Ed25519 precompile carrying the voucher, settle_and_seal, and
// distribute. The precompile must immediately precede settle_and_seal because
// the program reads the voucher from the instruction at index -1.
func buildSettleAndDistribute(
	channel settlementChannel,
	voucher *voucherArgs,
) ([]solana.Instruction, error) {
	var instructions []solana.Instruction

	if voucher != nil {
		signature, err := solana.SignatureFromBase58(voucher.SignatureBase58)
		if err != nil {
			return nil, fmt.Errorf("voucher signature is not valid base58: %w", err)
		}
		message := paymentchannels.EncodeVoucherMessage(
			channel.ChannelID, voucher.CumulativeAmount, voucher.ExpiresAt,
		)
		precompile, err := paymentchannels.BuildEd25519VerifyInstruction(
			message, signature[:], voucher.AuthorizedSigner,
		)
		if err != nil {
			return nil, err
		}
		instructions = append(instructions, precompile)
	}

	instructions = append(instructions, paymentchannels.BuildSettleAndSealInstruction(
		channel.ChannelID, channel.Payee, voucher != nil,
	))

	distribute, err := paymentchannels.BuildDistributeInstruction(paymentchannels.DistributeInstructionArgs{
		Channel:      channel.ChannelID,
		Payer:        channel.Payer,
		Payee:        channel.Payee,
		RentPayer:    channel.RentPayer,
		Mint:         channel.Mint,
		TokenProgram: channel.TokenProgram,
		Splits:       channel.Splits,
		Network:      channel.Network,
	})
	if err != nil {
		return nil, err
	}
	return append(instructions, distribute), nil
}

// buildSignedTransaction compiles instructions into a fee-payer-signed
// transaction anchored to blockhash.
func buildSignedTransaction(
	ctx context.Context,
	signer svm.FacilitatorSvmSigner,
	feePayer solana.PublicKey,
	network string,
	blockhash solana.Hash,
	instructions []solana.Instruction,
) (*solana.Transaction, error) {
	builder := solana.NewTransactionBuilder().
		SetRecentBlockHash(blockhash).
		SetFeePayer(feePayer)
	for _, instruction := range instructions {
		builder = builder.AddInstruction(instruction)
	}
	tx, err := builder.Build()
	if err != nil {
		return nil, fmt.Errorf("failed to build transaction: %w", err)
	}
	tx.Message.SetVersion(solana.MessageVersionV0)

	// Size the signature array to the header before signing: solana-go only
	// grows it to the signer's own index, which would leave a short array (and
	// a malformed wire transaction) when another required signer is absent.
	tx.Signatures = make([]solana.Signature, tx.Message.Header.NumRequiredSignatures)
	if err := signer.SignTransaction(ctx, tx, feePayer, network); err != nil {
		return nil, err
	}
	return tx, nil
}

// simulateInstructions simulates a facilitator-built instruction list without
// broadcasting. Signature verification is disabled because these transactions
// are never landed and the composite open simulation carries an unsigned payer.
func simulateInstructions(
	ctx context.Context,
	signer UptoFacilitatorSigner,
	feePayer solana.PublicKey,
	network string,
	instructions []solana.Instruction,
) error {
	tx, err := buildSignedTransaction(ctx, signer, feePayer, network, simPlaceholderBlockhash, instructions)
	if err != nil {
		return err
	}

	return signer.SimulateTransactionWithOpts(ctx, tx, network, &rpc.SimulateTransactionOpts{
		SigVerify:              false,
		ReplaceRecentBlockhash: true,
		Commitment:             upto.StateCommitment,
	})
}

// SettlementSimulationError is returned when explicit settlement simulation
// fails. The transaction is never broadcast.
type SettlementSimulationError struct {
	Err error
}

func (e *SettlementSimulationError) Error() string {
	if e.Err != nil {
		return e.Err.Error()
	}
	return "settlement simulation failed"
}

func (e *SettlementSimulationError) Unwrap() error {
	return e.Err
}

// submitSettleOptions configures the ComputeBudget prefix submitSettle
// attaches ahead of a settlement instruction list.
type submitSettleOptions struct {
	// ComputeUnitLimit overrides SetComputeUnitLimit. Defaults to
	// DefaultSettleComputeUnitLimit. Unlike the open builder, this is always
	// emitted (never omitted at 0): the transaction is facilitator-built, not
	// wallet-injected, so there is no default-CU fallback worth preserving.
	ComputeUnitLimit *uint32
	// ComputeUnitPriceMicroLamports overrides SetComputeUnitPrice; 0 omits
	// the instruction. Defaults to svm.DefaultComputeUnitPriceMicrolamports.
	ComputeUnitPriceMicroLamports *uint64
	// LatestBlockhash, when set, skips a blockhash fetch (e.g. prefetched in
	// parallel with a channel read during claim settle).
	LatestBlockhash *solana.Hash
}

// buildSettleComputeBudget builds the ComputeBudget prefix submitSettle
// attaches: a SetComputeUnitLimit (always emitted) and an optional
// SetComputeUnitPrice (omitted at 0).
func buildSettleComputeBudget(opts submitSettleOptions) ([]solana.Instruction, error) {
	computeUnitLimit := DefaultSettleComputeUnitLimit
	if opts.ComputeUnitLimit != nil {
		computeUnitLimit = *opts.ComputeUnitLimit
	}
	limitIx, err := computebudget.NewSetComputeUnitLimitInstructionBuilder().
		SetUnits(computeUnitLimit).
		ValidateAndBuild()
	if err != nil {
		return nil, fmt.Errorf("failed to build compute limit instruction: %w", err)
	}
	instructions := []solana.Instruction{limitIx}

	computeUnitPrice := uint64(svm.DefaultComputeUnitPriceMicrolamports)
	if opts.ComputeUnitPriceMicroLamports != nil {
		computeUnitPrice = *opts.ComputeUnitPriceMicroLamports
	}
	if computeUnitPrice > 0 {
		priceIx, err := computebudget.NewSetComputeUnitPriceInstructionBuilder().
			SetMicroLamports(computeUnitPrice).
			ValidateAndBuild()
		if err != nil {
			return nil, fmt.Errorf("failed to build compute price instruction: %w", err)
		}
		instructions = append(instructions, priceIx)
	}
	return instructions, nil
}

// submitSettle signs, broadcasts, and confirms a settlement instruction list
// (settle_and_seal/distribute or a reclaim batch), prefixed with a
// ComputeBudget SetComputeUnitLimit and optional SetComputeUnitPrice.
func submitSettle(
	ctx context.Context,
	signer UptoFacilitatorSigner,
	feePayer solana.PublicKey,
	network string,
	instructions []solana.Instruction,
	opts submitSettleOptions,
) (string, error) {
	computeBudget, err := buildSettleComputeBudget(opts)
	if err != nil {
		return "", err
	}

	var blockhash solana.Hash
	if opts.LatestBlockhash != nil {
		blockhash = *opts.LatestBlockhash
	} else {
		latest, _, err := signer.GetLatestBlockhash(ctx, network)
		if err != nil {
			return "", fmt.Errorf("failed to fetch latest blockhash: %w", err)
		}
		blockhash = latest
	}

	tx, err := buildSignedTransaction(
		ctx, signer, feePayer, network, blockhash, append(computeBudget, instructions...),
	)
	if err != nil {
		return "", err
	}

	if err := signer.SimulateTransaction(ctx, tx, network); err != nil {
		return "", &SettlementSimulationError{Err: err}
	}

	signature, err := signer.SendTransaction(ctx, tx, network)
	if err != nil {
		return "", err
	}
	if err := signer.ConfirmTransaction(ctx, signature, network); err != nil {
		return signature.String(), err
	}
	return signature.String(), nil
}
