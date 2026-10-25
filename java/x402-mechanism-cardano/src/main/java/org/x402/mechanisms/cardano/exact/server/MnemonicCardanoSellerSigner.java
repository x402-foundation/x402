package org.x402.mechanisms.cardano.exact.server;

import com.bloxbean.cardano.client.account.Account;
import java.util.HexFormat;
import org.x402.mechanisms.cardano.utils.MnemonicAccounts;
import org.x402.mechanisms.cardano.exact.masumi.MasumiCose;
import org.x402.mechanisms.cardano.exact.masumi.MasumiSellerAuthorization;

/**
 * {@link CardanoSellerSigner} backed by a BIP-39 mnemonic: base address of the account, CIP-8
 * signatures with its payment key.
 */
public final class MnemonicCardanoSellerSigner implements CardanoSellerSigner {

  private final String sellerAddress;
  private final byte[] privateKey;
  private final byte[] publicKey;

  /**
   * Derives the seller wallet.
   *
   * @param mnemonic the BIP-39 phrase
   * @param network the x402 Cardano network
   * @param accountIndex the account index
   */
  public MnemonicCardanoSellerSigner(String mnemonic, String network, int accountIndex) {
    Account account = MnemonicAccounts.account(mnemonic, network, accountIndex);
    this.sellerAddress = account.baseAddress();
    this.privateKey = account.privateKeyBytes();
    this.publicKey = account.publicKeyBytes();
  }

  @Override
  public String sellerAddress() {
    return sellerAddress;
  }

  @Override
  public MasumiSellerAuthorization signTerms(String address, String termsDigestHex) {
    return MasumiCose.signData(address, HexFormat.of().parseHex(termsDigestHex), privateKey, publicKey);
  }
}
