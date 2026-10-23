package org.x402.spring.facilitator;

import java.time.Clock;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.springframework.beans.factory.ObjectProvider;
import org.x402.mechanisms.cardano.utils.CardanoNetworks;
import org.x402.mechanisms.cardano.chain.BlockfrostChainBackend;
import org.x402.mechanisms.cardano.chain.CardanoChainBackend;
import org.x402.mechanisms.cardano.exact.facilitator.CardanoFacilitatorSigner;
import org.x402.mechanisms.cardano.exact.facilitator.ExactCardanoFacilitatorOptions;
import org.x402.mechanisms.cardano.exact.facilitator.ExactCardanoFacilitatorScheme;
import org.x402.mechanisms.cardano.exact.facilitator.ScriptDatumPolicy;
import org.x402.mechanisms.cardano.exact.facilitator.SettlementClaimStore;
import org.x402.mechanisms.cardano.exact.masumi.MasumiDeploymentValidator;
import org.x402.mechanisms.cardano.exact.masumi.MasumiRegistryValidator;
import org.x402.spring.X402ConfigurationException;
import org.x402.spring.cardano.NetworkBeans;
import org.x402.spring.cardano.X402CardanoNetworkBeans;
import org.x402.spring.cardano.X402CardanoProperties;

/**
 * The auto-built Cardano facilitator schemes, one per {@code
 * x402.facilitator-server.cardano.networks[]} entry. A custom scheme can wrap
 * {@link #forNetwork(String)} by composition (its {@code verify}/{@code settle} are final)
 * and register itself in an {@link X402FacilitatorCustomizer}.
 */
public final class CardanoFacilitatorSchemes {

  private final Map<String, ExactCardanoFacilitatorScheme> schemes = new LinkedHashMap<>();
  private final Map<String, CardanoChainBackend> backends = new LinkedHashMap<>();
  private final Map<String, ExactCardanoFacilitatorOptions> options = new LinkedHashMap<>();

  /**
   * Builds the schemes.
   *
   * @param cardano the Cardano settings
   * @param store the settlement claim store (shared by all networks)
   * @param registry the Masumi registry validator, if any
   * @param deployment the Masumi deployment validator, if any
   * @param clock the clock
   * @param networkBeans the by-network provider, if any
   * @param backendBean a plain backend bean, if any
   * @throws X402ConfigurationException for an incomplete network entry
   */
  public CardanoFacilitatorSchemes(X402FacilitatorServerProperties.Cardano cardano,
      SettlementClaimStore store, MasumiRegistryValidator registry,
      MasumiDeploymentValidator deployment, Clock clock,
      ObjectProvider<X402CardanoNetworkBeans> networkBeans,
      ObjectProvider<CardanoChainBackend> backendBean) {
    List<X402FacilitatorServerProperties.Network> entries = cardano.networks();
    for (int i = 0; i < entries.size(); i++) {
      X402FacilitatorServerProperties.Network entry = entries.get(i);
      String where = "x402.facilitator-server.cardano.networks[" + i + "]";
      String configured = entry == null ? null : entry.network();
      if (!CardanoNetworks.isCardanoNetwork(configured)) {
        throw new X402ConfigurationException(where + ".network: " + configured
            + " is not a Cardano network");
      }
      // A CIP-34 alias configures its canonical network; naming one network twice would give it
      // two schemes and two backends.
      String network = CardanoNetworks.normalize(configured);
      if (schemes.containsKey(network)) {
        throw new X402ConfigurationException(where + ".network: " + configured + " names " + network
            + ", which is already configured");
      }
      com.bloxbean.cardano.client.common.model.SlotConfig slots = slotConfig(where, entry.slotConfig());
      CardanoChainBackend backend = NetworkBeans.resolve(network, entries.size(), networkBeans,
          b -> b.chainBackend(network), backendBean, "CardanoChainBackend");
      if (backend == null) {
        X402CardanoProperties.Blockfrost bf = entry.blockfrost();
        String projectId = bf == null ? null : bf.projectId();
        String baseUrl = bf == null || bf.baseUrl() == null || bf.baseUrl().isBlank() ? null
            : bf.baseUrl();
        if ((projectId == null || projectId.isBlank()) && baseUrl == null) {
          throw new X402ConfigurationException(where + ".blockfrost.project-id is required (or "
              + "set blockfrost.base-url, or define a CardanoChainBackend bean)");
        }
        backend = new BlockfrostChainBackend(BlockfrostChainBackend.Config.builder()
            .network(network).projectId(projectId).baseUrl(baseUrl).clock(clock)
            .slotConfig(slots).networkMagic(networkMagic(network, entry.networkMagic()))
            .maxTipAge(cardano.maxTipAge())
            // The scheme reads the ledger's evidence itself, within its settle deadline; a
            // submit that also waited for inclusion would spend that budget twice.
            .awaitConfirmation(false)
            .evaluation(entry.evaluation() == null || entry.evaluation()).build());
      }
      CardanoFacilitatorSigner signer = entry.mnemonic() == null || entry.mnemonic().isBlank()
          ? null : CardanoFacilitatorSigner.fromMnemonic(entry.mnemonic(), network);
      ExactCardanoFacilitatorOptions opts = ExactCardanoFacilitatorOptions.builder()
          .settlementStore(store).acceptMempool(cardano.acceptMempool())
          .confirmationTimeout(cardano.confirmationTimeout())
          .confirmationPoll(cardano.confirmationPoll())
          .settleTimeout(cardano.settleTimeout())
          .chainCallReserve(cardano.chainCallReserve())
          .registryValidator(registry).deploymentValidator(deployment).clock(clock)
          .slotConfig(slots).lookupTimeout(cardano.lookupTimeout())
          .maxInputLookups(cardano.maxInputLookups())
          .scriptDatumPolicy(scriptDatumPolicy(cardano.scriptDatumPolicy()))
          .maxTransactionBytes(cardano.maxTxBytes())
          .masumiAllowedScriptHashes(scriptHashes(where, entry.masumiAllowedScriptHashes())).build();
      backends.put(network, backend);
      options.put(network, opts);
      schemes.put(network, new ExactCardanoFacilitatorScheme(backend, signer, opts));
    }
  }

  /**
   * The datum policy from its property value. The properties keep it as text, so binding them
   * never loads a Cardano class: a facilitator without the mechanism must still start.
   */
  private static ScriptDatumPolicy scriptDatumPolicy(String value) {
    String name = value == null ? "" : value.strip().toUpperCase(Locale.ROOT).replace('-', '_');
    try {
      return ScriptDatumPolicy.valueOf(name);
    } catch (IllegalArgumentException e) {
      throw new X402ConfigurationException("x402.facilitator-server.cardano.script-datum-policy: "
          + value + " is not one of reference, strict, v3-optional");
    }
  }

  private static Integer networkMagic(String network, Integer configured) {
    if (configured != null) {
      return configured;
    }
    String n = CardanoNetworks.normalize(network);
    if (CardanoNetworks.MAINNET.equals(n)) {
      return 764_824_073;
    }
    if (CardanoNetworks.PREPROD.equals(n)) {
      return 1;
    }
    return CardanoNetworks.PREVIEW.equals(n) ? 2 : null;
  }

  private static com.bloxbean.cardano.client.common.model.SlotConfig slotConfig(String where,
      X402FacilitatorServerProperties.SlotConfig c) {
    if (c == null || (c.zeroTime() == null && c.zeroSlot() == null && c.slotLength() == null)) {
      return null;
    }
    if (c.zeroTime() == null || c.zeroSlot() == null || c.slotLength() == null
        || c.slotLength() <= 0 || c.zeroSlot() < 0) {
      throw new X402ConfigurationException(where + ".slot-config needs zero-time, zero-slot and a "
          + "positive slot-length");
    }
    return new com.bloxbean.cardano.client.common.model.SlotConfig(
        c.slotLength(), c.zeroSlot(), c.zeroTime());
  }

  /**
   * The configured networks.
   *
   * @return the networks in declaration order
   */
  public List<String> networks() {
    return new ArrayList<>(schemes.keySet());
  }

  /**
   * The auto-built scheme of a network.
   *
   * @param network the network
   * @return the scheme, or {@code null}
   */
  public ExactCardanoFacilitatorScheme forNetwork(String network) {
    return schemes.get(network);
  }

  /** The allowlist as lowercase 28-byte hex hashes; anything else fails startup. */
  private static Set<String> scriptHashes(String where, List<String> hashes) {
    Set<String> result = new LinkedHashSet<>();
    if (hashes == null) {
      return result;
    }
    for (String hash : hashes) {
      if (hash == null || !hash.matches("[0-9a-fA-F]{56}")) {
        throw new X402ConfigurationException(where + ".masumi-allowed-script-hashes: " + hash
            + " is not a 28-byte hex script hash");
      }
      result.add(hash.toLowerCase(Locale.ROOT));
    }
    return result;
  }

  /**
   * The chain backend of a network.
   *
   * @param network the network
   * @return the backend, or {@code null}
   */
  public CardanoChainBackend backend(String network) {
    return backends.get(network);
  }

  /**
   * The options a network's scheme was built with.
   *
   * @param network the network
   * @return the options, or {@code null}
   */
  public ExactCardanoFacilitatorOptions options(String network) {
    return options.get(network);
  }
}
