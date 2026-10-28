package cardano

import "time"

// Resource bounds applied before decoding or hashing untrusted input.
const (
	MaxTransactionBytes             = 64 * 1024
	MaxTransactionInputs            = 256
	MaxScriptBytes                  = 64 * 1024
	MaxDatumBytes                   = 64 * 1024
	MaxScriptParameters             = 64
	MaxScriptParameterBytes         = 64 * 1024
	MaxMasumiCommitmentParts        = 32
	MaxMasumiCommitmentContentBytes = 1024 * 1024
	MaxMasumiAdminKeys              = 64
	MaxMasumiIdentifierCompressed   = 8 * 1024
	MaxMasumiIdentifierTextChars    = 32 * 1024
	MaxMasumiCoseBytes              = 16 * 1024
)

const (
	// MaxInputLookupConcurrency bounds concurrent input lookups per verification.
	MaxInputLookupConcurrency = 8
	// DefaultProviderTimeout bounds one chain-provider request.
	DefaultProviderTimeout = 10 * time.Second
)
