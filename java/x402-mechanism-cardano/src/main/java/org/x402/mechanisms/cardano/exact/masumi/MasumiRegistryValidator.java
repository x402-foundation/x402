package org.x402.mechanisms.cardano.exact.masumi;

/**
 * Independently validates a Masumi registry claim on the selected network. Without one, a
 * non-empty {@code agentIdentifier} is rejected.
 */
@FunctionalInterface
public interface MasumiRegistryValidator {

  /**
   * Validates a claim.
   *
   * @param claim the claim
   * @return true when the claim is authentic and resolves to the signed price
   */
  boolean validate(MasumiRegistryClaim claim);
}
