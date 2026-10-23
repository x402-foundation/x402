package org.x402.spring.cardano;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import org.apache.commons.logging.Log;
import org.apache.commons.logging.LogFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.x402.mechanisms.cardano.utils.CardanoConstants;
import org.x402.mechanisms.cardano.utils.CardanoNetworks;
import org.x402.mechanisms.cardano.exact.masumi.MasumiBlueprint;
import org.x402.mechanisms.cardano.exact.masumi.MasumiDeployment;
import org.x402.mechanisms.cardano.exact.server.CardanoSellerSigner;
import org.x402.spring.X402ConfigurationException;
import org.x402.spring.properties.X402Properties;

/**
 * What the Cardano resource-server wiring derives from the configuration before any offer is
 * resolved: the Cardano networks in use, each network's Masumi settings (the union of its
 * accounts' {@code cardano.masumi} blocks), the seller per network, and every
 * escrow address and escrow script hash a plain option must never pay into. Networks are keyed by
 * their canonical id, so CIP-34 aliases count as the same network.
 */
public final class CardanoServerPlan {

  private static final Log LOG = LogFactory.getLog(CardanoServerPlan.class);
  private static final String METHOD = "assetTransferMethod";
  private static final String DEPLOYMENT = "deployment";

  /**
   * A network's merged Masumi settings.
   *
   * @param sellerMnemonic the seller mnemonic, or {@code null}
   * @param sellerReturnAddress the payout address, or {@code null}
   * @param agentIdentifier the registry asset id, or {@code null}
   * @param deployment the network's deployment, or {@code null}
   */
  public record MasumiSettings(String sellerMnemonic, String sellerReturnAddress,
      String agentIdentifier, MasumiDeployment deployment) {}

  private final X402CardanoProperties cardano;
  private final Set<String> written = new LinkedHashSet<>();
  private final Set<String> networks = new LinkedHashSet<>();
  private final Map<String, MasumiSettings> settings = new LinkedHashMap<>();
  private final Map<String, CardanoSellerSigner> sellers = new LinkedHashMap<>();
  private final Map<String, Set<String>> escrows = new LinkedHashMap<>();
  private final Map<String, Set<String>> escrowScripts = new LinkedHashMap<>();
  private final List<String> warnings = new ArrayList<>();

  /**
   * Builds the plan.
   *
   * @param properties the starter properties
   * @param cardano the Cardano account blocks
   * @param networkBeans the by-network provider, if any
   * @param sellerBean a plain seller bean, if any
   * @throws X402ConfigurationException for conflicting settings or an ambiguous seller bean
   */
  public CardanoServerPlan(X402Properties properties, X402CardanoProperties cardano,
      ObjectProvider<X402CardanoNetworkBeans> networkBeans,
      ObjectProvider<CardanoSellerSigner> sellerBean) {
    this.cardano = cardano;
    Set<String> masumiAccounts = new LinkedHashSet<>();
    List<Object[]> declared = new ArrayList<>();
    properties.routes().values().forEach(offer -> offer.accepts().forEach(accept -> {
      if (accept == null) {
        return;
      }
      X402Properties.Account account =
          accept.account() == null ? null : properties.accounts().get(accept.account());
      String network = accept.account() != null
          ? (account == null ? null : account.network()) : accept.network();
      if (network == null || !CardanoNetworks.isCardanoNetwork(network)) {
        return;
      }
      written.add(network);
      networks.add(key(network));
      Object method = accept.extra() != null && accept.extra().containsKey(METHOD)
          ? accept.extra().get(METHOD)
          : account != null && account.extra() != null ? account.extra().get(METHOD) : null;
      if (CardanoConstants.METHOD_MASUMI.equals(method) && accept.account() != null) {
        masumiAccounts.add(accept.account());
      }
      if (accept.extra() != null && accept.extra().containsKey(DEPLOYMENT)) {
        declared.add(new Object[] {network, accept.extra().get(DEPLOYMENT)});
      }
      if (accept.price() != null && accept.price().extra().containsKey(DEPLOYMENT)) {
        declared.add(new Object[] {network, accept.price().extra().get(DEPLOYMENT)});
      }
    }));
    properties.accounts().forEach((name, account) -> {
      if (account != null && account.extra() != null && account.extra().containsKey(DEPLOYMENT)
          && CardanoNetworks.isCardanoNetwork(account.network())) {
        declared.add(new Object[] {account.network(), account.extra().get(DEPLOYMENT)});
      }
    });
    mergeSettings(masumiAccounts);
    for (String network : networks) {
      CardanoSellerSigner signer = NetworkBeans.resolve(network, networks.size(), networkBeans,
          b -> b.sellerSigner(network), sellerBean, "CardanoSellerSigner");
      MasumiSettings s = settings(network);
      if (signer == null && s.sellerMnemonic() != null) {
        signer = CardanoSellerSigner.fromMnemonic(s.sellerMnemonic(), network);
      }
      if (signer != null) {
        sellers.put(network, signer);
      }
      addEscrow(network, MasumiBlueprint.resolveDeployment(network, s.deployment()));
      addEscrow(network, MasumiBlueprint.resolveDeployment(network, null));
    }
    for (Object[] entry : declared) {
      try {
        addEscrow((String) entry[0], JsonShapes.deployment(entry[1]));
      } catch (RuntimeException e) {
        // reported with the offer and option index by the contributor
      }
    }
    warnings.forEach(LOG::warn);
  }

  private static String key(String network) {
    return CardanoNetworks.normalize(network);
  }

  private void mergeSettings(Set<String> masumiAccounts) {
    Map<String, Map<String, Object[]>> perNetwork = new LinkedHashMap<>();
    cardano.accounts().forEach((name, account) -> {
      if (account == null || account.cardano() == null || account.cardano().masumi() == null
          || !CardanoNetworks.isCardanoNetwork(account.network())) {
        return;
      }
      if (!masumiAccounts.contains(name)) {
        warnings.add("x402: account \"" + name + "\" has a cardano.masumi block but no Masumi "
            + "option uses it; the settings still apply to " + account.network());
      }
      X402CardanoProperties.Masumi m = account.cardano().masumi();
      String network = key(account.network());
      Map<String, Object[]> merged = perNetwork.computeIfAbsent(network, n -> new LinkedHashMap<>());
      put(merged, network, name, "seller-mnemonic", m.sellerMnemonic());
      put(merged, network, name, "seller-return-address", m.sellerReturnAddress());
      put(merged, network, name, "agent-identifier", m.agentIdentifier());
      put(merged, network, name, DEPLOYMENT,
          m.deployment() == null ? null : m.deployment().toMasumi());
    });
    perNetwork.forEach((network, merged) -> settings.put(network, new MasumiSettings(
        (String) value(merged, "seller-mnemonic"), (String) value(merged, "seller-return-address"),
        (String) value(merged, "agent-identifier"),
        (MasumiDeployment) value(merged, DEPLOYMENT))));
  }

  private static Object value(Map<String, Object[]> merged, String key) {
    Object[] entry = merged.get(key);
    return entry == null ? null : entry[1];
  }

  private static void put(Map<String, Object[]> merged, String network, String account,
      String key, Object value) {
    if (value == null) {
      return;
    }
    Object[] existing = merged.get(key);
    if (existing != null && !Objects.equals(existing[1], value)) {
      throw new X402ConfigurationException("x402.accounts." + account + ".cardano.masumi." + key
          + " conflicts with account \"" + existing[0] + "\" on " + network
          + "; a network has one Masumi seller setting per key");
    }
    merged.put(key, new Object[] {account, value});
  }

  private void addEscrow(String network, MasumiDeployment deployment) {
    if (deployment != null) {
      String k = key(network);
      escrows.computeIfAbsent(k, n -> new LinkedHashSet<>())
          .add(MasumiBlueprint.escrowAddress(k, deployment));
      escrowScripts.computeIfAbsent(k, n -> new LinkedHashSet<>())
          .add(MasumiBlueprint.escrowScriptHash(deployment));
    }
  }

  /**
   * The Cardano networks in use, canonical ids, in first-use order.
   *
   * @return the networks
   */
  public Set<String> networks() {
    return networks;
  }

  /**
   * The network identifiers as written in the configuration (aliases included); schemes are
   * registered under each, so requirement lookups find them.
   *
   * @return the identifiers in first-use order
   */
  public Set<String> writtenNetworks() {
    return written;
  }

  /**
   * A network's merged Masumi settings.
   *
   * @param network the network (aliases accepted)
   * @return the settings, all {@code null} when none are configured
   */
  public MasumiSettings settings(String network) {
    return settings.getOrDefault(key(network), new MasumiSettings(null, null, null, null));
  }

  /**
   * The Masumi seller of a network.
   *
   * @param network the network (aliases accepted)
   * @return the signer, or {@code null}
   */
  public CardanoSellerSigner seller(String network) {
    return sellers.get(key(network));
  }

  /**
   * Escrow addresses known for a network (canonical and configured deployments).
   *
   * @param network the network (aliases accepted)
   * @return the addresses
   */
  public Set<String> escrows(String network) {
    return escrows.getOrDefault(key(network), Set.of());
  }

  /**
   * Escrow script hashes known for a network; any address whose payment credential is one of
   * them pays into the escrow, whatever its stake part.
   *
   * @param network the network (aliases accepted)
   * @return lowercase hex script hashes
   */
  public Set<String> escrowScripts(String network) {
    return escrowScripts.getOrDefault(key(network), Set.of());
  }

  /**
   * Registers a deployment found while resolving an option.
   *
   * @param network the network
   * @param deployment the deployment
   */
  void addDeployment(String network, MasumiDeployment deployment) {
    addEscrow(network, deployment);
  }

  /**
   * The Cardano block of an account.
   *
   * @param account the account name, may be {@code null}
   * @return the block, or {@code null}
   */
  X402CardanoProperties.Cardano block(String account) {
    X402CardanoProperties.CardanoAccount a = account == null ? null
        : cardano.accounts().get(account);
    return a == null ? null : a.cardano();
  }
}
