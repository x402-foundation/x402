package org.x402.mechanisms.cardano.exact.server;

import org.x402.mechanisms.cardano.exact.masumi.MasumiSellerAuthorization;

/**
 * The selling wallet for Masumi quotes: its key-credential address and a CIP-8 signer over
 * {@code termsDigest}. {@link #fromMnemonic} builds one from a
 * mnemonic; a wallet or HSM integration supplies its own.
 */
public interface CardanoSellerSigner {

  /**
   * The seller's key-credential address.
   *
   * @return bech32 address
   */
  String sellerAddress();

  /**
   * CIP-30 {@code signData(sellerAddress, termsDigestHex)}.
   *
   * @param sellerAddress the address to sign with
   * @param termsDigestHex the digest as lowercase hex
   * @return the COSE key and signature
   */
  MasumiSellerAuthorization signTerms(String sellerAddress, String termsDigestHex);

  /**
   * A mnemonic-backed seller (account 0, base address).
   *
   * @param mnemonic the BIP-39 phrase
   * @param network the x402 Cardano network
   * @return the signer
   */
  static CardanoSellerSigner fromMnemonic(String mnemonic, String network) {
    return new MnemonicCardanoSellerSigner(mnemonic, network, 0);
  }

  /**
   * A mnemonic-backed seller.
   *
   * @param mnemonic the BIP-39 phrase
   * @param network the x402 Cardano network
   * @param accountIndex the account index
   * @return the signer
   */
  static CardanoSellerSigner fromMnemonic(String mnemonic, String network, int accountIndex) {
    return new MnemonicCardanoSellerSigner(mnemonic, network, accountIndex);
  }
}
