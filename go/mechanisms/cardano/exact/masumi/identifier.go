package masumi

import (
	"encoding/hex"
	"errors"
	"regexp"
	"unicode/utf16"

	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
)

const sellerNonceHexLength = 64

var lowerHexRegex = regexp.MustCompile(`^[0-9a-f]+$`)

// IdentifierParts are the five period-delimited segments of the Masumi
// compatibility identifier (blockchainIdentifier).
type IdentifierParts struct {
	SellerNonce string `json:"sellerNonce"`
	// AgentIdentifier is empty when the seller is unregistered.
	AgentIdentifier    string `json:"agentIdentifier"`
	BuyerNonce         string `json:"buyerNonce"`
	ReferenceSignature string `json:"referenceSignature"`
	ReferenceKey       string `json:"referenceKey"`
	ContractAddress    string `json:"contractAddress"`
}

// BuildIdentifierText joins the segments into the exact identifierText.
func BuildIdentifierText(parts IdentifierParts) string {
	return parts.SellerNonce + parts.AgentIdentifier + "." + parts.BuyerNonce + "." +
		parts.ReferenceSignature + "." + parts.ReferenceKey + "." + parts.ContractAddress
}

// EncodeBlockchainIdentifier returns the lowercase hex of the LZString-compressed
// identifier text.
func EncodeBlockchainIdentifier(parts IdentifierParts) (string, error) {
	text := utf16.Encode([]rune(BuildIdentifierText(parts)))
	if len(text) > cardano.MaxMasumiIdentifierTextChars {
		return "", errors.New("masumi identifier text exceeds the character limit")
	}
	compressed := lzCompressToBytes(text)
	if len(compressed) > cardano.MaxMasumiIdentifierCompressed {
		return "", errors.New("masumi identifier exceeds the compressed byte limit")
	}
	return hex.EncodeToString(compressed), nil
}

// DecodeBlockchainIdentifier decodes a wire blockchainIdentifier into its five
// segments. ok is false when the value is not lowercase hex, does not
// decompress within the limits, or lacks five segments with a 64-character
// seller nonce.
func DecodeBlockchainIdentifier(blockchainIdentifier string) (parts IdentifierParts, ok bool) {
	n := len(blockchainIdentifier)
	if n == 0 || n%2 != 0 || n/2 > cardano.MaxMasumiIdentifierCompressed || !lowerHexRegex.MatchString(blockchainIdentifier) {
		return IdentifierParts{}, false
	}
	raw, _ := hex.DecodeString(blockchainIdentifier)
	text, ok := lzDecompressBounded(raw, cardano.MaxMasumiIdentifierTextChars)
	if !ok || len(text) == 0 {
		return IdentifierParts{}, false
	}
	var segments [][]uint16
	start := 0
	for i, u := range text {
		if u == '.' {
			segments = append(segments, text[start:i])
			start = i + 1
		}
	}
	segments = append(segments, text[start:])
	if len(segments) != 5 || len(segments[0]) < sellerNonceHexLength {
		return IdentifierParts{}, false
	}
	str := func(units []uint16) string { return string(utf16.Decode(units)) }
	return IdentifierParts{
		SellerNonce:        str(segments[0][:sellerNonceHexLength]),
		AgentIdentifier:    str(segments[0][sellerNonceHexLength:]),
		BuyerNonce:         str(segments[1]),
		ReferenceSignature: str(segments[2]),
		ReferenceKey:       str(segments[3]),
		ContractAddress:    str(segments[4]),
	}, true
}
