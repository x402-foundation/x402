package org.x402.mechanisms.cardano.parity;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.get;
import static com.github.tomakehurst.wiremock.client.WireMock.getRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.okJson;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static com.github.tomakehurst.wiremock.core.WireMockConfiguration.wireMockConfig;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.common.model.Networks;
import com.bloxbean.cardano.client.common.model.SlotConfig;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.github.tomakehurst.wiremock.junit5.WireMockExtension;
import java.math.BigInteger;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.RegisterExtension;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.x402.core.FacilitatorContext;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.mechanisms.cardano.utils.CardanoErrors;
import org.x402.mechanisms.cardano.utils.CardanoNetworks;
import org.x402.mechanisms.cardano.utils.CardanoPolicies;
import org.x402.mechanisms.cardano.utils.CardanoTransactionDecoder;
import org.x402.mechanisms.cardano.utils.DecodedCardanoTransaction;
import org.x402.mechanisms.cardano.utils.Jcs;
import org.x402.mechanisms.cardano.utils.PlutusEncoding;
import org.x402.mechanisms.cardano.chain.BlockfrostChainBackend;
import org.x402.mechanisms.cardano.chain.ChainLookupException;
import org.x402.mechanisms.cardano.exact.facilitator.ExactCardanoFacilitatorOptions;
import org.x402.mechanisms.cardano.exact.facilitator.ExactCardanoFacilitatorScheme;
import org.x402.mechanisms.cardano.exact.masumi.MasumiDatum;
import org.x402.mechanisms.cardano.exact.masumi.MasumiDigests;
import org.x402.mechanisms.cardano.exact.masumi.MasumiIdentifier;
import org.x402.mechanisms.cardano.exact.masumi.MasumiSchema;
import org.x402.mechanisms.cardano.exact.masumi.MasumiVerifier;
import org.x402.mechanisms.cardano.exact.script.ScriptAddresses;
import org.x402.mechanisms.cardano.testing.FakeChain;
import org.x402.mechanisms.cardano.testing.MasumiFixtures;
import org.x402.mechanisms.cardano.testing.StubBackend;
import org.x402.mechanisms.cardano.testing.TxBuilder;
import org.x402.mechanisms.cardano.testing.Vectors;

/**
 * Regression guards (work package N12) for rules the production app pins by test and the SDK
 * enforces only in code: the Masumi schema bounds, surrogate refusal in every canonicalized
 * string, the COSE curve, the escrow output count, identifier tampering, the decoder's
 * width and duplicate-key gates, the slot clock, the protocol-parameter cache and the settlement
 * policy rules. Each test passes against the current SDK; it only ever tightens.
 */
class AppParityGuardsTest {

  private static final String PREPROD = "cardano:preprod";
  private static final BigInteger CPUB = BigInteger.valueOf(4310);

  // =================================================================== Unicode (MasumiUnicodeTest)

  static Stream<String> malformedUnicode() {
    String high = String.valueOf((char) 0xd800);
    String low = String.valueOf((char) 0xdc00);
    return Stream.of(high, low, high + "a", "a" + low, high + high, low + low, low + high);
  }

  @ParameterizedTest(name = "malformed value {index}")
  @MethodSource("malformedUnicode")
  void theCanonicalizerRejectsUnpairedSurrogatesInValuesAndNestedValues(String invalid) {
    assertThatThrownBy(() -> Jcs.canonicalize(invalid)).isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> Jcs.canonicalize(Map.of("nested", List.of(invalid))))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @ParameterizedTest(name = "malformed key {index}")
  @MethodSource("malformedUnicode")
  void theCanonicalizerRejectsUnpairedSurrogatesInObjectKeys(String invalid) {
    assertThatThrownBy(() -> Jcs.canonicalize(Map.of(invalid, "value"))).isInstanceOf(IllegalArgumentException.class);
  }

  @ParameterizedTest(name = "commitment content {index}")
  @MethodSource("malformedUnicode")
  void aCommitmentPartDigestRejectsMalformedJcsContentAndKeys(String invalid) {
    assertThatThrownBy(() -> MasumiDigests.commitmentPartDigest("jcs", invalid))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> MasumiDigests.commitmentPartDigest("jcs", Map.of(invalid, true)))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @ParameterizedTest(name = "commitment manifest {index}")
  @MethodSource("malformedUnicode")
  void theManifestDigestRejectsMalformedNamesAndMediaTypes(String invalid) {
    for (String field : List.of("name", "mediaType")) {
      Map<String, Object> commitment = commitment(MasumiFixtures.mutableExtra(MasumiFixtures.issue(b -> {})));
      part(commitment).put(field, invalid);
      assertThatThrownBy(() -> MasumiDigests.computeInputHash(commitment))
          .as(field)
          .isInstanceOf(IllegalArgumentException.class);
    }
  }

  @ParameterizedTest(name = "signed terms {index}")
  @MethodSource("malformedUnicode")
  void theTermsDigestRejectsMalformedKeysAndEveryStringValue(String invalid) {
    Map<String, Object> signed = MasumiDigests.buildSignedTerms(MasumiFixtures.issue(b -> {}));
    int strings = 0;
    for (Map.Entry<String, Object> entry : signed.entrySet()) {
      if (!(entry.getValue() instanceof String)) {
        continue;
      }
      Map<String, Object> mutated = new LinkedHashMap<>(signed);
      mutated.put(entry.getKey(), invalid);
      assertThatThrownBy(() -> MasumiDigests.computeTermsDigest(mutated))
          .as(entry.getKey())
          .isInstanceOf(IllegalArgumentException.class);
      strings++;
    }
    assertThat(strings).isGreaterThan(5);
    Map<String, Object> keyed = new LinkedHashMap<>(signed);
    keyed.put(invalid, "value");
    assertThatThrownBy(() -> MasumiDigests.computeTermsDigest(keyed)).isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void validSurrogatePairsAndNullStayCanonicalizableAndSchemaValid() {
    String emoji = new String(Character.toChars(0x1f600));
    Map<String, Object> content = new LinkedHashMap<>();
    content.put(emoji, "prefix" + emoji + "suffix");
    content.put("null", null);

    assertThat(Jcs.canonicalize(content))
        .isEqualTo("{\"null\":null,\"" + emoji + "\":\"prefix" + emoji + "suffix\"}");
    assertThat(Jcs.canonicalize(null)).isEqualTo("null");
  }

  @Test
  void malformedPartContentCannotBeSignedOrVerifiedAsALock() {
    // App: presentMalformedContentIsACommitmentFailure / malformedManifestStringsUseUpstreamGeneric...
    // A part whose content is an unpaired surrogate must never reach a successful lock check, and
    // the lock with that part's content absent (digest only) is accepted.
    PaymentRequirements quote = MasumiFixtures.issue(b -> {});
    Map<String, Object> noContent = MasumiFixtures.mutableExtra(quote);
    part(commitment(noContent)).remove("content");
    assertThat(lock(quote, noContent).ok()).isTrue();

    Map<String, Object> bad = MasumiFixtures.mutableExtra(quote);
    part(commitment(bad)).put("content", String.valueOf((char) 0xd800));
    MasumiVerifier.Check check = lock(quote, bad);
    assertThat(check.ok()).isFalse();
    assertThat(check.reason()).isIn(CardanoErrors.MASUMI_COMMITMENT, CardanoErrors.MASUMI_SCHEMA);

    for (String field : List.of("name", "mediaType")) {
      Map<String, Object> manifest = MasumiFixtures.mutableExtra(quote);
      part(commitment(manifest)).remove("content");
      part(commitment(manifest)).put(field, String.valueOf((char) 0xdc00));
      // The app answers its generic verification error; the SDK's verifyLock throws and the
      // scheme maps that to invalid_exact_cardano_payload_verification_error. Either is a refusal.
      assertThat(refused(() -> lock(quote, manifest))).as(field).isTrue();
    }
  }

  private static boolean refused(java.util.function.Supplier<MasumiVerifier.Check> check) {
    try {
      return !check.get().ok();
    } catch (IllegalArgumentException e) {
      return true;
    }
  }

  // =================================================================== COSE

  @Test
  void aCoseKeyOnAnyCurveButEd25519IsRefusedEvenWithAValidSignature() {
    String key = "a401010327200621582017cb79fb2b4120f2b1ec65e4198d6e08b28e813feb01e4a400839b85e18080ce";
    String signature =
        "84582aa201276761646472657373581d6057e3bf9f93c01043ca3392b1b2c9e096032075888168cabb89aab9b5a166686173686564f458203b33aabb96cea60b86f35425717666b5a969584f738a856c0b0d8887c300858958405621924f2a50d0fa1fcc3517500019c16bf4a149c2288f6b813027bd9078dc8df9c36f7509e0d5c418f94e2d8cf79c04e5e8e209fbb1bb3f47bfc186ce167b0a";
    String seller = "addr_test1vpt780ulj0qpqs72xwftrvkfuztqxgr43zqk3j4m3x4tndg6qr3hs";
    String digest = "3b33aabb96cea60b86f35425717666b5a969584f738a856c0b0d8887c3008589";

    assertThat(org.x402.mechanisms.cardano.exact.masumi.MasumiCose.verifySellerTermsSignature(
            key, signature, seller, digest))
        .isTrue();
    for (String crv : List.of("2007", "2001", "2000")) {
      String wrongCurve = key.replaceFirst("2006", crv);
      assertThat(wrongCurve).isNotEqualTo(key);
      assertThat(org.x402.mechanisms.cardano.exact.masumi.MasumiCose.verifySellerTermsSignature(
              wrongCurve, signature, seller, digest))
          .as("crv " + crv)
          .isFalse();
    }
  }

  // =================================================================== escrow and identifier

  @Test
  void aSecondEscrowOutputIsRefusedEvenWhenOnlyOneCarriesADatum() {
    PaymentRequirements quote = MasumiFixtures.issue(b -> {});
    DecodedCardanoTransaction tx = lockTx(quote);
    DecodedCardanoTransaction.Output first = tx.outputs().get(0);
    DecodedCardanoTransaction.Output datumless =
        new DecodedCardanoTransaction.Output(first.address(), first.coin(), Map.of(), null, 0, false);

    assertThat(lock(quote, quote.extra(), tx).ok()).isTrue();
    for (DecodedCardanoTransaction.Output second : List.of(first, datumless)) {
      List<DecodedCardanoTransaction.Output> outputs = new ArrayList<>(tx.outputs());
      outputs.add(second);
      MasumiVerifier.Check check = lock(quote, quote.extra(), withOutputs(tx, outputs));
      assertThat(check.ok()).isFalse();
      assertThat(check.reason()).isEqualTo(CardanoErrors.MASUMI_ESCROW_OUTPUT_COUNT);
    }
  }

  @Test
  void tamperingWithAnyOfTheSixIdentifierComponentsIsRefused() {
    PaymentRequirements quote = MasumiFixtures.issue(b -> {});
    for (int index = 0; index < 6; index++) {
      Map<String, Object> extra = MasumiFixtures.mutableExtra(quote);
      MasumiIdentifier.Parts decoded = MasumiIdentifier.decode((String) extra.get("blockchainIdentifier"));
      String[] parts = {
        decoded.sellerNonce(), decoded.agentIdentifier(), decoded.buyerNonce(),
        decoded.referenceSignature(), decoded.referenceKey(), decoded.contractAddress()
      };
      parts[index] =
          index == 5 ? MasumiFixtures.SELLER.sellerAddress() : "ff" + parts[index].substring(Math.min(parts[index].length(), 2));
      extra.put(
          "blockchainIdentifier",
          MasumiIdentifier.encode(
              new MasumiIdentifier.Parts(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5])));

      MasumiVerifier.Check check = lock(quote, extra);

      assertThat(check.ok()).as("component " + index).isFalse();
      assertThat(check.reason()).as("component " + index).isEqualTo(CardanoErrors.MASUMI_IDENTIFIER);
    }
  }

  @Test
  void anUppercaseIdentifierIsNeitherDecodedNorAcceptedByTheSchema() {
    Map<String, Object> extra = MasumiFixtures.mutableExtra(MasumiFixtures.issue(b -> {}));
    String identifier = (String) extra.get("blockchainIdentifier");

    assertThat(MasumiIdentifier.decode(identifier)).isNotNull();
    assertThat(MasumiIdentifier.decode(identifier.toUpperCase())).isNull();
    assertThat(MasumiIdentifier.decode("AABB")).isNull();
    assertThat(MasumiIdentifier.decode("deadbeef")).isNull();
    extra.put("blockchainIdentifier", identifier.toUpperCase());
    assertThat(MasumiSchema.validate(extra, PREPROD).ok()).isFalse();
  }

  // =================================================================== Masumi schema

  @Test
  void everyRequiredMasumiFieldIsRequired() {
    for (String field : List.of("inputCommitment", "blockchainIdentifier", "referenceKey", "referenceSignature", "terms")) {
      Map<String, Object> extra = base();
      extra.remove(field);
      assertThat(MasumiSchema.validate(extra, PREPROD).ok()).as(field).isFalse();
    }
    for (String field :
        List.of("version", "paymentType", "sellerAddress", "sellerNonce", "buyerNonce", "inputHash",
            "payByTime", "submitResultTime", "unlockTime", "externalDisputeUnlockTime")) {
      Map<String, Object> extra = base();
      terms(extra).remove(field);
      assertThat(MasumiSchema.validate(extra, PREPROD).ok()).as("terms." + field).isFalse();
    }
  }

  @Test
  void removedPolicyAndUnknownFieldsAreRefused() {
    for (String field : List.of("submissionPolicy", "unknown")) {
      Map<String, Object> extra = base();
      extra.put(field, "server");
      assertThat(MasumiSchema.validate(extra, PREPROD).detail()).as(field).contains("unknown field " + field);
    }
    Map<String, Object> extra = base();
    terms(extra).put("settlementPolicy", "l1");
    assertThat(MasumiSchema.validate(extra, PREPROD).detail()).contains("unknown field settlementPolicy");
  }

  @Test
  void wrongTypesAndNonCanonicalValuesAreRefused() {
    for (Object value : List.of("false", 0, true)) {
      Map<String, Object> extra = base();
      extra.put("areFeesSponsored", value);
      assertThat(MasumiSchema.validate(extra, PREPROD).ok()).as("fees " + value).isFalse();
    }
    for (Object value : List.of("01", "0", "-1", "1.5", " 12", 12, "9".repeat(21))) {
      Map<String, Object> extra = base();
      terms(extra).put("payByTime", value);
      assertThat(MasumiSchema.validate(extra, PREPROD).detail()).as("deadline " + value).contains("payByTime");
    }
    for (String field : List.of("referenceKey", "referenceSignature", "blockchainIdentifier")) {
      for (String value : List.of("", "AA", "abc", "00".repeat(16385))) {
        Map<String, Object> extra = base();
        extra.put(field, value);
        assertThat(MasumiSchema.validate(extra, PREPROD).detail()).as(field).contains(field);
      }
    }
    for (String field : List.of("confirmationPolicy", "deployment", "areFeesSponsored")) {
      Map<String, Object> extra = base();
      extra.put(field, null);
      assertThat(MasumiSchema.validate(extra, PREPROD).ok()).as("null " + field).isFalse();
    }
  }

  @Test
  void aMalformedConfirmationPolicyIsRefused() {
    for (Object value : List.of("1", 1.5, new BigInteger("18446744073709551617"), 21, -2)) {
      Map<String, Object> extra = base();
      extra.put("confirmationPolicy", Map.of("l1Confirmations", value));
      assertThat(MasumiSchema.validate(extra, PREPROD).ok()).as("confirmation " + value).isFalse();
    }
    Map<String, Object> extra = base();
    extra.put("confirmationPolicy", Map.of("l1Confirmations", 1, "unknown", 0));
    assertThat(MasumiSchema.validate(extra, PREPROD).ok()).isFalse();
    extra.put("confirmationPolicy", Map.of("l1Confirmations", 20));
    assertThat(MasumiSchema.validate(extra, PREPROD).ok()).isTrue();
  }

  @Test
  void duplicateCommitmentPartNamesAreRefused() {
    Map<String, Object> extra = base();
    Object only = parts(extra).get(0);
    commitment(extra).put("parts", List.of(only, only));
    assertThat(MasumiSchema.validate(extra, PREPROD).detail()).contains("duplicate part name");
  }

  @Test
  void thirtyThreeCommitmentPartsAreRefusedAndThirtyTwoAreNot() {
    Map<String, Object> extra = base();
    Object only = parts(extra).get(0);
    commitment(extra).put("parts", Collections.nCopies(33, only));
    assertThat(MasumiSchema.validate(extra, PREPROD).ok()).isFalse();
    // Distinct names so only the count differs from the 32-part boundary.
    List<Object> thirtyTwo = new ArrayList<>();
    for (int i = 0; i < 32; i++) {
      Map<String, Object> copy = new LinkedHashMap<>(part(commitment(base())));
      copy.put("name", "part" + i);
      thirtyTwo.add(copy);
    }
    Map<String, Object> boundary = base();
    commitment(boundary).put("parts", thirtyTwo);
    assertThat(MasumiSchema.validate(boundary, PREPROD).ok()).isTrue();
  }

  @Test
  void commitmentContentIsBoundedAndCyclesAreRefused() {
    for (Object content : List.of("x".repeat(1024 * 1024 + 1), Double.NaN)) {
      Map<String, Object> extra = base();
      part(commitment(extra)).put("content", content);
      assertThat(MasumiSchema.validate(extra, PREPROD).ok()).as("content").isFalse();
    }
    Object nested = 0;
    for (int i = 0; i < 65; i++) {
      nested = List.of(nested);
    }
    Map<String, Object> extra = base();
    part(commitment(extra)).put("content", nested);
    assertThat(MasumiSchema.validate(extra, PREPROD).detail()).contains("nesting limit");

    List<Object> cyclicList = new ArrayList<>();
    cyclicList.add(cyclicList);
    Map<String, Object> cyclicMap = new LinkedHashMap<>();
    cyclicMap.put("self", cyclicMap);
    for (Object cyclic : List.of(cyclicList, cyclicMap)) {
      extra = base();
      part(commitment(extra)).put("content", cyclic);
      assertThat(MasumiSchema.validate(extra, PREPROD).ok()).as("cyclic content").isFalse();
    }
  }

  @Test
  void rawContentMustBeCanonicalUnpaddedBase64url() {
    for (Object content : List.of("YQ==", "YR", "+/8", 123)) {
      Map<String, Object> extra = base();
      part(commitment(extra)).put("canonicalization", "raw");
      part(commitment(extra)).put("content", content);
      assertThat(MasumiSchema.validate(extra, PREPROD).ok()).as("raw " + content).isFalse();
    }
    Map<String, Object> extra = base();
    part(commitment(extra)).put("canonicalization", "raw");
    part(commitment(extra)).put("content", "YQ");
    assertThat(MasumiSchema.validate(extra, PREPROD).ok()).isTrue();
  }

  @Test
  void malformedDeploymentsAndRegistryIdentifiersAreRefused() {
    for (Object deployment :
        List.of(
            "bad",
            Map.of(),
            Map.of("requiredAdmins", "2", "adminVkeys", List.of("ab".repeat(28)), "cooldownPeriod", "0"))) {
      Map<String, Object> extra = base();
      extra.put("deployment", deployment);
      assertThat(MasumiSchema.validate(extra, PREPROD).ok()).as("deployment " + deployment).isFalse();
    }
    for (Object value : List.of("AB", "a", "ab".repeat(61), 1)) {
      Map<String, Object> extra = base();
      terms(extra).put("agentIdentifier", value);
      assertThat(MasumiSchema.validate(extra, PREPROD).detail()).as("agent " + value).contains("agentIdentifier");
    }
  }

  @Test
  void aNullSellerReturnAddressAndADisagreeingInputHashAreRefused() {
    Map<String, Object> extra = base();
    terms(extra).put("sellerReturnAddress", null);
    assertThat(MasumiSchema.validate(extra, PREPROD).ok()).isFalse();
    extra = base();
    terms(extra).put("inputHash", "ee".repeat(32));
    assertThat(MasumiSchema.validate(extra, PREPROD).detail()).contains("inputHash must equal");
  }

  // =================================================================== decoder width gates

  @Test
  void aRawInputIndexIsKeptExactlyAndCannotWrapToTheNonceIndexZero() {
    String hash = TxBuilder.hash32(0xaa);
    StubBackend backend = new StubBackend();
    backend.unspent(hash + "#0", walletAddress(), 10_000_000, Map.of());
    String wrapped =
        TxBuilder.create().input(hash, 4_294_967_296L)
            .output(payTo(), 2_000_000, Map.of(), null, false)
            .output(walletAddress(), 7_800_000, Map.of(), null, false)
            .fee(200_000).ttl(backend.slot + 300).signWith(TxBuilder.WALLET).build();
    PaymentRequirements requirements = new PaymentRequirements("exact", PREPROD, "lovelace", "2000000", payTo(), 600, Map.of());
    Map<String, Object> p = new LinkedHashMap<>();
    p.put("transaction", wrapped);
    p.put("nonce", hash + "#0");

    assertThat(CardanoTransactionDecoder.decode(wrapped).inputs()).containsExactly(hash + "#4294967296");
    var result = new ExactCardanoFacilitatorScheme(backend)
        .verify(new PaymentPayload(2, null, requirements, p, null), requirements);
    assertThat(result.isValid()).isFalse();
    assertThat(result.invalidReason()).isEqualTo(CardanoErrors.NONCE_NOT_IN_INPUTS);
  }

  @Test
  void aRawNetworkIdCannotWrapToTestnet() {
    String wrapped =
        TxBuilder.create().input(TxBuilder.hash32(0xaa), 0)
            .output(walletAddress(), 2_000_000, Map.of(), null, false).fee(200_000).ttl(100L)
            .bodyField(15, TxBuilder.uint(4_294_967_296L)).signWith(TxBuilder.WALLET).build();

    assertThatThrownBy(() -> CardanoTransactionDecoder.decode(wrapped)).isInstanceOf(RuntimeException.class);
  }

  @Test
  void duplicateBodyKeysAreRejectedAndTtlZeroIsPresentNotAbsent() {
    TxBuilder builder =
        TxBuilder.create().input(TxBuilder.hash32(0xaa), 0)
            .output(walletAddress(), 2_000_000, Map.of(), null, false).fee(200_000).ttl(100L);
    byte[] body = builder.body();
    assertThat(body[0] & 0xff).isBetween(0xa1, 0xb7);
    byte[] duplicated = new byte[body.length + 2];
    duplicated[0] = (byte) (body[0] + 1);
    System.arraycopy(body, 1, duplicated, 1, body.length - 1);
    duplicated[body.length] = 0x02; // a second fee key ...
    duplicated[body.length + 1] = 0x01; // ... carrying a different fee
    byte[] tx = new byte[1 + duplicated.length + 3];
    tx[0] = (byte) 0x84;
    System.arraycopy(duplicated, 0, tx, 1, duplicated.length);
    tx[tx.length - 3] = (byte) 0xa0;
    tx[tx.length - 2] = (byte) 0xf5;
    tx[tx.length - 1] = (byte) 0xf6;
    String pristine = Base64.getEncoder().encodeToString(unsigned(body));

    assertThat(CardanoTransactionDecoder.decode(pristine).fee()).isEqualTo(BigInteger.valueOf(200_000));
    assertThatThrownBy(() -> CardanoTransactionDecoder.decode(Base64.getEncoder().encodeToString(tx)))
        .isInstanceOf(IllegalArgumentException.class);

    String ttlZero =
        TxBuilder.create().input(TxBuilder.hash32(0xaa), 0)
            .output(walletAddress(), 2_000_000, Map.of(), null, false).fee(200_000).ttl(0L)
            .signWith(TxBuilder.WALLET).build();
    String noTtl =
        TxBuilder.create().input(TxBuilder.hash32(0xaa), 0)
            .output(walletAddress(), 2_000_000, Map.of(), null, false).fee(200_000).ttl(null)
            .signWith(TxBuilder.WALLET).build();
    assertThat(CardanoTransactionDecoder.decode(ttlZero).ttlSlot()).isEqualTo(BigInteger.ZERO);
    assertThat(CardanoTransactionDecoder.decode(noTtl).ttlSlot()).isNull();
  }

  // =================================================================== requirements and policy

  @Test
  void nonCanonicalAmountsAndUppercaseAssetsAreRejectedAsInvalidRequirements() {
    for (String amount : List.of("+2000000", "02000000")) {
      assertThat(verifyPlain(amount, "lovelace").invalidReason()).as(amount).isEqualTo(CardanoErrors.REQUIREMENTS_INVALID);
    }
    assertThat(verifyPlain("2000000", "LOVELACE").invalidReason()).isEqualTo(CardanoErrors.REQUIREMENTS_INVALID);
    assertThat(verifyPlain("2000000", "lovelace").isValid()).isTrue();
  }

  @Test
  void aNullOrOverflowingConfirmationPolicyIsMalformed() {
    Map<String, Object> nullPolicy = new LinkedHashMap<>();
    nullPolicy.put("confirmationPolicy", null);
    assertThat(CardanoPolicies.l1Confirmations(nullPolicy)).isNull();
    assertThat(CardanoPolicies.l1Confirmations(Map.of("confirmationPolicy", Map.of("l1Confirmations", 4294967297L))))
        .isNull();
  }

  @Test
  void networkAliasesFoldButCaseAndWhitespaceNever() {
    assertThat(CardanoNetworks.normalize("cip34:0-1")).isEqualTo(PREPROD);
    assertThat(CardanoNetworks.normalize("cip34:1-764824073")).isEqualTo("cardano:mainnet");
    assertThat(CardanoNetworks.normalize("cip34:0-2")).isEqualTo("cardano:preview");
    assertThat(CardanoNetworks.normalize("base-sepolia")).isEqualTo("base-sepolia");
    assertThat(CardanoNetworks.normalize("CARDANO:PREPROD")).isEqualTo("CARDANO:PREPROD");
    assertThat(CardanoNetworks.isCardanoNetwork("CARDANO:PREPROD")).isFalse();
    assertThat(CardanoNetworks.normalize(" cardano:preprod ")).isEqualTo(" cardano:preprod ");
    assertThat(CardanoNetworks.isCardanoNetwork(" cardano:preprod ")).isFalse();
    assertThat(CardanoNetworks.isCardanoNetwork(null)).isFalse();
    assertThat(CardanoNetworks.networkId(PREPROD)).isZero();
    assertThat(CardanoNetworks.networkId("cardano:preview")).isZero();
    assertThat(CardanoNetworks.networkId("cardano:mainnet")).isEqualTo(1);
  }

  // =================================================================== script parameters

  private static Map<String, Object> param(String type, Object value) {
    Map<String, Object> p = new LinkedHashMap<>();
    p.put("type", type);
    p.put("value", value);
    return p;
  }

  private static Map<String, Object> scriptWith(Map<String, Object> parameters) {
    Map<String, Object> script = new LinkedHashMap<>();
    script.put("type", "plutusV3");
    script.put("code", "4d01000033222220051200120011");
    Map<String, Object> extra = new LinkedHashMap<>();
    extra.put("assetTransferMethod", "script");
    extra.put("script", script);
    extra.put("parameters", parameters);
    return extra;
  }

  @Test
  void scriptParametersAreEnumeratedInJsObjectValuesOrder() {
    // Integer-like keys first in ascending numeric order, then string keys in insertion order.
    Map<String, Object> scrambled = new LinkedHashMap<>();
    scrambled.put("b", param("bigint", "10"));
    scrambled.put("1", param("bigint", "20"));
    scrambled.put("a", param("bigint", "30"));
    scrambled.put("0", param("bigint", "40"));
    Map<String, Object> inJsOrder = new LinkedHashMap<>();
    inJsOrder.put("0", param("bigint", "40"));
    inJsOrder.put("1", param("bigint", "20"));
    inJsOrder.put("b", param("bigint", "10"));
    inJsOrder.put("a", param("bigint", "30"));
    Map<String, Object> inJavaOrder = new LinkedHashMap<>();
    inJavaOrder.put("a", param("bigint", "30"));
    inJavaOrder.put("b", param("bigint", "10"));
    inJavaOrder.put("0", param("bigint", "40"));
    inJavaOrder.put("1", param("bigint", "20"));

    String hash = ScriptAddresses.deriveScriptHashHex(scriptWith(scrambled));

    assertThat(hash).isEqualTo(ScriptAddresses.deriveScriptHashHex(scriptWith(inJsOrder)));
    assertThat(hash).isNotEqualTo(ScriptAddresses.deriveScriptHashHex(scriptWith(inJavaOrder)));
  }

  @Test
  void nonCanonicalAndMistypedScriptParametersAreRefused() {
    for (Map<String, Object> p :
        List.of(
            param("bytes", "AA"), param("bytes", "f"), param("integer", "01"), param("integer", "+1"),
            param("integer", 1.5), param("integer", 9007199254740992L), param("boolean", "false"),
            param("string", 42))) {
      assertThatThrownBy(() -> ScriptAddresses.deriveScriptHashHex(scriptWith(Map.of("x", p))))
          .as(p.toString())
          .isInstanceOf(IllegalArgumentException.class);
    }
  }

  @Test
  void scriptParameterCountAndSizeAreBounded() {
    Map<String, Object> many = new LinkedHashMap<>();
    for (int i = 0; i < 65; i++) {
      many.put("p" + i, param("boolean", true));
    }
    assertThatThrownBy(() -> ScriptAddresses.deriveScriptHashHex(scriptWith(many)))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(
            () -> ScriptAddresses.deriveScriptHashHex(scriptWith(Map.of("x", param("string", "a".repeat(65536))))))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(
            () -> ScriptAddresses.deriveScriptHashHex(scriptWith(Map.of("x", param("integer", "1".repeat(129))))))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void aHashOnlyScriptDescriptorMustBeLowercaseAndAKeyAddressNeverMatches() {
    String hash = "4fff649fb4372ec3c408b6f0468d74e4d319904cde27fd3f00910a52";
    String address = "addr_test1wp8l7eylksmjas7ypzm0q35dwnjdxxvsfn0z0lflqzgs55stpd682";

    assertThat(ScriptAddresses.scriptAddressMatches(Map.of("scriptHash", hash), address)).isTrue();
    assertThat(ScriptAddresses.scriptAddressMatches(Map.of("scriptHash", hash.toUpperCase()), address)).isFalse();
    assertThat(ScriptAddresses.scriptAddressMatches(Map.of("scriptHash", "00".repeat(28)), address)).isFalse();
    assertThat(ScriptAddresses.scriptAddressMatches(Map.of("scriptHash", hash), payTo())).isFalse();
    assertThat(ScriptAddresses.scriptAddressMatches(Map.of("assetTransferMethod", "script"), address)).isFalse();
  }

  // =================================================================== slot clock

  @Test
  void slotsBeforeTheAnchorRoundDownLikeTheTypeScriptClock() {
    // App: ShelleyNetworkClock(anchorSlot 100, anchorTime 1_000_000 ms, slotLength 2000 ms).
    SlotConfig clock = new SlotConfig(2000, 100, 1_000_000);

    assertThat(CardanoNetworks.posixMsToSlot(clock, 999_999)).isEqualTo(99);
    assertThat(CardanoNetworks.posixMsToSlot(clock, 998_000)).isEqualTo(99);
    assertThat(CardanoNetworks.posixMsToSlot(clock, 997_999)).isEqualTo(98);
    assertThat(CardanoNetworks.posixMsToSlot(clock, 1_000_000)).isEqualTo(100);
    assertThat(CardanoNetworks.posixMsToSlot(clock, 1_001_999)).isEqualTo(100);
    assertThat(CardanoNetworks.posixMsToSlot(clock, 1_002_000)).isEqualTo(101);
  }

  // =================================================================== protocol-parameter cache

  @RegisterExtension
  static WireMockExtension wm = WireMockExtension.newInstance().options(wireMockConfig().dynamicPort()).build();

  /** A clock a test moves by hand. */
  private static final class MovableClock extends Clock {
    private volatile long millis;

    MovableClock(long millis) {
      this.millis = millis;
    }

    void advance(Duration d) {
      millis += d.toMillis();
    }

    @Override
    public ZoneId getZone() {
      return ZoneOffset.UTC;
    }

    @Override
    public Clock withZone(ZoneId zone) {
      return this;
    }

    @Override
    public Instant instant() {
      return Instant.ofEpochMilli(millis);
    }
  }

  @Test
  void expiredProtocolParametersAreNeverServedAfterAProviderFailure() {
    MovableClock clock = new MovableClock(1_655_769_600_000L + 1_000_000L);
    BlockfrostChainBackend backend =
        new BlockfrostChainBackend(
            BlockfrostChainBackend.Config.builder()
                .network(PREPROD)
                .baseUrl(wm.baseUrl() + "/")
                .projectId("preprodKey")
                .requestTimeout(Duration.ofSeconds(2))
                .clock(clock)
                .build());
    wm.stubFor(
        get("/epochs/latest/parameters")
            .willReturn(okJson("{\"coins_per_utxo_size\":\"4310\",\"min_fee_a\":44,\"min_fee_b\":155381}")));
    assertThat(backend.getProtocolParameters(PREPROD).getCoinsPerUtxoSize()).isEqualTo("4310");

    clock.advance(Duration.ofMinutes(11));
    wm.stubFor(get("/epochs/latest/parameters").willReturn(aResponse().withStatus(503)));
    assertThatThrownBy(() -> backend.getProtocolParameters(PREPROD)).isInstanceOf(ChainLookupException.class);

    wm.stubFor(
        get("/epochs/latest/parameters")
            .willReturn(okJson("{\"coins_per_utxo_size\":\"4320\",\"min_fee_a\":44,\"min_fee_b\":155381}")));
    assertThat(backend.getProtocolParameters(PREPROD).getCoinsPerUtxoSize()).isEqualTo("4320");
    wm.verify(3, getRequestedFor(urlEqualTo("/epochs/latest/parameters")));
  }

  // =================================================================== settlement

  private static final Clock FIXED = Clock.fixed(Instant.ofEpochMilli(Vectors.now()), ZoneOffset.UTC);

  private static ExactCardanoFacilitatorOptions.Builder fast() {
    return ExactCardanoFacilitatorOptions.builder()
        .clock(FIXED)
        .confirmationTimeout(Duration.ofMillis(5))
        .confirmationPoll(Duration.ofMillis(1));
  }

  @Test
  void anObsoleteSubmissionModeInThePayloadCannotSuppressTheFacilitatorBroadcast() {
    JsonNode fixture = Vectors.fixture("01-default-happy");
    ObjectNode wire = fixture.get("payload").deepCopy();
    ((ObjectNode) wire.get("payload")).put("submissionMode", "client");
    PaymentPayload payload = Vectors.payload(wire);
    PaymentRequirements requirements = Vectors.requirements(fixture.get("requirements"));
    String tx = (String) payload.payload().get("transaction");
    FakeChain chain = FakeChain.fromFixtures("01-default-happy");
    var scheme = new ExactCardanoFacilitatorScheme(chain, null, fast().build());

    SettleResponse response = scheme.settle(payload, requirements, FacilitatorContext.EMPTY);

    assertThat(chain.submissions()).containsExactly(tx);
    assertThat(response.transaction()).isEqualTo(CardanoTransactionDecoder.decode(tx).txHash());
    assertThat(response.isPending() || response.success()).isTrue();
  }

  @Test
  void acceptMempoolDoesNotWeakenAZeroConfirmationPolicy() {
    JsonNode fixture = Vectors.fixture("01-default-happy");
    PaymentRequirements zeroDepth =
        Vectors.requirements(fixture.get("requirements")).withExtra("confirmationPolicy", Map.of("l1Confirmations", 0));
    PaymentPayload wire = Vectors.payload(fixture.get("payload"));
    PaymentPayload payload = new PaymentPayload(2, wire.resource(), zeroDepth, wire.payload(), null);
    String tx = (String) wire.payload().get("transaction");
    FakeChain chain = FakeChain.fromFixtures("01-default-happy");
    var scheme = new ExactCardanoFacilitatorScheme(chain, null, fast().acceptMempool(true).build());

    SettleResponse inMempool = scheme.settle(payload, zeroDepth, FacilitatorContext.EMPTY);
    assertThat(inMempool.success()).isFalse();
    assertThat(inMempool.isPending()).isTrue();

    chain.include(tx, 0);
    SettleResponse included = scheme.settle(payload, zeroDepth, FacilitatorContext.EMPTY);
    assertThat(included.success()).isTrue();
    assertThat(included.extra()).containsEntry("status", "confirmed").containsEntry("confirmations", 0);
    assertThat(chain.submissions()).containsExactly(tx);
  }

  // =================================================================== helpers

  private static Map<String, Object> base() {
    return MasumiFixtures.mutableExtra(MasumiFixtures.issue(b -> {}));
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> terms(Map<String, Object> extra) {
    return (Map<String, Object>) extra.get("terms");
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> commitment(Map<String, Object> extra) {
    return (Map<String, Object>) extra.get("inputCommitment");
  }

  @SuppressWarnings("unchecked")
  private static List<Object> parts(Map<String, Object> extra) {
    return (List<Object>) commitment(extra).get("parts");
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> part(Map<String, Object> commitment) {
    return ((List<Map<String, Object>>) commitment.get("parts")).get(0);
  }

  private static String walletAddress() {
    return TxBuilder.walletAddress();
  }

  private static String payTo() {
    return new Account(Networks.testnet(), "test walk nut penalty hip pave soap entry language right filter choice", 1)
        .baseAddress();
  }

  private static byte[] unsigned(byte[] body) {
    byte[] tx = new byte[body.length + 4];
    tx[0] = (byte) 0x84;
    System.arraycopy(body, 0, tx, 1, body.length);
    tx[tx.length - 3] = (byte) 0xa0;
    tx[tx.length - 2] = (byte) 0xf5;
    tx[tx.length - 1] = (byte) 0xf6;
    return tx;
  }

  private static DecodedCardanoTransaction lockTx(PaymentRequirements quote) {
    byte[] datum = PlutusEncoding.encode(MasumiDatum.build(MasumiFixtures.lockInput(quote, 0)));
    return MasumiFixtures.lock(
        quote.payTo(), datum, 5_000_000, Map.of(), false, MasumiFixtures.ttlBeforePayBy(),
        List.of(MasumiFixtures.BUYER_KEY_HASH));
  }

  private static DecodedCardanoTransaction withOutputs(
      DecodedCardanoTransaction tx, List<DecodedCardanoTransaction.Output> outputs) {
    return new DecodedCardanoTransaction(
        tx.txHash(), tx.networkId(), tx.ttlSlot(), tx.validityStartSlot(), tx.inputs(), tx.fee(), tx.sizeBytes(),
        tx.balanceChangingOperations(), outputs, tx.vkeyWitnessCount(), tx.vkeyHashes(), tx.scriptWitnessCount(),
        tx.redeemerCount(), tx.signaturesValid(), tx.isValid());
  }

  private static MasumiVerifier.Check lock(PaymentRequirements quote, Object extra) {
    return lock(quote, extra, lockTx(quote));
  }

  private static MasumiVerifier.Check lock(PaymentRequirements quote, Object extra, DecodedCardanoTransaction tx) {
    return MasumiVerifier.verifyLock(
        extra, quote, tx, new MasumiVerifier.LockContext(MasumiFixtures.BUYER, CPUB, null, null, null));
  }

  private static org.x402.core.types.VerifyResponse verifyPlain(String amount, String asset) {
    String payer = TxBuilder.walletAddress();
    String payTo = payTo();
    String nonceHash = TxBuilder.hash32(0xaa);
    StubBackend backend = new StubBackend();
    backend.unspent(nonceHash + "#0", payer, 10_000_000, Map.of());
    String tx =
        TxBuilder.create()
            .input(nonceHash, 0)
            .output(payTo, 2_000_000, Map.of(), null, false)
            .output(payer, 7_800_000, Map.of(), null, false)
            .fee(200_000)
            .ttl(backend.slot + 300)
            .signWith(TxBuilder.WALLET)
            .build();
    PaymentRequirements requirements = new PaymentRequirements("exact", PREPROD, asset, amount, payTo, 600, Map.of());
    Map<String, Object> p = new LinkedHashMap<>();
    p.put("transaction", tx);
    p.put("nonce", nonceHash + "#0");
    return new ExactCardanoFacilitatorScheme(backend)
        .verify(new PaymentPayload(2, null, requirements, p, null), requirements);
  }
}
