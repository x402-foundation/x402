# @x402/mnemopay Changelog

## 2.8.0

### Minor Changes

- Initial release: MnemoPay middleware for x402 payment protocol
- `withMnemoPay()` wrapper adds economic memory to any x402-enabled fetch
- `recallEndpointInsight()` queries agent memory for endpoint cost/reliability data
- `rememberPaymentOutcome()` stores payment results for future reference
- Automatic settle/refund flow based on payment success/failure
