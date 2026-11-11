package facilitator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	solana "github.com/gagliardetto/solana-go"
	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels/generated"
	"github.com/x402-foundation/x402/go/v2/types"
)

type durablePhase string

const (
	phaseCompleted durablePhase = "completed"
	phasePending   durablePhase = "pending"
	phaseBroadcast durablePhase = "broadcast"
)

type durableArgs struct {
	key           string
	network       string
	payer         string
	beforeSend    func() (*x402.SettleResponse, error)
	send          func(func(string, string) error) (string, error)
	broadcast     func() (durableResult, error)
	onReplay      func(string) *x402.SettleResponse
	postcondition func(signature string, phase durablePhase) (any, *x402.SettleResponse, error)
}

// settleDurably runs one operation under args.key: it reconciles a pending
// broadcast, answers from chain state in beforeSend, or broadcasts under a
// reservation. Storage cost on the happy path is one pending read and one reservation.
func (f *BatchSvmScheme) settleDurably(ctx context.Context, args durableArgs) (any, string, *x402.SettleResponse, error) {
	finish := func(signature string, phase durablePhase) (any, string, *x402.SettleResponse, error) {
		channel, response, err := args.postcondition(signature, phase)
		if err != nil || response != nil {
			return nil, signature, response, err
		}
		return channel, signature, nil, nil
	}
	if pending, ok, err := f.pendingStore.Get(ctx, args.key); err != nil {
		return nil, "", nil, err
	} else if ok {
		recovered, err := f.reconcileBroadcast(ctx, args.key, pending, args.network, args.payer)
		if err != nil || !recovered.OK {
			return nil, recovered.Signature, recovered.Response, err
		}
		channel, signature, response, err := finish(recovered.Signature, phasePending)
		if err == nil && response == nil {
			f.forgetPending(ctx, args.key, pending)
		}
		return channel, signature, response, err
	}
	if args.beforeSend != nil {
		early, err := args.beforeSend()
		if err != nil || early != nil {
			return nil, "", early, err
		}
	}
	var sent durableResult
	var err error
	switch {
	case args.broadcast != nil:
		sent, err = args.broadcast()
	case args.send != nil:
		// A worker that recorded the key after the read above holds its reservation, so the send reconciles with it.
		sent, err = f.broadcastUnchecked(ctx, args.key, args.network, args.payer, args.send)
	default:
		return nil, "", nil, fmt.Errorf("settleDurably requires send")
	}
	if err != nil || !sent.OK {
		return nil, sent.Signature, sent.Response, err
	}
	if sent.Replayed && args.onReplay != nil {
		return nil, sent.Signature, args.onReplay(sent.Signature), nil
	}
	phase := phaseBroadcast
	if sent.Replayed {
		phase = phaseCompleted
	}
	return finish(sent.Signature, phase)
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
		return ValidatedDeposit{}, err
	}
	charge, err := paymentchannels.ParseU64(requirements.Amount, "amount")
	if err != nil {
		return ValidatedDeposit{}, err
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
			return ValidatedDeposit{}, err
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
	// The settlement ATAs (and the cluster slot, when the challenge carries no
	// recentSlot) are read alongside the channel. This is the last local-only
	// rejection, so invalid requests never reach RPC. Both are joined where
	// the serial path used to read them.
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
		if err := f.assertClaimChannel(existing, payload.ChannelConfig, terms, requirements, []generated.ChannelStatus{generated.ChannelStatus_Open}); err != nil {
			return ValidatedDeposit{}, err
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
		if err := settlement.result(ctx, deposit); err != nil {
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
	recent, err := recentSlotHint(requirements)
	if err != nil {
		return err
	}
	// The program accepts an open only within its slot window of the cluster
	// slot it lands at, so the window is judged against the challenge's
	// recentSlot or, without one, the cluster's own slot.
	if recent == nil {
		var slot uint64
		if slotRead != nil {
			slot, err = slotRead.result(ctx)
		} else {
			slot, err = f.signer.GetSlot(ctx, requirements.Network, paymentchannels.SlotCommitment)
		}
		if err != nil {
			return fmt.Errorf("%s: read cluster slot: %w", batchsettlement.ErrChannelState, err)
		}
		recent = &slot
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
	_ = ctx
	return nil
}

func (f *BatchSvmScheme) settleDeposit(ctx context.Context, payload batchsettlement.ParsedBatchPayload, requirements types.PaymentRequirements, facilitatorContext any) (*x402.SettleResponse, error) {
	validated, err := f.validateDeposit(ctx, payload, requirements, ProofAmountCeiling)
	if err != nil {
		return nil, err
	}
	if validated.Existing != nil && !validated.IsTopUp {
		channel, err := f.fetchChannel(ctx, requirements.Network, validated.ChannelID)
		if err != nil {
			return nil, err
		}
		if err := f.assertDepositChannel(channel, validated, requirements); err != nil {
			return nil, err
		}
		return DepositResponse(validated.ChannelID, channel, x402.Network(requirements.Network), "", validated.Deposit), nil
	}
	key := "batch:deposit:" + requirements.Network + ":" + validated.ChannelID
	var topUp *solana.Transaction
	if validated.IsTopUp {
		decoded, hash, err := decodeWithMessageHash(payload.Deposit.Transaction)
		if err != nil {
			return nil, fmt.Errorf("%s: %s", batchsettlement.ErrSettlementSimulation, err.Error())
		}
		topUp = decoded
		key = "batch:topup:" + requirements.Network + ":" + hash
	}
	feePayer, err := solana.PublicKeyFromBase58(validated.Terms.FeePayer)
	if err != nil {
		return nil, err
	}
	if validated.IsTopUp {
		if err := f.signer.SimulateTransaction(ctx, topUp, requirements.Network, nil); err != nil {
			return nil, fmt.Errorf("%s: %s", batchsettlement.ErrSettlementSimulation, err.Error())
		}
	} else if err := f.simulateOpen(ctx, validated, requirements, feePayer); err != nil {
		if strings.HasPrefix(err.Error(), batchsettlement.ErrSettlementSimulation+":") {
			return nil, err
		}
		return nil, fmt.Errorf("%s: %s", batchsettlement.ErrSettlementSimulation, err.Error())
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
	settled, err := paymentchannels.WriteThenBroadcast(ctx, paymentchannels.WriteThenBroadcastArgs[depositBroadcast]{
		Storage:        f.channelStorage,
		Kind:           kind,
		Records:        []paymentchannels.PaymentChannelRecord{record},
		OnStorageError: f.config.OnStorageError,
		Broadcast: func(reserved func()) (paymentchannels.BroadcastOutcome[depositBroadcast], error) {
			channel, signature, response, err := f.settleDurably(ctx, durableArgs{
				key:     key,
				network: requirements.Network,
				payer:   payload.ChannelConfig.Payer,
				send: func(onPrepared func(string, string) error) (string, error) {
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
				postcondition: func(string, durablePhase) (any, *x402.SettleResponse, error) {
					channel, err := f.fetchChannel(ctx, requirements.Network, validated.ChannelID)
					if err != nil {
						return nil, nil, err
					}
					if err := f.assertDepositChannel(channel, validated, requirements); err != nil {
						return nil, nil, err
					}
					return channel, nil, nil
				},
			})
			if err != nil {
				return paymentchannels.BroadcastOutcome[depositBroadcast]{}, err
			}
			disposition := paymentchannels.OpenBroadcastKeep
			if !validated.IsTopUp {
				disposition = openDisposition(response, channel != nil)
			}
			return paymentchannels.BroadcastOutcome[depositBroadcast]{
				Value:       depositBroadcast{channel: channel, signature: signature, response: response},
				Disposition: disposition,
			}, nil
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
	if settled.response != nil {
		return settled.response, nil
	}
	return DepositResponse(validated.ChannelID, settled.channel.(*generated.Channel), x402.Network(requirements.Network), settled.signature, validated.Deposit), nil
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
		cumulative, err := f.verifySignedVoucher(channelID, claim.Voucher, claim.ChannelConfig.PayerAuthorizer)
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
	feePayer := ""
	if len(prepared) > 0 {
		feePayer = prepared[0].FeePayer
	}
	if feePayer == "" {
		return nil, fmt.Errorf("%s", batchsettlement.ErrFeePayerMismatch)
	}
	for _, item := range prepared {
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
	channel, signature, response, err := f.settleDurably(ctx, durableArgs{
		key:     claimKey,
		network: requirements.Network,
		payer:   payer,
		beforeSend: func() (*x402.SettleResponse, error) {
			advanced := 0
			for _, item := range prepared {
				channel, err := f.fetchChannel(ctx, requirements.Network, item.ChannelID)
				if err != nil {
					return nil, err
				}
				if err := AssertNotClosing(channel, item.ChannelID); err != nil {
					return nil, err
				}
				if err := f.assertClaimChannel(channel, item.Claim.ChannelConfig, item.Terms, requirements, []generated.ChannelStatus{generated.ChannelStatus_Open}); err != nil {
					return nil, err
				}
				if item.Cumulative == 0 || item.Cumulative > channel.Deposit {
					return nil, fmt.Errorf("%s", batchsettlement.ErrCumulativeAmountMismatch)
				}
				if item.Cumulative <= channel.Settlement.Settled {
					advanced++
					continue
				}
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
			// The program watermark makes a claim idempotent: every voucher already at or below it is a repeat that landed.
			switch advanced {
			case 0:
				return nil, nil
			case len(prepared):
				return ClaimResponse(prepared, x402.Network(requirements.Network), ""), nil
			default:
				return nil, fmt.Errorf("%s", batchsettlement.ErrCumulativeAmountMismatch)
			}
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
					value, err := f.submitRedemptionUnchecked(ctx, feePayer, requirements.Network, instructions, claimKey, payer)
					if err != nil {
						return paymentchannels.BroadcastOutcome[durableResult]{}, err
					}
					return paymentchannels.BroadcastOutcome[durableResult]{Value: value, Disposition: paymentchannels.OpenBroadcastKeep}, nil
				},
			})
		},
		onReplay: func(signature string) *x402.SettleResponse {
			return ClaimResponse(prepared, x402.Network(requirements.Network), signature)
		},
		postcondition: func(signature string, _ durablePhase) (any, *x402.SettleResponse, error) {
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
				return nil, nil, err
			}
			if !ok {
				return nil, SettlementPending(x402.Network(requirements.Network), payer, signature, "claim confirmed but its channel watermark is not visible yet"), nil
			}
			for i, channel := range channels {
				if err := f.assertClaimChannel(channel, prepared[i].Claim.ChannelConfig, prepared[i].Terms, requirements, []generated.ChannelStatus{
					generated.ChannelStatus_Open,
					generated.ChannelStatus_Sealed,
					generated.ChannelStatus_Closing,
					generated.ChannelStatus_Distributed,
				}); err != nil {
					return nil, nil, err
				}
			}
			return channels, nil, nil
		},
	})
	if err != nil || response != nil {
		return response, err
	}
	_ = channel
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
	return f.distributeCurrent(ctx, payload, requirements)
}

// distributionKey identifies one distribution pass by the settled watermark of
// each channel, so a new claim starts a new pass and a repeat reuses the old one.
func distributionKey(network string, prepared []PreparedDistribution, channels []*generated.Channel) string {
	parts := make([]string, len(prepared))
	for i, item := range prepared {
		parts[i] = item.ChannelID + ":" + strconv.FormatUint(channels[i].Settlement.Settled, 10)
	}
	sort.Strings(parts)
	return "batch:distribute:" + network + ":" + strings.Join(parts, ",")
}

func (f *BatchSvmScheme) distributeCurrent(ctx context.Context, payload batchsettlement.BatchSettlePayload, requirements types.PaymentRequirements) (*x402.SettleResponse, error) {
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
	for _, item := range prepared {
		if item.FeePayer != feePayer {
			return nil, fmt.Errorf("%s", batchsettlement.ErrFeePayerMismatch)
		}
	}
	channels := make([]*generated.Channel, len(prepared))
	for i, item := range prepared {
		channel, err := f.fetchChannel(ctx, requirements.Network, item.ChannelID)
		if err != nil {
			return nil, err
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
	key := distributionKey(requirements.Network, prepared, channels)
	return f.coalescePayout(key, func() (*x402.SettleResponse, error) {
		return f.distributeKeyed(ctx, key, prepared, channels, requirements)
	})
}

// coalescePayout runs one payout pass per key in this process. Concurrent
// callers share its result, so OnDistributionConfirmed receives the payout once.
func (f *BatchSvmScheme) coalescePayout(key string, run func() (*x402.SettleResponse, error)) (*x402.SettleResponse, error) {
	passes := passesFor(f.pendingStore)
	passes.mu.Lock()
	if existing := passes.inflight[key]; existing != nil {
		passes.mu.Unlock()
		<-existing.done
		return existing.response, existing.err
	}
	pass := &distributionPass{done: make(chan struct{})}
	passes.inflight[key] = pass
	passes.mu.Unlock()
	pass.response, pass.err = run()
	close(pass.done)
	passes.mu.Lock()
	if passes.inflight[key] == pass {
		delete(passes.inflight, key)
	}
	passes.mu.Unlock()
	return pass.response, pass.err
}

// distributeKeyed runs the pass identified by key over channels as read.
func (f *BatchSvmScheme) distributeKeyed(ctx context.Context, key string, prepared []PreparedDistribution, channels []*generated.Channel, requirements types.PaymentRequirements) (*x402.SettleResponse, error) {
	feePayer := prepared[0].FeePayer
	if f.config.OnDistributionConfirmed != nil {
		if previous, ok, err := f.pendingStore.Get(ctx, resultKey(key)); err != nil {
			return nil, err
		} else if ok {
			stored, err := decodeDistributionResult(previous)
			if err != nil {
				return nil, err
			}
			if stored.Success {
				if err := f.recordPayout(ctx, key, stored, requirements); err != nil {
					return SettlementPending(x402.Network(requirements.Network), "", stored.Transaction, err.Error()), nil //nolint:nilerr // the payout landed; a hook failure stays pending
				}
				f.forgetPending(ctx, key, stored.Transaction)
			}
			return stored, nil
		}
	}
	if pending, ok, err := f.pendingStore.Get(ctx, key); err != nil {
		return nil, err
	} else if ok {
		recovered, err := f.reconcileBroadcast(ctx, key, pending, requirements.Network, "")
		if err != nil || !recovered.OK {
			return recovered.Response, err
		}
		return f.finishDistribution(ctx, key, recovered.Signature, prepared, requirements)
	}
	var instructions []solana.Instruction
	var swept []PreparedDistribution
	for i, item := range prepared {
		channel := channels[i]
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
		return SettleFailure(x402.Network(requirements.Network), batchsettlement.ErrCumulativeAmountMismatch, "", ""), nil
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
			value, err := f.submitRedemptionUnchecked(ctx, feePayer, requirements.Network, instructions, key, "")
			if err != nil {
				return paymentchannels.BroadcastOutcome[durableResult]{}, err
			}
			return paymentchannels.BroadcastOutcome[durableResult]{Value: value, Disposition: paymentchannels.OpenBroadcastKeep}, nil
		},
	})
	if err != nil || !submitted.OK {
		return submitted.Response, err
	}
	return f.finishDistribution(ctx, key, submitted.Signature, prepared, requirements)
}

func (f *BatchSvmScheme) finishDistribution(ctx context.Context, key, signature string, prepared []PreparedDistribution, requirements types.PaymentRequirements) (*x402.SettleResponse, error) {
	response, err := f.attributeDistribution(ctx, signature, prepared, requirements)
	if err != nil {
		var ambiguous *PayoutAttributionAmbiguousError
		if errors.As(err, &ambiguous) {
			failed := SettleFailureWithTransaction(x402.Network(requirements.Network), batchsettlement.ErrPayoutAttributionAmbiguous, "", err.Error(), signature)
			if err := f.keepPayoutResult(ctx, key, failed); err != nil {
				return SettlementPending(x402.Network(requirements.Network), "", signature, err.Error()), nil //nolint:nilerr // the sweep landed; a store failure stays pending
			}
			f.forgetPending(ctx, key, signature)
			return failed, nil
		}
		return SettlementPending(x402.Network(requirements.Network), "", signature, err.Error()), nil
	}
	if err := f.keepPayoutResult(ctx, key, response); err != nil {
		return SettlementPending(x402.Network(requirements.Network), "", signature, err.Error()), nil //nolint:nilerr // the sweep landed; a store failure stays pending
	}
	if err := f.recordPayout(ctx, key, response, requirements); err != nil {
		return SettlementPending(x402.Network(requirements.Network), "", signature, err.Error()), nil //nolint:nilerr // the sweep landed; a hook failure stays pending
	}
	f.forgetPending(ctx, key, signature)
	return response, nil
}

// keepPayoutResult stores a payout response for a retry. Without
// OnDistributionConfirmed there is nothing to replay and no store write is made.
func (f *BatchSvmScheme) keepPayoutResult(ctx context.Context, key string, response *x402.SettleResponse) error {
	if f.config.OnDistributionConfirmed == nil {
		return nil
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		return err
	}
	return f.pendingStore.Set(ctx, resultKey(key), string(encoded))
}

// recordPayout hands a confirmed payout to OnDistributionConfirmed once per key.
func (f *BatchSvmScheme) recordPayout(ctx context.Context, key string, response *x402.SettleResponse, requirements types.PaymentRequirements) error {
	if f.config.OnDistributionConfirmed == nil {
		return nil
	}
	if recorded, ok, err := f.pendingStore.Get(ctx, recordedKey(key)); err != nil {
		return err
	} else if ok && recorded != "" {
		return nil
	}
	if err := f.config.OnDistributionConfirmed(ctx, response, requirements); err != nil {
		return err
	}
	return f.pendingStore.Set(ctx, recordedKey(key), "1")
}

// attributeDistribution reads the confirmed sweep and attributes the
// recipient's payout. It reads chain state only and can be repeated.
func (f *BatchSvmScheme) attributeDistribution(ctx context.Context, signature string, prepared []PreparedDistribution, requirements types.PaymentRequirements) (*x402.SettleResponse, error) {
	reader, ok := f.raw.(svm.FacilitatorConfirmedTransactionReader)
	if !ok {
		return nil, fmt.Errorf("getConfirmedTransaction is required for payout accounting")
	}
	parsed, err := solana.SignatureFromBase58(signature)
	if err != nil {
		return nil, err
	}
	var evidence *svm.FacilitatorConfirmedTransaction
	for attempt := 0; attempt < ChannelReadAttempts; attempt++ {
		evidence, err = reader.GetConfirmedTransaction(ctx, parsed, requirements.Network)
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
	f.rememberSlot(requirements.Network, evidence.Slot)
	tokenProgram, err := solana.PublicKeyFromBase58(prepared[0].Terms.TokenProgram)
	if err != nil {
		return nil, err
	}
	mint, err := solana.PublicKeyFromBase58(requirements.Asset)
	if err != nil {
		return nil, err
	}
	payTo, err := solana.PublicKeyFromBase58(requirements.PayTo)
	if err != nil {
		return nil, err
	}
	recipient, err := paymentchannels.FindATA(payTo, mint, tokenProgram)
	if err != nil {
		return nil, err
	}
	recipientIndex := indexOf(evidence.AccountKeys, recipient.String())
	if recipientIndex < 0 {
		return nil, fmt.Errorf("recipient is absent from distribution transaction")
	}
	for _, item := range prepared {
		owner, err := solana.PublicKeyFromBase58(item.ChannelID)
		if err != nil {
			return nil, err
		}
		escrow, err := paymentchannels.FindATA(owner, mint, tokenProgram)
		if err != nil {
			return nil, err
		}
		escrowIndex := indexOf(evidence.AccountKeys, escrow.String())
		if escrowIndex < 0 {
			continue
		}
		if !balanceHasAccount(evidence.Meta.PostTokenBalances, escrowIndex) &&
			(item.ChannelConfig.Payer == requirements.PayTo || paymentchannels.ResolveTreasuryOwner(f.config.PaymentChannelsTreasuryOwner, requirements.Network).String() == requirements.PayTo) {
			return nil, &PayoutAttributionAmbiguousError{}
		}
	}
	pre, err := tokenBalance(evidence.Meta.PreTokenBalances, recipientIndex, requirements)
	if err != nil {
		return nil, err
	}
	post, err := tokenBalance(evidence.Meta.PostTokenBalances, recipientIndex, requirements)
	if err != nil {
		return nil, err
	}
	if post < pre {
		return nil, fmt.Errorf("negative recipient payout")
	}
	return &x402.SettleResponse{
		Success:     true,
		Network:     x402.Network(requirements.Network),
		Transaction: signature,
		Amount:      strconv.FormatUint(post-pre, 10),
		Extra:       map[string]any{"channels": channelIDs(prepared)},
	}, nil
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
	channel, signature, response, err := f.settleDurably(ctx, durableArgs{
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
			if err := f.assertClaimChannel(channel, payload.ChannelConfig, prepared.Terms, requirements, []generated.ChannelStatus{generated.ChannelStatus_Open, generated.ChannelStatus_Closing}); err != nil {
				return nil, err
			}
			if generated.ChannelStatus(channel.Status) == generated.ChannelStatus_Closing {
				return RefundResponse(prepared.ChannelID, channel, x402.Network(requirements.Network), ""), nil
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
		onReplay: func(signature string) *x402.SettleResponse {
			return RecoveredRefundResponse(prepared.ChannelID, payer, x402.Network(requirements.Network), signature)
		},
		postcondition: func(signature string, phase durablePhase) (any, *x402.SettleResponse, error) {
			observed, matched, err := f.fetchChannelUntil(ctx, requirements.Network, prepared.ChannelID, func(channel *generated.Channel) bool {
				if phase == phasePending {
					return channel == nil || statusIn(channel, closed)
				}
				return channel != nil && statusIn(channel, closed)
			})
			if err != nil {
				return nil, nil, err
			}
			if phase == phasePending && matched && observed == nil {
				return (*generated.Channel)(nil), nil, nil
			}
			if !matched || observed == nil {
				return nil, SettlementPending(x402.Network(requirements.Network), payer, signature, "request_close confirmed but the closing state is not visible yet"), nil
			}
			if err := f.assertClaimChannel(observed, payload.ChannelConfig, prepared.Terms, requirements, closed); err != nil {
				return nil, nil, err
			}
			return observed, nil, nil
		},
	})
	if err != nil || response != nil {
		return response, err
	}
	if channel == nil {
		return RecoveredRefundResponse(prepared.ChannelID, payer, x402.Network(requirements.Network), signature), nil
	}
	return RefundResponse(prepared.ChannelID, channel.(*generated.Channel), x402.Network(requirements.Network), signature), nil
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
		if err := f.assertClaimChannel(channel, payload.ChannelConfig, terms, requirements, []generated.ChannelStatus{generated.ChannelStatus_Open, generated.ChannelStatus_Closing}); err != nil {
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
	cumulative, err := f.verifySignedVoucher(channelID, *payload.Voucher, payload.ChannelConfig.PayerAuthorizer)
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
	if err := f.assertClaimChannel(channel, payload.ChannelConfig, terms, requirements, []generated.ChannelStatus{generated.ChannelStatus_Open}); err != nil {
		return nil, err
	}
	if cumulative > channel.Deposit {
		return nil, fmt.Errorf("%s", batchsettlement.ErrCumulativeExceedsDeposit)
	}
	charge, err := paymentchannels.ParseU64(requirements.Amount, "amount")
	if err != nil {
		return nil, err
	}
	// Cover settled + price, and stay strictly above settled even when the price is zero.
	minimum, ok := batchsettlement.AddU64(channel.Settlement.Settled, charge)
	if !ok || cumulative < minimum || cumulative <= channel.Settlement.Settled {
		return nil, fmt.Errorf("%s", batchsettlement.ErrCumulativeAmountMismatch)
	}
	return channel, nil
}

func (f *BatchSvmScheme) verifySignedVoucher(channelID string, voucher batchsettlement.BatchVoucher, signer string) (uint64, error) {
	if voucher.ExpiresAt != batchsettlement.ClientVoucherExpiresAt {
		return 0, fmt.Errorf("%s", batchsettlement.ErrVoucherExpiry)
	}
	cumulative, err := paymentchannels.ParseU64(voucher.MaxClaimableAmount, "maxClaimableAmount")
	if err != nil {
		return 0, err
	}
	channelKey, err := solana.PublicKeyFromBase58(channelID)
	if err != nil {
		return 0, err
	}
	message := paymentchannels.EncodeVoucherMessage(channelKey, cumulative, voucher.ExpiresAt)
	if err := paymentchannels.VerifyVoucherSignature(voucher.Signature, signer, message); err != nil {
		return 0, fmt.Errorf("%s", batchsettlement.ErrVoucherSignature)
	}
	return cumulative, nil
}

func (f *BatchSvmScheme) assertDepositChannel(channel *generated.Channel, validated ValidatedDeposit, requirements types.PaymentRequirements) error {
	if err := f.assertClaimChannel(channel, validated.Payload.ChannelConfig, validated.Terms, requirements, []generated.ChannelStatus{generated.ChannelStatus_Open}); err != nil {
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
		failed := false
		for i, id := range ids {
			channel, err := f.readChannel(ctx, network, id)
			if err != nil {
				failed = true
				break
			}
			channels[i] = channel
		}
		if !failed && predicate(channels) {
			for _, channel := range channels {
				if channel == nil {
					failed = true
					break
				}
			}
			if !failed {
				return channels, true, nil
			}
		}
		if attempt+1 < ChannelReadAttempts {
			if err := f.waitForChannelRead(ctx, attempt); err != nil {
				return nil, false, err
			}
		}
	}
	return nil, false, nil
}

type distributionPass struct {
	done     chan struct{}
	response *x402.SettleResponse
	err      error
}

type passRegistry struct {
	mu       sync.Mutex
	inflight map[string]*distributionPass
}

var distributionPasses sync.Map

func passesFor(store x402.PendingSettlementStore) *passRegistry {
	value, _ := distributionPasses.LoadOrStore(store, &passRegistry{inflight: map[string]*distributionPass{}})
	return value.(*passRegistry)
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
	for _, balance := range balances {
		if balance.AccountIndex != accountIndex {
			continue
		}
		if balance.Mint != requirements.Asset || balance.Owner != requirements.PayTo {
			return 0, fmt.Errorf("payout recipient balance mismatch")
		}
		return paymentchannels.ParseU64(balance.UITokenAmount.Amount, "payout balance")
	}
	return 0, nil
}

type distributionExtra struct {
	Channels []string `json:"channels"`
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

type depositBroadcast struct {
	channel   any
	signature string
	response  *x402.SettleResponse
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
