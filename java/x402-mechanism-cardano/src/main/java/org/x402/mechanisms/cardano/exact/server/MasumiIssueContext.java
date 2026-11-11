package org.x402.mechanisms.cardano.exact.server;

import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;

/**
 * What the issuer knows about the request a quote is issued for.
 *
 * @param requirement the template the route declared
 * @param resourceInfo the protected resource
 * @param transportContext the transport context (HTTP request, ...), may be {@code null}
 */
public record MasumiIssueContext(PaymentRequirements requirement, ResourceInfo resourceInfo, Object transportContext) {}
