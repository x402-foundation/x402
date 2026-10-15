package org.x402.mechanisms.cardano.exact.client;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.regex.Pattern;
import org.x402.core.SchemeNetworkClient;
import org.x402.core.types.PaymentRequirements;
import org.x402.mechanisms.cardano.utils.CardanoConstants;
import org.x402.mechanisms.cardano.utils.CardanoNetworks;
import org.x402.mechanisms.cardano.utils.CardanoPolicies;
import org.x402.mechanisms.cardano.utils.DefaultAssets;

/**
 * Cardano client for the {@code exact} scheme: validates the
 * requirements, lets the signer build and sign, and returns {@code {transaction, nonce}}. Nothing
 * is broadcast; the facilitator submits during settle. USDM is the network's default asset for
 * spend controls; lovelace is not a default.
 */
public final class ExactCardanoClientScheme implements SchemeNetworkClient {

  private static final Pattern ADDRESS = Pattern.compile("^(addr1|addr_test1)[0-9a-z]+$");

  private final ClientCardanoSigner signer;

  /**
   * Creates the client scheme.
   *
   * @param signer the buyer's wallet
   */
  public ExactCardanoClientScheme(ClientCardanoSigner signer) {
    this.signer = Objects.requireNonNull(signer, "signer");
  }

  @Override
  public String scheme() {
    return CardanoConstants.SCHEME_EXACT;
  }

  @Override
  public DefaultAsset findDefaultAsset(String asset, String network) {
    return DefaultAssets.find(asset, network);
  }

  @Override
  public PaymentPayloadResult createPaymentPayload(
      int x402Version, PaymentRequirements requirements, PaymentPayloadContext context) {
    if (!CardanoNetworks.isCardanoNetwork(requirements.network())) {
      throw new IllegalArgumentException("Unsupported Cardano network: " + requirements.network());
    }
    if (requirements.payTo() == null || requirements.payTo().isEmpty()) {
      throw new IllegalArgumentException("Pay-to address is required");
    }
    if (!ADDRESS.matcher(requirements.payTo()).matches()) {
      throw new IllegalArgumentException("Invalid Cardano pay-to address: " + requirements.payTo());
    }
    if (requirements.asset() == null || requirements.asset().isEmpty()) {
      throw new IllegalArgumentException("Asset is required");
    }
    if (!CardanoConstants.CANONICAL_ASSET.matcher(requirements.asset()).matches()) {
      throw new IllegalArgumentException("Cardano asset must use canonical lowercase form: " + requirements.asset());
    }
    if (requirements.amount() == null || requirements.amount().isEmpty()) {
      throw new IllegalArgumentException("Amount is required");
    }
    if (!CardanoConstants.POSITIVE_CANONICAL_AMOUNT.matcher(requirements.amount()).matches()) {
      throw new IllegalArgumentException("Amount must be a positive canonical integer, got: " + requirements.amount());
    }
    if (CardanoPolicies.l1Confirmations(requirements.extra()) == null) {
      throw new IllegalArgumentException("Cardano payment requirements carry an invalid confirmation policy");
    }
    ClientCardanoSignResult result =
        signer.buildAndSignPaymentTransaction(
            new ClientCardanoSignInput(
                requirements.network(),
                requirements.payTo(),
                requirements.asset(),
                requirements.amount(),
                requirements.maxTimeoutSeconds(),
                requirements.extra(),
                null));
    if (result == null || result.transaction() == null || result.transaction().isEmpty()) {
      throw new IllegalStateException("Cardano signer returned an empty transaction");
    }
    if (result.nonce() == null || !CardanoConstants.UTXO_REF.matcher(result.nonce()).matches()) {
      throw new IllegalStateException("Cardano signer returned an invalid nonce: " + result.nonce());
    }
    Map<String, Object> payload = new LinkedHashMap<>();
    payload.put("transaction", result.transaction());
    payload.put("nonce", result.nonce());
    return new PaymentPayloadResult(x402Version, payload, null);
  }
}
