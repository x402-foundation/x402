package org.x402.mechanisms.cardano.exact.server;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.x402.core.PaymentFlow;
import org.x402.core.SchemeNetworkServer.PaymentRequiredContext;
import org.x402.core.json.X402Json;
import org.x402.core.types.AssetAmount;
import org.x402.core.types.Money;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.Price;
import org.x402.core.types.ResourceInfo;
import org.x402.core.types.SupportedKind;
import org.x402.mechanisms.cardano.exact.masumi.InMemoryMasumiTermsStorage;
import org.x402.mechanisms.cardano.exact.masumi.MasumiBlueprint;
import org.x402.mechanisms.cardano.exact.masumi.MasumiDeployment;
import org.x402.mechanisms.cardano.exact.masumi.MasumiDigests;
import org.x402.mechanisms.cardano.exact.masumi.MasumiSchema;
import org.x402.mechanisms.cardano.exact.masumi.MasumiVerifier;
import org.x402.mechanisms.cardano.testing.Vectors;

/**
 * Cardano server scheme: {@code parsePrice}, {@code getAssetDecimals} and {@code
 * enhancePaymentRequirements} on vectors exported from the TypeScript SDK, and Masumi quote
 * issuance from a route template.
 */
class CardanoServerSchemeTest {

  private static final JsonNode VECTORS = Vectors.load("cardano-server.json");
  private static final String PREPROD = "cardano:preprod";
  private static final String SELLER_MNEMONIC =
      "test walk nut penalty hip pave soap entry language right filter choice";
  private static final Clock CLOCK = Clock.fixed(Instant.ofEpochMilli(1_785_755_400_000L), ZoneOffset.UTC);

  private static Price price(JsonNode node) {
    if (node.isTextual()) {
      return new Money(node.asText());
    }
    return X402Json.convert(node, AssetAmount.class);
  }

  @Test
  void parsePriceMatchesTypeScript() {
    var server = new ExactCardanoServerScheme();
    for (JsonNode c : VECTORS.get("parsePrice")) {
      Price price = price(c.get("price"));
      String network = c.get("network").asText();
      if (c.has("error")) {
        assertThatThrownBy(() -> server.parsePrice(price, network))
            .as(c.toString())
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessage(c.get("error").asText());
      } else {
        JsonNode actual = X402Json.mapper().valueToTree(server.parsePrice(price, network));
        assertThat(actual).as(c.toString()).isEqualTo(c.get("result"));
      }
    }
  }

  @Test
  void customMoneyParsersRunFirstInRegistrationOrder() {
    var server = new ExactCardanoServerScheme();
    server
        .registerMoneyParser((amount, network) -> null)
        .registerMoneyParser((amount, network) -> AssetAmount.of("lovelace", "7"))
        .registerMoneyParser((amount, network) -> AssetAmount.of("lovelace", "8"));
    assertThat(server.parsePrice(new Money("$1"), PREPROD).amount()).isEqualTo("7");

    var bad = new ExactCardanoServerScheme().registerMoneyParser((a, n) -> AssetAmount.of("LOVELACE", "1"));
    assertThatThrownBy(() -> bad.parsePrice(new Money("$1"), PREPROD))
        .hasMessage("Custom money parser result asset must use canonical lowercase Cardano form: LOVELACE");
  }

  @Test
  void assetAmountWithoutAssetIsRejected() {
    var server = new ExactCardanoServerScheme();
    assertThatThrownBy(() -> server.parsePrice(new AssetAmount(null, "1", null), PREPROD))
        .hasMessage("Asset unit must be specified for AssetAmount on network cardano:preprod");
  }

  @Test
  void getAssetDecimalsMatchesTypeScript() {
    var server = new ExactCardanoServerScheme();
    for (JsonNode c : VECTORS.get("getAssetDecimals")) {
      Integer expected = c.get("result").isNull() ? null : c.get("result").asInt();
      assertThat(server.getAssetDecimals(c.get("asset").asText(), c.get("network").asText()))
          .as(c.toString())
          .isEqualTo(expected);
    }
  }

  @Test
  void enhancePaymentRequirementsMatchesTypeScript() {
    var server = new ExactCardanoServerScheme();
    for (JsonNode c : VECTORS.get("enhance")) {
      PaymentRequirements requirements = Vectors.requirements(c.get("requirements"));
      SupportedKind kind = X402Json.convert(c.get("supportedKind"), SupportedKind.class);
      if (c.has("error")) {
        assertThatThrownBy(() -> server.enhancePaymentRequirements(requirements, kind, List.of()))
            .as(c.get("name").asText())
            .hasMessage(c.get("error").asText());
      } else {
        JsonNode actual =
            X402Json.mapper().valueToTree(server.enhancePaymentRequirements(requirements, kind, List.of()));
        assertThat(actual).as(c.get("name").asText()).isEqualTo(c.get("result"));
      }
    }
  }

  @Test
  void schemeShapeMatchesTypeScript() {
    var server = new ExactCardanoServerScheme();
    assertThat(server.scheme()).isEqualTo("exact");
    assertThat(server.defaultAssetTransferMethod()).isEqualTo("default");
    assertThat(server.paymentFlows()).containsOnlyKeys("default", "masumi", "script");
    assertThat(server.paymentFlows().values())
        .allMatch(c -> c.defaultFlow() == PaymentFlow.AUTHORIZATION && c.supported().equals(List.of(PaymentFlow.AUTHORIZATION)));
    assertThat(server.schemeHooks().onAfterVerify()).isNotNull();
  }

  // ---------------------------------------------------------------- Masumi issuance

  private static String escrow() {
    return MasumiBlueprint.escrowAddress(PREPROD, MasumiDeployment.DEFAULT);
  }

  private static PaymentRequirements template(Map<String, Object> extra) {
    return new PaymentRequirements("exact", PREPROD, "lovelace", "5000000", escrow(), 600, extra);
  }

  private static ExactCardanoServerScheme issuingServer(InMemoryMasumiTermsStorage storage) {
    return new ExactCardanoServerScheme(
        ExactCardanoServerConfig.builder()
            .masumiStorage(storage)
            .masumi(
                MasumiIssuerConfig.builder()
                    .seller(CardanoSellerSigner.fromMnemonic(SELLER_MNEMONIC, PREPROD))
                    .clock(CLOCK)
                    .build())
            .build());
  }

  private static PaymentRequiredContext context(List<PaymentRequirements> accepts, PaymentPayload paid) {
    return new PaymentRequiredContext(
        accepts, paid, ResourceInfo.of("https://api.example.com/jobs"), null, null, null);
  }

  @Test
  void aTemplateGetsAFreshSellerSignedQuoteThatVerifies() {
    var storage = new InMemoryMasumiTermsStorage();
    var server = issuingServer(storage);
    Map<String, Object> extra = new LinkedHashMap<>();
    extra.put("assetTransferMethod", "masumi");
    extra.put("confirmationPolicy", Map.of("l1Confirmations", 0));
    extra.put("areFeesSponsored", false);
    PaymentRequirements template = template(extra);

    List<PaymentRequirements> served = server.enrichPaymentRequiredResponse(context(List.of(template), null));

    assertThat(served).hasSize(1);
    PaymentRequirements quote = served.get(0);
    assertThat(quote.payTo()).isEqualTo(template.payTo());
    assertThat(quote.amount()).isEqualTo("5000000");
    assertThat(quote.extra()).containsEntry("areFeesSponsored", false);
    var schema = MasumiSchema.validate(quote.extra(), PREPROD);
    assertThat(schema.ok()).isTrue();
    var terms = schema.extra().terms();
    assertThat(terms.payByTime()).isEqualTo(String.valueOf(1_785_755_400_000L + 600_000));
    assertThat(terms.submitResultTime()).isEqualTo(String.valueOf(1_785_755_400_000L + 600_000 + 15 * 60_000));
    assertThat(terms.unlockTime()).isEqualTo(String.valueOf(1_785_755_400_000L + 600_000 + 35 * 60_000));
    assertThat(terms.externalDisputeUnlockTime())
        .isEqualTo(String.valueOf(1_785_755_400_000L + 600_000 + 55 * 60_000));
    assertThat(MasumiVerifier.verifyAuthorization(schema.extra(), quote, MasumiVerifier.AuthorizationOptions.NONE).ok())
        .isTrue();
    assertThat(storage.get(MasumiDigests.termsDigest(quote))).isNotNull();

    // A second unpaid 402 gets a different quote (fresh seller nonce).
    PaymentRequirements another =
        server.enrichPaymentRequiredResponse(context(List.of(template), null)).get(0);
    assertThat(another).isNotEqualTo(quote);

    // A paid retry naming the first quote is answered with exactly that quote.
    PaymentPayload paid = new PaymentPayload(2, null, quote, Map.of("transaction", "x"), null);
    assertThat(server.enrichPaymentRequiredResponse(context(List.of(template), paid)).get(0))
        .isEqualTo(quote);

    // ... also when only the transport carries it (HTTP PAYMENT-SIGNATURE header).
    String header =
        Base64.getEncoder().encodeToString(X402Json.write(paid).getBytes(java.nio.charset.StandardCharsets.UTF_8));
    var viaTransport =
        new PaymentRequiredContext(
            List.of(template),
            null,
            ResourceInfo.of("https://api.example.com/jobs"),
            null,
            null,
            Map.of("request", Map.of("paymentHeader", header)));
    assertThat(server.enrichPaymentRequiredResponse(viaTransport).get(0)).isEqualTo(quote);
  }

  @Test
  void issuedQuotesPassThroughAndAreStored() {
    var storage = new InMemoryMasumiTermsStorage();
    var server = new ExactCardanoServerScheme(ExactCardanoServerConfig.builder().masumiStorage(storage).build());
    PaymentRequirements issued = Vectors.requirements(Vectors.fixture("12-masumi-happy").get("requirements"));

    assertThat(server.enrichPaymentRequiredResponse(context(List.of(issued), null))).isNull();
    assertThat(storage.get(MasumiDigests.termsDigest(issued)).requirements()).isEqualTo(issued);

    assertThatThrownBy(
            () ->
                server.enrichPaymentRequiredResponse(
                    context(List.of(template(Map.of("assetTransferMethod", "masumi"))), null)))
        .hasMessage(
            "Masumi requirements must carry seller-signed terms unless ExactCardanoScheme is configured with a `masumi` issuer");
  }

  @Test
  void templatesAreCheckedAtRouteBuildTime() {
    var server = issuingServer(new InMemoryMasumiTermsStorage());
    SupportedKind kind =
        new SupportedKind(
            2,
            "exact",
            PREPROD,
            Map.of(
                "assetTransferMethods", List.of("default", "masumi", "script"),
                "areFeesSponsored", false,
                "l1Confirmations", Map.of("minimum", 0, "maximum", 20)));

    PaymentRequirements ok = template(Map.of("assetTransferMethod", "masumi"));
    assertThat(server.enhancePaymentRequirements(ok, kind, List.of()).extra())
        .containsEntry("areFeesSponsored", false);

    PaymentRequirements unknownKey = template(Map.of("assetTransferMethod", "masumi", "memo", "x"));
    assertThatThrownBy(() -> server.enhancePaymentRequirements(unknownKey, kind, List.of()))
        .hasMessage(
            "Masumi template extra may only carry assetTransferMethod, confirmationPolicy, areFeesSponsored, deployment; found memo");

    PaymentRequirements wrongPayTo = ok.withPayTo("addr_test1wrong");
    assertThatThrownBy(() -> server.enhancePaymentRequirements(wrongPayTo, kind, List.of()))
        .hasMessageStartingWith("Masumi route payTo must be the escrow address " + escrow());

    PaymentRequirements tooLong =
        new PaymentRequirements(
            "exact", PREPROD, "lovelace", "1", escrow(), 30 * 24 * 3600, Map.of("assetTransferMethod", "masumi"));
    assertThatThrownBy(() -> server.enhancePaymentRequirements(tooLong, kind, List.of()))
        .hasMessageContaining("pushes externalDisputeUnlockTime past the");

    PaymentRequirements preview =
        new PaymentRequirements(
            "exact", "cardano:preview", "lovelace", "1", escrow(), 600, Map.of("assetTransferMethod", "masumi"));
    SupportedKind previewKind = new SupportedKind(2, "exact", "cardano:preview", null);
    assertThatThrownBy(() -> server.enhancePaymentRequirements(preview, previewKind, List.of()))
        .hasMessage(
            "Network cardano:preview has no canonical Masumi deployment; supply extra.deployment or masumi.deployment");
  }

  @Test
  void theSellerSignerFromAMnemonicMatchesTypeScript() {
    JsonNode seller = Vectors.load("masumi-digests.json").get("seller");
    CardanoSellerSigner signer = CardanoSellerSigner.fromMnemonic(seller.get("mnemonic").asText(), PREPROD);

    assertThat(signer.sellerAddress()).isEqualTo(seller.get("sellerAddress").asText());
    var authorization = signer.signTerms(signer.sellerAddress(), seller.get("digest").asText());
    assertThat(authorization.key()).isEqualTo(seller.get("key").asText());
    assertThat(authorization.signature()).isEqualTo(seller.get("signature").asText());
  }
}
