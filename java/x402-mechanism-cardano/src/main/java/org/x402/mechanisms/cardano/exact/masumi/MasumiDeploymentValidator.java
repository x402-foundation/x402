package org.x402.mechanisms.cardano.exact.masumi;

/**
 * Explicitly approves one non-canonical Masumi V2 deployment. Choosing a deployment is choosing
 * the escrow's dispute
 * arbitrators.
 */
@FunctionalInterface
public interface MasumiDeploymentValidator {

  /**
   * Approves a deployment.
   *
   * @param claim the deployment claim
   * @return true when approved
   */
  boolean approve(MasumiDeploymentClaim claim);
}
