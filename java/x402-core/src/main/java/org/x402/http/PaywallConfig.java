package org.x402.http;

/**
 * Paywall options.
 *
 * @param appName the application name
 * @param appLogo the logo URL
 * @param sessionTokenEndpoint an onramp session endpoint
 * @param currentUrl the page URL
 * @param testnet whether to show testnets, {@code null} for the provider default
 */
public record PaywallConfig(
    String appName, String appLogo, String sessionTokenEndpoint, String currentUrl,
    Boolean testnet) {}
