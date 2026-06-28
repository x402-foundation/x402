package offerreceipt

// OFFER_RECEIPT is the extension identifier for signed offers and receipts.
const OFFER_RECEIPT = "offer-receipt"

// SignatureFormat identifies the signature envelope used by a signed artifact.
type SignatureFormat string

const (
	FormatEIP712 SignatureFormat = "eip712"
	FormatJWS    SignatureFormat = "jws"
)

// OfferPayload contains the canonical signed offer fields.
type OfferPayload struct {
	Version     int    `json:"version"`
	ResourceURL string `json:"resourceUrl"`
	Scheme      string `json:"scheme"`
	Network     string `json:"network"`
	Asset       string `json:"asset"`
	PayTo       string `json:"payTo"`
	Amount      string `json:"amount"`
	ValidUntil  int64  `json:"validUntil,omitempty"`
}

// ReceiptPayload contains the canonical signed receipt fields.
type ReceiptPayload struct {
	Version     int    `json:"version"`
	Network     string `json:"network"`
	ResourceURL string `json:"resourceUrl"`
	Payer       string `json:"payer"`
	IssuedAt    int64  `json:"issuedAt"`
	Transaction string `json:"transaction,omitempty"`
}

// SignedOffer is the transmitted signed offer artifact.
type SignedOffer struct {
	Format      SignatureFormat `json:"format"`
	Payload     *OfferPayload   `json:"payload,omitempty"`
	Signature   string          `json:"signature"`
	AcceptIndex *int            `json:"acceptIndex,omitempty"`
}

// SignedReceipt is the transmitted signed receipt artifact.
type SignedReceipt struct {
	Format    SignatureFormat `json:"format"`
	Payload   *ReceiptPayload `json:"payload,omitempty"`
	Signature string          `json:"signature"`
}

// DecodedOffer combines a signed offer with its extracted payload.
type DecodedOffer struct {
	OfferPayload
	SignedOffer SignedOffer
	Format      SignatureFormat
	AcceptIndex *int
}

type offerReceiptExtension struct {
	Info offerReceiptInfo `json:"info"`
}

type offerReceiptInfo struct {
	Offers  []SignedOffer  `json:"offers,omitempty"`
	Receipt *SignedReceipt `json:"receipt,omitempty"`
}
