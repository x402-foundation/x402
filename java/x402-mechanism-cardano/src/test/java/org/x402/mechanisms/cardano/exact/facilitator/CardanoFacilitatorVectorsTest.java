package org.x402.mechanisms.cardano.exact.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.math.BigInteger;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.x402.core.FacilitatorContext;
import org.x402.core.json.X402Json;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import com.bloxbean.cardano.client.api.model.ProtocolParams;
import org.x402.mechanisms.cardano.testing.Ccl;
import org.x402.mechanisms.cardano.testing.SnapshotChainBackend;
import org.x402.mechanisms.cardano.testing.Vectors;

/**
 * Java reaches the same decision, reason, message and payer as the TypeScript SDK
 * on every fixture exported by {@code java/tools/ts-vectors}, replayed against
 * the fixture's chain snapshot with {@code Clock.fixed(now)}.
 */
class CardanoFacilitatorVectorsTest {

  private static final String DECODE_FAILED =
      "invalid_exact_cardano_payload_transaction_decode_failed";

  static Stream<Arguments> fixtures() {
    return Vectors.facilitatorFixtures().stream()
        .map(f -> Arguments.of(f.get("id").asText(), f));
  }

  private static ExactCardanoFacilitatorOptions options(JsonNode fixture) {
    JsonNode o = fixture.get("options");
    var builder =
        ExactCardanoFacilitatorOptions.builder()
            .clock(Clock.fixed(Instant.ofEpochMilli(Vectors.now()), ZoneOffset.UTC))
            .settlementStore(new InMemorySettlementClaimStore());
    if (o.has("acceptMempool")) {
      builder.acceptMempool(o.get("acceptMempool").asBoolean());
    }
    if (o.has("confirmationTimeoutMs")) {
      builder.confirmationTimeout(Duration.ofMillis(o.get("confirmationTimeoutMs").asLong()));
    }
    if (o.has("confirmationPollMs")) {
      builder.confirmationPoll(Duration.ofMillis(o.get("confirmationPollMs").asLong()));
    }
    return builder.build();
  }

  @ParameterizedTest(name = "{0}")
  @MethodSource("fixtures")
  void javaDecidesLikeTypeScript(String id, JsonNode fixture) {
    var backend = new SnapshotChainBackend(fixture.get("chain"));
    var scheme = new ExactCardanoFacilitatorScheme(backend, null, options(fixture));
    PaymentPayload payload = Vectors.payload(fixture.get("payload"));
    PaymentRequirements requirements = Vectors.requirements(fixture.get("requirements"));

    Object result =
        "verify".equals(fixture.get("operation").asText())
            ? scheme.verify(payload, requirements, FacilitatorContext.EMPTY)
            : scheme.settle(payload, requirements, FacilitatorContext.EMPTY);

    ObjectNode actual = X402Json.mapper().valueToTree(result);
    ObjectNode expected = fixture.get("expected").deepCopy();
    if ("07c-already-on-ledger".equals(id)) {
      // Deliberate requirement change: the fixture expects ledger evidence to count as validity
      // (isValid true); public verify keeps the spent-nonce check instead, so a landed payment
      // cannot be replayed.
      expected.removeAll();
      expected.put("isValid", false);
      expected.put("invalidReason", "invalid_exact_cardano_payload_nonce_not_on_chain");
      expected.put("payer", fixture.get("expected").get("payer").asText());
    }
    if ("11g-settle-submit-failed".equals(id)) {
      // Deliberate requirement change (D2, user-approved 2026-10-14): the fixture expects an
      // unknown submit outcome to fail; it is pending (the claim is kept, the retry resumes), so a
      // client is never told to pay again for a payment that may still land.
      String txId = expected.get("transaction").asText();
      expected.put("errorReason", "settlement_pending");
      expected.put("errorMessage", "the submission outcome is unknown; retry to resume: "
          + expected.get("errorMessage").asText());
      // The payer is the nonce UTxO's owner, as recorded in the fixture's chain.
      String nonce = fixture.get("payload").get("payload").get("nonce").asText();
      expected.put("payer", fixture.get("chain").get("utxos").get(nonce).get("address").asText());
      ObjectNode pendingExtra = expected.putObject("extra");
      pendingExtra.put("status", "pending");
      pendingExtra.put("transactionId", txId);
    }
    if (DECODE_FAILED.equals(expected.path("invalidReason").asText())) {
      // The message is the CBOR library's own text; only the reason is normative.
      expected.remove("invalidMessage");
      actual.remove("invalidMessage");
    }
    assertThat(actual).as(fixture.get("description").asText()).isEqualTo(expected);
  }

  @Test
  void supportedExtraMatchesTypeScriptForEveryCapabilityCombination() {
    for (JsonNode c : Vectors.load("cardano-facilitator.json").get("supported")) {
      ObjectNode chain = Vectors.fixture("01-default-happy").get("chain").deepCopy();
      chain.put("transactionEvidence", c.get("transactionEvidence").asBoolean());
      var scheme =
          new ExactCardanoFacilitatorScheme(
              new SnapshotChainBackend(chain),
              null,
              ExactCardanoFacilitatorOptions.builder()
                  .acceptMempool(c.get("acceptMempool").asBoolean())
                  .build());
      JsonNode actual = X402Json.mapper().valueToTree(scheme.getExtra("cardano:preprod"));
      assertThat(actual).as(c.toString()).isEqualTo(c.get("extra"));
    }
  }

  @Test
  void protocolParametersComeFromTheReplacementBackend() {
    JsonNode happy = Vectors.fixture("01-default-happy");
    var expensive =
        new SnapshotChainBackend(happy.get("chain"))
            .withProtocolParameters(
                Ccl.params(
                    BigInteger.valueOf(4310), BigInteger.valueOf(44), BigInteger.valueOf(9_000_000)));
    var scheme = new ExactCardanoFacilitatorScheme(expensive, null, options(happy));

    var result =
        scheme.verify(
            Vectors.payload(happy.get("payload")),
            Vectors.requirements(happy.get("requirements")),
            FacilitatorContext.EMPTY);

    assertThat(result.isValid()).isFalse();
    assertThat(result.invalidReason()).isEqualTo("invalid_exact_cardano_payload_fee_below_minimum");

    JsonNode tooExpensive = Vectors.fixture("06d-fee-below-minimum");
    var cheap =
        new SnapshotChainBackend(tooExpensive.get("chain"))
            .withProtocolParameters(
                Ccl.params(
                    BigInteger.valueOf(4310), BigInteger.valueOf(44), BigInteger.valueOf(155381)));
    var ok =
        new ExactCardanoFacilitatorScheme(cheap, null, options(tooExpensive))
            .verify(
                Vectors.payload(tooExpensive.get("payload")),
                Vectors.requirements(tooExpensive.get("requirements")),
                FacilitatorContext.EMPTY);
    assertThat(ok.isValid()).isTrue();
  }

  @Test
  void providerOnlyFacilitatorAdvertisesNoSigners() {
    var backend = new SnapshotChainBackend(Vectors.fixture("01-default-happy").get("chain"));
    var providerOnly =
        new ExactCardanoFacilitatorScheme(backend, null, ExactCardanoFacilitatorOptions.defaults());
    assertThat(providerOnly.getSigners("cardano:preprod")).isEmpty();

    var withSigner =
        new ExactCardanoFacilitatorScheme(
            backend,
            CardanoFacilitatorSigner.ofAddresses(List.of("addr_test1vexample")),
            ExactCardanoFacilitatorOptions.defaults());
    assertThat(withSigner.getSigners("cardano:preprod")).containsExactly("addr_test1vexample");
    assertThat(withSigner.scheme()).isEqualTo("exact");
    assertThat(withSigner.caipFamily()).isEqualTo("cardano:*");
  }

  @Test
  void defaultsMirrorTheTypeScriptConfig() {
    var defaults = ExactCardanoFacilitatorOptions.defaults();
    assertThat(defaults.acceptMempool()).isFalse();
    assertThat(defaults.confirmationTimeout()).isEqualTo(Duration.ofSeconds(75));
    assertThat(defaults.confirmationPoll()).isEqualTo(Duration.ofSeconds(5));
    assertThat(defaults.settlementStore()).isInstanceOf(InMemorySettlementClaimStore.class);
    assertThat(defaults.registryValidator()).isNull();
    assertThat(defaults.deploymentValidator()).isNull();
    assertThat(defaults.clock()).isEqualTo(Clock.systemUTC());
  }

  @Test
  void everyEnumeratedFixtureIsPresent() {
    List<String> ids =
        Vectors.facilitatorFixtures().stream().map(f -> f.get("id").asText()).toList();
    assertThat(ids)
        .contains(
            "01-default-happy",
            "02a-wrong-network-accepted",
            "03-no-payto-output",
            "04-underpay",
            "05-wrong-asset",
            "06-nonce-not-input",
            "07-nonce-spent",
            "08-certificate-present",
            "09-ttl-too-far",
            "10-below-min-utxo",
            "11a-l1-out-of-range",
            "11c-mempool-policy-without-acceptMempool",
            "12-masumi-happy",
            "13-masumi-tampered-datum",
            "14-masumi-bad-cose-signature",
            "15-masumi-unknown-field",
            "16-script-happy",
            "17-script-wrong-datum",
            "18-script-wrong-address");
    Map<String, Object> happy = Vectors.map(Vectors.fixture("01-default-happy").get("expected"));
    assertThat(happy).containsEntry("isValid", true);
  }
}
