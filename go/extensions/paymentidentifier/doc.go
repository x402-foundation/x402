// Package paymentidentifier implements the payment-identifier extension for x402.
//
// The payment-identifier extension enables clients to provide an idempotency key
// that resource servers can use for deduplication of payment requests.
//
// # Usage
//
// Server-side (declaring the extension):
//
//	extensions := map[string]interface{}{
//	    paymentidentifier.PAYMENT_IDENTIFIER: paymentidentifier.DeclarePaymentIdentifierExtension(true),
//	}
//
// Client-side (appending the identifier):
//
//	err := paymentidentifier.AppendPaymentIdentifierToExtensions(extensions, "")
//	// A new ID is generated if empty string is passed
//
// Facilitator-side (extracting and validating):
//
//	id, err := paymentidentifier.ExtractPaymentIdentifier(payload, true)
//	if err != nil {
//	    // Handle error
//	}
package paymentidentifier
