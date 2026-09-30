package signinwithx

import (
	"context"
	"strings"
)

type signerAdapter struct {
	signer interface {
		Address() string
		SignMessage(context.Context, string) (string, error)
	}
	chainPrefix            string
	signatureType          string
	defaultSignatureScheme string
	formatSignature        func(string) string
}

// NewEVMSIWXSigner adapts an EVM message signer for SIWX.
func NewEVMSIWXSigner(signer EVMSigner) Signer {
	if signer == nil {
		return nil
	}
	return signerAdapter{
		signer:                 signer,
		chainPrefix:            "eip155:",
		signatureType:          SignatureTypeEIP191,
		defaultSignatureScheme: SignatureSchemeEIP191,
		formatSignature:        normalizeHexSignature,
	}
}

// NewSolanaSIWXSigner adapts a Solana message signer for SIWX.
func NewSolanaSIWXSigner(signer SolanaSigner) Signer {
	if signer == nil {
		return nil
	}
	return signerAdapter{
		signer:                 signer,
		chainPrefix:            "solana:",
		signatureType:          SignatureTypeEd25519,
		defaultSignatureScheme: SignatureSchemeSIWS,
		formatSignature:        func(signature string) string { return signature },
	}
}

func (s signerAdapter) Address() string {
	return s.signer.Address()
}

func (s signerAdapter) SignMessage(ctx context.Context, message string) (string, error) {
	return s.signer.SignMessage(ctx, message)
}

func (s signerAdapter) SupportsChain(chain SupportedChain) bool {
	return chain.Type == s.signatureType && strings.HasPrefix(chain.ChainID, s.chainPrefix)
}

func (s signerAdapter) DefaultSignatureScheme() string {
	return s.defaultSignatureScheme
}

func (s signerAdapter) FormatSignature(signature string) string {
	return s.formatSignature(signature)
}
