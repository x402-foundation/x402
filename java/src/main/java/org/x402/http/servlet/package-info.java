/**
 * Jakarta Servlet integration for x402 resource servers.
 *
 * <p>{@link org.x402.http.servlet.PaymentFilter} adapts {@link org.x402.http.HttpResourceServer} to the servlet
 * filter chain. It buffers the protected response and releases it only after the payment has settled.
 *
 * <p>Unless noted, methods and constructors throw {@link java.lang.NullPointerException} for {@code null}
 * arguments.
 */
package org.x402.http.servlet;
