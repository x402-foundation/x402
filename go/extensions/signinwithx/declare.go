package signinwithx

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// isoMillis matches JavaScript Date.toISOString() (UTC, milliseconds, "Z").
const isoMillis = "2006-01-02T15:04:05.000Z07:00"

// signatureTypeFor returns the CAIP-122 signature type for a CAIP-2 network.
func signatureTypeFor(network string) SignatureType {
	if strings.HasPrefix(network, "solana:") {
		return SignatureTypeEd25519
	}
	return SignatureTypeEIP191
}

// DeclareExtension builds a SIWX challenge for PaymentRequired.extensions. A
// fresh nonce and issuedAt are generated on every call, so servers invoke it
// per response. Domain is derived from ResourceURI when not set explicitly.
func DeclareExtension(opts DeclareOptions) (Extension, error) {
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return Extension{}, fmt.Errorf("generate nonce: %w", err)
	}
	now := time.Now().UTC()

	version := opts.Version
	if version == "" {
		version = "1"
	}
	domain := opts.Domain
	if domain == "" && opts.ResourceURI != "" {
		if u, err := url.Parse(opts.ResourceURI); err == nil {
			domain = u.Hostname()
		}
	}

	info := Info{
		Domain:   domain,
		URI:      opts.ResourceURI,
		Version:  version,
		Nonce:    hex.EncodeToString(nonce),
		IssuedAt: now.Format(isoMillis),
	}
	if opts.ResourceURI != "" {
		info.Resources = []string{opts.ResourceURI}
	}
	if opts.Statement != "" {
		info.Statement = opts.Statement
	}
	if opts.ExpirationSeconds != nil {
		info.ExpirationTime = now.Add(time.Duration(*opts.ExpirationSeconds) * time.Second).Format(isoMillis)
	}

	chains := make([]SupportedChain, 0, len(opts.Networks))
	for _, n := range opts.Networks {
		chains = append(chains, SupportedChain{ChainID: n, Type: signatureTypeFor(n)})
	}

	return Extension{Info: info, SupportedChains: chains, Schema: BuildSchema()}, nil
}
