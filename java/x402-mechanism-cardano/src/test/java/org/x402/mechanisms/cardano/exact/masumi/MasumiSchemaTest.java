package org.x402.mechanisms.cardano.exact.masumi;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;
import org.x402.core.types.PaymentRequirements;
import org.x402.mechanisms.cardano.testing.MasumiFixtures;
import org.x402.mechanisms.cardano.testing.TxBuilder;

/**
 * Every rejection detail of the closed Masumi schema.
 */
class MasumiSchemaTest {

  private static final String NETWORK = "cardano:preprod";
  private static final PaymentRequirements QUOTE =
      MasumiFixtures.issue(
          b ->
              b.deployment(new MasumiDeployment("1", List.of(TxBuilder.hash28(4)), "0"))
                  .sellerReturnAddress(MasumiFixtures.SELLER.sellerAddress())
                  .agentIdentifier(null)
                  .confirmationPolicy(Map.of("l1Confirmations", 2)));

  @SuppressWarnings("unchecked")
  private static Map<String, Object> map(Map<String, Object> m, String key) {
    return (Map<String, Object>) m.get(key);
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> part(Map<String, Object> extra) {
    return (Map<String, Object>) ((List<Object>) map(extra, "inputCommitment").get("parts")).get(0);
  }

  private static String detail(Consumer<Map<String, Object>> mutate) {
    Map<String, Object> extra = MasumiFixtures.mutableExtra(QUOTE);
    mutate.accept(extra);
    MasumiSchema.Result r = MasumiSchema.validate(extra, NETWORK);
    assertThat(r.ok()).isFalse();
    return r.detail();
  }

  @Test
  void theFullQuoteValidatesAndKeepsPresence() {
    MasumiSchema.Result r = MasumiSchema.validate(QUOTE.extra(), NETWORK);
    assertThat(r.ok()).isTrue();
    assertThat(r.extra().terms().agentIdentifierPresent()).isTrue();
    assertThat(r.extra().terms().agentIdentifier()).isNull();
    assertThat(r.extra().deployment().requiredAdmins()).isEqualTo("1");
    Map<String, Object> withFees = MasumiFixtures.mutableExtra(QUOTE);
    withFees.put("areFeesSponsored", false);
    assertThat(MasumiSchema.validate(withFees, NETWORK).extra().areFeesSponsored()).isFalse();
    assertThat(MasumiSchema.validate(withFees, NETWORK).extra().toJson()).containsKeys("deployment", "areFeesSponsored");
  }

  @Test
  void extraRules() {
    assertThat(MasumiSchema.validate("x", NETWORK).detail()).isEqualTo("extra must be an object");
    assertThat(detail(e -> e.put("memo", 1))).isEqualTo("extra has unknown field memo");
    assertThat(detail(e -> e.put("assetTransferMethod", "default"))).isEqualTo("extra.assetTransferMethod must be masumi");
    assertThat(detail(e -> e.put("confirmationPolicy", Map.of("l1Confirmations", 99))))
        .isEqualTo("extra.confirmationPolicy must be { l1Confirmations: -1..20 }");
    assertThat(detail(e -> e.put("areFeesSponsored", true))).isEqualTo("extra.areFeesSponsored must be false");
    assertThat(detail(e -> e.put("referenceKey", ""))).isEqualTo("extra.referenceKey must be non-empty lowercase even-length hex");
    assertThat(detail(e -> e.put("referenceSignature", "ABCD")))
        .isEqualTo("extra.referenceSignature must be non-empty lowercase even-length hex");
    assertThat(detail(e -> e.put("blockchainIdentifier", "aa".repeat(8 * 1024 + 1))))
        .isEqualTo("extra.blockchainIdentifier must be non-empty lowercase even-length hex");
  }

  @Test
  void commitmentRules() {
    assertThat(detail(e -> e.put("inputCommitment", 1))).isEqualTo("inputCommitment must be an object");
    assertThat(detail(e -> map(e, "inputCommitment").put("x", 1))).isEqualTo("inputCommitment has unknown field x");
    assertThat(detail(e -> map(e, "inputCommitment").put("version", "2"))).isEqualTo("inputCommitment.version must be '1'");
    assertThat(detail(e -> map(e, "inputCommitment").put("algorithm", "md5")))
        .isEqualTo("inputCommitment.algorithm must be 'sha256'");
    assertThat(detail(e -> map(e, "inputCommitment").put("digest", "00")))
        .isEqualTo("inputCommitment.digest must be 32-byte lowercase hex");
    assertThat(detail(e -> map(e, "inputCommitment").put("parts", List.of())))
        .isEqualTo("inputCommitment.parts must be a non-empty array");
    assertThat(detail(e -> map(e, "inputCommitment").put("parts", List.of(1)))).isEqualTo("parts[0] must be an object");
    assertThat(detail(e -> part(e).put("x", 1))).isEqualTo("parts[0] has unknown field x");
    assertThat(detail(e -> part(e).put("name", ""))).isEqualTo("parts[0].name must be a non-empty string");
    assertThat(detail(e -> part(e).put("canonicalization", "cbor"))).isEqualTo("parts[0].canonicalization must be jcs or raw");
    assertThat(detail(e -> part(e).put("mediaType", 5))).isEqualTo("parts[0].mediaType must be a string");
    assertThat(detail(e -> part(e).put("digest", "zz"))).isEqualTo("parts[0].digest must be 32-byte lowercase hex");
    assertThat(
            detail(
                e -> {
                  Map<String, Object> p = part(e);
                  p.put("canonicalization", "raw");
                  p.put("content", "a=");
                }))
        .isEqualTo("parts[0].content raw content must be canonical unpadded base64url");
    assertThat(
            detail(
                e -> {
                  Map<String, Object> p = part(e);
                  p.put("canonicalization", "raw");
                  p.put("content", "aGl");
                }))
        .isEqualTo("parts[0].content raw content exceeds the byte limit or is not canonical base64url");
    assertThat(detail(e -> part(e).put("content", Double.POSITIVE_INFINITY)))
        .isEqualTo("parts[0].content JCS content contains a non-finite number");
    assertThat(detail(e -> part(e).put("content", new Object()))).isEqualTo("parts[0].content JCS content must contain only plain JSON objects");
    Object deep = "leaf";
    for (int i = 0; i < 70; i++) {
      deep = List.of(deep);
    }
    Object nested = deep;
    assertThat(detail(e -> part(e).put("content", nested))).isEqualTo("parts[0].content JCS content exceeds the nesting limit");
    assertThat(detail(e -> part(e).put("content", "x".repeat(1024 * 1024 + 1))))
        .isEqualTo("parts[0].content JCS content exceeds the byte limit");
    Map<String, Object> bigKey = new LinkedHashMap<>();
    bigKey.put("k".repeat(1024 * 1024 + 1), 1);
    assertThat(detail(e -> part(e).put("content", bigKey))).isEqualTo("parts[0].content JCS content exceeds the byte limit");
    List<Object> many = new ArrayList<>();
    for (int i = 0; i < 100_001; i++) {
      many.add(i);
    }
    assertThat(detail(e -> part(e).put("content", many))).isEqualTo("parts[0].content JCS content exceeds the value limit");
    assertThat(
            detail(
                e -> {
                  @SuppressWarnings("unchecked")
                  List<Object> parts = new ArrayList<>((List<Object>) map(e, "inputCommitment").get("parts"));
                  parts.add(new LinkedHashMap<>(part(e)));
                  map(e, "inputCommitment").put("parts", parts);
                }))
        .isEqualTo("inputCommitment has duplicate part name body");
  }

  @Test
  void termsRules() {
    assertThat(detail(e -> e.put("terms", List.of()))).isEqualTo("terms must be an object");
    assertThat(detail(e -> map(e, "terms").put("amount", "1"))).isEqualTo("terms has unknown field amount");
    assertThat(detail(e -> map(e, "terms").put("version", 1))).isEqualTo("terms.version must be '1'");
    assertThat(detail(e -> map(e, "terms").put("paymentType", "Web3CardanoV1")))
        .isEqualTo("terms.paymentType must be Web3CardanoV2");
    assertThat(detail(e -> map(e, "terms").put("sellerAddress", "addr1qx")))
        .isEqualTo("terms.sellerAddress must be a key-credential address on network");
    assertThat(detail(e -> map(e, "terms").put("sellerReturnAddress", null)))
        .isEqualTo("terms.sellerReturnAddress must be a key-credential address on network");
    assertThat(detail(e -> map(e, "terms").put("sellerNonce", "ab")))
        .isEqualTo("terms.sellerNonce must be 32-byte lowercase hex");
    assertThat(detail(e -> map(e, "terms").put("buyerNonce", "0102")))
        .isEqualTo("terms.buyerNonce must be empty or 14-26 lowercase hex chars");
    assertThat(detail(e -> map(e, "terms").put("agentIdentifier", 7)))
        .isEqualTo("terms.agentIdentifier must be null or lowercase hex");
    assertThat(detail(e -> map(e, "terms").put("inputHash", "00".repeat(32))))
        .isEqualTo("terms.inputHash must equal inputCommitment.digest");
    assertThat(detail(e -> map(e, "terms").put("unlockTime", "01")))
        .isEqualTo("terms.unlockTime must be a positive POSIX-ms integer string");
    assertThat(MasumiSchema.isPosixMsString("1".repeat(21))).isFalse();
  }

  @Test
  void deploymentRules() {
    assertThat(detail(e -> e.put("deployment", "canonical"))).isEqualTo("deployment must be an object");
    assertThat(detail(e -> map(e, "deployment").put("x", 1))).isEqualTo("deployment has unknown field x");
    assertThat(detail(e -> map(e, "deployment").put("adminVkeys", List.of())))
        .isEqualTo("deployment.adminVkeys must be a non-empty array");
    assertThat(detail(e -> map(e, "deployment").put("adminVkeys", List.of("AB"))))
        .isEqualTo("deployment.adminVkeys must be 28-byte lowercase hex");
    assertThat(detail(e -> map(e, "deployment").put("requiredAdmins", "0")))
        .isEqualTo("deployment.requiredAdmins must be a positive integer string");
    assertThat(detail(e -> map(e, "deployment").put("requiredAdmins", "2")))
        .isEqualTo("deployment.requiredAdmins exceeds adminVkeys length");
    assertThat(detail(e -> map(e, "deployment").put("cooldownPeriod", "-1")))
        .isEqualTo("deployment.cooldownPeriod must be a non-negative integer string");
  }
}
