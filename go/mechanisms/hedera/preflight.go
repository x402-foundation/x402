package hedera

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"time"

	hiero "github.com/hiero-ledger/hiero-sdk-go/v2/sdk"
)

type mirrorAccount struct {
	Balance struct {
		Balance int64 `json:"balance"`
	} `json:"balance"`
	MaxAutomaticTokenAssociations int               `json:"max_automatic_token_associations"`
	ReceiverSigRequired           bool              `json:"receiver_sig_required"`
	Key                           *mirrorAccountKey `json:"key"`
}

type mirrorAccountKey struct {
	Type string `json:"_type"`
	Key  string `json:"key"`
}

type mirrorTokenRelationship struct {
	TokenID              string `json:"token_id"`
	Balance              int64  `json:"balance"`
	AutomaticAssociation bool   `json:"automatic_association"`
	FreezeStatus         string `json:"freeze_status"`
	KYCStatus            string `json:"kyc_status"`
}

type mirrorToken struct {
	Type          string            `json:"type"`
	Deleted       bool              `json:"deleted"`
	PauseStatus   string            `json:"pause_status"`
	FreezeDefault bool              `json:"freeze_default"`
	KYCKey        *mirrorAccountKey `json:"kyc_key"`
	CustomFees    struct {
		FixedFees      []json.RawMessage `json:"fixed_fees"`
		FractionalFees []json.RawMessage `json:"fractional_fees"`
		RoyaltyFees    []json.RawMessage `json:"royalty_fees"`
	} `json:"custom_fees"`
}

type mirrorTokensResponse struct {
	Tokens []mirrorTokenRelationship `json:"tokens"`
	Links  struct {
		Next *string `json:"next"`
	} `json:"links"`
}

type mirrorHTTP struct {
	client *http.Client
}

func newMirrorHTTP() *mirrorHTTP {
	return &mirrorHTTP{client: &http.Client{Timeout: 30 * time.Second}}
}

func (m *mirrorHTTP) getJSON(ctx context.Context, url string, out interface{}) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := m.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return fmt.Errorf("mirror node request failed with status %d: %s", resp.StatusCode, strings.TrimSpace(string(data)))
	}
	if out != nil && len(data) > 0 {
		return json.Unmarshal(data, out)
	}
	return nil
}

func resolvePayerKeyFromMirror(
	ctx context.Context,
	httpClient *mirrorHTTP,
	mirrorBase, payer string,
) (hiero.Key, *SignatureCheck) {
	var account mirrorAccount
	url := fmt.Sprintf("%s/api/v1/accounts/%s", mirrorBase, payer)
	if err := httpClient.getJSON(ctx, url, &account); err != nil {
		return nil, &SignatureCheck{Reason: "signature_unverifiable", Message: err.Error()}
	}
	key, err := parseMirrorAccountKey(account.Key)
	if err != nil {
		return nil, &SignatureCheck{Reason: "signature_unverifiable", Message: err.Error()}
	}
	if key == nil {
		return nil, &SignatureCheck{Reason: "signature_invalid", Message: "could not resolve payer key"}
	}
	return key, nil
}

func parseMirrorAccountKey(mirrorKey *mirrorAccountKey) (hiero.Key, error) {
	if mirrorKey == nil || strings.TrimSpace(mirrorKey.Key) == "" {
		return nil, nil
	}
	switch mirrorKey.Type {
	case "ED25519":
		return hiero.PublicKeyFromStringEd25519(mirrorKey.Key)
	case "ECDSA_SECP256K1":
		return hiero.PublicKeyFromStringECDSA(mirrorKey.Key)
	case "ProtobufEncoded":
		raw, err := hex.DecodeString(mirrorKey.Key)
		if err != nil {
			return nil, fmt.Errorf("decode protobuf-encoded key: %w", err)
		}
		return hiero.KeyFromBytes(raw)
	default:
		return nil, nil
	}
}

func preflightTransfer(
	ctx context.Context,
	httpClient *mirrorHTTP,
	mirrorBase, payer, payTo, asset, amount string,
) SignatureCheck {
	required, ok := new(big.Int).SetString(amount, 10)
	if !ok {
		return SignatureCheck{Reason: "invalid_amount", Message: "invalid amount"}
	}

	var payToAccount mirrorAccount
	if err := httpClient.getJSON(ctx, fmt.Sprintf("%s/api/v1/accounts/%s", mirrorBase, payTo), &payToAccount); err != nil {
		return SignatureCheck{Reason: "preflight_failed", Message: err.Error()}
	}
	if payToAccount.ReceiverSigRequired {
		return SignatureCheck{
			Reason:  "receiver_signature_required",
			Message: fmt.Sprintf("payTo %s requires a receiver signature", payTo),
		}
	}

	if IsHbarAsset(asset) {
		var account mirrorAccount
		if err := httpClient.getJSON(ctx, fmt.Sprintf("%s/api/v1/accounts/%s", mirrorBase, payer), &account); err != nil {
			return SignatureCheck{Reason: "preflight_failed", Message: err.Error()}
		}
		held := big.NewInt(account.Balance.Balance)
		if held.Cmp(required) < 0 {
			return SignatureCheck{
				Reason:  "insufficient_balance",
				Message: fmt.Sprintf("payer has %s tinybars, needs %s", held.String(), required.String()),
			}
		}
		return SignatureCheck{OK: true}
	}

	var token mirrorToken
	if err := httpClient.getJSON(ctx, fmt.Sprintf("%s/api/v1/tokens/%s", mirrorBase, asset), &token); err != nil {
		return SignatureCheck{Reason: "preflight_failed", Message: err.Error()}
	}
	if failure := tokenFailure(token, asset); failure != nil {
		return *failure
	}

	var payerTokens mirrorTokensResponse
	url := fmt.Sprintf("%s/api/v1/accounts/%s/tokens?token.id=%s", mirrorBase, payer, asset)
	if err := httpClient.getJSON(ctx, url, &payerTokens); err != nil {
		return SignatureCheck{Reason: "preflight_failed", Message: err.Error()}
	}
	held := big.NewInt(0)
	if len(payerTokens.Tokens) > 0 {
		payerToken := payerTokens.Tokens[0]
		if failure := tokenRelationshipFailure(payerToken, "payer"); failure != nil {
			return *failure
		}
		held = big.NewInt(payerToken.Balance)
	}
	if held.Cmp(required) < 0 {
		return SignatureCheck{
			Reason:  "insufficient_balance",
			Message: fmt.Sprintf("payer holds %s of %s, needs %s", held.String(), asset, required.String()),
		}
	}

	var payToTokens mirrorTokensResponse
	url = fmt.Sprintf("%s/api/v1/accounts/%s/tokens?token.id=%s", mirrorBase, payTo, asset)
	if err := httpClient.getJSON(ctx, url, &payToTokens); err != nil {
		return SignatureCheck{Reason: "preflight_failed", Message: err.Error()}
	}
	if len(payToTokens.Tokens) > 0 {
		if failure := tokenRelationshipFailure(payToTokens.Tokens[0], "payTo"); failure != nil {
			return *failure
		}
		return SignatureCheck{OK: true}
	}
	if token.FreezeDefault || token.KYCKey != nil {
		return SignatureCheck{
			Reason:  "pay_to_not_associated",
			Message: fmt.Sprintf("payTo %s must be explicitly associated with %s", payTo, asset),
		}
	}

	associated, err := hasAutomaticAssociationSlot(
		ctx,
		httpClient,
		mirrorBase,
		payTo,
		payToAccount.MaxAutomaticTokenAssociations,
	)
	if err != nil {
		return SignatureCheck{Reason: "preflight_failed", Message: err.Error()}
	}
	if associated {
		return SignatureCheck{OK: true}
	}
	return SignatureCheck{
		Reason:  "pay_to_not_associated",
		Message: fmt.Sprintf("payTo %s is not associated with %s and has no auto-association slots", payTo, asset),
	}
}

func tokenFailure(token mirrorToken, asset string) *SignatureCheck {
	if token.Type != "" && !strings.EqualFold(token.Type, "FUNGIBLE_COMMON") {
		return &SignatureCheck{Reason: "invalid_asset", Message: fmt.Sprintf("%s is not a fungible token", asset)}
	}
	if token.Deleted {
		return &SignatureCheck{Reason: "invalid_asset", Message: fmt.Sprintf("%s is deleted", asset)}
	}
	if strings.EqualFold(token.PauseStatus, "PAUSED") {
		return &SignatureCheck{Reason: "token_paused", Message: fmt.Sprintf("%s is paused", asset)}
	}
	if len(token.CustomFees.FixedFees) > 0 ||
		len(token.CustomFees.FractionalFees) > 0 ||
		len(token.CustomFees.RoyaltyFees) > 0 {
		return &SignatureCheck{
			Reason:  "token_custom_fees_unsupported",
			Message: fmt.Sprintf("%s has custom fees that may debit the transaction fee payer", asset),
		}
	}
	return nil
}

func tokenRelationshipFailure(token mirrorTokenRelationship, role string) *SignatureCheck {
	if strings.EqualFold(token.FreezeStatus, "FROZEN") {
		return &SignatureCheck{
			Reason:  "token_frozen",
			Message: fmt.Sprintf("%s token relationship for %s is frozen", role, token.TokenID),
		}
	}
	if strings.EqualFold(token.KYCStatus, "REVOKED") {
		return &SignatureCheck{
			Reason:  "token_kyc_revoked",
			Message: fmt.Sprintf("%s token relationship for %s has revoked KYC", role, token.TokenID),
		}
	}
	return nil
}

func hasAutomaticAssociationSlot(
	ctx context.Context,
	httpClient *mirrorHTTP,
	base, payTo string,
	maxAuto int,
) (bool, error) {
	if maxAuto < 0 {
		return true, nil
	}
	if maxAuto == 0 {
		return false, nil
	}

	consumed := 0
	next := fmt.Sprintf("/api/v1/accounts/%s/tokens", payTo)
	for next != "" {
		var page mirrorTokensResponse
		if err := httpClient.getJSON(ctx, base+next, &page); err != nil {
			return false, err
		}
		for _, token := range page.Tokens {
			if token.AutomaticAssociation {
				consumed++
			}
		}
		if consumed >= maxAuto {
			return false, nil
		}
		if page.Links.Next == nil {
			break
		}
		next = *page.Links.Next
	}
	return consumed < maxAuto, nil
}

func resolveAccountMirror(ctx context.Context, httpClient *mirrorHTTP, mirrorBase, accountIDOrAlias string) (AccountResolution, error) {
	if !IsValidEntityID(accountIDOrAlias) {
		return AccountResolution{Exists: false, IsAlias: true}, nil
	}
	var account mirrorAccount
	if err := httpClient.getJSON(ctx, fmt.Sprintf("%s/api/v1/accounts/%s", mirrorBase, accountIDOrAlias), &account); err != nil {
		if strings.Contains(err.Error(), "status 404") {
			return AccountResolution{Exists: false, IsAlias: false}, nil
		}
		return AccountResolution{}, err
	}
	return AccountResolution{Exists: true, IsAlias: false}, nil
}
