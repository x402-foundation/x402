package facilitator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	solana "github.com/gagliardetto/solana-go"
	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels/generated"
	"github.com/x402-foundation/x402/go/v2/types"
)

type durableArgs struct {
	key        string
	network    string
	payer      string
	beforeSend func() (*x402.SettleResponse, error)
	send       func(func(string, string) error) (string, error)
	broadcast  func() (durableResult, error)
	// postcondition observes the operation's result onchain, handing it back through
	// the caller's captures. fromPending is true when the signature was recovered
	// from the pending store rather than just sent.
	postcondition func(fromPending bool) error
}

// settleDurably runs one operation under args.key: it reconciles a pending
// broadcast, checks chain state in beforeSend, or broadcasts under a
// reservation. Storage cost on the happy path is one pending read and one reservation.
// A nil response means the operation landed and its postcondition held. Without
// broadcast, send must be set unless beforeSend always fails (a reconcile-only operation).
func (f *BatchSvmScheme) settleDurably(ctx context.Context, args durableArgs) (string, *x402.SettleResponse, error) {
	finish := func(signature string, fromPending bool) (string, *x402.SettleResponse, error) {
		if err := args.postcondition(fromPending); err != nil {
			return signature, f.unfinished(ctx, args.key, signature, args.payer, args.network, fromPending, err), nil
		}
		return signature, nil, nil
	}
	if pending, ok, err := f.pendingStore.Get(ctx, args.key); err != nil {
		return "", nil, err
	} else if ok {
		recovered, err := f.reconcileBroadcast(ctx, args.key, pending, args.network, args.payer)
		if err != nil || !recovered.OK {
			return recovered.Signature, recovered.Response, err
		}
		signature, response, err := finish(recovered.Signature, true)
		if err == nil && response == nil {
			f.forgetPending(ctx, args.key, pending)
		}
		return signature, response, err
	}
	if args.beforeSend != nil {
		early, err := args.beforeSend()
		if err != nil || early != nil {
			return "", early, err
		}
	}
	var sent durableResult
	var err error
	if args.broadcast != nil {
		sent, err = args.broadcast()
	} else {
		// A worker that recorded the key after the read above holds its reservation, so the send reconciles with it.
		sent, err = f.broadcastUnchecked(ctx, args.key, args.network, args.payer, args.send)
	}
	if err != nil || !sent.OK {
		return sent.Signature, sent.Response, err
	}
	return finish(sent.Signature, false)
}

// unfinished answers settlement_pending for a signature whose postcondition has not
// held yet, recording it first unless it already came from the pending store.
func (f *BatchSvmScheme) unfinished(ctx context.Context, key, signature, payer, network string, fromPending bool, cause error) *x402.SettleResponse {
	if fromPending {
		return SettlementPending(x402.Network(network), payer, signature, cause.Error())
	}
	return f.recordPending(ctx, key, signature, payer, network, cause)
}

func (f *BatchSvmScheme) validateDeposit(ctx context.Context, payload batchsettlement.ParsedBatchPayload, requirements types.PaymentRequirements, bound ProofAmountBound) (ValidatedDeposit, error) {
	if f.hooks.validateDeposit != nil {
		return f.hooks.validateDeposit(ctx, payload, requirements, bound)
	}
	terms, err := f.resolveTerms(ctx, payload.ChannelConfig, requirements, VoucherModeRequirements)
	if err != nil {
		return ValidatedDeposit{}, err
	}
	deposit, err := paymentchannels.ParseU64(payload.Deposit.Amount, "deposit.amount")
	if err != nil {
		return ValidatedDeposit{}, fmt.Errorf("%s: %w", batchsettlement.ErrPayloadType, err)
	}
	charge, err := paymentchannels.ParseU64(requirements.Amount, "amount")
	if err != nil {
		return ValidatedDeposit{}, fmt.Errorf("%s: %w", InvalidPaymentRequirements, err)
	}
	channelID, err := f.deriveChannelID(ctx, payload.ChannelConfig, terms.FeePayer)
	if err != nil {
		return ValidatedDeposit{}, err
	}
	proof, err := batchsettlement.ProofOf(payloadMap(payload))
	if err != nil {
		return ValidatedDeposit{}, err
	}
	var proofAmount uint64
	switch proof.Signer {
	case batchsettlement.VoucherSignerClient:
		proofAmount, err = paymentchannels.ParseU64(proof.Voucher.MaxClaimableAmount, "maxClaimableAmount")
		if err != nil {
			return ValidatedDeposit{}, fmt.Errorf("%s: %w", batchsettlement.ErrVoucherSignature, err)
		}
		if proof.Voucher.ChannelID != channelID {
			return ValidatedDeposit{}, fmt.Errorf("%s: voucher channel mismatch", batchsettlement.ErrChannelIDMismatch)
		}
		channelKey, err := solana.PublicKeyFromBase58(channelID)
		if err != nil {
			return ValidatedDeposit{}, err
		}
		message := paymentchannels.EncodeVoucherMessage(channelKey, proofAmount, proof.Voucher.ExpiresAt)
		if err := paymentchannels.VerifyVoucherSignature(proof.Voucher.Signature, payload.ChannelConfig.PayerAuthorizer, message); err != nil {
			return ValidatedDeposit{}, fmt.Errorf("%s: invalid voucher", batchsettlement.ErrVoucherSignature)
		}
		if proof.Voucher.ExpiresAt != batchsettlement.ClientVoucherExpiresAt {
			return ValidatedDeposit{}, fmt.Errorf("%s", batchsettlement.ErrVoucherExpiry)
		}
	case batchsettlement.VoucherSignerServer:
		proofAmount = charge
		if err := f.assertServerModeProof(payload, channelID, requirements, bound); err != nil {
			return ValidatedDeposit{}, err
		}
	default:
		return ValidatedDeposit{}, fmt.Errorf("%s", batchsettlement.ErrVoucherSignature)
	}
	// Parsing errors stay in result so earlier local rejections still win.
	prefetchCtx, cancelPrefetch := context.WithCancel(ctx)
	defer cancelPrefetch()
	settlement := f.startSettlementAccountsRead(prefetchCtx, requirements, payload.ChannelConfig.Payer, terms.TokenProgram)
	var slotRead *clusterSlotRead
	if hint, hintErr := recentSlotHint(requirements); hintErr == nil && hint == nil {
		slotRead = f.startClusterSlotRead(prefetchCtx, requirements.Network)
	}
	existing, err := f.readChannel(ctx, requirements.Network, channelID)
	if err != nil {
		return ValidatedDeposit{}, err
	}
	validated := ValidatedDeposit{
		Terms:       terms,
		ChannelID:   channelID,
		Deposit:     deposit,
		Proof:       proof,
		ProofAmount: proofAmount,
		Existing:    existing,
	}
	if payload.Voucher != nil {
		voucher := *payload.Voucher
		validated.Payload.Voucher = &voucher
	}
	if payload.Authorization != nil {
		authorization := *payload.Authorization
		validated.Payload.Authorization = &authorization
	}
	validated.Payload.Type = payload.Type
	validated.Payload.ChannelConfig = payload.ChannelConfig
	validated.Payload.Deposit = *payload.Deposit
	if existing != nil {
		if err := f.assertClaimChannel(existing, payload.ChannelConfig, terms, requirements, openStatuses); err != nil {
			return ValidatedDeposit{}, err
		}
		// The payer-signed open of this channel for exactly its deposit, with a pending
		// signature recorded, is the retry of an open that timed out, not a top-up.
		if existing.Deposit == deposit && existing.Settlement.Settled == 0 &&
			f.verifyOpenTransaction(payload, requirements, terms, channelID, deposit, nil) == nil {
			_, pending, err := f.pendingStore.Get(ctx, depositKey(requirements.Network, channelID))
			if err != nil {
				return ValidatedDeposit{}, err
			}
			if pending {
				if err := AssertDepositProof(proof.Signer, proofAmount, charge, deposit, nil); err != nil {
					return ValidatedDeposit{}, err
				}
				validated.ExpectedDeposit = deposit
				return validated, nil
			}
		}
		expected := existing.Deposit + deposit
		settled := existing.Settlement.Settled
		if err := AssertDepositProof(proof.Signer, proofAmount, charge, expected, &settled); err != nil {
			return ValidatedDeposit{}, err
		}
		feePayer, err := solana.PublicKeyFromBase58(terms.FeePayer)
		if err != nil {
			return ValidatedDeposit{}, err
		}
		from, err := solana.PublicKeyFromBase58(payload.ChannelConfig.Payer)
		if err != nil {
			return ValidatedDeposit{}, err
		}
		channelKey, err := solana.PublicKeyFromBase58(channelID)
		if err != nil {
			return ValidatedDeposit{}, err
		}
		mint, err := solana.PublicKeyFromBase58(requirements.Asset)
		if err != nil {
			return ValidatedDeposit{}, err
		}
		tokenProgram, err := solana.PublicKeyFromBase58(terms.TokenProgram)
		if err != nil {
			return ValidatedDeposit{}, err
		}
		if err := paymentchannels.VerifyTopUpTransaction(payload.Deposit.Transaction, paymentchannels.VerifyTopUpExpected{
			FeePayer:                    feePayer,
			From:                        from,
			ChannelID:                   channelKey,
			Mint:                        mint,
			TokenProgram:                tokenProgram,
			Amount:                      deposit,
			Memo:                        terms.Memo,
			MaxComputeUnits:             f.config.MaxComputeUnits,
			MaxPriorityFeeMicroLamports: f.config.MaxPriorityFeeMicroLamports,
			AcceptedTransactionVersions: f.transactionVersions,
		}); err != nil {
			return ValidatedDeposit{}, batchsettlement.SetupTransactionError(err)
		}
		if err := f.verifyTopUpSettlementAccounts(ctx, settlement, requirements.Network, payload.Deposit.Transaction, deposit); err != nil {
			return ValidatedDeposit{}, err
		}
		validated.ExpectedDeposit = expected
		validated.IsTopUp = true
		return validated, nil
	}
	if err := AssertDepositProof(proof.Signer, proofAmount, charge, deposit, nil); err != nil {
		return ValidatedDeposit{}, err
	}
	if err := f.verifyOpen(ctx, payload, requirements, terms, channelID, deposit, slotRead); err != nil {
		return ValidatedDeposit{}, err
	}
	if err := settlement.result(ctx, deposit); err != nil {
		return ValidatedDeposit{}, err
	}
	validated.ExpectedDeposit = deposit
	return validated, nil
}

func (f *BatchSvmScheme) verifyOpen(ctx context.Context, payload batchsettlement.ParsedBatchPayload, requirements types.PaymentRequirements, terms BatchTerms, channelID string, deposit uint64, slotRead *clusterSlotRead) error {
	recent, err := recentSlotHint(requirements)
	if err != nil {
		return err
	}
	// An open is accepted only inside the program's slot window of the cluster slot it lands at.
	// That slot is the challenge recentSlot, or the cluster slot when the challenge has none.
	if recent == nil {
		slot, err := slotRead.result(ctx)
		if err != nil {
			return err
		}
		recent = &slot
	}
	return f.verifyOpenTransaction(payload, requirements, terms, channelID, deposit, recent)
}

// verifyOpenTransaction checks the deposit transaction as the open of channelID.
// A nil recent skips the open-slot window, which only applies to an open yet to land.
func (f *BatchSvmScheme) verifyOpenTransaction(payload batchsettlement.ParsedBatchPayload, requirements types.PaymentRequirements, terms BatchTerms, channelID string, deposit uint64, recent *uint64) error {
	feePayer, err := solana.PublicKeyFromBase58(terms.FeePayer)
	if err != nil {
		return err
	}
	from, err := solana.PublicKeyFromBase58(payload.ChannelConfig.Payer)
	if err != nil {
		return err
	}
	mint, err := solana.PublicKeyFromBase58(requirements.Asset)
	if err != nil {
		return err
	}
	authorizer, err := solana.PublicKeyFromBase58(payload.ChannelConfig.PayerAuthorizer)
	if err != nil {
		return err
	}
	tokenProgram, err := solana.PublicKeyFromBase58(terms.TokenProgram)
	if err != nil {
		return err
	}
	openSlot, err := paymentchannels.ParseU64(payload.ChannelConfig.OpenSlot, "channelConfig.openSlot")
	if err != nil {
		return err
	}
	binding := batchsettlement.EncodeReceiverBindingMemo(terms.ReceiverAuthorizer)
	open, err := paymentchannels.VerifyOpenTransaction(payload.Deposit.Transaction, paymentchannels.VerifyOpenExpected{
		AuthorizedSigner:            authorizer,
		FeePayer:                    feePayer,
		From:                        from,
		Mint:                        mint,
		TokenProgram:                tokenProgram,
		Payee:                       feePayer,
		MaxCap:                      deposit,
		WithdrawDelay:               uint32(terms.WithdrawDelay),
		OpenSlot:                    openSlot,
		Recipients:                  []paymentchannels.Split{{Recipient: requirements.PayTo, BPS: batchsettlement.FullSplitBPS}},
		RecentSlot:                  recent,
		Memo:                        terms.Memo,
		ExpectedBindingMemo:         &binding,
		MaxComputeUnits:             f.config.MaxComputeUnits,
		MaxPriorityFeeMicroLamports: f.config.MaxPriorityFeeMicroLamports,
		MaxRequiredSignatures:       f.config.MaxRequiredSignatures,
		AcceptedTransactionVersions: f.transactionVersions,
	})
	if err != nil {
		return batchsettlement.SetupTransactionError(err)
	}
	if open.ChannelID.String() != channelID {
		return fmt.Errorf("%s: setup transaction channel mismatch", batchsettlement.ErrChannelIDMismatch)
	}
	return nil
}

func (f *BatchSvmScheme) settleDeposit(ctx context.Context, payload batchsettlement.ParsedBatchPayload, requirements types.PaymentRequirements, facilitatorContext any) (*x402.SettleResponse, error) {
	validated, err := f.validateDeposit(ctx, payload, requirements, ProofAmountCeiling)
	if err != nil {
		return nil, err
	}
	key := depositKey(requirements.Network, validated.ChannelID)
	if validated.Existing != nil && !validated.IsTopUp {
		if err := f.assertOpenReplayCaller(ctx, validated, requirements, facilitatorContext); err != nil {
			return nil, err
		}
		return f.settleOpenReplay(ctx, key, validated, requirements)
	}
	var topUp *solana.Transaction
	if validated.IsTopUp {
		decoded, hash, err := decodeWithMessageHash(payload.Deposit.Transaction)
		if err != nil {
			return nil, fmt.Errorf("%s: %s", batchsettlement.ErrSettlementSimulation, err.Error())
		}
		topUp = decoded
		key = topUpKey(requirements.Network, hash)
	}
	feePayer, err := solana.PublicKeyFromBase58(validated.Terms.FeePayer)
	if err != nil {
		return nil, err
	}
	if !validated.IsTopUp {
		if err := f.simulateOpen(ctx, validated, requirements, feePayer); err != nil {
			if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) || strings.HasPrefix(err.Error(), batchsettlement.ErrSettlementSimulation+":") {
				return nil, err
			}
			return nil, fmt.Errorf("%s: %s", batchsettlement.ErrSettlementSimulation, err.Error())
		}
	}
	expiresAt := int64(batchsettlement.ClientVoucherExpiresAt)
	if payload.Voucher != nil {
		expiresAt = payload.Voucher.ExpiresAt
	}
	receiverAuthorizer := ""
	callerIdentity := ""
	if !validated.IsTopUp {
		identity, err := DelegatedIdentityForOpen(ctx, f.delegated, validated.Terms.ReceiverAuthorizer, validated.ChannelID, validated.Payload.ChannelConfig.Payer, requirements, facilitatorContext)
		if err != nil {
			return nil, err
		}
		callerIdentity = identity
		receiverAuthorizer = validated.Terms.ReceiverAuthorizer
	}
	kind := paymentchannels.ChannelWriteOpen
	if validated.IsTopUp {
		kind = paymentchannels.ChannelWriteActivity
	}
	record := channelActivityRecord(requirements.Network, validated.ChannelID, requirements.PayTo, validated.Terms.TokenProgram, expiresAt, receiverAuthorizer, callerIdentity)
	settled, err := paymentchannels.WriteThenBroadcast(ctx, paymentchannels.WriteThenBroadcastArgs[*x402.SettleResponse]{
		Storage:        f.channelStorage,
		Kind:           kind,
		Records:        []paymentchannels.PaymentChannelRecord{record},
		OnStorageError: f.config.OnStorageError,
		Broadcast: func(reserved func()) (paymentchannels.BroadcastOutcome[*x402.SettleResponse], error) {
			var channel *generated.Channel
			signature, response, err := f.settleDurably(ctx, durableArgs{
				key:     key,
				network: requirements.Network,
				payer:   payload.ChannelConfig.Payer,
				send: func(onPrepared func(string, string) error) (string, error) {
					if topUp != nil {
						if err := f.signer.SimulateTransaction(ctx, topUp, requirements.Network, nil); err != nil {
							if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
								return "", err
							}
							return "", fmt.Errorf("%s: %s", batchsettlement.ErrSettlementSimulation, err.Error())
						}
					}
					signature, err := paymentchannels.BroadcastOpen(ctx, f.signer, feePayer, requirements.Network, payload.Deposit.Transaction, paymentchannels.ChannelBroadcastHooks{
						OnPrepared: func(broadcastSignature, wire string) error {
							if err := onPrepared(broadcastSignature, wire); err != nil {
								return err
							}
							reserved()
							return nil
						},
					})
					if err != nil {
						return "", err
					}
					return signature, nil
				},
				postcondition: func(fromPending bool) error {
					var err error
					channel, err = f.fetchDepositChannelForSettle(ctx, validated, requirements, fromPending)
					return err
				},
			})
			if err != nil {
				return paymentchannels.BroadcastOutcome[*x402.SettleResponse]{}, err
			}
			disposition := paymentchannels.OpenBroadcastKeep
			if !validated.IsTopUp {
				disposition = openDisposition(response, channel != nil)
			}
			if response == nil {
				response = DepositResponse(validated.ChannelID, channel, x402.Network(requirements.Network), signature, validated.Deposit)
			}
			return paymentchannels.BroadcastOutcome[*x402.SettleResponse]{Value: response, Disposition: disposition}, nil
		},
	})
	if err != nil {
		if errors.Is(err, paymentchannels.ErrReceiverAuthorizerConflict) {
			return nil, fmt.Errorf("%s: %s", batchsettlement.ErrReceiverAuthorizerMismatch, err.Error())
		}
		if errors.Is(err, paymentchannels.ErrCallerIdentityConflict) {
			return nil, fmt.Errorf("%s: %s", batchsettlement.ErrDelegatedUnauthenticated, err.Error())
		}
		return nil, err
	}
	return settled, nil
}

func depositKey(network, channelID string) string {
	return "batch:deposit:" + network + ":" + channelID
}

func topUpKey(network, messageHash string) string {
	return "batch:topup:" + network + ":" + messageHash
}

// assertOpenReplayCaller lets only the caller that opened a delegated channel consume its pending open signature.
func (f *BatchSvmScheme) assertOpenReplayCaller(ctx context.Context, validated ValidatedDeposit, requirements types.PaymentRequirements, facilitatorContext any) error {
	identity, err := DelegatedIdentityForOpen(ctx, f.delegated, validated.Terms.ReceiverAuthorizer, validated.ChannelID, validated.Payload.ChannelConfig.Payer, requirements, facilitatorContext)
	if err != nil || identity == "" {
		return err
	}
	record, err := f.channelStorage.Get(ctx, requirements.Network, validated.ChannelID)
	if err != nil {
		return err
	}
	// A lost row, or one without the opener's identity, fails closed.
	if record == nil || record.CallerIdentity != identity {
		return fmt.Errorf("%s: caller identity does not match the channel binding", batchsettlement.ErrDelegatedUnauthenticated)
	}
	return nil
}

// settleOpenReplay reconciles the pending signature of an open under key and never
// broadcasts. A record consumed since validation is a duplicate.
func (f *BatchSvmScheme) settleOpenReplay(ctx context.Context, key string, validated ValidatedDeposit, requirements types.PaymentRequirements) (*x402.SettleResponse, error) {
	var channel *generated.Channel
	signature, response, err := f.settleDurably(ctx, durableArgs{
		key:     key,
		network: requirements.Network,
		payer:   validated.Payload.ChannelConfig.Payer,
		beforeSend: func() (*x402.SettleResponse, error) {
			return nil, fmt.Errorf("%s: open already reconciled", ChannelBusy)
		},
		postcondition: func(bool) error {
			var err error
			channel, err = f.fetchDepositChannelForSettle(ctx, validated, requirements, false)
			return err
		},
	})
	if err != nil || response != nil {
		return response, err
	}
	return DepositResponse(validated.ChannelID, channel, x402.Network(requirements.Network), signature, validated.Deposit), nil
}

func (f *BatchSvmScheme) verifyTopUpSettlementAccounts(ctx context.Context, settlement *settlementAccountsRead, network, wire string, deposit uint64) error {
	err := settlement.result(ctx, deposit)
	if err == nil {
		return nil
	}
	_, hash, hashErr := decodeWithMessageHash(wire)
	if hashErr != nil {
		return err
	}
	_, pending, pendingErr := f.pendingStore.Get(ctx, topUpKey(network, hash))
	if pendingErr != nil {
		return pendingErr
	}
	if pending {
		return nil
	}
	return err
}

func (f *BatchSvmScheme) fetchDepositChannelForSettle(ctx context.Context, validated ValidatedDeposit, requirements types.PaymentRequirements, fromPending bool) (*generated.Channel, error) {
	channel, err := f.fetchChannel(ctx, requirements.Network, validated.ChannelID)
	if err != nil {
		return nil, err
	}
	if fromPending && validated.IsTopUp && validated.Existing != nil &&
		channel.Deposit == validated.Existing.Deposit &&
		channel.Deposit >= validated.Deposit &&
		channel.Deposit >= validated.ProofAmount {
		if err := f.assertClaimChannel(channel, validated.Payload.ChannelConfig, validated.Terms, requirements, openStatuses); err != nil {
			return nil, err
		}
		return channel, nil
	}
	if err := f.assertDepositChannel(channel, validated, requirements); err != nil {
		return nil, err
	}
	return channel, nil
}

func (f *BatchSvmScheme) simulateOpen(ctx context.Context, validated ValidatedDeposit, requirements types.PaymentRequirements, feePayer solana.PublicKey) error {
	channelID, err := solana.PublicKeyFromBase58(validated.ChannelID)
	if err != nil {
		return err
	}
	payer, err := solana.PublicKeyFromBase58(validated.Payload.ChannelConfig.Payer)
	if err != nil {
		return err
	}
	mint, err := solana.PublicKeyFromBase58(requirements.Asset)
	if err != nil {
		return err
	}
	tokenProgram, err := solana.PublicKeyFromBase58(validated.Terms.TokenProgram)
	if err != nil {
		return err
	}
	return paymentchannels.SimulateOpenSettleDistribute(ctx, f.signer, feePayer, validated.Payload.Deposit.Transaction, paymentchannels.SettlementSimChannel{
		ChannelID:     channelID,
		Mint:          mint,
		Network:       requirements.Network,
		Payee:         feePayer,
		Payer:         payer,
		RentPayer:     feePayer,
		Splits:        []paymentchannels.Split{{Recipient: requirements.PayTo, BPS: batchsettlement.FullSplitBPS}},
		TokenProgram:  tokenProgram,
		TreasuryOwner: f.config.PaymentChannelsTreasuryOwner,
	})
}

func (f *BatchSvmScheme) settleClaims(ctx context.Context, payload batchsettlement.BatchClaimPayload, requirements types.PaymentRequirements) (*x402.SettleResponse, error) {
	if len(payload.Claims) == 0 || len(payload.Claims) > f.maxClaimChannels() {
		return nil, fmt.Errorf("%s: claims exceed the facilitator's maxClaimChannels %d", batchsettlement.ErrPayloadType, f.maxClaimChannels())
	}
	prepared := make([]PreparedClaim, 0, len(payload.Claims))
	var instructions []solana.Instruction
	for _, claim := range payload.Claims {
		terms, err := f.resolveTerms(ctx, claim.ChannelConfig, requirements, VoucherModePayload)
		if err != nil {
			return nil, err
		}
		channelID, err := f.deriveChannelID(ctx, claim.ChannelConfig, terms.FeePayer)
		if err != nil {
			return nil, err
		}
		if channelID != claim.ChannelID || channelID != claim.Voucher.ChannelID {
			return nil, fmt.Errorf("%s", batchsettlement.ErrChannelIDMismatch)
		}
		cumulative, err := verifySignedVoucher(channelID, claim.Voucher, claim.ChannelConfig.PayerAuthorizer)
		if err != nil {
			return nil, err
		}
		prepared = append(prepared, PreparedClaim{
			Claim:        claim,
			ChannelID:    channelID,
			FeePayer:     terms.FeePayer,
			Cumulative:   cumulative,
			ExpiresAt:    claim.Voucher.ExpiresAt,
			PayTo:        requirements.PayTo,
			TokenProgram: terms.TokenProgram,
			Terms:        terms,
		})
	}
	feePayer := prepared[0].FeePayer
	for _, item := range prepared[1:] {
		if item.FeePayer != feePayer {
			return nil, fmt.Errorf("%s", batchsettlement.ErrFeePayerMismatch)
		}
	}
	parts := make([]string, len(prepared))
	for i, item := range prepared {
		parts[i] = item.ChannelID + ":" + strconv.FormatUint(item.Cumulative, 10)
	}
	sort.Strings(parts)
	claimKey := "batch:claim:" + requirements.Network + ":" + strings.Join(parts, ",")
	payer := prepared[0].Claim.ChannelConfig.Payer
	signature, response, err := f.settleDurably(ctx, durableArgs{
		key:     claimKey,
		network: requirements.Network,
		payer:   payer,
		beforeSend: func() (*x402.SettleResponse, error) {
			states := make([]batchsettlement.BatchRedemptionChannelState, len(prepared))
			applied := false
			for i, item := range prepared {
				channel, err := f.fetchChannel(ctx, requirements.Network, item.ChannelID)
				if err != nil {
					return nil, err
				}
				if err := AssertNotClosing(channel, item.ChannelID); err != nil {
					return nil, err
				}
				if err := f.assertClaimChannel(channel, item.Claim.ChannelConfig, item.Terms, requirements, openStatuses); err != nil {
					return nil, err
				}
				if item.Cumulative > channel.Deposit {
					return nil, fmt.Errorf("%s", batchsettlement.ErrCumulativeAmountMismatch)
				}
				applied = applied || item.Cumulative <= channel.Settlement.Settled
				states[i] = redemptionSnapshot(item.ChannelID, channel)
			}
			if applied {
				return ResyncFailure(x402.Network(requirements.Network), batchsettlement.ErrCumulativeAmountMismatch, "claim already applied onchain", states), nil
			}
			for _, item := range prepared {
				authorizer, err := solana.PublicKeyFromBase58(item.Claim.ChannelConfig.PayerAuthorizer)
				if err != nil {
					return nil, err
				}
				channelKey, err := solana.PublicKeyFromBase58(item.ChannelID)
				if err != nil {
					return nil, err
				}
				built, err := paymentchannels.BuildSettleInstructions(paymentchannels.SettleBuildArgs{
					ChannelID: channelKey,
					Voucher: paymentchannels.SettleVoucher{
						AuthorizedSigner: authorizer,
						SignatureBase58:  item.Claim.Voucher.Signature,
						CumulativeAmount: item.Cumulative,
						ExpiresAt:        item.ExpiresAt,
					},
				})
				if err != nil {
					return nil, err
				}
				instructions = append(instructions, built...)
			}
			return nil, nil
		},
		broadcast: func() (durableResult, error) {
			records := make([]paymentchannels.PaymentChannelRecord, len(prepared))
			for i, item := range prepared {
				records[i] = channelActivityRecord(requirements.Network, item.ChannelID, item.PayTo, item.TokenProgram, item.ExpiresAt, "", "")
			}
			return paymentchannels.WriteThenBroadcast(ctx, paymentchannels.WriteThenBroadcastArgs[durableResult]{
				Storage:        f.channelStorage,
				Kind:           paymentchannels.ChannelWriteActivity,
				Records:        records,
				OnStorageError: f.config.OnStorageError,
				Broadcast: func(func()) (paymentchannels.BroadcastOutcome[durableResult], error) {
					value, err := f.submitWith(ctx, f.broadcastUnchecked, feePayer, requirements.Network, instructions, claimKey, payer)
					if err != nil {
						return paymentchannels.BroadcastOutcome[durableResult]{}, err
					}
					return paymentchannels.BroadcastOutcome[durableResult]{Value: value, Disposition: paymentchannels.OpenBroadcastKeep}, nil
				},
			})
		},
		postcondition: func(bool) error {
			ids := make([]string, len(prepared))
			for i, item := range prepared {
				ids[i] = item.ChannelID
			}
			channels, ok, err := f.fetchChannelsUntil(ctx, requirements.Network, ids, func(channels []*generated.Channel) bool {
				for i, channel := range channels {
					if channel == nil || channel.Settlement.Settled < prepared[i].Cumulative {
						return false
					}
				}
				return true
			})
			if err != nil {
				return err
			}
			if !ok {
				return errors.New("claim confirmed but its channel watermark is not visible yet")
			}
			for i, channel := range channels {
				if err := f.assertClaimChannel(channel, prepared[i].Claim.ChannelConfig, prepared[i].Terms, requirements, allChannelStatuses); err != nil {
					return err
				}
			}
			return nil
		},
	})
	if err != nil || response != nil {
		return response, err
	}
	return ClaimResponse(prepared, x402.Network(requirements.Network), signature), nil
}

func (f *BatchSvmScheme) settleDistributions(ctx context.Context, payload batchsettlement.BatchSettlePayload, requirements types.PaymentRequirements) (*x402.SettleResponse, error) {
	if len(payload.Channels) == 0 || len(payload.Channels) > f.maxSettleChannels() {
		return nil, fmt.Errorf("%s: invalid channel batch", batchsettlement.ErrPayloadType)
	}
	seen := map[string]struct{}{}
	for _, channel := range payload.Channels {
		if _, ok := seen[channel.ChannelID]; ok {
			return nil, fmt.Errorf("%s: invalid channel batch", batchsettlement.ErrPayloadType)
		}
		seen[channel.ChannelID] = struct{}{}
	}
	prepared := make([]PreparedDistribution, 0, len(payload.Channels))
	for _, entry := range payload.Channels {
		terms, err := f.resolveTerms(ctx, entry.ChannelConfig, requirements, VoucherModePayload)
		if err != nil {
			return nil, err
		}
		channelID, err := f.deriveChannelID(ctx, entry.ChannelConfig, terms.FeePayer)
		if err != nil {
			return nil, err
		}
		if channelID != entry.ChannelID {
			return nil, fmt.Errorf("%s", batchsettlement.ErrChannelIDMismatch)
		}
		prepared = append(prepared, PreparedDistribution{
			ChannelConfig: entry.ChannelConfig,
			ChannelID:     channelID,
			FeePayer:      terms.FeePayer,
			Terms:         terms,
		})
	}
	feePayer := prepared[0].FeePayer
	for _, item := range prepared[1:] {
		if item.FeePayer != feePayer {
			return nil, fmt.Errorf("%s", batchsettlement.ErrFeePayerMismatch)
		}
	}
	return f.distributeKeyed(ctx, distributionKey(requirements.Network, prepared), prepared, requirements)
}

// distributionKey keys a channel set's pending and payout records, independent
// of chain state, so an unfinished distribution survives a later claim.
func distributionKey(network string, prepared []PreparedDistribution) string {
	ids := channelIDs(prepared)
	sort.Strings(ids)
	return "batch:distribute:" + network + ":" + strings.Join(ids, ",")
}

// distributionPassKey reserves one pass by each channel's settled watermark;
// "" when a channel is absent, since no pass can start then.
func distributionPassKey(key string, prepared []PreparedDistribution, channels []*generated.Channel) string {
	parts := make([]string, len(prepared))
	for i, item := range prepared {
		if channels[i] == nil {
			return ""
		}
		parts[i] = item.ChannelID + ":" + strconv.FormatUint(channels[i].Settlement.Settled, 10)
	}
	sort.Strings(parts)
	return key + ":pass:" + strings.Join(parts, ",")
}

// distributionChannels reads and checks prepared's channels. While recovering,
// an absent (possibly reclaimed) channel is left nil rather than awaited.
func (f *BatchSvmScheme) distributionChannels(ctx context.Context, prepared []PreparedDistribution, requirements types.PaymentRequirements, recovering bool) ([]*generated.Channel, error) {
	read := f.fetchChannel
	if recovering {
		read = f.readChannel
	}
	channels := make([]*generated.Channel, len(prepared))
	for i, item := range prepared {
		channel, err := read(ctx, requirements.Network, item.ChannelID)
		if err != nil {
			return nil, err
		}
		if channel == nil {
			continue
		}
		if err := f.assertClaimChannel(channel, item.ChannelConfig, item.Terms, requirements, []generated.ChannelStatus{
			generated.ChannelStatus_Open,
			generated.ChannelStatus_Sealed,
			generated.ChannelStatus_Distributed,
		}); err != nil {
			return nil, err
		}
		channels[i] = channel
	}
	return channels, nil
}

// distributeKeyed finishes any unfinished payout under key before starting
// another pass, so OnDistributionConfirmed receives every payout.
func (f *BatchSvmScheme) distributeKeyed(ctx context.Context, key string, prepared []PreparedDistribution, requirements types.PaymentRequirements) (*x402.SettleResponse, error) {
	feePayer := prepared[0].FeePayer
	var previous *x402.SettleResponse
	if f.config.OnDistributionConfirmed != nil {
		raw, ok, err := f.pendingStore.Get(ctx, resultKey(key))
		if err != nil {
			return nil, err
		}
		if ok {
			if previous, err = decodeDistributionResult(raw); err != nil {
				return nil, err
			}
			if pending := f.completePayout(ctx, key, previous, requirements); pending != nil {
				return pending, nil
			}
		}
	}
	pending, hasPending, err := f.pendingStore.Get(ctx, key)
	if err != nil {
		return nil, err
	}
	if signature, _, _ := parseBroadcastRecord(pending); hasPending && previous != nil && signature == previous.Transaction {
		f.forgetPending(ctx, key, previous.Transaction)
		hasPending = false
	}
	channels, err := f.distributionChannels(ctx, prepared, requirements, previous != nil || hasPending)
	if err != nil {
		return nil, err
	}
	passKey := distributionPassKey(key, prepared, channels)
	if hasPending {
		recovered, err := f.reconcileBroadcastAt(ctx, key, passKey, pending, requirements.Network, "")
		if err != nil || !recovered.OK {
			return recovered.Response, err
		}
		return f.finishDistribution(ctx, key, recovered.Signature, true, prepared, channels, requirements)
	}
	var instructions []solana.Instruction
	var swept []PreparedDistribution
	for i, item := range prepared {
		channel := channels[i]
		if channel == nil {
			continue
		}
		status := generated.ChannelStatus(channel.Status)
		if status == generated.ChannelStatus_Distributed || (status == generated.ChannelStatus_Open && channel.Settlement.PayoutWatermark == channel.Settlement.Settled) {
			continue
		}
		swept = append(swept, item)
		instruction, err := f.distributeInstruction(ctx, item.ChannelID, channel, item.Terms, requirements)
		if err != nil {
			return nil, err
		}
		instructions = append(instructions, instruction)
	}
	if len(instructions) == 0 {
		if previous != nil {
			return previous, nil
		}
		return ResyncFailure(x402.Network(requirements.Network), batchsettlement.ErrCumulativeAmountMismatch, "nothing to distribute onchain", observedStates(prepared, channels)), nil
	}
	if passKey == "" {
		return nil, fmt.Errorf("%s: a channel of the batch is not visible", batchsettlement.ErrChannelState)
	}
	memo, err := randomBatchMemo()
	if err != nil {
		return nil, err
	}
	instructions = append(instructions, solana.NewInstruction(
		solana.MustPublicKeyFromBase58(svm.MemoProgramAddress),
		solana.AccountMetaSlice{},
		[]byte(memo),
	))
	records := make([]paymentchannels.PaymentChannelRecord, len(swept))
	for i, item := range swept {
		records[i] = channelActivityRecord(requirements.Network, item.ChannelID, requirements.PayTo, item.Terms.TokenProgram, batchsettlement.ClientVoucherExpiresAt, "", "")
	}
	submitted, err := paymentchannels.WriteThenBroadcast(ctx, paymentchannels.WriteThenBroadcastArgs[durableResult]{
		Storage:        f.channelStorage,
		Kind:           paymentchannels.ChannelWriteActivity,
		Records:        records,
		OnStorageError: f.config.OnStorageError,
		Broadcast: func(func()) (paymentchannels.BroadcastOutcome[durableResult], error) {
			value, err := f.submitWith(ctx, f.broadcastReserving(passKey), feePayer, requirements.Network, instructions, key, "")
			if err != nil {
				return paymentchannels.BroadcastOutcome[durableResult]{}, err
			}
			return paymentchannels.BroadcastOutcome[durableResult]{Value: value, Disposition: paymentchannels.OpenBroadcastKeep}, nil
		},
	})
	if err != nil || !submitted.OK {
		return submitted.Response, err
	}
	return f.finishDistribution(ctx, key, submitted.Signature, false, prepared, channels, requirements)
}

func observedStates(prepared []PreparedDistribution, channels []*generated.Channel) []batchsettlement.BatchRedemptionChannelState {
	states := make([]batchsettlement.BatchRedemptionChannelState, 0, len(prepared))
	for i, item := range prepared {
		if channels[i] != nil {
			states = append(states, redemptionSnapshot(item.ChannelID, channels[i]))
		}
	}
	return states
}

// distributedStates is nil unless every channel was read: the server adopts only a complete batch.
func distributedStates(prepared []PreparedDistribution, channels []*generated.Channel) []batchsettlement.BatchRedemptionChannelState {
	return completeStates(prepared, channels, distributedSnapshot)
}

// completeStates is nil unless every channel was read.
func completeStates(prepared []PreparedDistribution, channels []*generated.Channel, snapshot func(string, *generated.Channel) batchsettlement.BatchRedemptionChannelState) []batchsettlement.BatchRedemptionChannelState {
	states := make([]batchsettlement.BatchRedemptionChannelState, len(prepared))
	for i, item := range prepared {
		if channels[i] == nil {
			return nil
		}
		states[i] = snapshot(item.ChannelID, channels[i])
	}
	return states
}

// confirmedStates reads the channels again, after a recovered sweep was attributed
// (which records the slot the read must reach). The channels read before the
// recovery may have moved on, for instance by a later claim, so they cannot say what
// the recovered transaction left behind: the watermarks are the chain's own. It is
// nil when a channel cannot be read, since the confirmed sweep does not wait on an
// optional field.
func (f *BatchSvmScheme) confirmedStates(ctx context.Context, prepared []PreparedDistribution, requirements types.PaymentRequirements) []batchsettlement.BatchRedemptionChannelState {
	channels := make([]*generated.Channel, len(prepared))
	for i, item := range prepared {
		channel, err := f.readChannel(ctx, requirements.Network, item.ChannelID)
		if err != nil {
			return nil
		}
		channels[i] = channel
	}
	return completeStates(prepared, channels, redemptionSnapshot)
}

func (f *BatchSvmScheme) finishDistribution(ctx context.Context, key, signature string, fromPending bool, prepared []PreparedDistribution, channels []*generated.Channel, requirements types.PaymentRequirements) (*x402.SettleResponse, error) {
	network := x402.Network(requirements.Network)
	unfinished := func(cause error) *x402.SettleResponse {
		return f.unfinished(ctx, key, signature, "", requirements.Network, fromPending, cause)
	}
	response, err := f.attributeDistribution(ctx, signature, prepared, requirements)
	if err != nil {
		var ambiguous *PayoutAttributionAmbiguousError
		if !errors.As(err, &ambiguous) {
			return unfinished(err), nil
		}
		response = SettleFailureWithTransaction(network, batchsettlement.ErrPayoutAttributionAmbiguous, "", err.Error(), signature)
	} else {
		// A fresh sweep paid every channel up to its settled watermark as read before it.
		// A recovered one may predate watermarks that moved since, so read the chain again.
		var states []batchsettlement.BatchRedemptionChannelState
		if fromPending {
			states = f.confirmedStates(ctx, prepared, requirements)
		} else {
			states = distributedStates(prepared, channels)
		}
		if states != nil {
			response.Extra[batchsettlement.ExtraChannelStates] = states
		}
		if f.config.OnDistributionConfirmed != nil {
			if err := storePayoutResult(ctx, f.pendingStore, key, response); err != nil {
				return unfinished(err), nil //nolint:nilerr // the sweep landed; a store failure stays pending
			}
			if pending := f.completePayout(ctx, key, response, requirements); pending != nil {
				return pending, nil
			}
		}
	}
	if fromPending {
		f.forgetPending(ctx, key, signature)
	}
	return response, nil
}

func (f *BatchSvmScheme) completePayout(ctx context.Context, key string, response *x402.SettleResponse, requirements types.PaymentRequirements) *x402.SettleResponse {
	err := f.config.OnDistributionConfirmed(ctx, response, requirements)
	if err == nil {
		err = f.pendingStore.Delete(ctx, resultKey(key))
	}
	if err != nil {
		return SettlementPending(response.Network, response.Payer, response.Transaction, err.Error())
	}
	return nil
}

// confirmedEvidence reads a confirmed transaction with its token-balance metadata, waiting
// for the metadata to become visible, and rejects one that failed onchain. It records the
// transaction's slot so later channel reads reach it.
func (f *BatchSvmScheme) confirmedEvidence(ctx context.Context, signature, network string) (*svm.FacilitatorConfirmedTransaction, error) {
	parsed, err := solana.SignatureFromBase58(signature)
	if err != nil {
		return nil, err
	}
	var evidence *svm.FacilitatorConfirmedTransaction
	for attempt := 0; attempt < ChannelReadAttempts; attempt++ {
		evidence, err = f.raw.GetConfirmedTransaction(ctx, parsed, network)
		if err == nil && evidence != nil && evidence.Meta != nil && evidence.Meta.PreTokenBalances != nil && evidence.Meta.PostTokenBalances != nil {
			break
		}
		if attempt+1 < ChannelReadAttempts {
			if err := f.waitForChannelRead(ctx, attempt); err != nil {
				return nil, err
			}
		}
	}
	if evidence == nil || evidence.Meta == nil || evidence.Meta.PreTokenBalances == nil || evidence.Meta.PostTokenBalances == nil {
		return nil, fmt.Errorf("payout transaction metadata is not visible yet")
	}
	if evidence.Meta.Err != nil {
		return nil, &svm.TransactionOnchainFailureError{Message: "distribution transaction failed onchain"}
	}
	f.rememberSlot(network, evidence.Slot)
	return evidence, nil
}

// attributeClose reads the confirmed seal or cooperative refund and attributes what it
// paid the receiver and returned to the payer. A receiver that is also the payer or the
// treasury shares a token account with them, so the two cannot be told apart.
func (f *BatchSvmScheme) attributeClose(ctx context.Context, signature string, requirements types.PaymentRequirements, terms BatchTerms, payer string) (CloseAttribution, error) {
	if payer == requirements.PayTo ||
		paymentchannels.ResolveTreasuryOwner(f.config.PaymentChannelsTreasuryOwner, requirements.Network).String() == requirements.PayTo {
		return CloseAttribution{}, &PayoutAttributionAmbiguousError{}
	}
	evidence, err := f.confirmedEvidence(ctx, signature, requirements.Network)
	if err != nil {
		return CloseAttribution{}, err
	}
	attribution, err := closeTransfers(evidence, requirements, terms, payer)
	if err != nil {
		return CloseAttribution{}, unattributable(err)
	}
	return attribution, nil
}

func closeTransfers(evidence *svm.FacilitatorConfirmedTransaction, requirements types.PaymentRequirements, terms BatchTerms, payer string) (CloseAttribution, error) {
	tokenProgram, err := solana.PublicKeyFromBase58(terms.TokenProgram)
	if err != nil {
		return CloseAttribution{}, err
	}
	paid, err := ownerBalanceChange(evidence, requirements.PayTo, requirements.Asset, tokenProgram)
	if err != nil {
		return CloseAttribution{}, fmt.Errorf("receiver payout: %w", err)
	}
	refunded, err := ownerBalanceChange(evidence, payer, requirements.Asset, tokenProgram)
	if err != nil {
		return CloseAttribution{}, fmt.Errorf("payer refund: %w", err)
	}
	return CloseAttribution{PaidToReceiver: paid, RefundedToPayer: refunded}, nil
}

// ownerBalanceChange is the increase of owner's token balance of mint across the transaction.
func ownerBalanceChange(evidence *svm.FacilitatorConfirmedTransaction, owner, mint string, tokenProgram solana.PublicKey) (uint64, error) {
	ownerKey, err := solana.PublicKeyFromBase58(owner)
	if err != nil {
		return 0, err
	}
	mintKey, err := solana.PublicKeyFromBase58(mint)
	if err != nil {
		return 0, err
	}
	account, err := paymentchannels.FindATA(ownerKey, mintKey, tokenProgram)
	if err != nil {
		return 0, err
	}
	index := indexOf(evidence.AccountKeys, account.String())
	if index < 0 {
		return 0, fmt.Errorf("token account is absent from the transaction")
	}
	pre, err := balanceOf(evidence.Meta.PreTokenBalances, index, mint, owner)
	if err != nil {
		return 0, err
	}
	post, err := balanceOf(evidence.Meta.PostTokenBalances, index, mint, owner)
	if err != nil {
		return 0, err
	}
	if post < pre {
		return 0, fmt.Errorf("negative balance change")
	}
	return post - pre, nil
}

// attributeDistribution reads the confirmed sweep and attributes the
// recipient's payout. It reads chain state only and can be repeated.
func (f *BatchSvmScheme) attributeDistribution(ctx context.Context, signature string, prepared []PreparedDistribution, requirements types.PaymentRequirements) (*x402.SettleResponse, error) {
	evidence, err := f.confirmedEvidence(ctx, signature, requirements.Network)
	if err != nil {
		return nil, err
	}
	paid, err := f.distributionPayout(evidence, prepared, requirements)
	if err != nil {
		return nil, unattributable(err)
	}
	return &x402.SettleResponse{
		Success:     true,
		Network:     x402.Network(requirements.Network),
		Transaction: signature,
		Amount:      strconv.FormatUint(paid, 10),
		Extra:       map[string]any{"channels": channelIDs(prepared)},
	}, nil
}

func (f *BatchSvmScheme) distributionPayout(evidence *svm.FacilitatorConfirmedTransaction, prepared []PreparedDistribution, requirements types.PaymentRequirements) (uint64, error) {
	tokenProgram, err := solana.PublicKeyFromBase58(prepared[0].Terms.TokenProgram)
	if err != nil {
		return 0, err
	}
	mint, err := solana.PublicKeyFromBase58(requirements.Asset)
	if err != nil {
		return 0, err
	}
	payTo, err := solana.PublicKeyFromBase58(requirements.PayTo)
	if err != nil {
		return 0, err
	}
	recipient, err := paymentchannels.FindATA(payTo, mint, tokenProgram)
	if err != nil {
		return 0, err
	}
	recipientIndex := indexOf(evidence.AccountKeys, recipient.String())
	if recipientIndex < 0 {
		return 0, fmt.Errorf("recipient is absent from distribution transaction")
	}
	for _, item := range prepared {
		owner, err := solana.PublicKeyFromBase58(item.ChannelID)
		if err != nil {
			return 0, err
		}
		escrow, err := paymentchannels.FindATA(owner, mint, tokenProgram)
		if err != nil {
			return 0, err
		}
		escrowIndex := indexOf(evidence.AccountKeys, escrow.String())
		if escrowIndex < 0 {
			continue
		}
		if !balanceHasAccount(evidence.Meta.PostTokenBalances, escrowIndex) &&
			(item.ChannelConfig.Payer == requirements.PayTo || paymentchannels.ResolveTreasuryOwner(f.config.PaymentChannelsTreasuryOwner, requirements.Network).String() == requirements.PayTo) {
			return 0, &PayoutAttributionAmbiguousError{}
		}
	}
	pre, err := tokenBalance(evidence.Meta.PreTokenBalances, recipientIndex, requirements)
	if err != nil {
		return 0, err
	}
	post, err := tokenBalance(evidence.Meta.PostTokenBalances, recipientIndex, requirements)
	if err != nil {
		return 0, err
	}
	if post < pre {
		return 0, fmt.Errorf("negative recipient payout")
	}
	return post - pre, nil
}

func (f *BatchSvmScheme) settleRefund(ctx context.Context, payload batchsettlement.BatchRefundPayload, requirements types.PaymentRequirements, facilitatorContext any) (*x402.SettleResponse, error) {
	deps := f.sealDependencies()
	limits := RefundLimits{
		MaxComputeUnits:             f.config.MaxComputeUnits,
		MaxPriorityFeeMicroLamports: f.config.MaxPriorityFeeMicroLamports,
		TransactionVersions:         f.transactionVersions,
	}
	var prepared PreparedRefund
	var err error
	if deps.PrepareRefund != nil {
		prepared, err = deps.PrepareRefund(ctx, payload, requirements, limits, facilitatorContext)
	} else {
		prepared, err = PrepareRefund(ctx, deps, payload, requirements, limits, facilitatorContext)
	}
	if err != nil {
		return nil, err
	}
	if prepared.RequestClose == "" {
		return SettleCooperativeRefund(ctx, deps, payload, requirements, prepared, facilitatorContext)
	}
	requestClose, hash, err := decodeWithMessageHash(prepared.RequestClose)
	if err != nil {
		return nil, err
	}
	key := "batch:refund:" + requirements.Network + ":" + prepared.ChannelID + ":" + hash
	payer := payload.ChannelConfig.Payer
	closed := []generated.ChannelStatus{generated.ChannelStatus_Closing, generated.ChannelStatus_Sealed, generated.ChannelStatus_Distributed}
	var channel *generated.Channel
	signature, response, err := f.settleDurably(ctx, durableArgs{
		key:     key,
		network: requirements.Network,
		payer:   payer,
		beforeSend: func() (*x402.SettleResponse, error) {
			channel, err := f.fetchChannel(ctx, requirements.Network, prepared.ChannelID)
			if err != nil {
				return nil, err
			}
			if err := AssertRefundable(channel, prepared.ChannelID); err != nil {
				return nil, err
			}
			if err := f.assertClaimChannel(channel, payload.ChannelConfig, prepared.Terms, requirements, refundableStatuses); err != nil {
				return nil, err
			}
			if err := AssertRefundVoucher(channel, prepared.Cumulative); err != nil {
				return nil, err
			}
			if generated.ChannelStatus(channel.Status) == generated.ChannelStatus_Closing {
				return nil, fmt.Errorf("%s: %s is already closing", batchsettlement.ErrCloseState, prepared.ChannelID)
			}
			return nil, nil
		},
		send: func(onPrepared func(string, string) error) (string, error) {
			if err := f.signer.SimulateTransaction(ctx, requestClose, requirements.Network, nil); err != nil {
				return "", err
			}
			feePayer, err := solana.PublicKeyFromBase58(prepared.Terms.FeePayer)
			if err != nil {
				return "", err
			}
			return paymentchannels.BroadcastOpen(ctx, f.signer, feePayer, requirements.Network, prepared.RequestClose, paymentchannels.ChannelBroadcastHooks{OnPrepared: onPrepared})
		},
		postcondition: func(fromPending bool) error {
			observed, matched, err := f.fetchChannelUntil(ctx, requirements.Network, prepared.ChannelID, func(channel *generated.Channel) bool {
				if fromPending {
					return channel == nil || statusIn(channel, closed)
				}
				return channel != nil && statusIn(channel, closed)
			})
			if err != nil {
				return err
			}
			if fromPending && matched && observed == nil {
				return nil
			}
			if !matched || observed == nil {
				return errors.New("request_close confirmed but the closing state is not visible yet")
			}
			if err := f.assertClaimChannel(observed, payload.ChannelConfig, prepared.Terms, requirements, closed); err != nil {
				return err
			}
			channel = observed
			return nil
		},
	})
	if err != nil || response != nil {
		return response, err
	}
	if channel == nil {
		return RecoveredRefundResponse(prepared.ChannelID, payer, x402.Network(requirements.Network), signature), nil
	}
	return RefundResponse(prepared.ChannelID, channel, x402.Network(requirements.Network), signature), nil
}

func (f *BatchSvmScheme) verifyRefund(ctx context.Context, payload batchsettlement.ParsedBatchPayload, requirements types.PaymentRequirements) (*x402.VerifyResponse, error) {
	terms, err := f.resolveTerms(ctx, payload.ChannelConfig, requirements, VoucherModeRequirements)
	if err != nil {
		return nil, err
	}
	channelID, err := f.deriveChannelID(ctx, payload.ChannelConfig, terms.FeePayer)
	if err != nil {
		return nil, err
	}
	signer, err := VoucherSignerFor(payload.ChannelConfig, requirements.Extra, VoucherModePayload)
	if err != nil {
		return nil, err
	}
	if signer == batchsettlement.VoucherSignerServer && payload.Voucher == nil {
		refund := batchsettlement.BatchRefundPayload{ChannelConfig: payload.ChannelConfig, Authorization: payload.Authorization}
		if err := AssertServerModeRefundProof(refund, channelID, f.now()); err != nil {
			return nil, err
		}
		channel, err := f.fetchChannel(ctx, requirements.Network, channelID)
		if err != nil {
			return nil, err
		}
		if err := AssertNotClosing(channel, channelID); err != nil {
			return nil, err
		}
		if err := AssertRefundable(channel, channelID); err != nil {
			return nil, err
		}
		if err := f.assertClaimChannel(channel, payload.ChannelConfig, terms, requirements, refundableStatuses); err != nil {
			return nil, err
		}
		return &x402.VerifyResponse{IsValid: true, Payer: payload.ChannelConfig.Payer, Extra: VerifiedChannelExtra(channelID, channel)}, nil
	}
	if signer == batchsettlement.VoucherSignerServer && payload.Voucher != nil {
		return nil, fmt.Errorf("%s: invalid payer proof", batchsettlement.ErrVoucherSignature)
	}
	refund := batchsettlement.BatchRefundPayload{
		Type:          payload.Type,
		ChannelConfig: payload.ChannelConfig,
		Voucher:       payload.Voucher,
		Authorization: payload.Authorization,
		Transaction:   payload.Transaction,
	}
	channel, id, _, err := ValidateRefund(ctx, f.sealDependencies(), refund, requirements, RefundLimits{
		MaxComputeUnits:             f.config.MaxComputeUnits,
		MaxPriorityFeeMicroLamports: f.config.MaxPriorityFeeMicroLamports,
		TransactionVersions:         f.transactionVersions,
	}, nil)
	if err != nil {
		return nil, err
	}
	return &x402.VerifyResponse{IsValid: true, Payer: channel.Payer.String(), Extra: VerifiedChannelExtra(id, channel)}, nil
}

func (f *BatchSvmScheme) validateVoucherOnly(ctx context.Context, payload batchsettlement.ParsedBatchPayload, requirements types.PaymentRequirements, terms BatchTerms, channelID string) (*generated.Channel, error) {
	cumulative, err := verifySignedVoucher(channelID, *payload.Voucher, payload.ChannelConfig.PayerAuthorizer)
	if err != nil {
		return nil, err
	}
	channel, err := f.fetchChannel(ctx, requirements.Network, channelID)
	if err != nil {
		return nil, err
	}
	if err := AssertNotClosing(channel, channelID); err != nil {
		return nil, err
	}
	if err := f.assertClaimChannel(channel, payload.ChannelConfig, terms, requirements, openStatuses); err != nil {
		return nil, err
	}
	if cumulative > channel.Deposit {
		return nil, fmt.Errorf("%s", batchsettlement.ErrCumulativeExceedsDeposit)
	}
	charge, err := paymentchannels.ParseU64(requirements.Amount, "amount")
	if err != nil {
		return nil, fmt.Errorf("%s: %w", InvalidPaymentRequirements, err)
	}
	// Cover settled + price, and stay strictly above settled even when the price is zero.
	minimum, ok := batchsettlement.AddU64(channel.Settlement.Settled, charge)
	if !ok || cumulative < minimum || cumulative <= channel.Settlement.Settled {
		return nil, fmt.Errorf("%s", batchsettlement.ErrCumulativeAmountMismatch)
	}
	return channel, nil
}

func verifySignedVoucher(channelID string, voucher batchsettlement.BatchVoucher, signer string) (uint64, error) {
	if voucher.ExpiresAt != batchsettlement.ClientVoucherExpiresAt {
		return 0, fmt.Errorf("%s", batchsettlement.ErrVoucherExpiry)
	}
	cumulative, err := paymentchannels.ParseU64(voucher.MaxClaimableAmount, "maxClaimableAmount")
	if err != nil {
		return 0, fmt.Errorf("%s: %w", batchsettlement.ErrVoucherSignature, err)
	}
	channelKey, err := solana.PublicKeyFromBase58(channelID)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", batchsettlement.ErrVoucherSignature, err)
	}
	message := paymentchannels.EncodeVoucherMessage(channelKey, cumulative, voucher.ExpiresAt)
	if err := paymentchannels.VerifyVoucherSignature(voucher.Signature, signer, message); err != nil {
		return 0, fmt.Errorf("%s", batchsettlement.ErrVoucherSignature)
	}
	return cumulative, nil
}

func (f *BatchSvmScheme) assertDepositChannel(channel *generated.Channel, validated ValidatedDeposit, requirements types.PaymentRequirements) error {
	if err := f.assertClaimChannel(channel, validated.Payload.ChannelConfig, validated.Terms, requirements, openStatuses); err != nil {
		return err
	}
	if channel.Deposit != validated.ExpectedDeposit {
		return fmt.Errorf("%s: confirmed deposit mismatch", batchsettlement.ErrChannelState)
	}
	return nil
}

func (f *BatchSvmScheme) fetchChannelsUntil(ctx context.Context, network string, ids []string, predicate func([]*generated.Channel) bool) ([]*generated.Channel, bool, error) {
	for attempt := 0; attempt < ChannelReadAttempts; attempt++ {
		channels := make([]*generated.Channel, len(ids))
		var err error
		for i, id := range ids {
			if channels[i], err = f.readChannel(ctx, network, id); err != nil {
				break
			}
		}
		if err == nil && predicate(channels) {
			return channels, true, nil
		}
		if attempt+1 < ChannelReadAttempts {
			if err := f.waitForChannelRead(ctx, attempt); err != nil {
				return nil, false, err
			}
		}
	}
	return nil, false, nil
}

// decodeWithMessageHash decodes a base64 transaction and returns its message
// hash, which is stable across fee-payer signature variants of the same message.
func decodeWithMessageHash(base64Tx string) (*solana.Transaction, string, error) {
	tx, err := svm.DecodeTransaction(base64Tx)
	if err != nil {
		return nil, "", err
	}
	hash, err := svm.MessageHash(tx)
	if err != nil {
		return nil, "", err
	}
	return tx, hash, nil
}

func payloadMap(payload batchsettlement.ParsedBatchPayload) map[string]any {
	record := map[string]any{
		"type": payload.Type,
		"channelConfig": map[string]any{
			"payer":              payload.ChannelConfig.Payer,
			"payerAuthorizer":    payload.ChannelConfig.PayerAuthorizer,
			"receiver":           payload.ChannelConfig.Receiver,
			"receiverAuthorizer": payload.ChannelConfig.ReceiverAuthorizer,
			"token":              payload.ChannelConfig.Token,
			"withdrawDelay":      payload.ChannelConfig.WithdrawDelay,
			"salt":               payload.ChannelConfig.Salt,
			"openSlot":           payload.ChannelConfig.OpenSlot,
		},
	}
	if payload.ChannelConfig.VoucherSigner != "" {
		record["channelConfig"].(map[string]any)["voucherSigner"] = payload.ChannelConfig.VoucherSigner
	}
	if payload.Deposit != nil {
		record["deposit"] = map[string]any{"amount": payload.Deposit.Amount, "transaction": payload.Deposit.Transaction}
	}
	if payload.Voucher != nil {
		record["voucher"] = voucherMap(payload.Voucher)
	}
	if payload.Authorization != nil {
		record["authorization"] = map[string]any{
			"type":             payload.Authorization.Type,
			"channelId":        payload.Authorization.ChannelID,
			"payer":            payload.Authorization.Payer,
			"requestId":        payload.Authorization.RequestID,
			"authorizedAmount": payload.Authorization.AuthorizedAmount,
			"expiresAt":        payload.Authorization.ExpiresAt,
			"signature":        payload.Authorization.Signature,
		}
	}
	return record
}

func indexOf(keys []string, want string) int {
	for i, key := range keys {
		if key == want {
			return i
		}
	}
	return -1
}

func balanceHasAccount(balances []svm.FacilitatorTokenBalance, accountIndex int) bool {
	for _, balance := range balances {
		if balance.AccountIndex == accountIndex {
			return true
		}
	}
	return false
}

func tokenBalance(balances []svm.FacilitatorTokenBalance, accountIndex int, requirements types.PaymentRequirements) (uint64, error) {
	return balanceOf(balances, accountIndex, requirements.Asset, requirements.PayTo)
}

// balanceOf is the token balance listed for accountIndex, which must be owner's balance of mint; zero when unlisted.
func balanceOf(balances []svm.FacilitatorTokenBalance, accountIndex int, mint, owner string) (uint64, error) {
	for _, balance := range balances {
		if balance.AccountIndex != accountIndex {
			continue
		}
		if balance.Mint != mint || balance.Owner != owner {
			return 0, fmt.Errorf("payout recipient balance mismatch")
		}
		return paymentchannels.ParseU64(balance.UITokenAmount.Amount, "payout balance")
	}
	return 0, nil
}

type distributionExtra struct {
	Channels      []string                                      `json:"channels"`
	ChannelStates []batchsettlement.BatchRedemptionChannelState `json:"channelStates,omitempty"`
}

type storedDistribution struct {
	x402.SettleResponse
	Extra *distributionExtra `json:"extra,omitempty"`
}

func decodeDistributionResult(raw string) (*x402.SettleResponse, error) {
	var stored storedDistribution
	if err := json.Unmarshal([]byte(raw), &stored); err != nil {
		return nil, err
	}
	response := stored.SettleResponse
	if stored.Extra != nil {
		response.Extra = map[string]any{"channels": stored.Extra.Channels}
		if stored.Extra.ChannelStates != nil {
			response.Extra[batchsettlement.ExtraChannelStates] = stored.Extra.ChannelStates
		}
	}
	return &response, nil
}

func channelIDs(prepared []PreparedDistribution) []string {
	ids := make([]string, len(prepared))
	for i, item := range prepared {
		ids[i] = item.ChannelID
	}
	return ids
}

func statusIn(channel *generated.Channel, allowed []generated.ChannelStatus) bool {
	if channel == nil {
		return false
	}
	for _, status := range allowed {
		if generated.ChannelStatus(channel.Status) == status {
			return true
		}
	}
	return false
}

func channelActivityRecord(network, channelID, payTo, tokenProgram string, expiresAt int64, receiverAuthorizer, callerIdentity string) paymentchannels.PaymentChannelRecord {
	return paymentchannels.PaymentChannelRecord{
		Network:            network,
		ChannelID:          channelID,
		PayTo:              payTo,
		TokenProgram:       tokenProgram,
		ExpiresAt:          expiresAt,
		LastActivityAt:     time.Now(),
		ReceiverAuthorizer: receiverAuthorizer,
		CallerIdentity:     callerIdentity,
	}
}

// openDisposition reverts only a definitive open failure: the send was rejected,
// the transaction landed with an error, or its blockhash expired unlanded.
// Pending and a failed attempt to persist a pending signature are kept.
func openDisposition(response *x402.SettleResponse, confirmed bool) paymentchannels.OpenBroadcastDisposition {
	if confirmed || response == nil || response.Success || response.ErrorReason != "transaction_failed" {
		return paymentchannels.OpenBroadcastKeep
	}
	if strings.Contains(response.ErrorMessage, "failed to persist") {
		return paymentchannels.OpenBroadcastKeep
	}
	return paymentchannels.OpenBroadcastRevert
}
