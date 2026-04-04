---
title: "Security Best Practices"
description: "Recommendations for building secure x402 integrations, including counterparty risk assessment"
---

# Security Best Practices

As the x402 ecosystem grows and more agents make autonomous payments, it is important to consider security beyond the protocol layer. This guide covers practical recommendations for both buyers (clients) and sellers (resource servers).

## Counterparty Risk

x402 payments are **irreversible on-chain**. Before sending payment, agent developers should assess whether the counterparty is trustworthy.

### Recommendations for Buyers

1. **Verify the resource server** - Before making a payment, confirm that the resource server endpoint is legitimate. Check the domain, TLS certificate, and any available reputation data.

2. **Check wallet and domain reputation** - Use available on-chain analytics or risk-scoring services to screen the recipient wallet address and domain before sending funds. This can help identify sanctioned entities or known-malicious addresses.

3. **Start with small payments** - When interacting with a new service for the first time, consider making a small test payment to verify that the service delivers as expected before committing larger amounts.

4. **Validate response quality** - After receiving a response, verify that the data or service delivered matches what was advertised. Implement automated quality checks where possible.

### Recommendations for Sellers

1. **Use HTTPS** - Always serve your x402 endpoints over HTTPS to prevent man-in-the-middle attacks on payment headers.

2. **Validate payment payloads** - Always verify payment payloads through a trusted facilitator rather than implementing custom verification logic.

3. **Implement rate limiting** - Protect your endpoints from abuse by implementing rate limiting per wallet address or IP.

4. **Monitor settlement** - Track settlement outcomes and alert on unusual patterns such as repeated failures or duplicate submissions.

## Sanctions Compliance

If your application operates in a regulated environment, consider implementing sanctions screening for wallet addresses before accepting or sending payments. Several ecosystem tools provide OFAC and other sanctions list screening compatible with x402 flows.

## Agent-Specific Considerations

Autonomous agents making payments on behalf of users should:

- **Enforce spending limits** - Set per-transaction and per-period spending caps to limit exposure.
- **Log all transactions** - Maintain an audit trail of all payment decisions, including the rationale for each payment.
- **Implement circuit breakers** - Automatically pause payments if error rates or refund rates exceed thresholds.
