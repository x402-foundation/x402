package org.x402.mechanisms.cardano.parity;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.math.BigInteger;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.x402.core.FacilitatorContext;
import org.x402.core.json.X402Json;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.mechanisms.cardano.utils.CardanoAddresses;
import org.x402.mechanisms.cardano.utils.CardanoTransactionDecoder;
import org.x402.mechanisms.cardano.utils.DecodedCardanoTransaction;
import org.x402.mechanisms.cardano.utils.Jcs;
import org.x402.mechanisms.cardano.exact.facilitator.ExactCardanoFacilitatorOptions;
import org.x402.mechanisms.cardano.exact.facilitator.ExactCardanoFacilitatorScheme;
import org.x402.mechanisms.cardano.exact.facilitator.InMemorySettlementClaimStore;
import org.x402.mechanisms.cardano.exact.masumi.MasumiBlueprint;
import org.x402.mechanisms.cardano.exact.masumi.MasumiConstants;
import org.x402.mechanisms.cardano.exact.masumi.MasumiCose;
import org.x402.mechanisms.cardano.exact.masumi.MasumiDeployment;
import org.x402.mechanisms.cardano.exact.masumi.MasumiDigests;
import org.x402.mechanisms.cardano.exact.masumi.MasumiIdentifier;
import org.x402.mechanisms.cardano.exact.masumi.MasumiSchema;
import org.x402.mechanisms.cardano.exact.masumi.MasumiVerifier;
import org.x402.mechanisms.cardano.exact.script.ScriptAddresses;
import org.x402.mechanisms.cardano.testing.StubBackend;

/**
 * Independent cross-checks ported from the production Cardano facilitator app (work package N11):
 * transactions built and signed by the pinned TypeScript package, the spec's identifier and
 * LZ-bomb vectors, the Aiken script hash with an applied parameter, the V1/V2/V3 script addresses,
 * the min-UTxO of a 367-byte lock and the app's own COSE triple. Every expectation is the app's
 * published value, so the SDK is checked against a second implementation rather than itself.
 */
class AppParityVectorsTest {

  private static final JsonNode PAYMENTS = load("/parity/app-upstream-payments.json");

  private static final String PREPROD = "cardano:preprod";

  // --- app MasumiBlueprintTest / MasumiIdentifierTest: the spec's published vector ---

  private static final String SPEC_ESCROW =
      "addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g";
  private static final String SPEC_IDENTIFIER =
      "230d7c6574f41d1c0acc96ade8eae04360019f607004d8809c07d005c053019cae007700bce8058680d89818c04e44002c035931a2c00daf5e00ac9bf00b6c401b80473c6535d00e6003cb8b110199db615001ca8eecc6019b58076c603b13763a80";
  private static final String SPEC_TEXT =
      "1111111111111111111111111111111111111111111111111111111111111111..55555555555555555555555555555555.a10101."
          + "addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g";

  /** Produced by lz-string compressToUint8Array: five segments, 33,000 buyer-nonce characters. */
  private static final String LZ_BOMB =
      "230d7c6574f41d010c9c96ade8e6bd9eeff830a38934b3c8b2aba9b6bbe871a79975b7d8f3afb9f7bff818287091a2c788992a7499b2e7c858a97295aad7a8d9ab769dbaf7e83868f193a6cf98b96af59bb6efd878e9f397aedfb8f9ebf79fbefff80c0a0e090d0b0f088c8a8e898d8b8f884c4a4e494d4b4f48cccacec9cdcbcfc82c2a2e292d2b2f28acaaaea9adabafa86c6a6e696d6b6f68eceaeee9edebefe81c1a1e191d1b1f189c9a9e999d9b9f985c5a5e595d5b5f58dcdaded9dddbdfd83c3a3e393d3b3f38bcbabeb9bdbbbfb87c7a7e797d7b7f78fcfafef9fdfbfff8060281c090682c1e088642a1d0986c2e1f084478e00056545a3d118cc563d1886000019f1c0440004d890027003e8005c00a600672a70000660800358d280000";

  // --- app MasumiCoseTest: a genuine CIP-8 seller authorization built by the TypeScript package ---

  private static final String COSE_SELLER = "addr_test1vpt780ulj0qpqs72xwftrvkfuztqxgr43zqk3j4m3x4tndg6qr3hs";
  private static final String COSE_OTHER_SELLER = "addr_test1vrdhewmpp96gv6az4vymy80hlw9082sjz6rylt2srpntsdq6njxxu";
  private static final String COSE_KEY =
      "a401010327200621582017cb79fb2b4120f2b1ec65e4198d6e08b28e813feb01e4a400839b85e18080ce";
  private static final String COSE_SIGNATURE =
      "84582aa201276761646472657373581d6057e3bf9f93c01043ca3392b1b2c9e096032075888168cabb89aab9b5a166686173686564f458203b33aabb96cea60b86f35425717666b5a969584f738a856c0b0d8887c300858958405621924f2a50d0fa1fcc3517500019c16bf4a149c2288f6b813027bd9078dc8df9c36f7509e0d5c418f94e2d8cf79c04e5e8e209fbb1bb3f47bfc186ce167b0a";
  private static final String COSE_DIGEST = "3b33aabb96cea60b86f35425717666b5a969584f738a856c0b0d8887c3008589";

  // --- app TestTx: the shared MINIMAL_PLUTUS_V3 script and its known-good hashes/addresses ---

  private static final String SCRIPT_CODE = "4d01000033222220051200120011";
  private static final String SCRIPT_HASH_V3 = "4fff649fb4372ec3c408b6f0468d74e4d319904cde27fd3f00910a52";
  private static final String SCRIPT_ADDR_V3 = "addr_test1wp8l7eylksmjas7ypzm0q35dwnjdxxvsfn0z0lflqzgs55stpd682";
  private static final String SCRIPT_HASH_V3_INT42 = "7bfdc59e675e288dc869395143d2ed2d227bd23f0663449c847f6fcc";
  private static final String SCRIPT_ADDR_V1 = "addr_test1wpnlxv2xv9a9ucvnvzqakwepzl9ltx7jzgm53av2e9ncv4sysemm8";
  private static final String SCRIPT_ADDR_V2 = "addr_test1wpunlryvl7aqsxe22erzlsseej87v5kk5vutvtrmzdy8dect48z0w";

  private static JsonNode load(String resource) {
    try (InputStream in = AppParityVectorsTest.class.getResourceAsStream(resource)) {
      if (in == null) {
        throw new IllegalStateException("missing " + resource);
      }
      return X402Json.mapper().readTree(in);
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }

  private static Stream<JsonNode> payments(String... names) {
    List<String> wanted = List.of(names);
    return java.util.stream.StreamSupport.stream(PAYMENTS.get("payments").spliterator(), false)
        .filter(p -> wanted.contains(p.get("name").asText()));
  }

  private static Stream<JsonNode> masumiPayments() {
    return payments("masumi-ada", "masumi-token");
  }

  private static Stream<JsonNode> verifiablePayments() {
    return payments("ada", "token", "masumi-ada", "masumi-token", "script");
  }

  private static PaymentRequirements requirements(JsonNode payment) {
    return X402Json.convert(payment.get("requirements"), PaymentRequirements.class);
  }

  private static String transaction(JsonNode payment) {
    return payment.get("payload").get("payload").get("transaction").asText();
  }

  private static Map<String, Object> script(String type, boolean withParameter) {
    Map<String, Object> script = new LinkedHashMap<>();
    script.put("type", type);
    script.put("code", SCRIPT_CODE);
    Map<String, Object> extra = new LinkedHashMap<>();
    extra.put("assetTransferMethod", "script");
    extra.put("script", script);
    if (withParameter) {
      Map<String, Object> p1 = new LinkedHashMap<>();
      p1.put("type", "bigint");
      p1.put("value", "42");
      extra.put("parameters", new LinkedHashMap<>(Map.of("p1", p1)));
    }
    return extra;
  }

  // ------------------------------------------------------------------ TS-built payments

  /** App: MasumiUpstreamCompatibilityTest and UpstreamVerificationTest, through the full scheme. */
  @ParameterizedTest(name = "{0}")
  @MethodSource("paymentNames")
  void tsBuiltPaymentsVerifyThroughTheFullScheme(String name) {
    JsonNode payment = payments(name).findFirst().orElseThrow();
    StubBackend backend = new StubBackend();
    backend.slot = payment.get("currentSlot").asLong();
    payment.get("inputs").fields().forEachRemaining(e -> {
      JsonNode in = e.getValue();
      Map<String, BigInteger> assets = new LinkedHashMap<>();
      in.get("assets").fields().forEachRemaining(a -> assets.put(a.getKey(), new BigInteger(a.getValue().asText())));
      backend.unspent(e.getKey(), in.get("address").asText(), in.get("coin").asLong(), assets);
    });
    var options =
        ExactCardanoFacilitatorOptions.builder()
            .clock(Clock.fixed(Instant.ofEpochMilli(PAYMENTS.get("clockMillis").asLong()), ZoneOffset.UTC))
            .settlementStore(new InMemorySettlementClaimStore())
            .confirmationTimeout(Duration.ofMillis(5))
            .confirmationPoll(Duration.ofMillis(1))
            .build();
    var scheme = new ExactCardanoFacilitatorScheme(backend, null, options);

    var result =
        scheme.verify(
            X402Json.convert(payment.get("payload"), PaymentPayload.class),
            requirements(payment),
            FacilitatorContext.EMPTY);

    assertThat(result.invalidReason()).as(name).isNull();
    assertThat(result.isValid()).as(name).isTrue();
    assertThat(result.payer()).as(name).isEqualTo(payment.get("payer").asText());
    assertThat(CardanoTransactionDecoder.decode(transaction(payment)).txHash())
        .as(name)
        .isEqualTo(payment.get("txHash").asText());
  }

  static Stream<String> paymentNames() {
    return verifiablePayments().map(p -> p.get("name").asText());
  }

  /** App: MasumiUpstreamCompatibilityTest, at the lock-verifier level with the app's 4310 parameter. */
  @Test
  void tsBuiltMasumiAdaAndTokenLocksPassTheLockVerifier() {
    int checked = 0;
    for (JsonNode payment : (Iterable<JsonNode>) masumiPayments()::iterator) {
      String name = payment.get("name").asText();
      PaymentRequirements requirements = requirements(payment);
      DecodedCardanoTransaction tx = CardanoTransactionDecoder.decode(transaction(payment));
      assertThat(tx.signaturesValid()).as(name).isTrue();
      var check =
          MasumiVerifier.verifyLock(
              requirements.extra(),
              requirements,
              tx,
              new MasumiVerifier.LockContext(payment.get("payer").asText(), BigInteger.valueOf(4310), null, null, null));
      assertThat(check.reason()).as(name).isNull();
      assertThat(check.ok()).as(name).isTrue();
      checked++;
    }
    assertThat(checked).isEqualTo(2);
  }

  /** App: MasumiDigestsTest#termsAndCommitmentDigestsMatchPinnedTypeScript. */
  @Test
  void termsAndCommitmentDigestsMatchThePinnedTypeScriptPackage() {
    int checked = 0;
    for (JsonNode payment : (Iterable<JsonNode>) masumiPayments()::iterator) {
      String name = payment.get("name").asText();
      PaymentRequirements requirements = requirements(payment);
      assertThat((JsonNode) X402Json.mapper().valueToTree(MasumiDigests.buildSignedTerms(requirements)))
          .as(name)
          .isEqualTo(payment.get("signedTerms"));
      assertThat(MasumiDigests.termsDigest(requirements)).as(name).isEqualTo(payment.get("termsDigest").asText());
      @SuppressWarnings("unchecked")
      Map<String, Object> commitment = (Map<String, Object>) requirements.extra().get("inputCommitment");
      assertThat(MasumiDigests.computeInputHash(commitment)).as(name).isEqualTo(payment.get("inputHash").asText());
      checked++;
    }
    assertThat(checked).isEqualTo(2);
  }

  /** App: MasumiDigestsTest#numbersUnicodeNullAndKeyOrderMatchPinnedTypeScript. */
  @Test
  void jcsAndCommitmentPartDigestsMatchThePinnedTypeScriptPackage() throws Exception {
    int checked = 0;
    for (JsonNode vector : PAYMENTS.get("jcs")) {
      Object content = X402Json.mapper().treeToValue(vector.get("content"), Object.class);
      assertThat(Jcs.canonicalize(content)).as(vector.toString()).isEqualTo(vector.get("canonical").asText());
      assertThat(MasumiDigests.commitmentPartDigest("jcs", content))
          .as(vector.toString())
          .isEqualTo(vector.get("digest").asText());
      checked++;
    }
    assertThat(checked).isPositive();
  }

  // ------------------------------------------------------------------ identifier and escrow

  /** App: MasumiBlueprintTest#derivesTheSpecEscrowAddressFromTheDefaultDeployment. */
  @Test
  void theSpecEscrowAddressDerivesFromTheDefaultDeployment() {
    assertThat(MasumiBlueprint.escrowAddress(PREPROD, MasumiDeployment.DEFAULT)).isEqualTo(SPEC_ESCROW);
  }

  /** App: MasumiIdentifierTest#decodesTheSpecVector and #roundTripsThroughTheIdentifierText. */
  @Test
  void theSpecIdentifierVectorDecodesAndRoundTrips() {
    MasumiIdentifier.Parts parts = MasumiIdentifier.decode(SPEC_IDENTIFIER);

    assertThat(parts).isNotNull();
    assertThat(parts.sellerNonce()).isEqualTo("11".repeat(32));
    assertThat(parts.agentIdentifier()).isEmpty();
    assertThat(parts.buyerNonce()).isEmpty();
    assertThat(parts.referenceSignature()).isEqualTo("55".repeat(16));
    assertThat(parts.referenceKey()).isEqualTo("a10101");
    assertThat(parts.contractAddress()).isEqualTo(SPEC_ESCROW);
    assertThat(MasumiIdentifier.buildText(parts)).isEqualTo(SPEC_TEXT);
  }

  /** The reverse direction of the spec vector: the SDK's LZ encoder emits the spec's bytes. */
  @Test
  void theSdkEncoderReproducesTheSpecIdentifierBytes() {
    MasumiIdentifier.Parts parts = MasumiIdentifier.decode(SPEC_IDENTIFIER);
    assertThat(MasumiIdentifier.encode(parts)).isEqualTo(SPEC_IDENTIFIER);
  }

  /** App: MasumiIdentifierTest#boundsExpansionBeforeAllocatingAnOversizedIdentifier. */
  @Test
  void anLzBombIsRefusedBeforeItIsExpanded() {
    assertThat(MasumiIdentifier.decode(LZ_BOMB)).isNull();
    assertThat(MasumiIdentifier.decode("00".repeat(8193))).isNull();
  }

  // ------------------------------------------------------------------ COSE triple

  /** App: MasumiCoseTest. The seller signature is the app's own triple (key, signature, digest). */
  @Test
  void theAppsCoseTripleVerifiesAndOnlyThatTriple() {
    assertThat(MasumiCose.verifySellerTermsSignature(COSE_KEY, COSE_SIGNATURE, COSE_SELLER, COSE_DIGEST)).isTrue();
    // a different digest, i.e. the price re-quoted
    assertThat(MasumiCose.verifySellerTermsSignature(COSE_KEY, COSE_SIGNATURE, COSE_SELLER, "00".repeat(32)))
        .isFalse();
    // a key that does not control the seller address
    assertThat(MasumiCose.verifySellerTermsSignature(COSE_KEY, COSE_SIGNATURE, COSE_OTHER_SELLER, COSE_DIGEST))
        .isFalse();
    // malformed COSE objects
    assertThat(MasumiCose.verifySellerTermsSignature("a10101", COSE_SIGNATURE, COSE_SELLER, COSE_DIGEST)).isFalse();
    assertThat(MasumiCose.verifySellerTermsSignature(COSE_KEY, "deadbeef", COSE_SELLER, COSE_DIGEST)).isFalse();
  }

  /** App: MasumiCoseTest#reconstructsTheSameTermsDigestAsTypeScript. */
  @Test
  void theSdkRebuildsTheTermsDigestOfTheAppsCoseTriple() {
    Map<String, Object> terms = new LinkedHashMap<>();
    terms.put("version", "1");
    terms.put("paymentType", "Web3CardanoV2");
    terms.put("sellerAddress", COSE_SELLER);
    terms.put("sellerNonce", "0000000000000000000000000000000000000000000000000000000000000004");
    terms.put("buyerNonce", "");
    terms.put("inputHash", "a04e62604bb67a7e1dc06926a0d6d040fd8d60cc28b2cb5fb94afcfff5d7bcea");
    terms.put("payByTime", "1789992600000");
    terms.put("submitResultTime", "1789993800000");
    terms.put("unlockTime", "1789994700000");
    terms.put("externalDisputeUnlockTime", "1789995600000");
    Map<String, Object> extra = new LinkedHashMap<>();
    extra.put("assetTransferMethod", "masumi");
    extra.put("terms", terms);

    PaymentRequirements at3 = new PaymentRequirements("exact", PREPROD, "lovelace", "3000000", SPEC_ESCROW, 600, extra);
    PaymentRequirements at9 = new PaymentRequirements("exact", PREPROD, "lovelace", "9000000", SPEC_ESCROW, 600, extra);

    assertThat(MasumiDigests.termsDigest(at3)).isEqualTo(COSE_DIGEST);
    assertThat(MasumiDigests.termsDigest(at9)).isNotEqualTo(COSE_DIGEST);
    assertThat(MasumiCose.verifySellerTermsSignature(COSE_KEY, COSE_SIGNATURE, COSE_SELLER, MasumiDigests.termsDigest(at9)))
        .isFalse();
  }

  /** The schema accepts the app's TS-built extras (shape parity). */
  @Test
  void theSchemaAcceptsEveryTsBuiltMasumiExtra() {
    for (JsonNode payment : (Iterable<JsonNode>) masumiPayments()::iterator) {
      PaymentRequirements r = requirements(payment);
      assertThat(MasumiSchema.validate(r.extra(), r.network()).ok()).as(payment.get("name").asText()).isTrue();
    }
  }

  // ------------------------------------------------------------------ scripts and min-UTxO

  /** App: ScriptAddressConformanceTest#derivesEmptyParamsHashMatchingReference. */
  @Test
  void theMinimalPlutusV3ScriptHashesToTheAppsReferenceHash() {
    assertThat(ScriptAddresses.deriveScriptHashHex(script("plutusV3", false))).isEqualTo(SCRIPT_HASH_V3);
  }

  /** App: ScriptAddressConformanceTest#derivesParametrizedHashMatchingReference (Aiken INT42). */
  @Test
  void theAikenScriptWithTheParameterBigint42HashesToTheAppsReferenceHash() {
    assertThat(ScriptAddresses.deriveScriptHashHex(script("plutusV3", true))).isEqualTo(SCRIPT_HASH_V3_INT42);
  }

  /** App: TestTx.SCRIPT_ADDR_V1/V2/V3 -- one code, three language tags, three addresses. */
  @Test
  void theSameCodeHasADifferentAddressPerPlutusLanguage() {
    assertThat(address("plutusV1")).isEqualTo(SCRIPT_ADDR_V1);
    assertThat(address("plutusV2")).isEqualTo(SCRIPT_ADDR_V2);
    assertThat(address("plutusV3")).isEqualTo(SCRIPT_ADDR_V3);
    assertThat(ScriptAddresses.scriptAddressMatches(script("plutusV1", false), SCRIPT_ADDR_V1)).isTrue();
    assertThat(ScriptAddresses.scriptAddressMatches(script("plutusV2", false), SCRIPT_ADDR_V2)).isTrue();
    assertThat(ScriptAddresses.scriptAddressMatches(script("plutusV3", false), SCRIPT_ADDR_V3)).isTrue();
    assertThat(ScriptAddresses.scriptAddressMatches(script("plutusV3", false), SCRIPT_ADDR_V2)).isFalse();
  }

  /** App: ScriptAddressConformanceTest#matchesScriptHashOnly / #isParameterSensitive. */
  @Test
  void aHashOnlyDescriptorMatchesAndAnAppliedParameterDoesNot() {
    assertThat(ScriptAddresses.scriptAddressMatches(
            Map.of("assetTransferMethod", "script", "scriptHash", SCRIPT_HASH_V3), SCRIPT_ADDR_V3))
        .isTrue();
    assertThat(ScriptAddresses.scriptAddressMatches(script("plutusV3", true), SCRIPT_ADDR_V3)).isFalse();
  }

  private static String address(String type) {
    return CardanoAddresses.enterpriseScriptAddress(PREPROD, ScriptAddresses.deriveScriptHashHex(script(type, false)));
  }

  /** App: MasumiTransferVerifierTest#crossImplementationMinUtxoFixture (367-byte lock datum). */
  @Test
  void theMinUtxoOfA367ByteLockMatchesTheTypeScriptFixture() {
    BigInteger coinsPerUtxoByte = BigInteger.valueOf(4310);

    assertThat(MasumiConstants.minUtxoLovelace(367, 0, coinsPerUtxoByte)).isEqualTo(BigInteger.valueOf(3_124_750));
    assertThat(MasumiConstants.minUtxoLovelace(367, 1, coinsPerUtxoByte)).isEqualTo(BigInteger.valueOf(3_340_250));
  }
}
