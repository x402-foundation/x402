Facilitator before-verify and before-settle aborts now raise `VerifyError` and `SettleError` instead of `PaymentAbortedError`, and copy the hook message onto `invalid_message` and `error_message`.
