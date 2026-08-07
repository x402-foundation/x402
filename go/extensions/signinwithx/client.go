package signinwithx

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	x402 "github.com/x402-foundation/x402/go/v2"
	x402http "github.com/x402-foundation/x402/go/v2/http"
	"github.com/x402-foundation/x402/go/v2/types"
)

// EVMSigner signs EIP-191 SIWX messages.
type EVMSigner interface {
	Address() string
	SignMessage(ctx context.Context, message string) (string, error)
}

// SolanaSigner signs Ed25519 SIWS messages and returns Base58 signatures.
type SolanaSigner interface {
	Address() string
	SignMessage(ctx context.Context, message string) (string, error)
}

// Signer is a chain-aware SIWX signer used by multi-signer clients.
type Signer interface {
	Address() string
	SignMessage(ctx context.Context, message string) (string, error)
	SupportsChain(chain SupportedChain) bool
	DefaultSignatureScheme() string
	FormatSignature(signature string) string
}

// ClientExtension signs SIWX challenges declared by HTTP PaymentRequired responses.
type ClientExtension struct {
	signers []Signer
}

// CreateClientExtension creates a client extension that auto-wires SIWX HTTP auth retries.
func CreateClientExtension(signer EVMSigner) *ClientExtension {
	return CreateClientExtensionWithSigners(NewEVMSIWXSigner(signer))
}

// CreateClientExtensionWithSigners creates a client extension with ordered SIWX signers.
func CreateClientExtensionWithSigners(signers ...Signer) *ClientExtension {
	return &ClientExtension{signers: compactSigners(signers)}
}

func (e *ClientExtension) Key() string {
	return ExtensionKey
}

func (e *ClientExtension) EnrichPaymentPayload(_ context.Context, payload types.PaymentPayload, _ types.PaymentRequired) (types.PaymentPayload, error) {
	return payload, nil
}

func (e *ClientExtension) PaymentRequiredHook() x402http.PaymentRequiredHook {
	return CreateClientHookWithSigners(e.signers...)
}

var _ x402.ClientExtension = (*ClientExtension)(nil)

// CreatePayload creates and signs a SIWX payload from a server declaration.
func CreatePayload(ctx context.Context, declaration interface{}, signer EVMSigner) (Payload, error) {
	return CreatePayloadWithSigners(ctx, declaration, NewEVMSIWXSigner(signer))
}

// CreatePayloadWithSigners creates and signs a SIWX payload using the first compatible signer.
func CreatePayloadWithSigners(ctx context.Context, declaration interface{}, signers ...Signer) (Payload, error) {
	signers = compactSigners(signers)
	if len(signers) == 0 {
		return Payload{}, fmt.Errorf("SIWX signer is required")
	}

	ext, err := extensionFromInterface(declaration)
	if err != nil {
		return Payload{}, err
	}

	var lastErr error
	for _, signer := range signers {
		chain, ok := selectSignerChain(ext.SupportedChains, signer)
		if !ok {
			continue
		}

		payload := payloadForSigner(ext.Info, chain, signer)
		message, err := CreateMessage(payload)
		if err != nil {
			lastErr = err
			continue
		}
		signature, err := signer.SignMessage(ctx, message)
		if err != nil {
			lastErr = fmt.Errorf("sign SIWX message: %w", err)
			continue
		}
		payload.Signature = signer.FormatSignature(signature)
		return payload, nil
	}

	if lastErr != nil {
		return Payload{}, lastErr
	}
	return Payload{}, fmt.Errorf("SIWX declaration does not support any configured signer")
}

// CreateHeader creates a SIGN-IN-WITH-X header value from a server declaration.
func CreateHeader(ctx context.Context, declaration interface{}, signer EVMSigner) (string, error) {
	payload, err := CreatePayload(ctx, declaration, signer)
	if err != nil {
		return "", err
	}
	return EncodeHeader(payload)
}

// CreateHeaderWithSigners creates a SIGN-IN-WITH-X header value with ordered signers.
func CreateHeaderWithSigners(ctx context.Context, declaration interface{}, signers ...Signer) (string, error) {
	payload, err := CreatePayloadWithSigners(ctx, declaration, signers...)
	if err != nil {
		return "", err
	}
	return EncodeHeader(payload)
}

// CreateClientHook creates an HTTP on-payment-required hook for SIWX authentication.
func CreateClientHook(signer EVMSigner) x402http.PaymentRequiredHook {
	return CreateClientHookWithSigners(NewEVMSIWXSigner(signer))
}

// CreateClientHookWithSigners creates an HTTP on-payment-required hook using ordered SIWX signers.
func CreateClientHookWithSigners(signers ...Signer) x402http.PaymentRequiredHook {
	signers = compactSigners(signers)
	return func(ctx context.Context, paymentRequired types.PaymentRequired) (*x402http.PaymentRequiredHookResult, error) {
		if paymentRequired.Extensions == nil {
			return nil, nil
		}
		declaration, ok := paymentRequired.Extensions[ExtensionKey]
		if !ok {
			return nil, nil
		}
		header, createErr := CreateHeaderWithSigners(ctx, declaration, signers...)
		if createErr != nil {
			return noPaymentRequiredHookResult()
		}
		return &x402http.PaymentRequiredHookResult{
			Headers: map[string]string{HeaderName: header},
		}, nil
	}
}

func noPaymentRequiredHookResult() (*x402http.PaymentRequiredHookResult, error) {
	return nil, nil
}

func extensionFromInterface(declaration interface{}) (Extension, error) {
	switch ext := declaration.(type) {
	case Extension:
		return ext, nil
	case *Extension:
		if ext == nil {
			return Extension{}, fmt.Errorf("SIWX declaration is nil")
		}
		return *ext, nil
	default:
		data, err := json.Marshal(declaration)
		if err != nil {
			return Extension{}, fmt.Errorf("marshal SIWX declaration: %w", err)
		}
		var decoded Extension
		if err := json.Unmarshal(data, &decoded); err != nil {
			return Extension{}, fmt.Errorf("unmarshal SIWX declaration: %w", err)
		}
		if decoded.Info.Version == "" && len(decoded.SupportedChains) == 0 {
			return Extension{}, fmt.Errorf("invalid SIWX declaration")
		}
		return decoded, nil
	}
}

func selectSignerChain(chains []SupportedChain, signer Signer) (SupportedChain, bool) {
	for _, chain := range chains {
		if signer.SupportsChain(chain) {
			return chain, true
		}
	}
	return SupportedChain{}, false
}

func normalizeHexSignature(signature string) string {
	if strings.HasPrefix(signature, "0x") || strings.HasPrefix(signature, "0X") {
		return signature
	}
	return "0x" + signature
}

func payloadForSigner(info Info, chain SupportedChain, signer Signer) Payload {
	signatureScheme := chain.SignatureScheme
	if signatureScheme == "" {
		signatureScheme = signer.DefaultSignatureScheme()
	}
	return Payload{
		Domain:          info.Domain,
		Address:         signer.Address(),
		Statement:       info.Statement,
		URI:             info.URI,
		Version:         info.Version,
		ChainID:         chain.ChainID,
		Type:            chain.Type,
		Nonce:           info.Nonce,
		IssuedAt:        info.IssuedAt,
		ExpirationTime:  info.ExpirationTime,
		NotBefore:       info.NotBefore,
		RequestID:       info.RequestID,
		Resources:       info.Resources,
		SignatureScheme: signatureScheme,
	}
}

func compactSigners(signers []Signer) []Signer {
	compact := make([]Signer, 0, len(signers))
	for _, signer := range signers {
		if signer != nil {
			compact = append(compact, signer)
		}
	}
	return compact
}
