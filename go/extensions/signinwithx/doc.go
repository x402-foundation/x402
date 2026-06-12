// Package signinwithx implements the sign-in-with-x (SIWX) extension for x402.
//
// SIWX is a CAIP-122 wallet authentication extension. A server advertises a
// challenge in the PaymentRequired response; the client signs it and returns
// the proof in the SIGN-IN-WITH-X header. Servers use it to recognise
// returning wallets and skip payment for addresses that have already paid.
// See specs/extensions/sign-in-with-x.md.
//
// This package provides the protocol core: challenge declaration, message
// construction, header encoding, field validation, and signature verification
// for EVM (eip155:*) and Solana (solana:*) chains.
//
// Server-side:
//
//	ext, _ := signinwithx.DeclareExtension(signinwithx.DeclareOptions{
//	    ResourceURI: "https://api.example.com/data",
//	    Networks:    []string{"eip155:8453"},
//	    Statement:   "Sign in to access your content",
//	})
//	// include ext in PaymentRequired.extensions under signinwithx.Key
//
//	payload, _ := signinwithx.ParseHeader(r.Header.Get(signinwithx.Header))
//	res := signinwithx.Verify(ctx, payload, "https://api.example.com/data", signinwithx.ValidationOptions{}, nil)
//	if res.Valid { /* grant access to res.Address */ }
//
// EVM verification defaults to EOA (EIP-191) recovery with no RPC. Pass
// VerifyOptions.EVMVerifier to enable smart-wallet signatures (EIP-1271 /
// ERC-6492). Solana uses Ed25519.
package signinwithx
