package org.x402.spring.cardano;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.core.env.Environment;
import org.x402.mechanisms.cardano.exact.masumi.MasumiDeployment;

/**
 * The Cardano settings under {@code x402}: the {@code cardano} block of each account and the
 * Cardano payment client ({@code x402.client.cardano}). They share the prefix with {@link
 * org.x402.spring.properties.X402Properties}, so they are bound with {@link #bind(Environment)}
 * rather than as a second {@code @ConfigurationProperties} bean, which would give the IDE two
 * conflicting {@code x402.accounts} entries; their metadata is listed by hand.
 *
 * @param accounts account name → network and Cardano settings
 * @param client the client side ({@code x402.client.cardano})
 */
public record X402CardanoProperties(Map<String, CardanoAccount> accounts, Client client) {

  /** Normalizes absent values. */
  public X402CardanoProperties {
    accounts = accounts == null ? Map.of()
        : Collections.unmodifiableMap(new LinkedHashMap<>(accounts));
    client = client == null ? new Client(null) : client;
  }

  /**
   * Binds the Cardano view of {@code x402.*}.
   *
   * @param environment the environment
   * @return the settings, empty when none are set
   */
  public static X402CardanoProperties bind(Environment environment) {
    return Binder.get(environment).bind("x402", X402CardanoProperties.class)
        .orElseGet(() -> new X402CardanoProperties(null, null));
  }

  /**
   * {@code x402.client}, Cardano part.
   *
   * @param cardano the Cardano payment client
   */
  public record Client(ClientCardano cardano) {

    /** Normalizes an absent block. */
    public Client {
      cardano = cardano == null ? new ClientCardano(null, null) : cardano;
    }
  }

  /**
   * {@code x402.client.cardano}: the wallets the payment client signs with.
   *
   * @param mnemonic the default mnemonic for every network
   * @param networks one entry per Cardano network the client pays on
   */
  public record ClientCardano(String mnemonic, List<CardanoNetwork> networks) {

    /** Normalizes an absent list. */
    public ClientCardano {
      networks = networks == null ? List.of() : List.copyOf(networks);
    }
  }

  /**
   * One client network.
   *
   * @param network the CAIP-2 network
   * @param mnemonic overrides the default mnemonic, may be null
   * @param blockfrost the Blockfrost backend for UTxO lookups
   */
  public record CardanoNetwork(String network, String mnemonic, Blockfrost blockfrost) {}

  /**
   * A Blockfrost backend (client and facilitator server).
   *
   * @param projectId the project id
   * @param baseUrl the API base URL, or blank for the network's default
   */
  public record Blockfrost(String projectId, String baseUrl) {}

  /**
   * One account's Cardano view.
   *
   * @param network the account's network
   * @param cardano the Cardano block, may be null
   */
  public record CardanoAccount(String network, Cardano cardano) {}

  /**
   * x402.accounts.<name>.cardano.
   *
   * @param l1Confirmations the confirmation depth (-1..20) → extra.confirmationPolicy
   * @param masumi Masumi seller settings for the account's network
   */
  public record Cardano(Integer l1Confirmations, Masumi masumi) {}

  /**
   * x402.accounts.<name>.cardano.masumi; the settings of a network are the union of its
   * accounts' blocks.
   *
   * @param sellerMnemonic signs Masumi quotes (a CardanoSellerSigner bean wins)
   * @param sellerReturnAddress optional key-credential payout address
   * @param agentIdentifier optional registry asset id
   * @param deployment a non-canonical escrow deployment (required on Preview)
   */
  public record Masumi(String sellerMnemonic, String sellerReturnAddress, String agentIdentifier,
      Deployment deployment) {}

  /**
   * Masumi escrow validator parameters.
   *
   * @param requiredAdmins positive decimal string
   * @param adminVkeys 28-byte hex key hashes, in order
   * @param cooldownPeriod non-negative decimal string (ms)
   */
  public record Deployment(String requiredAdmins, List<String> adminVkeys,
      String cooldownPeriod) {

    /**
     * The mechanism's deployment.
     *
     * @return the deployment
     */
    public MasumiDeployment toMasumi() {
      return new MasumiDeployment(requiredAdmins, adminVkeys == null ? List.of() : adminVkeys,
          cooldownPeriod);
    }
  }
}
