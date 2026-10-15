package org.x402.spring.client.cardano;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.ObjectProvider;
import org.x402.mechanisms.cardano.utils.CardanoNetworks;
import org.x402.mechanisms.cardano.chain.BlockfrostChainBackend;
import org.x402.mechanisms.cardano.exact.client.ClientCardanoSigner;
import org.x402.mechanisms.cardano.signer.ClientCardanoSignerConfig;
import org.x402.mechanisms.cardano.signer.MnemonicClientCardanoSigner;
import org.x402.spring.X402ConfigurationException;
import org.x402.spring.cardano.NetworkBeans;
import org.x402.spring.cardano.X402CardanoNetworkBeans;
import org.x402.spring.cardano.X402CardanoProperties;

/**
 * The buyer's Cardano wallets, one per {@code x402.client.cardano.networks[]} entry: one
 * signer per network, each with its own chain provider. A signer bean wins over the mnemonic.
 */
public final class X402CardanoClients {

  private final Map<String, ClientCardanoSigner> signers = new LinkedHashMap<>();
  private final Map<String, BlockfrostChainBackend.Config> blockfrost = new LinkedHashMap<>();

  /**
   * Builds the wallets.
   *
   * @param cardano {@code x402.client.cardano}, may be {@code null}
   * @param networkBeans the by-network provider, if any
   * @param signerBean a plain signer bean, if any
   * @throws X402ConfigurationException for an incomplete entry
   */
  public X402CardanoClients(X402CardanoProperties.ClientCardano cardano,
      ObjectProvider<X402CardanoNetworkBeans> networkBeans,
      ObjectProvider<ClientCardanoSigner> signerBean) {
    List<X402CardanoProperties.CardanoNetwork> entries = cardano == null ? List.of() : cardano.networks();
    for (int i = 0; i < entries.size(); i++) {
      X402CardanoProperties.CardanoNetwork entry = entries.get(i);
      String where = "x402.client.cardano.networks[" + i + "]";
      String network = entry == null ? null : entry.network();
      if (!CardanoNetworks.isCardanoNetwork(network)) {
        throw new X402ConfigurationException(where + ".network: " + network
            + " is not a Cardano network (cardano:mainnet, cardano:preprod, cardano:preview)");
      }
      ClientCardanoSigner signer = NetworkBeans.resolve(network, entries.size(), networkBeans,
          b -> b.clientSigner(network), signerBean, "ClientCardanoSigner");
      if (signer == null) {
        // Only the mnemonic signer reads the chain itself; a supplied signer brings its own.
        X402CardanoProperties.Blockfrost bf = entry.blockfrost();
        String projectId = bf == null ? null : bf.projectId();
        String baseUrl = bf == null || bf.baseUrl() == null || bf.baseUrl().isBlank() ? null
            : bf.baseUrl();
        if ((projectId == null || projectId.isBlank()) && baseUrl == null) {
          throw new X402ConfigurationException(where + ".blockfrost.project-id is required (or "
              + "set blockfrost.base-url for a self-hosted endpoint)");
        }
        BlockfrostChainBackend.Config config = BlockfrostChainBackend.Config.builder()
            .network(network).projectId(projectId).baseUrl(baseUrl).build();
        blockfrost.put(network, config);
        String mnemonic = entry.mnemonic() != null && !entry.mnemonic().isBlank()
            ? entry.mnemonic() : cardano.mnemonic();
        if (mnemonic == null || mnemonic.isBlank()) {
          throw new X402ConfigurationException(where + ": no mnemonic; set "
              + "x402.client.cardano.mnemonic, " + where + ".mnemonic, or a ClientCardanoSigner "
              + "bean");
        }
        signer = new MnemonicClientCardanoSigner(ClientCardanoSignerConfig.builder()
            .mnemonic(mnemonic).network(network)
            .walletProvider(new BlockfrostChainBackend(config)).build());
      }
      signers.put(network, signer);
    }
  }

  /**
   * The configured networks.
   *
   * @return the networks in declaration order
   */
  public List<String> networks() {
    return new ArrayList<>(signers.keySet());
  }

  /**
   * The wallet of a network.
   *
   * @param network the network
   * @return the signer, or {@code null}
   */
  public ClientCardanoSigner signer(String network) {
    return signers.get(network);
  }

  /**
   * The Blockfrost settings of a network.
   *
   * @param network the network
   * @return the settings, or {@code null}
   */
  public BlockfrostChainBackend.Config blockfrost(String network) {
    return blockfrost.get(network);
  }
}
