package org.x402.mechanisms.cardano.exact.client;

/**
 * The buyer's wallet: builds and signs, never broadcasts. The
 * mnemonic-backed default is {@code signer.MnemonicClientCardanoSigner}; wallets and HSMs
 * implement this interface.
 */
public interface ClientCardanoSigner {

  /**
   * The funding address.
   *
   * @return bech32 address
   */
  String getAddress();

  /**
   * Builds and signs a transaction for the requirements. The nonce UTxO must be an input.
   *
   * @param input the payment
   * @return the base64 signed transaction and the nonce
   */
  ClientCardanoSignResult buildAndSignPaymentTransaction(ClientCardanoSignInput input);
}
