package org.x402.mechanisms.cardano.parity;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.address.Address;
import com.bloxbean.cardano.client.address.AddressProvider;
import com.bloxbean.cardano.client.common.model.Networks;
import com.bloxbean.cardano.client.crypto.Blake2bUtil;
import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigInteger;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.x402.core.FacilitatorContext;
import org.x402.core.facilitator.X402Facilitator;
import org.x402.core.json.X402Json;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.core.types.VerifyResponse;
import org.x402.mechanisms.cardano.utils.CardanoAddresses;
import org.x402.mechanisms.cardano.utils.CardanoErrors;
import org.x402.mechanisms.cardano.utils.CardanoTransactionDecoder;
import org.x402.mechanisms.cardano.utils.Cbor;
import org.x402.mechanisms.cardano.exact.facilitator.ExactCardanoFacilitatorOptions;
import org.x402.mechanisms.cardano.exact.facilitator.ExactCardanoFacilitatorScheme;
import org.x402.mechanisms.cardano.exact.facilitator.ScriptDatumPolicy;
import org.x402.mechanisms.cardano.exact.script.ScriptAddresses;
import org.x402.mechanisms.cardano.testing.FakeChain;
import org.x402.mechanisms.cardano.testing.StubBackend;
import org.x402.mechanisms.cardano.testing.TxBuilder;
import org.x402.mechanisms.cardano.testing.Vectors;

/**
 * Work package B8-gaps: SDK tests for the behaviours the cardano-x402-facilitator app tests pin
 * and no earlier SDK test did, ported before those app tests are deleted. Each test names its app
 * source. Reason codes follow the SDK/TypeScript codes (see the B8 change list for the intentional
 * differences). Wire JSON, verification, auxiliary data, value conservation, the registry and the
 * settlement-claim states live here; the Masumi and chain-provider ports are in
 * {@link AppB8MasumiGapsTest} and {@link AppB8ChainGapsTest}.
 */
class AppB8GapsTest {

  private static final String NETWORK = "cardano:preprod";
  private static final String PAYER = TxBuilder.walletAddress();
  private static final String PAY_TO =
      new Account(Networks.testnet(), "test walk nut penalty hip pave soap entry language right filter choice", 1)
          .baseAddress();
  private static final String NONCE_HASH = TxBuilder.hash32(0xaa);
  private static final String NONCE = NONCE_HASH + "#0";

  private final StubBackend backend = new StubBackend();

  // ------------------------------------------------------------------ helpers

  private TxBuilder plain() {
    backend.unspent(NONCE, PAYER, 10_000_000, Map.of());
    return TxBuilder.create()
        .input(NONCE_HASH, 0)
        .output(PAY_TO, 2_000_000, Map.of(), null, false)
        .output(PAYER, 7_800_000, Map.of(), null, false)
        .fee(200_000)
        .ttl(backend.slot + 300)
        .signWith(TxBuilder.WALLET);
  }

  private static PaymentRequirements requirements(String amount, String asset, int timeout, Map<String, Object> extra) {
    return new PaymentRequirements("exact", NETWORK, asset, amount, PAY_TO, timeout, extra);
  }

  private static PaymentPayload payload(PaymentRequirements accepted, String tx) {
    Map<String, Object> p = new LinkedHashMap<>();
    p.put("transaction", tx);
    p.put("nonce", NONCE);
    return new PaymentPayload(2, null, accepted, p, null);
  }

  private VerifyResponse verify(StubBackend chain, String tx, PaymentRequirements req) {
    return new ExactCardanoFacilitatorScheme(chain).verify(payload(req, tx), req, FacilitatorContext.EMPTY);
  }

  private VerifyResponse verify(String tx) {
    return verify(backend, tx, requirements("2000000", "lovelace", 600, Map.of()));
  }

  private VerifyResponse verify(String tx, PaymentRequirements req) {
    return verify(backend, tx, req);
  }

  // ============================================================ 1-3 ProtocolJsonTest (wire JSON)

  /** App ProtocolJsonTest#deserializesVerifyRequest (:10-27). */
  @Test
  void aVerifyRequestBodyDeserializesAndIgnoresUnknownFields() throws Exception {
    String json = """
        {"x402Version":2,
         "paymentPayload":{"x402Version":2,
           "accepted":{"scheme":"exact","network":"cardano:preprod","asset":"lovelace",
                       "amount":"2000000","payTo":"addr_test1abc","maxTimeoutSeconds":600,"extra":{}},
           "payload":{"transaction":"AAAA","nonce":"aa#0"},
           "unknownField":true},
         "paymentRequirements":{"scheme":"exact","network":"cardano:preprod","asset":"lovelace",
           "amount":"2000000","payTo":"addr_test1abc","maxTimeoutSeconds":600,
           "extra":{"assetTransferMethod":"default"}}}
        """;
    JsonNode root = X402Json.mapper().readTree(json);

    PaymentPayload payload = X402Json.convert(root.get("paymentPayload"), PaymentPayload.class);
    PaymentRequirements requirements = X402Json.convert(root.get("paymentRequirements"), PaymentRequirements.class);

    assertThat(root.get("x402Version").asInt()).isEqualTo(2);
    assertThat(payload.x402Version()).isEqualTo(2);
    assertThat(payload.accepted().network()).isEqualTo("cardano:preprod");
    assertThat(payload.payload().get("nonce")).isEqualTo("aa#0");
    assertThat(requirements.extra().get("assetTransferMethod")).isEqualTo("default");
  }

  /**
   * App ProtocolJsonTest#settleFailWithTxCarriesTransactionNetworkAndStatus (:46-54). The SDK
   * carries the status in {@code extra.status} (the wire has no top-level status field).
   */
  @Test
  void aSettleFailureWithATransactionCarriesTransactionNetworkAndStatus() {
    SettleResponse response = new SettleResponse(false, CardanoErrors.SETTLEMENT_FAILED, null, "addr_test1payer",
        "abcd1234", NETWORK, null, null, null, Map.of("status", "mempool"));

    JsonNode json = X402Json.mapper().valueToTree(response);

    assertThat(json.get("transaction").asText()).isEqualTo("abcd1234");
    assertThat(json.get("network").asText()).isEqualTo(NETWORK);
    assertThat(json.get("extra").get("status").asText()).isEqualTo("mempool");
  }

  /**
   * App ProtocolJsonTest#settleNullStatusOmitsExtraAndDoesNotThrow (:56-63) and the GP "status on
   * success": a response without extra serializes without an extra member, and a real confirmed
   * settle carries the status.
   */
  @Test
  void aSettleResponseWithoutStatusOmitsExtraAndARealSettleCarriesIt() {
    JsonNode ok = X402Json.mapper().valueToTree(SettleResponse.success("abcd1234", NETWORK, "addr_test1payer"));
    JsonNode failed = X402Json.mapper()
        .valueToTree(new SettleResponse(false, CardanoErrors.SETTLEMENT_FAILED, null, "addr_test1payer", "abcd1234",
            NETWORK, null, null, null, null));
    assertThat(ok.has("extra")).isFalse();
    assertThat(ok.has("status")).isFalse();
    assertThat(failed.has("extra")).isFalse();
    assertThat(failed.has("status")).isFalse();

    JsonNode fixture = Vectors.fixture("01-default-happy");
    FakeChain chain = FakeChain.fromFixtures("01-default-happy");
    PaymentPayload payload = Vectors.payload(fixture.get("payload"));
    PaymentRequirements req = Vectors.requirements(fixture.get("requirements")).withExtra("confirmationPolicy", Map.of("l1Confirmations", 0));
    String tx = (String) payload.payload().get("transaction");
    var scheme = new ExactCardanoFacilitatorScheme(chain, null, ExactCardanoFacilitatorOptions.builder()
        .clock(Clock.fixed(Instant.ofEpochMilli(Vectors.now()), ZoneOffset.UTC))
        .confirmationTimeout(Duration.ofMillis(5)).confirmationPoll(Duration.ofMillis(1)).build());
    PaymentPayload zeroDepth = new PaymentPayload(2, payload.resource(), req, payload.payload(), null);
    scheme.settle(zeroDepth, req, FacilitatorContext.EMPTY);
    chain.include(tx, 0);

    SettleResponse settled = scheme.settle(zeroDepth, req, FacilitatorContext.EMPTY);

    assertThat(settled.success()).isTrue();
    JsonNode wire = X402Json.mapper().valueToTree(settled);
    assertThat(wire.get("transaction").asText()).isEqualTo(CardanoTransactionDecoder.decode(tx).txHash());
    assertThat(wire.get("network").asText()).isEqualTo(NETWORK);
    assertThat(wire.get("extra").get("status").asText()).isEqualTo("confirmed");
  }

  /** GP ProtocolJsonTest: invalidReason omission on a valid verify response. */
  @Test
  void aValidVerifyResponseOmitsTheInvalidReason() {
    JsonNode json = X402Json.mapper().valueToTree(VerifyResponse.valid("addr_test1payer"));
    assertThat(json.get("isValid").asBoolean()).isTrue();
    assertThat(json.get("payer").asText()).isEqualTo("addr_test1payer");
    assertThat(json.has("invalidReason")).isFalse();
  }

  // ============================================================ registry (GP X402FacilitatorRegistryTest)

  /**
   * GP X402FacilitatorRegistryTest#findsByVersionSchemeAndNormalizedNetwork: the registry misses.
   * The SDK facilitator throws for a payload version, scheme or network nobody registered.
   */
  @Test
  void theRegistryRefusesAVersionSchemeOrNetworkNobodyRegistered() {
    X402Facilitator facilitator = new X402Facilitator().register(NETWORK, new ExactCardanoFacilitatorScheme(backend));
    String tx = plain().build();
    PaymentRequirements req = requirements("2000000", "lovelace", 600, Map.of());

    assertThat(facilitator.verify(payload(req, tx), req).isValid()).isTrue();

    PaymentPayload v1 = new PaymentPayload(1, null, req, payload(req, tx).payload(), null);
    assertThatThrownBy(() -> facilitator.verify(v1, req)).hasMessageContaining("x402 version: 1");
    PaymentRequirements upto = new PaymentRequirements("upto", NETWORK, "lovelace", "2000000", PAY_TO, 600, Map.of());
    assertThatThrownBy(() -> facilitator.verify(payload(upto, tx), upto)).hasMessageContaining("scheme: upto");
    PaymentRequirements mainnet =
        new PaymentRequirements("exact", "cardano:mainnet", "lovelace", "2000000", PAY_TO, 600, Map.of());
    assertThatThrownBy(() -> facilitator.verify(payload(mainnet, tx), mainnet))
        .hasMessageContaining("network: cardano:mainnet");
  }

  // ============================================================ 21-24 ExactCardanoVerifyTest

  /** App ExactCardanoVerifyTest#rejectsMalformedAsset (:147-152). */
  @Test
  void aMalformedAssetIsInvalidRequirements() {
    assertThat(verify(plain().build(), requirements("2000000", "not-an-asset", 600, Map.of())).invalidReason())
        .isEqualTo(CardanoErrors.REQUIREMENTS_INVALID);
  }

  /** GP ExactCardanoVerifyTest#rejectsNonIntegerAmount / rejectsNegativeAmount (:131-145). */
  @ParameterizedTest(name = "amount {0}")
  @ValueSource(strings = {"2.5", "-2000000"})
  void aNonIntegerOrNegativeAmountIsInvalidRequirements(String amount) {
    assertThat(verify(plain().build(), requirements(amount, "lovelace", 600, Map.of())).invalidReason())
        .isEqualTo(CardanoErrors.REQUIREMENTS_INVALID);
  }

  /**
   * GP ExactCardanoVerifyTest#requiresPositiveTimeoutForFreshPayment (the app also covered a null
   * timeout; the SDK field is a primitive int, so null cannot be expressed).
   */
  @ParameterizedTest(name = "timeout {0}")
  @ValueSource(ints = {0, -1})
  void aNonPositiveTimeoutIsInvalidRequirementsForAFreshPayment(int timeout) {
    assertThat(verify(plain().build(), requirements("2000000", "lovelace", timeout, Map.of())).invalidReason())
        .isEqualTo(CardanoErrors.REQUIREMENTS_INVALID);
  }

  /** GP ExactCardanoVerifyTest#acceptsCip34AliasAsAcceptedNetwork (:85-92). */
  @Test
  void aCip34AliasAsTheAcceptedNetworkIsAccepted() {
    PaymentRequirements req = requirements("2000000", "lovelace", 600, Map.of());
    PaymentRequirements accepted =
        new PaymentRequirements("exact", "cip34:0-1", "lovelace", "2000000", PAY_TO, 600, Map.of());

    VerifyResponse response = new ExactCardanoFacilitatorScheme(backend)
        .verify(payload(accepted, plain().build()), req, FacilitatorContext.EMPTY);

    assertThat(response.isValid()).as(response.invalidReason()).isTrue();
  }

  /**
   * App ExactCardanoVerifyTest#rejectsRewardAddressAsPayToOrChangeOutput (:167-177). A reward
   * address as the change output and as payTo must both be refused.
   */
  @Test
  void aRewardAddressAsPayToOrAsAChangeOutputIsRefused() {
    String reward = AddressProvider.getRewardAddress(
        new Address(PAYER).getPaymentCredential().orElseThrow(), Networks.testnet()).toBech32();
    backend.unspent(NONCE, PAYER, 10_000_000, Map.of());

    byte[] rewardBytes = new Address(reward).getBytes();
    byte[] rewardOutput = new Cbor.Writer().header(5, 2).header(0, 0).bytes(rewardBytes).header(0, 1)
        .header(0, 7_800_000).toByteArray();
    byte[] rewardPayment = new Cbor.Writer().header(5, 2).header(0, 0).bytes(rewardBytes).header(0, 1)
        .header(0, 2_000_000).toByteArray();

    String rewardChange = TxBuilder.create().input(NONCE_HASH, 0)
        .output(PAY_TO, 2_000_000, Map.of(), null, false)
        .rawOutput(rewardOutput)
        .fee(200_000).ttl(backend.slot + 300).signWith(TxBuilder.WALLET).build();
    assertThat(verify(rewardChange).invalidReason()).isEqualTo(CardanoErrors.TRANSACTION_DECODE_FAILED);

    String directReward = TxBuilder.create().input(NONCE_HASH, 0)
        .rawOutput(rewardPayment)
        .output(PAYER, 7_800_000, Map.of(), null, false)
        .fee(200_000).ttl(backend.slot + 300).signWith(TxBuilder.WALLET).build();
    PaymentRequirements rewardSeller =
        new PaymentRequirements("exact", NETWORK, "lovelace", "2000000", reward, 600, Map.of());
    assertThat(verify(directReward, rewardSeller).invalidReason()).isEqualTo(CardanoErrors.REQUIREMENTS_INVALID);
  }

  /** App ExactCardanoVerifyTest#rejectsTtlEqualToCurrentSlot (:247-251): ttl == slot is expired. */
  @Test
  void aTtlEqualToTheCurrentSlotIsExpired() {
    assertThat(verify(plain().ttl(backend.slot).build()).invalidReason()).isEqualTo(CardanoErrors.TTL_EXPIRED);
    assertThat(verify(plain().ttl(backend.slot + 1).build()).isValid()).isTrue();
  }

  /** App ExactCardanoVerifyTest#acceptsOverpayment (:348-352). */
  @Test
  void payingMoreThanRequiredIsAccepted() {
    assertThat(verify(plain().build(), requirements("1500000", "lovelace", 600, Map.of())).isValid()).isTrue();
    assertThat(verify(plain().build(), requirements("2000001", "lovelace", 600, Map.of())).invalidReason())
        .isEqualTo(CardanoErrors.AMOUNT_INSUFFICIENT);
  }

  // ============================================================ 5 ScriptTransferVerifierTest

  private static final String CODE = "4d01000033222220051200120011";
  private static final byte[] INLINE = {(byte) 0xd8, 0x79, (byte) 0x80};

  private VerifyResponse verifyScript(ScriptDatumPolicy policy, Map<String, Object> extra, byte[] inlineDatum) {
    String hash = ScriptAddresses.deriveScriptHashHex(extra);
    String payTo = CardanoAddresses.enterpriseScriptAddress(NETWORK, hash);
    backend.unspent(NONCE, PAYER, 10_000_000, Map.of());
    TxBuilder b = TxBuilder.create().input(NONCE_HASH, 0)
        .output(payTo, 2_000_000, Map.of(), inlineDatum, false)
        .output(PAYER, 7_800_000, Map.of(), null, false)
        .fee(200_000).ttl(backend.slot + 300).isValid(true).signWith(TxBuilder.WALLET);
    PaymentRequirements req = new PaymentRequirements("exact", NETWORK, "lovelace", "2000000", payTo, 600, extra);
    var options = ExactCardanoFacilitatorOptions.builder();
    if (policy != null) {
      options.scriptDatumPolicy(policy);
    }
    return new ExactCardanoFacilitatorScheme(backend, null, options.build())
        .verify(payload(req, b.build()), req, FacilitatorContext.EMPTY);
  }

  private static Map<String, Object> scriptExtra(String type) {
    Map<String, Object> extra = new LinkedHashMap<>();
    extra.put("assetTransferMethod", "script");
    extra.put("script", Map.of("type", type, "code", CODE));
    return extra;
  }

  /** App ScriptTransferVerifierTest#happyScriptHashOnlyWithDatum (:101-105), under strict. */
  @Test
  void aScriptHashOnlyDescriptorWithADatumIsValidUnderStrict() {
    String hash = ScriptAddresses.deriveScriptHashHex(scriptExtra("plutusV3"));
    Map<String, Object> hashOnly = new LinkedHashMap<>();
    hashOnly.put("assetTransferMethod", "script");
    hashOnly.put("scriptHash", hash);

    VerifyResponse response = verifyScript(ScriptDatumPolicy.STRICT, hashOnly, INLINE);

    assertThat(response.isValid()).as(response.invalidReason()).isTrue();
    assertThat(response.payer()).isEqualTo(PAYER);
  }

  /** GP ScriptTransferVerifierTest#referencePolicyAcceptsV3Datumless. */
  @Test
  void aPlutusV3OutputWithoutADatumIsAcceptedUnderTheReferencePolicy() {
    assertThat(verifyScript(ScriptDatumPolicy.REFERENCE, scriptExtra("plutusV3"), null).isValid()).isTrue();
    assertThat(verifyScript(null, scriptExtra("plutusV3"), null).isValid()).isTrue();
    assertThat(verifyScript(ScriptDatumPolicy.STRICT, scriptExtra("plutusV3"), null).invalidReason())
        .isEqualTo(CardanoErrors.SCRIPT_DATUM_MISSING);
  }

  // ============================================================ 9-10 + GP AuxiliaryDataVerificationTest

  private static byte[] metadata(String text) {
    return new Cbor.Writer().header(5, 1).header(0, 1).text(text).toByteArray();
  }

  private static byte[] hex(String hex) {
    return HexFormat.of().parseHex(hex);
  }

  /**
   * A signed payment carrying auxiliary data and its commitment. {@code delegated} models the app's
   * "complete validator" arm: the backend offers a full phase-1 validator and the body carries a
   * reference input.
   */
  private String withAux(boolean delegated, byte[] aux, byte[] committedHash) {
    backend.phase1Validator = delegated;
    TxBuilder b = plain();
    if (delegated) {
      b.bodyField(18, new Cbor.Writer().header(4, 1).header(4, 2).bytes(hex("cd".repeat(32))).header(0, 0).toByteArray());
    }
    if (committedHash != null) {
      b.bodyField(7, new Cbor.Writer().bytes(committedHash).toByteArray());
    }
    if (aux != null) {
      b.auxiliaryData(aux);
    }
    return b.build();
  }

  private void assertAux(boolean delegated, byte[] aux, byte[] hash, String expectedReason) {
    VerifyResponse response = verify(withAux(delegated, aux, hash));
    assertThat(response.invalidReason()).isEqualTo(expectedReason);
    assertThat(response.isValid()).isEqualTo(expectedReason == null);
  }

  /** The four app arms of the auxiliary-data suite, now with the full-validator arm for the base cases. */
  @ParameterizedTest(name = "delegated={0}")
  @ValueSource(booleans = {false, true})
  void theBaseAuxiliaryDataRulesHoldWithAndWithoutAFullValidator(boolean delegated) {
    byte[] metadata = metadata("ok");
    assertAux(delegated, null, new byte[32], CardanoErrors.TRANSACTION_DECODE_FAILED);
    assertAux(delegated, metadata, null, CardanoErrors.TRANSACTION_DECODE_FAILED);
    assertAux(delegated, metadata, new byte[32], CardanoErrors.TRANSACTION_DECODE_FAILED);
    byte[] oversized = new Cbor.Writer().header(5, 1).header(0, 1).text("é".repeat(33)).toByteArray();
    assertAux(delegated, oversized, Blake2bUtil.blake2bHash256(oversized), CardanoErrors.TRANSACTION_DECODE_FAILED);
    assertAux(delegated, metadata, Blake2bUtil.blake2bHash256(metadata), null);
    byte[] tagged = new Cbor.Writer().header(6, 259).header(5, 1).header(0, 0).raw(metadata).toByteArray();
    assertAux(delegated, tagged, Blake2bUtil.blake2bHash256(tagged), null);
  }

  /** App AuxiliaryDataVerificationTest#hashesExactWireEncodingOfMetadata (:55-61). */
  @ParameterizedTest(name = "delegated={0}")
  @ValueSource(booleans = {false, true})
  void theCommitmentHashesTheExactWireEncodingOfTheMetadata(boolean delegated) {
    // Indefinite map, non-minimal integer encoding: semantically {1: "ok"}.
    byte[] nonCanonical = hex("bf1801626f6bff");
    assertAux(delegated, nonCanonical, Blake2bUtil.blake2bHash256(nonCanonical), null);
    // The hash of the canonical re-encoding of the same value does not match.
    assertAux(delegated, nonCanonical, Blake2bUtil.blake2bHash256(metadata("ok")),
        CardanoErrors.TRANSACTION_DECODE_FAILED);
  }

  /** App AuxiliaryDataVerificationTest#acceptsNestedMetadataAndBoundaryValues (:86-95). */
  @ParameterizedTest(name = "delegated={0}")
  @ValueSource(booleans = {false, true})
  void nestedMetadataAndBoundaryValuesAreAccepted(boolean delegated) {
    for (String hex : List.of(
        "a1019f01ff", // indefinite metadata list
        "a101a141001bffffffffffffffff", // bytes map key, uint64 maximum
        "a1013bffffffffffffffff", // negative integer minimum
        "a1015840" + "00".repeat(64))) { // 64-byte bytes: at the limit
      byte[] bytes = hex(hex);
      assertAux(delegated, bytes, Blake2bUtil.blake2bHash256(bytes), null);
    }
  }

  /** GP AuxiliaryDataVerificationTest#rejectsMalformedMetadataValues (:78-93), both arms. */
  @ParameterizedTest(name = "delegated={0}")
  @ValueSource(booleans = {false, true})
  void malformedMetadataValuesAreDecodeFailures(boolean delegated) {
    for (String hex : List.of(
        "a101f5", // booleans are not metadata
        "a101c001", // tagged integer
        "a10161ff", // invalid UTF-8
        "a1616101", // text label
        "a1015841" + "00".repeat(65), // oversized bytes
        "a101c249010000000000000000", // positive integer outside uint64
        "d90103a10180")) { // auxiliary script bundle: unsupported
      byte[] bytes = hex(hex);
      assertAux(delegated, bytes, Blake2bUtil.blake2bHash256(bytes), CardanoErrors.TRANSACTION_DECODE_FAILED);
    }
  }

  /** GP AuxiliaryDataVerificationTest#rejectsTaggedAuxiliaryCommitment (tag 24 on the aux hash). */
  @Test
  void aTaggedAuxiliaryDataHashIsADecodeFailure() {
    byte[] metadata = metadata("ok");
    byte[] taggedHash = new Cbor.Writer().header(6, 24).bytes(Blake2bUtil.blake2bHash256(metadata)).toByteArray();
    String tx = plain().bodyField(7, taggedHash).auxiliaryData(metadata).build();

    assertThatThrownBy(() -> CardanoTransactionDecoder.decode(tx)).isInstanceOf(RuntimeException.class);
    assertThat(verify(tx).invalidReason()).isEqualTo(CardanoErrors.TRANSACTION_DECODE_FAILED);
  }

  // ============================================================ 11-13 + GP UpstreamVerificationTest

  private static final String POLICY = "aa".repeat(28);
  private static final String ASSET = POLICY + ".01";

  /** App UpstreamVerificationTest#nativeTokensMustBeConserved (:91-95). */
  @Test
  void nativeTokensInTheInputsMustReachTheOutputs() {
    String tx = plain().build();
    backend.unspent(NONCE, PAYER, 10_000_000, Map.of(ASSET, BigInteger.ONE));

    assertThat(verify(tx).invalidReason()).isEqualTo(CardanoErrors.VALUE_NOT_CONSERVED);
  }

  /** App UpstreamVerificationTest#nativeAssetConservationUsesLiteralInputAndOutputQuantities (:154-173). */
  @Test
  void nativeAssetConservationUsesTheLiteralInputAndOutputQuantities() {
    PaymentRequirements req = requirements("4", ASSET, 600, Map.of());
    long[][] outputs = {{9_800_000, 5}, {9_800_001, 5}, {9_800_000, 4}};
    for (long[] output : outputs) {
      backend.unspent(NONCE, PAYER, 10_000_000, Map.of(ASSET, BigInteger.valueOf(5)));
      String tx = TxBuilder.create().input(NONCE_HASH, 0)
          .output(PAY_TO, output[0], Map.of(ASSET, output[1]), null, false)
          .fee(200_000).ttl(backend.slot + 300).signWith(TxBuilder.WALLET).build();
      VerifyResponse response = verify(tx, req);
      if (output[0] == 9_800_000 && output[1] == 5) {
        assertThat(response.isValid()).as(response.invalidReason() + " " + response.invalidMessage()).isTrue();
      } else {
        assertThat(response.invalidReason()).as(output[0] + "/" + output[1])
            .isEqualTo(CardanoErrors.VALUE_NOT_CONSERVED);
      }
    }
  }

  /**
   * App UpstreamVerificationTest#feeBoundaryMatchesIndependent500ByteVector (:175-195). A 500-byte
   * transaction needs 44 * 500 + 155381 = 177381 lovelace; one less is below the minimum.
   */
  @Test
  void theMinimumFeeBoundaryMatchesAnIndependent500ByteVector() {
    for (long fee : new long[] {177_380, 177_381}) {
      String tx = txOfExactly(500, fee);
      assertThat(Base64.getDecoder().decode(tx)).hasSize(500);
      backend.unspent(NONCE, PAYER, 10_000_000, Map.of());
      VerifyResponse response = verify(tx);
      if (fee == 177_380) {
        assertThat(response.invalidReason()).isEqualTo(CardanoErrors.FEE_BELOW_MINIMUM);
      } else {
        assertThat(response.isValid()).as(response.invalidReason() + " " + response.invalidMessage()).isTrue();
      }
    }
  }

  /** A balanced signed payment padded (with a datum on the change output) to an exact size. */
  private String txOfExactly(int size, long fee) {
    for (int pad = 0; pad < 400; pad++) {
      String tx = TxBuilder.create().input(NONCE_HASH, 0)
          .output(PAY_TO, 2_000_000, Map.of(), null, false)
          .output(PAYER, 8_000_000 - fee, Map.of(), new Cbor.Writer().bytes(new byte[pad]).toByteArray(), false)
          .fee(fee).ttl(backend.slot + 300).signWith(TxBuilder.WALLET).build();
      if (Base64.getDecoder().decode(tx).length == size) {
        return tx;
      }
    }
    throw new IllegalStateException("no padding reaches " + size + " bytes");
  }

  /** GP UpstreamVerificationTest#completeValidatorAlsoRunsOnPlainPaymentsAndExceptionsFailClosed. */
  @Test
  void aFullPhase1ValidatorAlsoRunsOnPlainPaymentsAndItsExceptionsFailClosed() {
    String tx = plain().build();
    backend.phase1Validator = true;
    assertThat(verify(tx).isValid()).isTrue();

    backend.phase1Error = new IllegalArgumentException("ledger rejected");
    VerifyResponse response = verify(tx);
    assertThat(response.invalidReason()).isEqualTo(CardanoErrors.TRANSACTION_PHASE1_INVALID);
    assertThat(response.invalidMessage()).isEqualTo("ledger rejected");
  }

  // ---------------------------------------------- GP: recipient / amount / method on resume

  /**
   * GP UpstreamVerificationTest#broadcastRetryRechecksRecipientAmountAndAuthorizationWithSpentInputs
   * and #broadcastRetryStillChecksTransferMethod. After a broadcast with an unknown outcome the
   * claim is bound to the requirements that were settled, so a retry (verify or settle) naming
   * another recipient, amount or transfer method is refused; the original requirements resume
   * and verify with the nonce already spent.
   */
  @Test
  void aBroadcastRetryIsBoundToTheSettledRecipientAmountAndMethod() {
    JsonNode fixture = Vectors.fixture("01-default-happy");
    PaymentPayload payload = Vectors.payload(fixture.get("payload"));
    PaymentRequirements settled = Vectors.requirements(fixture.get("requirements"));
    String tx = (String) payload.payload().get("transaction");
    FakeChain chain = FakeChain.fromFixtures("01-default-happy").submitMode(FakeChain.SubmitMode.THROW_AFTER_BROADCAST);
    var scheme = new ExactCardanoFacilitatorScheme(chain, null, ExactCardanoFacilitatorOptions.builder()
        .clock(Clock.fixed(Instant.ofEpochMilli(Vectors.now()), ZoneOffset.UTC))
        .confirmationTimeout(Duration.ofMillis(5)).confirmationPoll(Duration.ofMillis(1)).build());
    assertThat(scheme.settle(payload, settled, FacilitatorContext.EMPTY).success()).isFalse();
    assertThat(chain.submissions()).containsExactly(tx);

    // The nonce is spent only once the transaction is included.
    chain.include(tx, 1);
    assertThat(scheme.verify(payload, settled, FacilitatorContext.EMPTY).isValid()).isTrue();

    String other = "addr_test1vqneq3v0dqh3x3muv6ee3lt8e5729xymnxuavx6tndcjc2cv24ef9";
    List<PaymentRequirements> changed = List.of(
        settled.withPayTo(other),
        settled.withAmount(Long.toString(Long.parseLong(settled.amount()) + 1)),
        settled.withExtra("assetTransferMethod", "unsupported"));
    for (PaymentRequirements req : changed) {
      VerifyResponse verdict = scheme.verify(payload, req, FacilitatorContext.EMPTY);
      assertThat(verdict.isValid()).as(req.toString()).isFalse();
      assertThat(verdict.invalidReason()).as(req.toString()).isEqualTo(CardanoErrors.DUPLICATE_SETTLEMENT);
      SettleResponse retry = scheme.settle(payload, req, FacilitatorContext.EMPTY);
      assertThat(retry.success()).as(req.toString()).isFalse();
    }
    assertThat(chain.submissions()).containsExactly(tx);
  }
}
