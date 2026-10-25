package org.x402.spring.offer;

/**
 * Called once per resolved payment option, after YAML merging and before core validation.
 * Mechanism auto-configurations use it to derive a {@code pay-to} or add {@code
 * extra} keys. A contributor may not change the network or an {@code assetTransferMethod}
 * inherited from the account; a thrown exception fails startup naming the offer and option.
 */
@FunctionalInterface
public interface X402OptionContributor {

  /**
   * Contributes to one option.
   *
   * @param option the draft option
   */
  void contribute(OptionDraft option);
}
