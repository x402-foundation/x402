package hedera

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"

	hiero "github.com/hiero-ledger/hiero-sdk-go/v2/sdk"
	"github.com/x402-foundation/x402/go/v2/types"
)

type operatorKey struct {
	id  hiero.AccountID
	key hiero.PrivateKey
}

// PrivateKeyFacilitatorSigner is the default FacilitatorHederaSigner implementation.
type PrivateKeyFacilitatorSigner struct {
	operators     []operatorKey
	mirrorNodeURL string
	http          *mirrorHTTP
	newClient     func(network string) (*hiero.Client, error)
}

func (s *PrivateKeyFacilitatorSigner) sdkClient(network string) (*hiero.Client, error) {
	if s.newClient != nil {
		return s.newClient(network)
	}
	return newSDKClient(network)
}

// NewPrivateKeyFacilitatorSigner builds a facilitator signer from operator credentials.
func NewPrivateKeyFacilitatorSigner(cfg SignerConfig) (*PrivateKeyFacilitatorSigner, error) {
	if len(cfg.Operators) == 0 {
		return nil, fmt.Errorf("at least one operator credential is required")
	}
	ops := make([]operatorKey, 0, len(cfg.Operators))
	for _, op := range cfg.Operators {
		id, err := hiero.AccountIDFromString(op.AccountID)
		if err != nil {
			return nil, fmt.Errorf("operator account id %q: %w", op.AccountID, err)
		}
		key, err := ParsePrivateKey(op.PrivateKey)
		if err != nil {
			return nil, fmt.Errorf("operator key for %s: %w", op.AccountID, err)
		}
		ops = append(ops, operatorKey{id: id, key: key})
	}
	return &PrivateKeyFacilitatorSigner{
		operators:     ops,
		mirrorNodeURL: cfg.MirrorNodeURL,
		http:          newMirrorHTTP(),
	}, nil
}

var _ FacilitatorHederaSigner = (*PrivateKeyFacilitatorSigner)(nil)

func (s *PrivateKeyFacilitatorSigner) GetAddresses(_ context.Context, _ string) []string {
	out := make([]string, len(s.operators))
	for i, op := range s.operators {
		out[i] = op.id.String()
	}
	return out
}

func (s *PrivateKeyFacilitatorSigner) findOperator(feePayer string) (*operatorKey, error) {
	for i := range s.operators {
		if accountIDsEqual(s.operators[i].id.String(), feePayer) {
			return &s.operators[i], nil
		}
	}
	return nil, fmt.Errorf("fee_payer_not_managed_by_facilitator")
}

func (s *PrivateKeyFacilitatorSigner) SignAndSubmitTransaction(
	ctx context.Context,
	transactionBase64, feePayer, network string,
) (string, error) {
	if err := AssertSupportedNetwork(network); err != nil {
		return "", err
	}
	op, err := s.findOperator(feePayer)
	if err != nil {
		return "", err
	}
	raw, err := base64.StdEncoding.DecodeString(transactionBase64)
	if err != nil {
		return "", err
	}
	txIface, err := hiero.TransactionFromBytes(raw)
	if err != nil {
		return "", err
	}
	if _, ok := asTransferTransaction(txIface); !ok {
		return "", fmt.Errorf("expected TransferTransaction")
	}

	signed, txID, err := addOperatorSignatures(raw, op.key)
	if err != nil {
		return "", err
	}
	if txID.AccountID == nil || txID.ValidStart == nil {
		return "", fmt.Errorf("missing transaction id in payload")
	}
	txIDString := txID.String()
	if err := s.submitSignedTransfers(ctx, network, signed); err != nil {
		var unknown *submissionOutcomeUnknownError
		if errors.As(err, &unknown) {
			return txIDString, &TransactionSubmittedError{
				TransactionID:  txIDString,
				OutcomeUnknown: true,
				Err:            err,
			}
		}
		return "", err
	}
	if err := s.waitSuccess(ctx, network, *op, txID); err != nil {
		return txIDString, receiptError(txIDString, err)
	}
	return txIDString, nil
}

func (s *PrivateKeyFacilitatorSigner) AwaitTransaction(ctx context.Context, transactionID, network string) error {
	if err := AssertSupportedNetwork(network); err != nil {
		return err
	}
	txID, err := hiero.TransactionIdFromString(transactionID)
	if err != nil {
		return err
	}
	if txID.AccountID == nil {
		return fmt.Errorf("missing transaction id account")
	}
	op, err := s.findOperator(txID.AccountID.String())
	if err != nil {
		return err
	}
	if result, err := s.mirrorTransactionResult(ctx, network, txID); err == nil && result != "" {
		if result != "SUCCESS" {
			return receiptError(transactionID, &mirrorFailureError{result: result})
		}
		return nil
	}
	if err := s.waitSuccess(ctx, network, *op, txID); err != nil {
		return receiptError(transactionID, err)
	}
	return nil
}

type mirrorTransactionsResponse struct {
	Transactions []struct {
		Result    string `json:"result"`
		Nonce     int    `json:"nonce"`
		Scheduled bool   `json:"scheduled"`
	} `json:"transactions"`
}

// mirrorFailureError is a definitive non-success consensus result read from the Mirror Node.
type mirrorFailureError struct {
	result string
}

func (e *mirrorFailureError) Error() string {
	return "transaction reached consensus with status " + e.result
}

// mirrorTransactionResult reads the consensus result of txID from the Mirror Node, which
// retains it after consensus nodes drop receipts (about 3 minutes). It returns "" when the
// Mirror Node has no record of the submitted transaction yet.
func (s *PrivateKeyFacilitatorSigner) mirrorTransactionResult(ctx context.Context, network string, txID hiero.TransactionID) (string, error) {
	base, err := mirrorURLForNetwork(network, s.mirrorNodeURL)
	if err != nil {
		return "", err
	}
	if txID.AccountID == nil || txID.ValidStart == nil {
		return "", fmt.Errorf("incomplete transaction id")
	}
	id := fmt.Sprintf("%s-%d-%09d", txID.AccountID.String(), txID.ValidStart.Unix(), txID.ValidStart.Nanosecond())
	var resp mirrorTransactionsResponse
	if err := s.http.getJSON(ctx, base+"/api/v1/transactions/"+id, &resp); err != nil {
		return "", err
	}
	result := ""
	for _, tx := range resp.Transactions {
		// Child, scheduled, and duplicate records do not describe the submitted transaction.
		if tx.Nonce != 0 || tx.Scheduled || tx.Result == "" || tx.Result == "DUPLICATE_TRANSACTION" {
			continue
		}
		if tx.Result == "SUCCESS" {
			return tx.Result, nil
		}
		result = tx.Result
	}
	return result, nil
}

// receiptError treats only a definitive non-success consensus status as terminal.
func receiptError(transactionID string, err error) *TransactionSubmittedError {
	var status hiero.ErrHederaReceiptStatus
	var mirrorFailure *mirrorFailureError
	terminal := (errors.As(err, &status) && status.Status != hiero.StatusUnknown) || errors.As(err, &mirrorFailure)
	return &TransactionSubmittedError{
		TransactionID:  transactionID,
		OutcomeUnknown: !terminal,
		Err:            err,
	}
}

func (s *PrivateKeyFacilitatorSigner) VerifyPayerSignature(
	ctx context.Context,
	payer, transactionBase64, network string,
) SignatureCheck {
	if err := AssertSupportedNetwork(network); err != nil {
		return SignatureCheck{Reason: "network_mismatch", Message: err.Error()}
	}
	raw, err := base64.StdEncoding.DecodeString(transactionBase64)
	if err != nil {
		return SignatureCheck{Reason: "signature_invalid", Message: err.Error()}
	}
	txIface, err := hiero.TransactionFromBytes(raw)
	if err != nil {
		return SignatureCheck{Reason: "signature_invalid", Message: err.Error()}
	}

	base, err := mirrorURLForNetwork(network, s.mirrorNodeURL)
	if err != nil {
		return SignatureCheck{Reason: "signature_unverifiable", Message: err.Error()}
	}
	key, check := resolvePayerKeyFromMirror(ctx, s.http, base, payer)
	if check != nil {
		return *check
	}
	if !keySignsTransaction(key, txIface) {
		return SignatureCheck{
			Reason:  "signature_invalid",
			Message: fmt.Sprintf("payer %s did not sign the transaction", payer),
		}
	}
	return SignatureCheck{OK: true}
}

func keySignsTransaction(key hiero.Key, tx hiero.TransactionInterface) bool {
	switch k := key.(type) {
	case hiero.PublicKey:
		return k.VerifyTransaction(tx)
	case *hiero.PublicKey:
		if k == nil {
			return false
		}
		return k.VerifyTransaction(tx)
	case hiero.KeyList:
		return keyListSigns(k, tx)
	case *hiero.KeyList:
		if k == nil {
			return false
		}
		return keyListSigns(*k, tx)
	default:
		return false
	}
}

func keyListSigns(list hiero.KeyList, tx hiero.TransactionInterface) bool {
	keys := list.GetKeys()
	threshold := list.GetThreshold()
	if threshold <= 0 {
		threshold = len(keys)
	}
	matched := 0
	for _, key := range keys {
		if keySignsTransaction(key, tx) {
			matched++
		}
	}
	return matched >= threshold
}

func (s *PrivateKeyFacilitatorSigner) PreflightTransfer(
	ctx context.Context,
	payer, payTo, asset, amount, network string,
) SignatureCheck {
	base, err := mirrorURLForNetwork(network, s.mirrorNodeURL)
	if err != nil {
		return SignatureCheck{Reason: "preflight_failed", Message: err.Error()}
	}
	return preflightTransfer(ctx, s.http, base, payer, payTo, asset, amount)
}

func (s *PrivateKeyFacilitatorSigner) ResolveAccount(
	ctx context.Context,
	accountIDOrAlias, network string,
) (AccountResolution, error) {
	base, err := mirrorURLForNetwork(network, s.mirrorNodeURL)
	if err != nil {
		return AccountResolution{}, err
	}
	return resolveAccountMirror(ctx, s.http, base, accountIDOrAlias)
}

func (s *PrivateKeyFacilitatorSigner) waitSuccess(
	ctx context.Context,
	network string,
	op operatorKey,
	txID hiero.TransactionID,
) error {
	sdkClient, err := s.sdkClient(network)
	if err != nil {
		return err
	}
	defer sdkClient.Close()
	sdkClient.SetOperator(op.id, op.key)

	type result struct {
		receipt hiero.TransactionReceipt
		err     error
	}
	done := make(chan result, 1)
	go func() {
		receipt, execErr := hiero.NewTransactionReceiptQuery().
			SetTransactionID(txID).
			Execute(sdkClient)
		done <- result{receipt: receipt, err: execErr}
	}()

	select {
	case <-ctx.Done():
		return ctx.Err()
	case res := <-done:
		if res.err != nil {
			return res.err
		}
		return res.receipt.ValidateStatus(true)
	}
}

// privateKeyClientSigner implements ClientHederaSigner.
type privateKeyClientSigner struct {
	accountID hiero.AccountID
	key       hiero.PrivateKey
	network   string
	cfg       *ClientConfig
}

// maxClientTransactionNodes keeps partially signed transactions small enough
// for HTTP payment headers while retaining alternate-node submission fallback.
const maxClientTransactionNodes = 3

// NewPrivateKeyClientSigner builds a ClientHederaSigner from account id + private key.
func NewPrivateKeyClientSigner(accountID, privateKey, network string, cfg ...*ClientConfig) (ClientHederaSigner, error) {
	if err := AssertSupportedNetwork(network); err != nil {
		return nil, err
	}
	id, err := hiero.AccountIDFromString(accountID)
	if err != nil {
		return nil, fmt.Errorf("account id: %w", err)
	}
	key, err := ParsePrivateKey(privateKey)
	if err != nil {
		return nil, fmt.Errorf("private key: %w", err)
	}
	var c *ClientConfig
	if len(cfg) > 0 {
		c = cfg[0]
	}
	return &privateKeyClientSigner{accountID: id, key: key, network: network, cfg: c}, nil
}

func (c *privateKeyClientSigner) AccountID() string {
	return c.accountID.String()
}

func (c *privateKeyClientSigner) CreatePartiallySignedTransferTransaction(
	ctx context.Context,
	requirements types.PaymentRequirements,
) (string, error) {
	_ = ctx
	if err := AssertSupportedNetwork(string(requirements.Network)); err != nil {
		return "", err
	}
	feePayer, ok := requirements.Extra["feePayer"].(string)
	if !ok || feePayer == "" {
		return "", fmt.Errorf("feePayer is required in paymentRequirements.extra")
	}
	amt, err := ParsePositiveAmount(requirements.Amount)
	if err != nil {
		return "", err
	}
	if !amt.IsInt64() {
		return "", fmt.Errorf("amount exceeds int64 range supported by Hedera TransferTransaction")
	}
	amtInt := amt.Int64()

	payTo, err := hiero.AccountIDFromString(requirements.PayTo)
	if err != nil {
		return "", fmt.Errorf("payTo: %w", err)
	}
	feePayerID, err := hiero.AccountIDFromString(feePayer)
	if err != nil {
		return "", fmt.Errorf("feePayer: %w", err)
	}

	tx := hiero.NewTransferTransaction()
	if IsHbarAsset(requirements.Asset) {
		tx.AddHbarTransfer(c.accountID, hiero.HbarFromTinybar(-amtInt))
		tx.AddHbarTransfer(payTo, hiero.HbarFromTinybar(amtInt))
	} else {
		tokenID, err := hiero.TokenIDFromString(requirements.Asset)
		if err != nil {
			return "", fmt.Errorf("asset: %w", err)
		}
		tx.AddTokenTransfer(tokenID, c.accountID, -amtInt)
		tx.AddTokenTransfer(tokenID, payTo, amtInt)
	}
	tx.SetTransactionID(hiero.TransactionIDGenerate(feePayerID))

	client, err := newSDKClient(string(requirements.Network))
	if err != nil {
		return "", err
	}
	defer client.Close()
	client.SetMaxNodesPerTransaction(maxClientTransactionNodes)

	frozen, err := tx.FreezeWith(client)
	if err != nil {
		return "", err
	}
	signed := frozen.Sign(c.key)
	bytes, err := signed.ToBytes()
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(bytes), nil
}
