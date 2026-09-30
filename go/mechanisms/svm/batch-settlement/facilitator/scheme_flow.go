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
	"github.com/gagliardetto/solana-go/rpc"

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
	beforePending func() error
	beforeSend    func() (*x402.SettleResponse, error)
	send          func(func(string, string) error) (string, error)
	broadcast     func() (durableResult, error)
	onCompleted   func(string) (*x402.SettleResponse, error)
	onReplay      func(string) *x402.SettleResponse
	postcondition func(signature string, phase durablePhase) (any, *x402.SettleResponse, error)
}

func (f *BatchSvmScheme) settleDurably(ctx context.Context, args durableArgs) (any, string, *x402.SettleResponse, error) {
	finish := func(signature string, phase durablePhase) (any, string, *x402.SettleResponse, error) {
		channel, response, err := args.postcondition(signature, phase)
		if err != nil || response != nil {
			return nil, signature, response, err
		}
		if phase == phaseCompleted {
			return channel, signature, nil, nil
		}
		incomplete, err := f.completeOrPending(ctx, args.key, signature, args.network, args.payer)
		if err != nil || incomplete != nil {
			return nil, signature, incomplete, err
		}
		return channel, signature, nil, nil
	}
	if completed, ok, err := f.pendingStore.Get(ctx, f.completedBroadcastKey(args.key)); err != nil {
		return nil, "", nil, err
	} else if ok {
		if args.onCompleted != nil {
			response, err := args.onCompleted(completed)
			return nil, completed, response, err
		}
		return finish(completed, phaseCompleted)
	}
	if args.beforePending != nil {
		if err := args.beforePending(); err != nil {
			return nil, "", nil, err
		}
	}
	if pending, ok, err := f.pendingStore.Get(ctx, args.key); err != nil {
		return nil, "", nil, err
	} else if ok {
		recovered, err := f.reconcileBroadcast(ctx, args.key, pending, args.network, args.payer)
		if err != nil || !recovered.OK {
			return nil, recovered.Signature, recovered.Response, err
		}
		return finish(recovered.Signature, phasePending)
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
		sent, err = f.broadcastDurably(ctx, args.key, args.network, args.payer, args.send)
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
		switch proof.Signer {
		case batchsettlement.VoucherSignerServer:
			if charge > expected {
				return ValidatedDeposit{}, fmt.Errorf("%s: charge exceeds topped-up ceiling", batchsettlement.ErrCumulativeAmountMismatch)
			}
		case batchsettlement.VoucherSignerClient:
			if proofAmount < charge || proofAmount > expected {
				return ValidatedDeposit{}, fmt.Errorf("%s: voucher exceeds topped-up ceiling", batchsettlement.ErrCumulativeAmountMismatch)
			}
		default:
			return ValidatedDeposit{}, fmt.Errorf("%s", batchsettlement.ErrVoucherSignature)
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
		}); err != nil {
			return ValidatedDeposit{}, err
		}
		if err := f.assertSettlementAccounts(ctx, requirements, payload.ChannelConfig.Payer, terms.TokenProgram); err != nil {
			return ValidatedDeposit{}, err
		}
		validated.ExpectedDeposit = expected
		validated.IsTopUp = true
		return validated, nil
	}
	switch proof.Signer {
	case batchsettlement.VoucherSignerServer:
		if charge > deposit {
			return ValidatedDeposit{}, fmt.Errorf("%s: invalid first voucher amount", batchsettlement.ErrCumulativeAmountMismatch)
		}
	case batchsettlement.VoucherSignerClient:
		if proofAmount != charge || charge > deposit {
			return ValidatedDeposit{}, fmt.Errorf("%s: invalid first voucher amount", batchsettlement.ErrCumulativeAmountMismatch)
		}
	default:
		return ValidatedDeposit{}, fmt.Errorf("%s", batchsettlement.ErrVoucherSignature)
	}
	if err := f.verifyOpen(ctx, payload, requirements, terms, channelID, deposit); err != nil {
		return ValidatedDeposit{}, err
	}
	if err := f.assertSettlementAccounts(ctx, requirements, payload.ChannelConfig.Payer, terms.TokenProgram); err != nil {
		return ValidatedDeposit{}, err
	}
	validated.ExpectedDeposit = deposit
	return validated, nil
}

func (f *BatchSvmScheme) verifyOpen(ctx context.Context, payload batchsettlement.ParsedBatchPayload, requirements types.PaymentRequirements, terms BatchTerms, channelID string, deposit uint64) error {
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
	recent, err := ParseOptionalSlot(nil)
	if requirements.Extra != nil {
		recent, err = ParseOptionalSlot(requirements.Extra[batchsettlement.ExtraRecentSlot])
	}
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
	})
	if err != nil {
		return err
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
	key := "batch:deposit:" + requirements.Network + ":" + validated.ChannelID
	if validated.IsTopUp {
		key = "batch:topup:" + requirements.Network + ":" + payload.Deposit.Transaction
	}
	if existing, err := f.readChannel(ctx, requirements.Network, validated.ChannelID); err != nil {
		return nil, err
	} else if existing != nil && !validated.IsTopUp {
		channel, err := f.fetchChannel(ctx, requirements.Network, validated.ChannelID)
		if err != nil {
			return nil, err
		}
		if err := f.assertDepositChannel(channel, validated, requirements); err != nil {
			return nil, err
		}
		return DepositResponse(validated.ChannelID, channel, x402.Network(requirements.Network), "", validated.Deposit), nil
	}
	if f.settlementCache.IsDuplicate(key) {
		return SettleFailure(x402.Network(requirements.Network), ChannelBusy, payload.ChannelConfig.Payer, ""), nil
	}
	feePayer, err := solana.PublicKeyFromBase58(validated.Terms.FeePayer)
	if err != nil {
		f.settlementCache.Delete(key)
		return nil, err
	}
	if validated.IsTopUp {
		tx, err := svm.DecodeTransaction(payload.Deposit.Transaction)
		if err != nil {
			f.settlementCache.Delete(key)
			return nil, fmt.Errorf("%s: %s", batchsettlement.ErrSettlementSimulation, err.Error())
		}
		if err := f.signer.SimulateTransaction(ctx, tx, requirements.Network, nil); err != nil {
			f.settlementCache.Delete(key)
			return nil, fmt.Errorf("%s: %s", batchsettlement.ErrSettlementSimulation, err.Error())
		}
	} else if err := f.simulateOpen(ctx, validated, requirements, feePayer); err != nil {
		f.settlementCache.Delete(key)
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
			f.settlementCache.Delete(key)
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
	broadcasting := false
	settled, err := paymentchannels.WriteThenBroadcast(ctx, paymentchannels.WriteThenBroadcastArgs[depositBroadcast]{
		Storage:        f.channelStorage,
		Kind:           kind,
		Records:        []paymentchannels.PaymentChannelRecord{record},
		OnStorageError: f.config.OnStorageError,
		Broadcast: func(reserved func()) (paymentchannels.BroadcastOutcome[depositBroadcast], error) {
			broadcasting = true
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
						if _, found := PendingSignatureOf(err); !found {
							f.settlementCache.Delete(key)
						}
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
		if !broadcasting {
			f.settlementCache.Delete(key)
		}
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
		ChannelID:    channelID,
		Mint:         mint,
		Network:      requirements.Network,
		Payee:        feePayer,
		Payer:        payer,
		RentPayer:    feePayer,
		Splits:       []paymentchannels.Split{{Recipient: requirements.PayTo, BPS: batchsettlement.FullSplitBPS}},
		TokenProgram: tokenProgram,
	})
}

func (f *BatchSvmScheme) settleClaims(ctx context.Context, payload batchsettlement.BatchClaimPayload, requirements types.PaymentRequirements) (*x402.SettleResponse, error) {
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
		onCompleted: func(signature string) (*x402.SettleResponse, error) {
			return ClaimResponse(prepared, x402.Network(requirements.Network), signature), nil
		},
		beforeSend: func() (*x402.SettleResponse, error) {
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
				if item.Cumulative <= channel.Settlement.Settled || item.Cumulative > channel.Deposit {
					return nil, fmt.Errorf("%s", batchsettlement.ErrCumulativeAmountMismatch)
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
			if f.settlementCache.IsDuplicate(claimKey) {
				return SettleFailure(x402.Network(requirements.Network), ChannelBusy, payer, ""), nil
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
					value, err := f.submitRedemption(ctx, feePayer, requirements.Network, instructions, claimKey, payer)
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
	if len(payload.Channels) == 0 || len(payload.Channels) > MaxChannelsPerSettleTx {
		return nil, fmt.Errorf("%s: invalid channel batch", batchsettlement.ErrPayloadType)
	}
	seen := map[string]struct{}{}
	ids := make([]string, len(payload.Channels))
	for i, channel := range payload.Channels {
		if _, ok := seen[channel.ChannelID]; ok {
			return nil, fmt.Errorf("%s: invalid channel batch", batchsettlement.ErrPayloadType)
		}
		seen[channel.ChannelID] = struct{}{}
		ids[i] = channel.ChannelID
	}
	sort.Strings(ids)
	key := fmt.Sprintf("batch:distribute:%s:%s:%s:%s", requirements.Network, requirements.Asset, requirements.PayTo, strings.Join(ids, ","))
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
	response, err := f.distributeCurrent(ctx, payload, requirements, key)
	pass.response, pass.err = response, err
	close(pass.done)
	passes.mu.Lock()
	if passes.inflight[key] == pass {
		delete(passes.inflight, key)
	}
	passes.mu.Unlock()
	return response, err
}

func (f *BatchSvmScheme) distributeCurrent(ctx context.Context, payload batchsettlement.BatchSettlePayload, requirements types.PaymentRequirements, key string) (*x402.SettleResponse, error) {
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
	if pending, ok, err := f.pendingStore.Get(ctx, key); err != nil {
		return nil, err
	} else if ok {
		recovered, err := f.reconcileBroadcast(ctx, key, pending, requirements.Network, "")
		if err != nil || !recovered.OK {
			return recovered.Response, err
		}
		return f.finishDistribution(ctx, key, recovered.Signature, prepared, requirements)
	}
	previous, hasPrevious, err := f.pendingStore.Get(ctx, key+":result")
	if err != nil {
		return nil, err
	}
	if slotText, ok, err := f.pendingStore.Get(ctx, key+":slot"); err != nil {
		return nil, err
	} else if ok {
		slot, err := paymentchannels.ParseU64(slotText, "slot")
		if err != nil {
			return nil, err
		}
		f.rememberSlot(requirements.Network, slot)
	}
	var instructions []solana.Instruction
	var swept []PreparedDistribution
	for _, item := range prepared {
		var channel *generated.Channel
		var err error
		if hasPrevious {
			channel, err = f.readChannel(ctx, requirements.Network, item.ChannelID)
		} else {
			channel, err = f.fetchChannel(ctx, requirements.Network, item.ChannelID)
		}
		if err != nil {
			return nil, err
		}
		if channel == nil && hasPrevious {
			continue
		}
		if channel == nil {
			return nil, fmt.Errorf("%s", batchsettlement.ErrChannelState)
		}
		if err := f.assertClaimChannel(channel, item.ChannelConfig, item.Terms, requirements, []generated.ChannelStatus{
			generated.ChannelStatus_Open,
			generated.ChannelStatus_Sealed,
			generated.ChannelStatus_Distributed,
		}); err != nil {
			return nil, err
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
		if hasPrevious {
			var stored x402.SettleResponse
			if err := json.Unmarshal([]byte(previous), &stored); err != nil {
				return nil, err
			}
			return &stored, nil
		}
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
	_ = f.pendingStore.Delete(ctx, f.completedBroadcastKey(key))
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
			value, err := f.submitRedemption(ctx, feePayer, requirements.Network, instructions, key, "")
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
	response, err := f.attributeDistribution(ctx, key, signature, prepared, requirements)
	if err != nil {
		var ambiguous *PayoutAttributionAmbiguousError
		if errors.As(err, &ambiguous) {
			failed := SettleFailureWithTransaction(x402.Network(requirements.Network), batchsettlement.ErrPayoutAttributionAmbiguous, "", err.Error(), signature)
			encoded, marshalErr := json.Marshal(failed)
			if marshalErr != nil {
				return nil, marshalErr
			}
			if err := f.pendingStore.Set(ctx, key+":result", string(encoded)); err != nil {
				return nil, err
			}
			if err := f.completeBroadcast(ctx, key, signature, requirements.Network); err != nil {
				return SettlementPending(x402.Network(requirements.Network), "", signature, err.Error()), nil
			}
			return failed, nil
		}
		return SettlementPending(x402.Network(requirements.Network), "", signature, err.Error()), nil
	}
	return response, nil
}

func (f *BatchSvmScheme) attributeDistribution(ctx context.Context, key, signature string, prepared []PreparedDistribution, requirements types.PaymentRequirements) (*x402.SettleResponse, error) {
	cachedKey := "batch:transaction:" + requirements.Network + ":" + signature + ":result"
	if cached, ok, err := f.pendingStore.Get(ctx, cachedKey); err != nil {
		return nil, err
	} else if ok {
		var stored x402.SettleResponse
		if err := json.Unmarshal([]byte(cached), &stored); err != nil {
			return nil, err
		}
		if f.config.OnDistributionConfirmed != nil {
			if err := f.config.OnDistributionConfirmed(ctx, &stored, requirements); err != nil {
				return nil, err
			}
		}
		encoded, err := json.Marshal(stored)
		if err != nil {
			return nil, err
		}
		if err := f.pendingStore.Set(ctx, key+":result", string(encoded)); err != nil {
			return nil, err
		}
		if err := f.completeBroadcast(ctx, key, signature, requirements.Network); err != nil {
			return nil, err
		}
		return &stored, nil
	}
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
	if err := f.pendingStore.Set(ctx, key+":slot", strconv.FormatUint(evidence.Slot, 10)); err != nil {
		return nil, err
	}
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
			(item.ChannelConfig.Payer == requirements.PayTo || paymentchannels.TreasuryOwner(requirements.Network).String() == requirements.PayTo) {
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
	response := &x402.SettleResponse{
		Success:     true,
		Network:     x402.Network(requirements.Network),
		Transaction: signature,
		Amount:      strconv.FormatUint(post-pre, 10),
		Extra:       map[string]any{"channels": channelIDs(prepared)},
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		return nil, err
	}
	if err := f.pendingStore.Set(ctx, "batch:transaction:"+requirements.Network+":"+signature+":result", string(encoded)); err != nil {
		return nil, err
	}
	if f.config.OnDistributionConfirmed != nil {
		if err := f.config.OnDistributionConfirmed(ctx, response, requirements); err != nil {
			return nil, err
		}
	}
	if err := f.pendingStore.Set(ctx, key+":result", string(encoded)); err != nil {
		return nil, err
	}
	if err := f.completeBroadcast(ctx, key, signature, requirements.Network); err != nil {
		return nil, err
	}
	return response, nil
}

func (f *BatchSvmScheme) settleRefund(ctx context.Context, payload batchsettlement.BatchRefundPayload, requirements types.PaymentRequirements, facilitatorContext any) (*x402.SettleResponse, error) {
	deps := f.sealDependencies()
	limits := RefundLimits{
		MaxComputeUnits:             f.config.MaxComputeUnits,
		MaxPriorityFeeMicroLamports: f.config.MaxPriorityFeeMicroLamports,
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
	key := "batch:refund:" + requirements.Network + ":" + prepared.ChannelID + ":" + prepared.RequestClose
	payer := payload.ChannelConfig.Payer
	closed := []generated.ChannelStatus{generated.ChannelStatus_Closing, generated.ChannelStatus_Sealed, generated.ChannelStatus_Distributed}
	channel, signature, response, err := f.settleDurably(ctx, durableArgs{
		key:     key,
		network: requirements.Network,
		payer:   payer,
		onCompleted: func(signature string) (*x402.SettleResponse, error) {
			observed, matched, err := f.fetchChannelUntil(ctx, requirements.Network, prepared.ChannelID, func(channel *generated.Channel) bool {
				return channel == nil || statusIn(channel, closed)
			})
			if err != nil {
				return nil, err
			}
			if matched && observed != nil {
				if err := f.assertClaimChannel(observed, payload.ChannelConfig, prepared.Terms, requirements, closed); err != nil {
					return nil, err
				}
				return RefundResponse(prepared.ChannelID, observed, x402.Network(requirements.Network), signature), nil
			}
			return RecoveredRefundResponse(prepared.ChannelID, payer, x402.Network(requirements.Network), signature), nil
		},
		beforeSend: func() (*x402.SettleResponse, error) {
			channel, err := f.fetchChannel(ctx, requirements.Network, prepared.ChannelID)
			if err != nil {
				return nil, err
			}
			if err := f.assertClaimChannel(channel, payload.ChannelConfig, prepared.Terms, requirements, []generated.ChannelStatus{generated.ChannelStatus_Open, generated.ChannelStatus_Closing}); err != nil {
				return nil, err
			}
			if generated.ChannelStatus(channel.Status) == generated.ChannelStatus_Closing {
				return RefundResponse(prepared.ChannelID, channel, x402.Network(requirements.Network), ""), nil
			}
			if f.settlementCache.IsDuplicate(key) {
				return SettleFailure(x402.Network(requirements.Network), ChannelBusy, channel.Payer.String(), ""), nil
			}
			return nil, nil
		},
		send: func(onPrepared func(string, string) error) (string, error) {
			tx, err := svm.DecodeTransaction(prepared.RequestClose)
			if err != nil {
				f.settlementCache.Delete(key)
				return "", err
			}
			if err := f.signer.SimulateTransaction(ctx, tx, requirements.Network, nil); err != nil {
				f.settlementCache.Delete(key)
				return "", err
			}
			feePayer, err := solana.PublicKeyFromBase58(prepared.Terms.FeePayer)
			if err != nil {
				return "", err
			}
			signature, err := paymentchannels.BroadcastOpen(ctx, f.signer, feePayer, requirements.Network, prepared.RequestClose, paymentchannels.ChannelBroadcastHooks{OnPrepared: onPrepared})
			if err != nil {
				if _, found := PendingSignatureOf(err); !found {
					f.settlementCache.Delete(key)
				}
				return "", err
			}
			return signature, nil
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

func (f *BatchSvmScheme) assertSettlementAccounts(ctx context.Context, requirements types.PaymentRequirements, payer, tokenProgram string) error {
	mint, err := solana.PublicKeyFromBase58(requirements.Asset)
	if err != nil {
		return err
	}
	program, err := solana.PublicKeyFromBase58(tokenProgram)
	if err != nil {
		return err
	}
	owners := []struct {
		label string
		owner solana.PublicKey
	}{}
	for _, item := range []struct {
		label string
		value string
	}{
		{"payer", payer},
		{"recipient", requirements.PayTo},
		{"payment-channel treasury", paymentchannels.TreasuryOwner(requirements.Network).String()},
	} {
		owner, err := solana.PublicKeyFromBase58(item.value)
		if err != nil {
			return err
		}
		owners = append(owners, struct {
			label string
			owner solana.PublicKey
		}{item.label, owner})
	}
	for _, item := range owners {
		ata, err := paymentchannels.FindATA(item.owner, mint, program)
		if err != nil {
			return err
		}
		account, err := f.signer.GetAccountInfo(ctx, ata, requirements.Network, &rpc.GetAccountInfoOpts{
			Encoding:   solana.EncodingBase64,
			Commitment: paymentchannels.StateCommitment,
		})
		if err != nil || account == nil || account.Value == nil {
			return fmt.Errorf("%s: missing %s ATA: %s", batchsettlement.ErrSettlementSimulation, item.label, ata)
		}
		if account.Value.Owner.String() != tokenProgram {
			return fmt.Errorf("%s: %s ATA is not owned by %s: %s", batchsettlement.ErrSettlementSimulation, item.label, tokenProgram, ata)
		}
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

func passesFor(store PendingSettlementStore) *passRegistry {
	value, _ := distributionPasses.LoadOrStore(store, &passRegistry{inflight: map[string]*distributionPass{}})
	return value.(*passRegistry)
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
