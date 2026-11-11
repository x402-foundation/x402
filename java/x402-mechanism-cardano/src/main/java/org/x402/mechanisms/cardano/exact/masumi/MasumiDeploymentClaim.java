package org.x402.mechanisms.cardano.exact.masumi;

/**
 * A non-canonical deployment to approve.
 *
 * @param network the x402 network
 * @param payTo the escrow address
 * @param deployment the declared parameters
 */
public record MasumiDeploymentClaim(String network, String payTo, MasumiDeployment deployment) {}
