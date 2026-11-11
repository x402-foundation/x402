package org.x402.mechanisms.cardano.exact.server;

import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.x402.core.json.X402Json;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;
import org.x402.mechanisms.cardano.utils.CardanoConstants;
import org.x402.mechanisms.cardano.exact.masumi.MasumiBlueprint;
import org.x402.mechanisms.cardano.exact.masumi.MasumiCommitmentInput;
import org.x402.mechanisms.cardano.exact.masumi.MasumiConstants;
import org.x402.mechanisms.cardano.exact.masumi.MasumiDeployment;
import org.x402.mechanisms.cardano.exact.masumi.MasumiIssue;

/**
 * Issues seller-signed Masumi quotes for route templates.
 */
public final class MasumiQuoteIssuer {

  /** {@code extra} keys a template may carry; everything else is issued. */
  public static final Set<String> TEMPLATE_KEYS =
      Set.of("assetTransferMethod", "confirmationPolicy", "areFeesSponsored", "deployment");

  private static final String TEMPLATE_KEYS_TEXT = "assetTransferMethod, confirmationPolicy, areFeesSponsored, deployment";
  private static final String MCP_PAYMENT_META_KEY = "x402/payment";

  private final MasumiIssuerConfig config;

  /**
   * Creates an issuer.
   *
   * @param config the seller and issuance policy
   */
  public MasumiQuoteIssuer(MasumiIssuerConfig config) {
    this.config = config;
  }

  /**
   * Whether an {@code extra} block selects the Masumi method.
   *
   * @param extra the block
   * @return true for {@code assetTransferMethod: masumi}
   */
  public static boolean isMasumiExtra(Object extra) {
    return extra instanceof Map<?, ?> map && CardanoConstants.METHOD_MASUMI.equals(map.get("assetTransferMethod"));
  }

  /**
   * Whether a Masumi {@code extra} is a template awaiting issuance (no {@code terms} key).
   *
   * @param extra the block
   * @return true for an unissued template
   */
  public static boolean isMasumiTemplate(Object extra) {
    return isMasumiExtra(extra) && !((Map<?, ?>) extra).containsKey("terms");
  }

  private static MasumiDeployment deploymentOf(Object raw) {
    if (raw == null) {
      return null;
    }
    if (raw instanceof MasumiDeployment d) {
      return d;
    }
    @SuppressWarnings("unchecked")
    Map<String, ?> map = (Map<String, ?>) raw;
    return MasumiDeployment.fromJson(map);
  }

  /**
   * Checks a template at route-build time: only template keys, a last deadline inside the
   * horizon, a deployment, and {@code payTo} equal to its escrow address.
   *
   * @param requirements the template
   * @param config the issuer settings
   * @throws IllegalArgumentException when it cannot be issued as declared
   */
  public static void assertMasumiTemplate(PaymentRequirements requirements, MasumiIssuerConfig config) {
    Map<String, Object> extra = requirements.extra();
    for (String key : extra.keySet()) {
      if (!TEMPLATE_KEYS.contains(key)) {
        throw new IllegalArgumentException(
            "Masumi template extra may only carry " + TEMPLATE_KEYS_TEXT + "; found " + key);
      }
    }
    MasumiDeadlineOffsets offsets = config == null ? MasumiDeadlineOffsets.DEFAULT : config.deadlines();
    BigInteger horizon =
        config == null || config.maxDeadlineHorizonMs() == null
            ? MasumiConstants.MAX_DEADLINE_HORIZON_MS
            : config.maxDeadlineHorizonMs();
    BigInteger lastDeadline =
        BigInteger.valueOf(requirements.maxTimeoutSeconds())
            .multiply(BigInteger.valueOf(1000))
            .add(BigInteger.valueOf(offsets.externalDisputeUnlockAfterPayByMs()));
    if (lastDeadline.compareTo(horizon) > 0) {
      throw new IllegalArgumentException(
          "Masumi template maxTimeoutSeconds " + requirements.maxTimeoutSeconds()
              + " pushes externalDisputeUnlockTime past the " + horizon + "ms horizon");
    }
    MasumiDeployment declared = extra.containsKey("deployment") ? deploymentOf(extra.get("deployment")) : null;
    MasumiDeployment deployment =
        MasumiBlueprint.resolveDeployment(
            requirements.network(), declared != null ? declared : config == null ? null : config.deployment());
    if (deployment == null) {
      throw new IllegalArgumentException(
          "Network " + requirements.network()
              + " has no canonical Masumi deployment; supply extra.deployment or masumi.deployment");
    }
    String escrow = MasumiBlueprint.escrowAddress(requirements.network(), deployment);
    if (!escrow.equals(requirements.payTo())) {
      throw new IllegalArgumentException(
          "Masumi route payTo must be the escrow address " + escrow + " on " + requirements.network() + "; got "
              + (requirements.payTo() == null || requirements.payTo().isEmpty() ? "(empty)" : requirements.payTo()));
    }
  }

  /**
   * Checks a template against this issuer's configuration.
   *
   * @param requirements the template
   */
  public void assertTemplate(PaymentRequirements requirements) {
    assertMasumiTemplate(requirements, config);
  }

  /**
   * Reads the paid payload from the transport contexts this package knows: a map with {@code
   * request.paymentHeader} (base64 JSON of the {@code PAYMENT-SIGNATURE} header) or MCP {@code
   * meta["x402/payment"]}.
   *
   * @param transportContext the transport context
   * @return the payload, or {@code null}
   */
  public static PaymentPayload paymentPayloadFromTransportContext(Object transportContext) {
    if (!(transportContext instanceof Map<?, ?> context)) {
      return null;
    }
    Object request = context.get("request");
    Object header = request instanceof Map<?, ?> r ? r.get("paymentHeader") : null;
    if (header instanceof String h && !h.isEmpty()) {
      try {
        JsonNode decoded =
            X402Json.mapper().readTree(new String(Base64.getDecoder().decode(h), StandardCharsets.UTF_8));
        if (isPaymentPayloadLike(decoded)) {
          return X402Json.convert(decoded, PaymentPayload.class);
        }
      } catch (Exception e) {
        // A malformed header fails matching downstream anyway.
      }
    }
    Object meta = context.get("meta");
    if (meta instanceof Map<?, ?> m) {
      JsonNode node = X402Json.mapper().valueToTree(m.get(MCP_PAYMENT_META_KEY));
      if (isPaymentPayloadLike(node)) {
        return X402Json.convert(node, PaymentPayload.class);
      }
    }
    return null;
  }

  private static boolean isPaymentPayloadLike(JsonNode value) {
    return value != null
        && value.isObject()
        && value.path("x402Version").isNumber()
        && value.path("accepted").isObject()
        && value.path("payload").isObject();
  }

  /**
   * The paid payload a 402 answers, if any.
   *
   * @param paymentPayload the payload core passed, or {@code null}
   * @param transportContext the transport context
   * @return the payload, or {@code null}
   */
  public PaymentPayload paidPayload(PaymentPayload paymentPayload, Object transportContext) {
    if (paymentPayload != null) {
      return paymentPayload;
    }
    PaymentPayload fromTransport = paymentPayloadFromTransportContext(transportContext);
    if (fromTransport != null) {
      return fromTransport;
    }
    return config.paymentPayloadFromTransport() == null ? null : config.paymentPayloadFromTransport().apply(transportContext);
  }

  /**
   * Issues a fresh quote for a template: {@code payByTime = now + maxTimeoutSeconds}, later
   * deadlines from the offsets; template fields and {@code extra} keys are kept.
   *
   * @param template the template
   * @param resourceInfo the protected resource
   * @param transportContext the transport context
   * @return the seller-signed requirements
   */
  public PaymentRequirements issue(PaymentRequirements template, ResourceInfo resourceInfo, Object transportContext) {
    Map<String, Object> templateExtra = template.extra();
    CardanoSellerSigner seller = config.seller().apply(template.network());
    MasumiDeployment declared = deploymentOf(templateExtra.get("deployment"));
    MasumiDeployment deployment = declared != null ? declared : config.deployment();
    MasumiIssueContext context = new MasumiIssueContext(template, resourceInfo, transportContext);
    List<MasumiCommitmentInput> commitment =
        config.commitment() != null ? config.commitment().apply(context) : defaultCommitment(context);
    MasumiDeadlineOffsets offsets = config.deadlines();
    long payByMs = config.clock().millis() + template.maxTimeoutSeconds() * 1000L;

    MasumiIssue.Builder input =
        MasumiIssue.Input.builder()
            .network(template.network())
            .asset(template.asset())
            .amount(template.amount())
            .maxTimeoutSeconds(template.maxTimeoutSeconds())
            .sellerAddress(seller.sellerAddress())
            .signTerms(seller::signTerms)
            .commitment(commitment)
            .payByTime(Long.toString(payByMs))
            .submitResultTime(Long.toString(payByMs + offsets.submitResultAfterPayByMs()))
            .unlockTime(Long.toString(payByMs + offsets.unlockAfterPayByMs()))
            .externalDisputeUnlockTime(Long.toString(payByMs + offsets.externalDisputeUnlockAfterPayByMs()))
            .sellerReturnAddress(config.sellerReturnAddress())
            .confirmationPolicy(templateExtra.get("confirmationPolicy"))
            .deployment(deployment)
            .maxDeadlineHorizonMs(config.maxDeadlineHorizonMs())
            .clock(config.clock());
    if (config.agentIdentifierPresent()) {
      input.agentIdentifier(config.agentIdentifier());
    }
    PaymentRequirements issued = MasumiIssue.issue(input.build());
    if (!issued.payTo().equals(template.payTo())) {
      throw new IllegalArgumentException(
          "Masumi route payTo must be the escrow address " + issued.payTo() + " on " + template.network() + "; got "
              + (template.payTo() == null || template.payTo().isEmpty() ? "(empty)" : template.payTo()));
    }
    Map<String, Object> extra = new LinkedHashMap<>(issued.extra());
    if (templateExtra.containsKey("areFeesSponsored")) {
      extra.put("areFeesSponsored", templateExtra.get("areFeesSponsored"));
    }
    return template.withExtra(extra);
  }

  private static List<MasumiCommitmentInput> defaultCommitment(MasumiIssueContext context) {
    String url = context.resourceInfo() == null ? null : context.resourceInfo().url();
    Map<String, Object> content = new LinkedHashMap<>();
    content.put("url", url);
    return List.of(new MasumiCommitmentInput("resource", "jcs", "application/json", content, true));
  }
}
