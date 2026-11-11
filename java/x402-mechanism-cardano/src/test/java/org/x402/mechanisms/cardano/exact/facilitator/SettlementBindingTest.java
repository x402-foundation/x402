package org.x402.mechanisms.cardano.exact.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.x402.core.json.X402Json;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;

/**
 * The binding digest equals the cardano-x402-facilitator's {@code SettlementDigest}, so journal
 * rows migrated from it keep their binding. The expected values were produced by running that
 * application's own {@code SettlementDigest.compute} and {@code computeLegacy} on the same wire
 * JSON.
 */
class SettlementBindingTest {

  private static final String PAY_TO = "addr_test1qq9lafv5q6tzm0hj7dhwn9sw3pt8at7utl72lmk4xqcjts2k34ky8776vzes76ae0hhd"
      + "ful5l3ejn2teha8pgsz4jyxquttlcd";
  private static final ResourceInfo WEATHER = ResourceInfo.of("https://api.example.com/weather");

  private static PaymentRequirements wire(int maxTimeout, String extraJson) {
    String json = "{\"scheme\":\"exact\",\"network\":\"cardano:preprod\",\"asset\":\"lovelace\",\"amount\":\"2000000\","
        + "\"payTo\":\"" + PAY_TO + "\",\"maxTimeoutSeconds\":" + maxTimeout
        + (extraJson == null ? "" : ",\"extra\":" + extraJson) + "}";
    JsonNode node;
    try {
      node = X402Json.mapper().readTree(json);
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
    return X402Json.convert(node, PaymentRequirements.class);
  }

  @Test
  void theBindingMatchesTheAppsSettlementDigest() {
    assertThat(SettlementBinding.digest(wire(600, "{}"), WEATHER))
        .isEqualTo("8ee20061f3992159fc0509c0aeefb3a1c476f052fd757abf3aa2c321f739dcab");
    PaymentRequirements policy = wire(600,
        "{\"confirmationPolicy\":{\"l1Confirmations\":1},\"assetTransferMethod\":\"default\"}");
    assertThat(SettlementBinding.digest(policy, WEATHER))
        .isEqualTo("bae5b6fda1f815b122fd0cc13750605cee4758c046716b58cbd2779019582ea1");
    assertThat(SettlementBinding.legacyDigest(policy, WEATHER))
        .isEqualTo("bfc6377928e82540fa2ba9c4b912236ec0dc2e39bcbc7d0700446f3b0d0d0dae");
    PaymentRequirements nested = wire(60, "{\"z\":{\"b\":1.10,\"a\":[3,{\"y\":null,\"x\":\"\\u00e9\"}]},\"a\":true}");
    assertThat(SettlementBinding.digest(nested, null))
        .isEqualTo("cf40299a12acc892c7877bd5caff1048ffaec5a0703d241341c0d51155c620f4");
  }

  @Test
  void theConfirmationPolicyDoesNotChangeTheBinding() {
    PaymentRequirements one = wire(600, "{\"confirmationPolicy\":{\"l1Confirmations\":1},\"assetTransferMethod\":\"default\"}");
    PaymentRequirements three = wire(600, "{\"confirmationPolicy\":{\"l1Confirmations\":3},\"assetTransferMethod\":\"default\"}");
    assertThat(SettlementBinding.digest(one, WEATHER)).isEqualTo(SettlementBinding.digest(three, WEATHER));
  }

  @Test
  void aLegacyDigestOrAnAbsentExtraRecordStillMatches() {
    PaymentRequirements policy = wire(600,
        "{\"confirmationPolicy\":{\"l1Confirmations\":1},\"assetTransferMethod\":\"default\"}");
    assertThat(SettlementBinding.of(policy, WEATHER).matches(
        "bfc6377928e82540fa2ba9c4b912236ec0dc2e39bcbc7d0700446f3b0d0d0dae")).isTrue();
    // The application digested an absent extra as null; the SDK sees an empty map.
    assertThat(SettlementBinding.of(wire(600, "{}"), WEATHER).matches(
        "c2d3ebb1ac471d678408f4754d372d16bfcd43550bb8f4882badf51cb8ffcfc7")).isTrue();
    assertThat(SettlementBinding.of(wire(600, null), WEATHER).matches(
        "c2d3ebb1ac471d678408f4754d372d16bfcd43550bb8f4882badf51cb8ffcfc7")).isTrue();
  }

  @Test
  void aDifferentResourceUrlOrAmountIsADifferentBinding() {
    SettlementBinding base = SettlementBinding.of(wire(600, "{}"), WEATHER);
    assertThat(base.matches(SettlementBinding.digest(wire(600, "{}"),
        ResourceInfo.of("https://api.example.com/other")))).isFalse();
    PaymentRequirements more = wire(600, "{}").withAmount("3000000");
    assertThat(base.matches(SettlementBinding.digest(more, WEATHER))).isFalse();
    assertThat(base.matches(null)).isFalse();
    assertThat(base.matches(base.digest())).isTrue();
  }

  @Test
  void anAbsentTimeoutRecordFromTheAppStillMatches() throws Exception {
    // The application digested an absent maxTimeoutSeconds as null; the SDK reads it as 0.
    String canonical = "{\"requirements\":{\"scheme\":\"exact\",\"network\":\"cardano:preprod\","
        + "\"asset\":\"lovelace\",\"amount\":\"2000000\",\"payTo\":\"" + PAY_TO + "\","
        + "\"maxTimeoutSeconds\":null,\"extra\":{}},\"resource\":\"https://api.example.com/weather\"}";
    String appDigest = java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256")
        .digest(canonical.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
    PaymentRequirements noTimeout = X402Json.convert(X402Json.mapper().readTree(
        "{\"scheme\":\"exact\",\"network\":\"cardano:preprod\",\"asset\":\"lovelace\",\"amount\":\"2000000\","
            + "\"payTo\":\"" + PAY_TO + "\",\"extra\":{}}"), PaymentRequirements.class);

    assertThat(SettlementBinding.of(noTimeout, WEATHER).matches(appDigest)).isTrue();
    assertThat(SettlementBinding.of(wire(600, "{}"), WEATHER).matches(appDigest)).isFalse();
  }
}
