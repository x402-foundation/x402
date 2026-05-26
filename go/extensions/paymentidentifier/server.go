package paymentidentifier

// paymentIdentifierResourceServerExtension implements ResourceServerExtension
// for the payment-identifier extension.
type paymentIdentifierResourceServerExtension struct{}

// Key returns the extension identifier key.
func (e *paymentIdentifierResourceServerExtension) Key() string {
	return PAYMENT_IDENTIFIER
}

// EnrichDeclaration is a no-op for payment-identifier since the declaration is static.
// Unlike bazaar which needs to enrich with HTTP method, payment-identifier
// has no dynamic content that depends on the transport context.
func (e *paymentIdentifierResourceServerExtension) EnrichDeclaration(
	declaration interface{},
	transportContext interface{},
) interface{} {
	// No enrichment needed - the declaration is static
	return declaration
}

// PaymentIdentifierResourceServerExtension is the singleton instance of the
// payment-identifier resource server extension.
var PaymentIdentifierResourceServerExtension = &paymentIdentifierResourceServerExtension{}
