package org.x402.e2e.client.networks.impl;

import java.time.Duration;
import java.util.Optional;
import org.x402.core.client.X402Client;
import org.x402.core.types.SettleResponse;
import org.x402.e2e.client.networks.CatalogNetworks;
import org.x402.e2e.client.networks.E2eClientNetwork;
import org.x402.e2e.client.networks.E2eEnv;
import org.x402.mechanisms.cardano.chain.BlockfrostChainBackend;
import org.x402.mechanisms.cardano.exact.client.ExactCardanoClientScheme;
import org.x402.mechanisms.cardano.signer.ClientCardanoSignerConfig;
import org.x402.mechanisms.cardano.signer.MnemonicClientCardanoSigner;

/**
 * Cardano: exact scheme with a mnemonic wallet on Blockfrost.
 *
 * <p>Env: {@code CLIENT_CARDANO_MNEMONIC} and {@code BLOCKFROST_PROJECT_ID} (both required to
 * register), optional {@code CARDANO_NETWORK} (harness-injected, else the catalog's testnet) and
 * {@code CARDANO_RPC_URL} (Blockfrost base URL, default per network).
 */
public final class CardanoClientNetwork implements E2eClientNetwork {

  /** How long to wait for Blockfrost to list the payment's change output (up to 120 s). */
  private static final Duration WALLET_SETTLE_TIMEOUT = Duration.ofSeconds(120);

  private static final Duration WALLET_SETTLE_POLL = Duration.ofSeconds(3);

  private final String network;
  private final BlockfrostChainBackend blockfrost;
  private final MnemonicClientCardanoSigner signer;

  private CardanoClientNetwork(String network, BlockfrostChainBackend blockfrost,
      MnemonicClientCardanoSigner signer) {
    this.network = network;
    this.blockfrost = blockfrost;
    this.signer = signer;
  }

  /**
   * Creates the Cardano network when its env is set.
   *
   * @return the network, or empty when {@code CLIENT_CARDANO_MNEMONIC} or {@code
   *     BLOCKFROST_PROJECT_ID} is missing
   */
  public static Optional<E2eClientNetwork> fromEnv() {
    String mnemonic = E2eEnv.envOr("CLIENT_CARDANO_MNEMONIC", null);
    if (mnemonic == null) {
      System.err.println("[java-http] cardano skipped: CLIENT_CARDANO_MNEMONIC is not set");
      return Optional.empty();
    }
    String projectId = E2eEnv.envOr("BLOCKFROST_PROJECT_ID", null);
    if (projectId == null) {
      System.err.println("[java-http] cardano skipped: BLOCKFROST_PROJECT_ID is not set");
      return Optional.empty();
    }
    String network = CatalogNetworks.resolveCaip2("cardano");
    String rpcUrl = E2eEnv.envOr("CARDANO_RPC_URL", BlockfrostChainBackend.defaultBaseUrl(network));

    BlockfrostChainBackend blockfrost =
        new BlockfrostChainBackend(
            BlockfrostChainBackend.Config.builder()
                .network(network)
                .baseUrl(rpcUrl)
                .projectId(projectId)
                .build());
    MnemonicClientCardanoSigner signer =
        new MnemonicClientCardanoSigner(
            ClientCardanoSignerConfig.builder()
                .mnemonic(mnemonic)
                .network(network)
                .walletProvider(blockfrost)
                .build());
    System.err.println("[java-http] cardano: " + network + " (" + CatalogNetworks.pattern(network)
        + ")");
    return Optional.of(new CardanoClientNetwork(network, blockfrost, signer));
  }

  @Override
  public String namespace() {
    return CatalogNetworks.namespace(network);
  }

  @Override
  public void register(X402Client client) {
    client.register(CatalogNetworks.pattern(network), new ExactCardanoClientScheme(signer));
  }

  /**
   * Waits until Blockfrost lists this payment's change output. Sequential e2e clients are separate
   * processes and Blockfrost does not see mempool spends, so the next client would otherwise build
   * on the same input.
   */
  @Override
  public void afterSettle(SettleResponse settle) {
    String transaction = settle.transaction();
    String payer = settle.payer();
    if (transaction == null || transaction.isEmpty() || payer == null || payer.isEmpty()) {
      return;
    }
    long deadline = System.nanoTime() + WALLET_SETTLE_TIMEOUT.toNanos();
    while (System.nanoTime() < deadline) {
      try {
        boolean listed =
            blockfrost.getAll(payer).stream()
                .anyMatch(utxo -> transaction.equalsIgnoreCase(utxo.getTxHash()));
        if (listed) {
          return;
        }
      } catch (RuntimeException e) {
        // Transient Blockfrost/network error: keep polling until the deadline.
        System.err.println("[java-http] wallet settle poll failed: " + e.getMessage());
      }
      try {
        Thread.sleep(WALLET_SETTLE_POLL.toMillis());
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        return;
      }
    }
    System.err.println("[java-http] change output of " + transaction + " not listed after "
        + WALLET_SETTLE_TIMEOUT.toSeconds() + " s");
  }
}
