package paymentchannels

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"math"
	"time"

	solana "github.com/gagliardetto/solana-go"
	computebudget "github.com/gagliardetto/solana-go/programs/compute-budget"
	"github.com/gagliardetto/solana-go/rpc"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels/generated"
)

// simPlaceholderBlockhash is compiled into deposit composite sims; the RPC
// replaces it before simulation.
var simPlaceholderBlockhash = solana.Hash{}

const (
	// DefaultChannelReadMaxAttempts is how many times a confirmed open is
	// re-read before the facilitator treats it as missing. The backoff is
	// linear: replica lag is a small multiple of Solana's ~400ms slot time.
	// The defaults sleep 200/400/600/800/1000ms across 6 reads, totalling 3.0s.
	DefaultChannelReadMaxAttempts = 6
	// DefaultChannelReadBackoffStep is the linear delay added per attempt.
	DefaultChannelReadBackoffStep = 200 * time.Millisecond

	// DefaultSettleComputeUnitLimit is the default inline v1 compute limit for
	// facilitator-submitted settlement transactions. A measured claim with a
	// warm recipient ATA consumes ~21.6k CU; a distribute that must recreate a
	// closed recipient ATA adds ~25k. 100k keeps headroom over that worst case.
	DefaultSettleComputeUnitLimit uint32 = 100_000

	// DefaultSettleLoadedAccountsDataSizeLimit is the inline v1 account-data
	// budget for normal settlement. Four MiB covers the mainnet Token-2022
	// program-data account (about 1.4 MiB) with room for the remaining programs
	// and accounts loaded by a settlement.
	DefaultSettleLoadedAccountsDataSizeLimit uint32 = 4_194_304

	ReclaimLoadedAccountsDataSizeBase       uint32 = 262_144
	ReclaimLoadedAccountsDataSizePerChannel uint32 = 1_024

	// ReclaimComputeUnitBase is the base SetComputeUnitLimit for a reclaim batch.
	ReclaimComputeUnitBase uint32 = 25_000
	// ReclaimComputeUnitPerChannel is the additional compute units budgeted per
	// reclaim instruction. A measured reclaim consumes ~320 CU per channel.
	ReclaimComputeUnitPerChannel uint32 = 5_000
)

// ReclaimComputeUnitLimit returns the SetComputeUnitLimit for a reclaim batch
// of channelCount channels, clamped to the per-transaction maximum.
func ReclaimComputeUnitLimit(channelCount int) uint32 {
	limit := ReclaimComputeUnitBase + ReclaimComputeUnitPerChannel*uint32(channelCount)
	if limit > maxTransactionComputeUnits {
		return maxTransactionComputeUnits
	}
	return limit
}

// ReclaimLoadedAccountsDataSizeLimit returns the inline v1 account-data budget
// for a reclaim batch.
func ReclaimLoadedAccountsDataSizeLimit(channelCount int) uint32 {
	return ReclaimLoadedAccountsDataSizeBase + ReclaimLoadedAccountsDataSizePerChannel*uint32(channelCount)
}

// ChannelReadPolicy bounds how long FetchAndVerifyOpenChannel waits for a
// confirmed open to become visible. The zero value resolves to the package defaults.
type ChannelReadPolicy struct {
	MaxAttempts int
	BackoffStep time.Duration
}

// ResolveChannelReadPolicy fills unset fields with the package defaults.
func ResolveChannelReadPolicy(policy ChannelReadPolicy) ChannelReadPolicy {
	if policy.MaxAttempts <= 0 {
		policy.MaxAttempts = DefaultChannelReadMaxAttempts
	}
	if policy.BackoffStep <= 0 {
		policy.BackoffStep = DefaultChannelReadBackoffStep
	}
	return policy
}

// DelayAfterAttempt returns how long to wait before the read following the
// given 1-based attempt.
func DelayAfterAttempt(policy ChannelReadPolicy, attempt int) time.Duration {
	return policy.BackoffStep * time.Duration(attempt)
}

// ExpectedOpenChannel are the challenge-bound terms a confirmed channel account must match.
type ExpectedOpenChannel struct {
	AuthorizedSigner string
	Mint             string
	Payee            string
	Payer            string
	RentPayer        string
	Deposit          uint64
	GracePeriod      uint32
	Splits           []Split
}

// VerifiedOpenChannel are the onchain channel facts retained from verification through settlement.
type VerifiedOpenChannel struct {
	ChannelID        solana.PublicKey
	AuthorizedSigner solana.PublicKey
	Mint             solana.PublicKey
	Payee            solana.PublicKey
	Payer            solana.PublicKey
	RentPayer        solana.PublicKey
	Deposit          uint64
	OpenSlot         uint64
	Splits           []Split
}

// ChannelExists reports whether the channel PDA is already allocated onchain.
func ChannelExists(ctx context.Context, rpcClient ChannelRPC, channelID solana.PublicKey) (bool, error) {
	account, err := getChannelAccount(ctx, rpcClient, channelID)
	if err != nil {
		if errors.Is(err, rpc.ErrNotFound) {
			return false, nil
		}
		return false, fmt.Errorf("failed to fetch channel %s: %w", channelID, err)
	}
	return account != nil && account.Value != nil, nil
}

// FetchAndVerifyOpenChannel refetches the confirmed channel and rebinds it to
// the challenge terms before the facilitator settles against it.
func FetchAndVerifyOpenChannel(
	ctx context.Context,
	rpcClient ChannelRPC,
	channelID solana.PublicKey,
	expected ExpectedOpenChannel,
	policy ChannelReadPolicy,
) (*VerifiedOpenChannel, error) {
	policy = ResolveChannelReadPolicy(policy)
	for attempt := 1; attempt <= policy.MaxAttempts; attempt++ {
		channel, exists, err := fetchChannelAccount(ctx, rpcClient, channelID)
		if err != nil {
			return nil, err
		}
		if exists {
			return VerifyOpenChannelAccount(channelID, channel, expected)
		}
		if attempt == policy.MaxAttempts {
			break
		}
		timer := time.NewTimer(DelayAfterAttempt(policy, attempt))
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
	return nil, fmt.Errorf("channel %s does not exist", channelID)
}

// VerifyOpenChannelAccount binds a decoded channel account to the terms verified
// in the submitted open. The onchain account is the source of truth for settlement.
func VerifyOpenChannelAccount(
	channelID solana.PublicKey,
	channel *generated.Channel,
	expected ExpectedOpenChannel,
) (*VerifiedOpenChannel, error) {
	if channel.Discriminator != uint8(generated.AccountDiscriminator_Channel) {
		return nil, fmt.Errorf("channel %s has an invalid account discriminator", channelID)
	}
	status := generated.ChannelStatus(channel.Status)
	if status != generated.ChannelStatus_Open {
		return nil, fmt.Errorf("channel %s is not open (status %s)", channelID, ChannelStatusString(status))
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
	expectedHash, err := GetChannelDistributionHash(expected.Splits)
	if err != nil {
		return nil, err
	}
	if channel.DistributionHash != expectedHash {
		return nil, fmt.Errorf("channel distribution does not match the expected recipient split")
	}
	return &VerifiedOpenChannel{
		ChannelID:        channelID,
		AuthorizedSigner: channel.AuthorizedSigner,
		Mint:             channel.Mint,
		Payee:            channel.Payee,
		Payer:            channel.Payer,
		RentPayer:        channel.RentPayer,
		Deposit:          channel.Deposit,
		OpenSlot:         channel.OpenSlot,
		Splits:           expected.Splits,
	}, nil
}

// ChannelBroadcastHooks run around an open broadcast so a caller can persist
// the signature before confirmation is awaited.
type ChannelBroadcastHooks struct {
	// OnPrepared runs after the fee payer signs and before the bytes can be sent.
	OnPrepared func(signature, wire string) error
	// OnBroadcast runs once the transaction is on the network, before confirmation.
	OnBroadcast func(signature string) error
}

// ChannelBroadcastConfirmationError is returned when a client transaction was
// broadcast but its confirmation could not be observed. The transaction may
// still land. The caller must persist Signature and reconcile against it.
type ChannelBroadcastConfirmationError struct {
	Signature string
	Err       error
}

func (e *ChannelBroadcastConfirmationError) Error() string {
	return fmt.Sprintf("broadcast %s could not be confirmed: %v", e.Signature, e.Err)
}

func (e *ChannelBroadcastConfirmationError) Unwrap() error { return e.Err }

// BroadcastOpen co-signs the fee-payer slot of a partially signed open,
// broadcasts it, and waits for confirmation.
func BroadcastOpen(
	ctx context.Context,
	signer svm.FacilitatorSvmSigner,
	feePayer solana.PublicKey,
	network string,
	openTransactionBase64 string,
	hooks ChannelBroadcastHooks,
) (string, error) {
	tx, err := svm.DecodeTransaction(openTransactionBase64)
	if err != nil {
		return "", err
	}
	if !svm.IsAcceptedTransactionVersion(tx.Message.GetVersion()) {
		return "", fmt.Errorf("%s: unsupported transaction message version %d", svm.ErrUnsupportedTransactionVersion, int(tx.Message.GetVersion())-1)
	}
	if err := signer.SignTransaction(ctx, tx, feePayer, network); err != nil {
		return "", err
	}
	signature := ""
	if len(tx.Signatures) > 0 {
		signature = tx.Signatures[0].String()
	}
	wire, err := svm.EncodeTransaction(tx)
	if err != nil {
		return "", err
	}
	if hooks.OnPrepared != nil {
		if err := hooks.OnPrepared(signature, wire); err != nil {
			return "", err
		}
	}
	sent, err := signer.SendTransaction(ctx, tx, network)
	if err != nil {
		if hooks.OnPrepared != nil || hooks.OnBroadcast != nil {
			return "", &ChannelBroadcastConfirmationError{Signature: signature, Err: err}
		}
		return "", err
	}
	if hooks.OnPrepared == nil {
		signature = sent.String()
	}
	if hooks.OnBroadcast != nil {
		if err := hooks.OnBroadcast(signature); err != nil {
			return "", err
		}
	}
	if err := signer.ConfirmTransaction(ctx, sent, network); err != nil {
		return "", &ChannelBroadcastConfirmationError{Signature: signature, Err: err}
	}
	return signature, nil
}

// SettlementSimChannel are the channel fields needed to simulate settle and distribute.
type SettlementSimChannel struct {
	ChannelID    solana.PublicKey
	Mint         solana.PublicKey
	Network      string
	Payee        solana.PublicKey
	Payer        solana.PublicKey
	RentPayer    solana.PublicKey
	Splits       []Split
	TokenProgram solana.PublicKey
}

// SimulateOpenSettleDistribute simulates open + settle_and_seal(has_voucher=0)
// + distribute against live state before broadcasting the open. The simulated
// transaction is never broadcast.
func SimulateOpenSettleDistribute(
	ctx context.Context,
	signer PaymentChannelFacilitatorSigner,
	feePayer solana.PublicKey,
	openTransactionBase64 string,
	channel SettlementSimChannel,
) error {
	openTx, err := svm.DecodeTransaction(openTransactionBase64)
	if err != nil {
		return err
	}
	if !svm.IsAcceptedTransactionVersion(openTx.Message.GetVersion()) {
		return fmt.Errorf("%s: unsupported transaction message version %d", svm.ErrUnsupportedTransactionVersion, int(openTx.Message.GetVersion())-1)
	}
	computeLimitIx, err := computebudget.NewSetComputeUnitLimitInstructionBuilder().
		SetUnits(maxTransactionComputeUnits).
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
		isPriorityFee := len(compiled.Data) > 0 && compiled.Data[0] == ComputeBudgetSetUnitPrice
		if program.Equals(solana.ComputeBudget) && !isPriorityFee {
			continue
		}
		accounts, err := compiled.ResolveInstructionAccounts(&openTx.Message)
		if err != nil {
			return fmt.Errorf("failed to resolve open instruction accounts: %w", err)
		}
		instructions = append(instructions, solana.NewInstruction(program, accounts, compiled.Data))
	}
	settle, err := BuildSettleAndSealInstructions(SettleAndSealBuildArgs{
		ChannelID: channel.ChannelID,
		Payee:     channel.Payee,
	})
	if err != nil {
		return err
	}
	instructions = append(instructions, settle...)
	distribute, err := BuildDistributeInstruction(DistributeInstructionArgs{
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
		return err
	}
	instructions = append(instructions, distribute)

	tx, err := buildSignedTransaction(ctx, signer, feePayer, channel.Network, simPlaceholderBlockhash, instructions)
	if err != nil {
		return err
	}
	replaceRecentBlockhash := true
	err = signer.SimulateTransaction(ctx, tx, channel.Network, &svm.FacilitatorSimulateTransactionOptions{
		ReplaceRecentBlockhash: &replaceRecentBlockhash,
		Commitment:             StateCommitment,
	})
	if err != nil {
		return fmt.Errorf("zero-charge settlement simulation failed: %w", err)
	}
	return nil
}

// SubmitSettleOptions configures the inline v1 resource budget and broadcast hooks.
type SubmitSettleOptions struct {
	ComputeUnitLimit            *uint32
	LoadedAccountsDataSizeLimit *uint32
	// UseTransactionV1 opts facilitator-owned submissions into the v1 message
	// format. The zero value preserves the existing v0 wire format.
	UseTransactionV1 bool
	// ComputeUnitPriceMicroLamports is converted to v1's total priority fee.
	ComputeUnitPriceMicroLamports *uint64
	// LatestBlockhash, when set, skips a blockhash fetch.
	LatestBlockhash *solana.Hash
	OnPrepared      func(signature, wire string) error
	OnBroadcast     func(signature string) error
}

// ChannelSubmitSigner is the subset of a facilitator signer a channel submission needs.
type ChannelSubmitSigner interface {
	GetLatestBlockhash(ctx context.Context, network string) (solana.Hash, uint64, error)
	SimulateTransaction(ctx context.Context, tx *solana.Transaction, network string, opts *svm.FacilitatorSimulateTransactionOptions) error
	SendTransaction(ctx context.Context, tx *solana.Transaction, network string) (solana.Signature, error)
	ConfirmTransaction(ctx context.Context, signature solana.Signature, network string) error
	SignTransaction(ctx context.Context, tx *solana.Transaction, feePayer solana.PublicKey, network string) error
}

// ChannelSimulationError is returned when explicit simulation rejects a channel
// transaction. The transaction was never broadcast.
type ChannelSimulationError struct {
	Err error
}

func (e *ChannelSimulationError) Error() string {
	return fmt.Sprintf("channel transaction simulation failed: %v", e.Err)
}

func (e *ChannelSimulationError) Unwrap() error { return e.Err }

// SettlementConfirmationTimeoutError is returned when confirmation is not
// observed. The transaction's fate is unknown, not failed.
type SettlementConfirmationTimeoutError struct {
	Signature string
}

func (e *SettlementConfirmationTimeoutError) Error() string {
	return fmt.Sprintf("timed out waiting for tx %s confirmation", e.Signature)
}

// SubmitSettle signs a settlement through feePayer, broadcasts it on client,
// and confirms. It does not simulate; the RPC send is the only preflight.
func SubmitSettle(
	ctx context.Context,
	feePayer svm.FacilitatorSvmSigner,
	client *rpc.Client,
	feePayerKey solana.PublicKey,
	network string,
	instructions []solana.Instruction,
	opts SubmitSettleOptions,
) (string, error) {
	blockhash, err := resolveSubmitBlockhash(ctx, client, opts)
	if err != nil {
		return "", err
	}
	tx, err := compileChannelTransaction(ctx, feePayer, feePayerKey, network, blockhash, instructions, opts)
	if err != nil {
		return "", err
	}
	signature, err := submitSignedTransaction(tx, opts, func(tx *solana.Transaction) (solana.Signature, error) {
		return client.SendTransaction(ctx, tx)
	}, func(signature solana.Signature) error {
		return ConfirmSignature(ctx, client, signature, 30*time.Second, false)
	})
	return signature, err
}

// SubmitChannelTransactionWithSigner signs, simulates, broadcasts, and confirms
// a channel transaction through the facilitator signer. Simulation is explicit
// so a preflight rejection is not an opaque send error.
func SubmitChannelTransactionWithSigner(
	ctx context.Context,
	feePayer svm.FacilitatorSvmSigner,
	signer ChannelSubmitSigner,
	feePayerKey solana.PublicKey,
	network string,
	instructions []solana.Instruction,
	opts SubmitSettleOptions,
) (string, error) {
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
	tx, err := compileChannelTransaction(ctx, feePayer, feePayerKey, network, blockhash, instructions, opts)
	if err != nil {
		return "", err
	}
	if err := signer.SimulateTransaction(ctx, tx, network, nil); err != nil {
		return "", &ChannelSimulationError{Err: err}
	}
	return submitSignedTransaction(tx, opts, func(tx *solana.Transaction) (solana.Signature, error) {
		return signer.SendTransaction(ctx, tx, network)
	}, func(signature solana.Signature) error {
		return signer.ConfirmTransaction(ctx, signature, network)
	})
}

// ConfirmSignature polls getSignatureStatuses until the signature reaches at
// least confirmed, or timeout elapses. searchTransactionHistory is sent only
// on the first lookup; later polls use the recent-status cache.
func ConfirmSignature(ctx context.Context, client *rpc.Client, signature solana.Signature, timeout time.Duration, searchTransactionHistory bool) error {
	deadline := time.Now().Add(timeout)
	search := searchTransactionHistory
	for {
		statuses, err := client.GetSignatureStatuses(ctx, search, signature)
		search = false
		if err != nil {
			return err
		}
		if statuses != nil && len(statuses.Value) > 0 && statuses.Value[0] != nil {
			status := statuses.Value[0]
			if status.Err != nil {
				return &svm.TransactionOnchainFailureError{
					Message: fmt.Sprintf("tx %s failed onchain: %v", signature, status.Err),
				}
			}
			level := status.ConfirmationStatus
			if level == "" || level == rpc.ConfirmationStatusConfirmed || level == rpc.ConfirmationStatusFinalized {
				return nil
			}
		}
		if time.Now().After(deadline) {
			return &SettlementConfirmationTimeoutError{Signature: signature.String()}
		}
		timer := time.NewTimer(time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

// GetChannelDistributionHash computes the distribution commitment the program
// stores at open and re-checks at distribute.
func GetChannelDistributionHash(splits []Split) ([32]byte, error) {
	hasher := sha256.New()
	hasher.Write(u32LE(uint32(len(splits))))
	for _, split := range splits {
		recipient, err := solana.PublicKeyFromBase58(split.Recipient)
		if err != nil {
			return [32]byte{}, fmt.Errorf("invalid distribution recipient %s: %w", split.Recipient, err)
		}
		hasher.Write(recipient.Bytes())
		hasher.Write(u16LE(split.BPS))
	}
	var out [32]byte
	copy(out[:], hasher.Sum(nil))
	return out, nil
}

func fetchChannelAccount(ctx context.Context, rpcClient ChannelRPC, channelID solana.PublicKey) (*generated.Channel, bool, error) {
	account, err := getChannelAccount(ctx, rpcClient, channelID)
	if err != nil {
		if errors.Is(err, rpc.ErrNotFound) {
			return nil, false, nil
		}
		return nil, false, fmt.Errorf("failed to fetch channel %s: %w", channelID, err)
	}
	if account == nil || account.Value == nil {
		return nil, false, nil
	}
	channel, err := DecodeChannel(account.Value.Data.GetBinary())
	if err != nil {
		return nil, true, err
	}
	return channel, true, nil
}

func getChannelAccount(ctx context.Context, rpcClient ChannelRPC, channelID solana.PublicKey) (*rpc.GetAccountInfoResult, error) {
	return rpcClient.GetAccountInfo(ctx, channelID, &rpc.GetAccountInfoOpts{
		Encoding:   solana.EncodingBase64,
		Commitment: StateCommitment,
	})
}

func resolveSubmitBlockhash(
	ctx context.Context,
	client *rpc.Client,
	opts SubmitSettleOptions,
) (solana.Hash, error) {
	if opts.LatestBlockhash != nil {
		return *opts.LatestBlockhash, nil
	}
	latest, err := client.GetLatestBlockhash(ctx, BlockhashCommitment)
	if err != nil {
		return solana.Hash{}, fmt.Errorf("failed to fetch latest blockhash: %w", err)
	}
	return latest.Value.Blockhash, nil
}

func compileChannelTransaction(
	ctx context.Context,
	feePayer svm.FacilitatorSvmSigner,
	feePayerKey solana.PublicKey,
	network string,
	blockhash solana.Hash,
	instructions []solana.Instruction,
	opts SubmitSettleOptions,
) (*solana.Transaction, error) {
	if opts.UseTransactionV1 {
		tx, err := buildSettleTransaction(feePayerKey, blockhash, instructions, opts)
		if err != nil {
			return nil, err
		}
		if err := feePayer.SignTransaction(ctx, tx, feePayerKey, network); err != nil {
			return nil, err
		}
		return tx, nil
	}
	budget, err := buildSettleComputeBudget(opts)
	if err != nil {
		return nil, err
	}
	return buildSignedTransaction(ctx, feePayer, feePayerKey, network, blockhash, append(budget, instructions...))
}

func buildSettleComputeBudget(opts SubmitSettleOptions) ([]solana.Instruction, error) {
	limit := DefaultSettleComputeUnitLimit
	if opts.ComputeUnitLimit != nil {
		limit = *opts.ComputeUnitLimit
	}
	limitIx, err := computebudget.NewSetComputeUnitLimitInstructionBuilder().SetUnits(limit).ValidateAndBuild()
	if err != nil {
		return nil, fmt.Errorf("failed to build compute limit instruction: %w", err)
	}
	instructions := []solana.Instruction{limitIx}
	price := uint64(svm.DefaultComputeUnitPriceMicrolamports)
	if opts.ComputeUnitPriceMicroLamports != nil {
		price = *opts.ComputeUnitPriceMicroLamports
	}
	if price == 0 {
		return instructions, nil
	}
	priceIx, err := computebudget.NewSetComputeUnitPriceInstructionBuilder().SetMicroLamports(price).ValidateAndBuild()
	if err != nil {
		return nil, fmt.Errorf("failed to build compute price instruction: %w", err)
	}
	return append(instructions, priceIx), nil
}

func priorityFeeLamports(computeUnitLimit uint32, microLamports uint64) (uint64, error) {
	whole := microLamports / 1_000_000
	if computeUnitLimit > 0 && whole > math.MaxUint64/uint64(computeUnitLimit) {
		return 0, fmt.Errorf("priority fee overflows uint64")
	}
	fee := whole * uint64(computeUnitLimit)
	remainder := microLamports % 1_000_000
	fraction := (remainder*uint64(computeUnitLimit) + 999_999) / 1_000_000
	if fee > math.MaxUint64-fraction {
		return 0, fmt.Errorf("priority fee overflows uint64")
	}
	return fee + fraction, nil
}

func buildSettleTransactionConfig(opts SubmitSettleOptions) (solana.TransactionConfig, error) {
	limit := DefaultSettleComputeUnitLimit
	if opts.ComputeUnitLimit != nil {
		limit = *opts.ComputeUnitLimit
	}
	loadedLimit := DefaultSettleLoadedAccountsDataSizeLimit
	if opts.LoadedAccountsDataSizeLimit != nil {
		loadedLimit = *opts.LoadedAccountsDataSizeLimit
	}
	config := solana.TransactionConfig{}.
		WithComputeUnitLimit(limit).
		WithLoadedAccountsDataSizeLimit(loadedLimit)
	price := uint64(svm.DefaultComputeUnitPriceMicrolamports)
	if opts.ComputeUnitPriceMicroLamports != nil {
		price = *opts.ComputeUnitPriceMicroLamports
	}
	if price == 0 {
		return config, nil
	}
	fee, err := priorityFeeLamports(limit, price)
	if err != nil {
		return solana.TransactionConfig{}, err
	}
	return config.WithPriorityFee(fee), nil
}

func buildSettleTransaction(
	feePayer solana.PublicKey,
	blockhash solana.Hash,
	instructions []solana.Instruction,
	opts SubmitSettleOptions,
) (*solana.Transaction, error) {
	config, err := buildSettleTransactionConfig(opts)
	if err != nil {
		return nil, err
	}
	tx, err := solana.NewTransaction(
		instructions,
		blockhash,
		solana.TransactionPayer(feePayer),
		solana.TransactionV1Config(config),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to build transaction: %w", err)
	}
	tx.Signatures = make([]solana.Signature, tx.Message.Header.NumRequiredSignatures)
	return tx, nil
}

// FacilitatorV1TransactionFits checks every v1 envelope limit against an encoded candidate.
func FacilitatorV1TransactionFits(
	feePayer solana.PublicKey,
	instructions []solana.Instruction,
	opts SubmitSettleOptions,
) bool {
	tx, err := buildSettleTransaction(feePayer, simPlaceholderBlockhash, instructions, opts)
	if err != nil {
		return false
	}
	if len(tx.Message.AccountKeys) > solana.MaxAddressesV1 || len(tx.Message.Instructions) > solana.MaxInstructionsV1 {
		return false
	}
	wire, err := tx.MarshalBinary()
	return err == nil && len(wire) <= solana.MaxTransactionSizeV1
}

func buildSignedTransaction(
	ctx context.Context,
	signer svm.FacilitatorSvmSigner,
	feePayer solana.PublicKey,
	network string,
	blockhash solana.Hash,
	instructions []solana.Instruction,
) (*solana.Transaction, error) {
	builder := solana.NewTransactionBuilder().SetRecentBlockHash(blockhash).SetFeePayer(feePayer)
	for _, instruction := range instructions {
		builder = builder.AddInstruction(instruction)
	}
	tx, err := builder.Build()
	if err != nil {
		return nil, fmt.Errorf("failed to build transaction: %w", err)
	}
	if _, err := tx.Message.SetVersion(solana.MessageVersionV0); err != nil {
		return nil, fmt.Errorf("failed to set transaction version: %w", err)
	}
	tx.Signatures = make([]solana.Signature, tx.Message.Header.NumRequiredSignatures)
	if err := signer.SignTransaction(ctx, tx, feePayer, network); err != nil {
		return nil, err
	}
	return tx, nil
}

func submitSignedTransaction(
	tx *solana.Transaction,
	opts SubmitSettleOptions,
	send func(*solana.Transaction) (solana.Signature, error),
	confirm func(solana.Signature) error,
) (string, error) {
	signature := ""
	if len(tx.Signatures) > 0 {
		signature = tx.Signatures[0].String()
	}
	if opts.OnPrepared != nil {
		wire, err := svm.EncodeTransaction(tx)
		if err != nil {
			return "", err
		}
		if err := opts.OnPrepared(signature, wire); err != nil {
			return "", err
		}
	}
	sent, err := send(tx)
	if err != nil {
		return "", &SettlementConfirmationTimeoutError{Signature: signature}
	}
	if opts.OnPrepared == nil {
		signature = sent.String()
	}
	if opts.OnBroadcast != nil {
		if err := opts.OnBroadcast(signature); err != nil {
			return "", err
		}
	}
	if err := confirm(sent); err != nil {
		var timeout *SettlementConfirmationTimeoutError
		if errors.As(err, &timeout) {
			return "", err
		}
		var onchain *svm.TransactionOnchainFailureError
		if errors.As(err, &onchain) {
			return "", err
		}
		return "", &SettlementConfirmationTimeoutError{Signature: signature}
	}
	return signature, nil
}
