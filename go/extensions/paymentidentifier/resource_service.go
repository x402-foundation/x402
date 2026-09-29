package paymentidentifier

// DeclarePaymentIdentifierExtension creates a payment-identifier extension declaration
// for inclusion in PaymentRequired.extensions.
//
// Resource servers call this function to advertise support for payment identifiers.
// The declaration indicates whether a payment identifier is required and includes
// the schema that clients must follow.
//
// Args:
//   - required: Whether clients must provide a payment identifier.
//     When true, clients must provide an `id` or receive a 400 Bad Request.
//
// Returns:
//   - A PaymentIdentifierExtension object ready for PaymentRequired.extensions
//
// Example:
//
//	// Include in PaymentRequired response (optional identifier)
//	extensions := map[string]interface{}{
//	    paymentidentifier.PAYMENT_IDENTIFIER: paymentidentifier.DeclarePaymentIdentifierExtension(false),
//	}
//
//	// Require payment identifier
//	extensions := map[string]interface{}{
//	    paymentidentifier.PAYMENT_IDENTIFIER: paymentidentifier.DeclarePaymentIdentifierExtension(true),
//	}
func DeclarePaymentIdentifierExtension(required bool) PaymentIdentifierExtension {
	return PaymentIdentifierExtension{
		Info: PaymentIdentifierInfo{
			Required: required,
		},
		Schema: PaymentIdentifierSchema(),
	}
}
