package evm

import "github.com/ethereum/go-ethereum/common"

// erc7702Prefix is the 3-byte delegation designation prefix defined in EIP-7702.
var erc7702Prefix = []byte{0xef, 0x01, 0x00}

// IsERC7702Delegation reports whether code is a valid ERC-7702 delegation designation:
// exactly 23 bytes (3-byte prefix + 20-byte delegate address).
//
// NOTE: this is a diagnostic helper — the verification path does not branch on 7702
// detection. It routes by code.length (via VerifySignatureStrict) and the delegate
// decides via isValidSignature, which mirrors on-chain SignatureChecker semantics.
func IsERC7702Delegation(code []byte) bool {
	if len(code) != 23 {
		return false
	}
	return code[0] == erc7702Prefix[0] && code[1] == erc7702Prefix[1] && code[2] == erc7702Prefix[2]
}

// GetERC7702DelegateAddress extracts the 20-byte delegate address from a 7702 designation.
// Returns a **checksummed EIP-55** common.Address. The Python and TypeScript equivalents
// return lowercase hex strings — normalise before comparing cross-SDK outputs.
// Returns (common.Address{}, false) if code is not a valid delegation.
func GetERC7702DelegateAddress(code []byte) (common.Address, bool) {
	if !IsERC7702Delegation(code) {
		return common.Address{}, false
	}
	return common.BytesToAddress(code[3:23]), true
}
