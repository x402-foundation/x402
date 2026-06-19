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

// ClientExtension signs SIWX challenges declared by HTTP PaymentRequired responses.
type ClientExtension struct {
	signer EVMSigner
}

// CreateClientExtension creates a client extension that auto-wires SIWX HTTP auth retries.
func CreateClientExtension(signer EVMSigner) *ClientExtension {
	return &ClientExtension{signer: signer}
}

func (e *ClientExtension) Key() string {
	return ExtensionKey
}

func (e *ClientExtension) EnrichPaymentPayload(_ context.Context, payload types.PaymentPayload, _ types.PaymentRequired) (types.PaymentPayload, error) {
	return payload, nil
}

func (e *ClientExtension) EchoPaymentRequiredExtension() bool {
	return false
}

func (e *ClientExtension) PaymentRequiredHook() x402http.PaymentRequiredHook {
	return CreateClientHook(e.signer)
}

var _ x402.ClientExtension = (*ClientExtension)(nil)

// CreatePayload creates and signs a SIWX payload from a server declaration.
func CreatePayload(ctx context.Context, declaration interface{}, signer EVMSigner) (Payload, error) {
	if signer == nil {
		return Payload{}, fmt.Errorf("SIWX signer is required")
	}

	ext, err := extensionFromInterface(declaration)
	if err != nil {
		return Payload{}, err
	}

	chain, ok := selectEVMChain(ext.SupportedChains)
	if !ok {
		return Payload{}, fmt.Errorf("SIWX declaration does not support EVM EIP-191 signing")
	}

	info := ext.Info
	payload := Payload{
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
		SignatureScheme: chain.SignatureScheme,
	}
	if payload.SignatureScheme == "" {
		payload.SignatureScheme = SignatureSchemeEIP191
	}

	message, err := CreateMessage(payload)
	if err != nil {
		return Payload{}, err
	}
	signature, err := signer.SignMessage(ctx, message)
	if err != nil {
		return Payload{}, fmt.Errorf("sign SIWX message: %w", err)
	}
	payload.Signature = normalizeHexSignature(signature)
	return payload, nil
}

// CreateHeader creates a SIGN-IN-WITH-X header value from a server declaration.
func CreateHeader(ctx context.Context, declaration interface{}, signer EVMSigner) (string, error) {
	payload, err := CreatePayload(ctx, declaration, signer)
	if err != nil {
		return "", err
	}
	return EncodeHeader(payload)
}

// CreateClientHook creates an HTTP on-payment-required hook for SIWX authentication.
func CreateClientHook(signer EVMSigner) x402http.PaymentRequiredHook {
	return func(ctx context.Context, paymentRequired types.PaymentRequired) (*x402http.PaymentRequiredHookResult, error) {
		if paymentRequired.Extensions == nil {
			return nil, nil
		}
		declaration, ok := paymentRequired.Extensions[ExtensionKey]
		if !ok {
			return nil, nil
		}
		header, createErr := CreateHeader(ctx, declaration, signer)
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

func selectEVMChain(chains []SupportedChain) (SupportedChain, bool) {
	for _, chain := range chains {
		if chain.Type == SignatureTypeEIP191 && strings.HasPrefix(chain.ChainID, "eip155:") {
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
