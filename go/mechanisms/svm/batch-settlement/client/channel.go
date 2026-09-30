package client

import (
	"context"
	"fmt"

	solana "github.com/gagliardetto/solana-go"
	"github.com/google/uuid"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
)

const maxSafeInteger uint64 = 1<<53 - 1

// SignBatchVoucher signs the canonical voucher message.
func SignBatchVoucher(
	ctx context.Context,
	signer BatchClientSigner,
	channelID string,
	maxClaimableAmount uint64,
	expiresAt int64,
) (batchsettlement.BatchVoucher, error) {
	channel, err := solana.PublicKeyFromBase58(channelID)
	if err != nil {
		return batchsettlement.BatchVoucher{}, fmt.Errorf("payer authorizer did not return a voucher signature")
	}
	signature, err := paymentchannels.SignVoucher(ctx, signer, channel, maxClaimableAmount, expiresAt)
	if err != nil {
		return batchsettlement.BatchVoucher{}, fmt.Errorf("payer authorizer did not return a voucher signature")
	}
	return batchsettlement.BatchVoucher{
		ChannelID:          channelID,
		MaxClaimableAmount: batchsettlement.FormatU64(maxClaimableAmount),
		ExpiresAt:          expiresAt,
		Signature:          signature,
	}, nil
}

// BatchChannelTracker is the client's view of one channel's charged cumulative.
type BatchChannelTracker struct {
	ChannelID     string
	ChannelConfig batchsettlement.BatchChannelConfig
	signer        BatchClientSigner
	cumulative    uint64
}

// NewBatchChannelTracker starts a tracker at initialCumulative.
func NewBatchChannelTracker(
	channelID string,
	config batchsettlement.BatchChannelConfig,
	signer BatchClientSigner,
	initialCumulative uint64,
) *BatchChannelTracker {
	return &BatchChannelTracker{
		ChannelID:     channelID,
		ChannelConfig: config,
		signer:        signer,
		cumulative:    initialCumulative,
	}
}

// Cumulative is the confirmed charged amount.
func (t *BatchChannelTracker) Cumulative() uint64 { return t.cumulative }

// PreviewVoucher signs the next voucher without committing it.
func (t *BatchChannelTracker) PreviewVoucher(ctx context.Context, charge uint64) (batchsettlement.BatchVoucher, error) {
	if charge == 0 {
		return batchsettlement.BatchVoucher{}, fmt.Errorf("charge must be positive")
	}
	if t.ChannelConfig.VoucherSigner == batchsettlement.VoucherSignerServer {
		return batchsettlement.BatchVoucher{}, fmt.Errorf("server-signed channels do not use client vouchers")
	}
	next, err := batchsettlement.AddU64Checked(t.cumulative, charge)
	if err != nil {
		return batchsettlement.BatchVoucher{}, err
	}
	return SignBatchVoucher(ctx, t.signer, t.ChannelID, next, batchsettlement.ClientVoucherExpiresAt)
}

// Authorization signs an expiring payer proof for a server-signed channel.
func (t *BatchChannelTracker) Authorization(
	ctx context.Context,
	requestID string,
	authorizedAmount uint64,
	expiresAt int64,
) (batchsettlement.BatchAuthorization, error) {
	if t.ChannelConfig.VoucherSigner != batchsettlement.VoucherSignerServer {
		return batchsettlement.BatchAuthorization{}, fmt.Errorf("client-signed channels do not use server authorization")
	}
	return batchsettlement.SignBatchAuthorization(
		ctx, t.signer, t.ChannelID, t.ChannelConfig.PayerAuthorizer, requestID, authorizedAmount, expiresAt,
	)
}

// Commit records a cumulative amount confirmed by the resource server.
func (t *BatchChannelTracker) Commit(cumulative uint64) error {
	if cumulative < t.cumulative {
		return fmt.Errorf("confirmed cumulative amount cannot move backwards")
	}
	t.cumulative = cumulative
	return nil
}

// Voucher signs and commits the next charge.
func (t *BatchChannelTracker) Voucher(ctx context.Context, charge uint64) (batchsettlement.BatchVoucher, error) {
	voucher, err := t.PreviewVoucher(ctx, charge)
	if err != nil {
		return batchsettlement.BatchVoucher{}, err
	}
	if err := t.Commit(t.cumulative + charge); err != nil {
		return batchsettlement.BatchVoucher{}, err
	}
	return voucher, nil
}

// RefundVoucher signs a client-mode voucher at the confirmed cumulative amount.
func (t *BatchChannelTracker) RefundVoucher(ctx context.Context) (batchsettlement.BatchVoucher, error) {
	if t.ChannelConfig.VoucherSigner == batchsettlement.VoucherSignerServer {
		return batchsettlement.BatchVoucher{}, fmt.Errorf("server-signed channels refund with payer authorization")
	}
	return SignBatchVoucher(ctx, t.signer, t.ChannelID, t.cumulative, batchsettlement.ClientVoucherExpiresAt)
}

type credentialMode string

const (
	credentialClient credentialMode = "client"
	credentialServer credentialMode = "server"
)

type signedCredential struct {
	voucher       *batchsettlement.BatchVoucher
	authorization *batchsettlement.BatchAuthorization
}

func credentialFor(
	ctx context.Context,
	mode credentialMode,
	tracker *BatchChannelTracker,
	charge uint64,
	authorization *struct {
		requestID string
		expiresAt int64
	},
	refund bool,
) (signedCredential, error) {
	switch mode {
	case credentialClient:
		if refund {
			voucher, err := tracker.RefundVoucher(ctx)
			if err != nil {
				return signedCredential{}, err
			}
			return signedCredential{voucher: &voucher}, nil
		}
		voucher, err := tracker.PreviewVoucher(ctx, charge)
		if err != nil {
			return signedCredential{}, err
		}
		return signedCredential{voucher: &voucher}, nil
	case credentialServer:
		if authorization == nil {
			return signedCredential{}, fmt.Errorf("authorizationExpiresAt is required for operator voucher signing")
		}
		proof, err := tracker.Authorization(ctx, authorization.requestID, charge, authorization.expiresAt)
		if err != nil {
			return signedCredential{}, err
		}
		return signedCredential{authorization: &proof}, nil
	default:
		unexpected := mode
		return signedCredential{}, fmt.Errorf("%s", string(unexpected))
	}
}

// BuildDepositArgs are the inputs for a first deposit payload.
type BuildDepositArgs struct {
	Payer                  BatchClientSigner
	Receiver               string
	ReceiverAuthorizer     string
	Mint                   string
	FeePayer               string
	TokenProgram           string
	Blockhash              solana.Hash
	OpenSlot               uint64
	DepositAmount          uint64
	FirstCharge            uint64
	WithdrawDelay          int
	Memo                   *string
	Salt                   *uint64
	VoucherSigner          string
	Operator               string
	AuthorizationExpiresAt *int64
}

// BuiltDeposit is a signed deposit payload and the tracker that produced it.
type BuiltDeposit struct {
	ChannelID string
	Payload   batchsettlement.BatchDepositPayload
	Tracker   *BatchChannelTracker
}

// BuildDepositPayload builds and signs the opening deposit.
func BuildDepositPayload(ctx context.Context, args BuildDepositArgs) (*BuiltDeposit, error) {
	if args.FirstCharge == 0 || args.FirstCharge > args.DepositAmount {
		return nil, fmt.Errorf("first charge must be positive and no greater than the deposit")
	}
	if args.OpenSlot > maxSafeInteger {
		return nil, fmt.Errorf("openSlot must fit in a JavaScript safe integer")
	}
	voucherSigner := args.VoucherSigner
	if voucherSigner == "" {
		voucherSigner = batchsettlement.VoucherSignerClient
	}
	authorizedSigner := args.Payer.Address().String()
	if voucherSigner == batchsettlement.VoucherSignerServer {
		authorizedSigner = args.Operator
	}
	if authorizedSigner == "" {
		return nil, fmt.Errorf("operator is required for operator voucher signing")
	}
	var pendingAuth *struct {
		requestID string
		expiresAt int64
	}
	if voucherSigner == batchsettlement.VoucherSignerServer {
		if args.AuthorizationExpiresAt == nil || *args.AuthorizationExpiresAt <= 0 || uint64(*args.AuthorizationExpiresAt) > maxSafeInteger {
			return nil, fmt.Errorf("authorizationExpiresAt is required for operator voucher signing")
		}
		pendingAuth = &struct {
			requestID string
			expiresAt int64
		}{requestID: uuid.NewString(), expiresAt: *args.AuthorizationExpiresAt}
	}
	feePayer, err := solana.PublicKeyFromBase58(args.FeePayer)
	if err != nil {
		return nil, err
	}
	mint, err := solana.PublicKeyFromBase58(args.Mint)
	if err != nil {
		return nil, err
	}
	tokenProgram, err := solana.PublicKeyFromBase58(args.TokenProgram)
	if err != nil {
		return nil, err
	}
	authorizer, err := solana.PublicKeyFromBase58(authorizedSigner)
	if err != nil {
		return nil, err
	}
	binding := batchsettlement.EncodeReceiverBindingMemo(args.ReceiverAuthorizer)
	open, err := paymentchannels.BuildOpenTransaction(paymentchannels.BuildOpenArgs{
		Payer:            args.Payer.Address(),
		Payee:            feePayer,
		Mint:             mint,
		AuthorizedSigner: authorizer,
		FeePayer:         feePayer,
		TokenProgram:     tokenProgram,
		Deposit:          args.DepositAmount,
		Blockhash:        args.Blockhash,
		OpenSlot:         args.OpenSlot,
		GracePeriod:      uint32(args.WithdrawDelay),
		Recipients:       []paymentchannels.Split{{Recipient: args.Receiver, BPS: batchsettlement.FullSplitBPS}},
		Salt:             args.Salt,
		Memo:             args.Memo,
		BindingMemo:      &binding,
	})
	if err != nil {
		return nil, err
	}
	if err := args.Payer.SignTransaction(ctx, open.Transaction); err != nil {
		return nil, err
	}
	encoded, err := svm.EncodeTransaction(open.Transaction)
	if err != nil {
		return nil, err
	}
	config := batchsettlement.BatchChannelConfig{
		Payer:              args.Payer.Address().String(),
		PayerAuthorizer:    authorizedSigner,
		Receiver:           args.Receiver,
		ReceiverAuthorizer: args.ReceiverAuthorizer,
		Token:              args.Mint,
		WithdrawDelay:      args.WithdrawDelay,
		Salt:               batchsettlement.FormatU64(open.Salt),
		OpenSlot:           int64(open.OpenSlot),
	}
	if voucherSigner == batchsettlement.VoucherSignerServer {
		config.VoucherSigner = voucherSigner
	}
	tracker := NewBatchChannelTracker(open.ChannelID.String(), config, args.Payer, 0)
	mode := credentialClient
	if pendingAuth != nil {
		mode = credentialServer
	}
	credential, err := credentialFor(ctx, mode, tracker, args.FirstCharge, pendingAuth, false)
	if err != nil {
		return nil, err
	}
	payload := batchsettlement.BatchDepositPayload{
		Type:          batchsettlement.PayloadTypeDeposit,
		ChannelConfig: config,
		Voucher:       credential.voucher,
		Authorization: credential.authorization,
		Deposit: batchsettlement.BatchDeposit{
			Amount:      batchsettlement.FormatU64(args.DepositAmount),
			Transaction: encoded,
		},
	}
	return &BuiltDeposit{ChannelID: open.ChannelID.String(), Payload: payload, Tracker: tracker}, nil
}

// BuildRefundArgs are the inputs for a refund payload.
type BuildRefundArgs struct {
	Payer         BatchClientSigner
	FeePayer      string
	ChannelID     string
	ChannelConfig batchsettlement.BatchChannelConfig
	Voucher       *batchsettlement.BatchVoucher
	Authorization *batchsettlement.BatchAuthorization
	Blockhash     *solana.Hash
	Memo          *string
}

// BuildRefundPayload builds a cooperative close, optionally with a payer-signed request_close.
func BuildRefundPayload(ctx context.Context, args BuildRefundArgs) (batchsettlement.BatchRefundPayload, error) {
	serverMode := args.ChannelConfig.VoucherSigner == batchsettlement.VoucherSignerServer
	payload := batchsettlement.BatchRefundPayload{
		Type:          batchsettlement.PayloadTypeRefund,
		ChannelConfig: args.ChannelConfig,
	}
	if serverMode {
		if args.Authorization == nil || args.Voucher != nil {
			return batchsettlement.BatchRefundPayload{}, fmt.Errorf("server-signed refund requires payer authorization only")
		}
		payload.Authorization = args.Authorization
	} else {
		if args.Voucher == nil || args.Authorization != nil {
			return batchsettlement.BatchRefundPayload{}, fmt.Errorf("client-signed refund requires a voucher")
		}
		payload.Voucher = args.Voucher
	}
	if args.Blockhash == nil {
		return payload, nil
	}
	feePayer, err := solana.PublicKeyFromBase58(args.FeePayer)
	if err != nil {
		return batchsettlement.BatchRefundPayload{}, err
	}
	channelID, err := solana.PublicKeyFromBase58(args.ChannelID)
	if err != nil {
		return batchsettlement.BatchRefundPayload{}, err
	}
	tx, err := paymentchannels.BuildRequestCloseTransaction(paymentchannels.BuildRequestCloseArgs{
		Payer:     args.Payer.Address(),
		FeePayer:  feePayer,
		ChannelID: channelID,
		Blockhash: *args.Blockhash,
		Memo:      args.Memo,
	})
	if err != nil {
		return batchsettlement.BatchRefundPayload{}, err
	}
	if err := args.Payer.SignTransaction(ctx, tx); err != nil {
		return batchsettlement.BatchRefundPayload{}, err
	}
	encoded, err := svm.EncodeTransaction(tx)
	if err != nil {
		return batchsettlement.BatchRefundPayload{}, err
	}
	payload.Transaction = encoded
	return payload, nil
}
