package signinwithx

import "strings"

// DeclareExtension creates a sign-in-with-x extension declaration.
func DeclareExtension(options DeclareOptions) map[string]interface{} {
	version := options.Version
	if version == "" {
		version = Version
	}

	info := Info{
		Statement: options.Statement,
		Version:   version,
	}

	supportedChains := make([]SupportedChain, 0, len(options.Networks))
	for _, network := range options.Networks {
		supportedChains = append(supportedChains, SupportedChain{
			ChainID: network,
			Type:    SignatureTypeForNetwork(network),
		})
	}

	return map[string]interface{}{
		ExtensionKey: Extension{
			Info:            info,
			SupportedChains: supportedChains,
			Schema:          Schema(),
			Options:         options,
		},
	}
}

// SignatureTypeForNetwork returns the SIWX signature type for a CAIP-2 network.
func SignatureTypeForNetwork(network string) string {
	if strings.HasPrefix(network, "solana:") {
		return SignatureTypeEd25519
	}
	return SignatureTypeEIP191
}
