package org.x402.mechanisms.cardano.exact.masumi;

import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.x402.mechanisms.cardano.utils.CardanoAddresses;
import org.x402.mechanisms.cardano.utils.CardanoNetworks;
import org.x402.mechanisms.cardano.utils.PlutusEncoding;
import org.x402.mechanisms.cardano.exact.script.FlatApplier;
import org.x402.mechanisms.cardano.exact.script.ScriptAddresses;

/**
 * Derivation of the deployment-specific {@code vested_pay} escrow address. The verifier derives
 * the address itself from the canonical
 * compiled validator; {@code payTo} is never trusted or defaulted.
 */
public final class MasumiBlueprint {

  /** CIP-57 validator title. */
  public static final String VALIDATOR_TITLE = "vested_pay.vested_pay.spend";
  /** {@code SHA-256(JCS(blueprint))} of the pinned blueprint document. */
  public static final String BLUEPRINT_DIGEST =
      "6249de17bb87c5246106af6b0f33de22b44ca24b9c1445fa36d10eb8b583dec7";

  private static final Map<String, String> CACHE = new LinkedHashMap<>();

  private MasumiBlueprint() {}

  /**
   * The un-applied compiled validator.
   *
   * @return lowercase hex
   */
  public static String compiledCode() {
    return MasumiBlueprintCode.compiledCode();
  }

  /**
   * The deployment that applies to a payment: the declared one, else the canonical one; Preview
   * has none.
   *
   * @param network the network
   * @param declared {@code extra.deployment}, or {@code null}
   * @return the deployment, or {@code null}
   */
  public static MasumiDeployment resolveDeployment(String network, MasumiDeployment declared) {
    if (declared != null) {
      return declared;
    }
    return CardanoNetworks.PREVIEW.equals(CardanoNetworks.normalize(network)) ? null : MasumiDeployment.DEFAULT;
  }

  /**
   * The escrow validator hash for a deployment (memoized).
   *
   * @param deployment the parameters
   * @return lowercase hex script hash
   */
  public static String escrowScriptHash(MasumiDeployment deployment) {
    String key =
        deployment.requiredAdmins() + "|" + String.join(",", deployment.adminVkeys()) + "|" + deployment.cooldownPeriod();
    synchronized (CACHE) {
      String cached = CACHE.get(key);
      if (cached != null) {
        return cached;
      }
    }
    List<PlutusData> admins = new ArrayList<>();
    for (String vkey : deployment.adminVkeys()) {
      admins.add(PlutusEncoding.bytes(vkey));
    }
    byte[] applied =
        FlatApplier.applyParams(
            HexFormat.of().parseHex(MasumiBlueprintCode.compiledCode()),
            List.of(
                PlutusEncoding.integer(new BigInteger(deployment.requiredAdmins())),
                PlutusEncoding.list(admins),
                PlutusEncoding.integer(new BigInteger(deployment.cooldownPeriod()))));
    String hash = HexFormat.of().formatHex(ScriptAddresses.scriptHash("plutusV3", applied));
    synchronized (CACHE) {
      if (CACHE.size() >= MasumiConstants.MAX_SCRIPT_HASH_CACHE_ENTRIES) {
        CACHE.remove(CACHE.keySet().iterator().next());
      }
      CACHE.put(key, hash);
    }
    return hash;
  }

  /**
   * The bech32 enterprise escrow address of a deployment on a network.
   *
   * @param network the network
   * @param deployment the parameters
   * @return the address
   */
  public static String escrowAddress(String network, MasumiDeployment deployment) {
    return CardanoAddresses.enterpriseScriptAddress(network, escrowScriptHash(deployment));
  }
}
