package org.x402.mechanisms.cardano.chain;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.equalTo;
import static com.github.tomakehurst.wiremock.client.WireMock.equalToJson;
import static com.github.tomakehurst.wiremock.client.WireMock.get;
import static com.github.tomakehurst.wiremock.client.WireMock.getRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.okJson;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.postRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static com.github.tomakehurst.wiremock.client.WireMock.urlPathEqualTo;
import static com.github.tomakehurst.wiremock.core.WireMockConfiguration.wireMockConfig;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.bloxbean.cardano.client.api.model.ProtocolParams;
import com.github.tomakehurst.wiremock.junit5.WireMockExtension;
import java.math.BigInteger;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.RegisterExtension;
import org.x402.mechanisms.cardano.utils.CardanoTransactionDecoder;
import org.x402.mechanisms.cardano.testing.Ccl;
import org.x402.mechanisms.cardano.testing.Vectors;

/** The Blockfrost backend against a WireMock Blockfrost: every SPI method, incl. evidence. */
class BlockfrostChainBackendTest {

  @RegisterExtension
  static WireMockExtension wm = WireMockExtension.newInstance().options(wireMockConfig().dynamicPort()).build();

  private static final String TX = "ab".repeat(32);
  private static final String PAYER =
      Vectors.fixture("01-default-happy").get("expected").get("payer").asText();
  private static final String UNIT = "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9" + "0014df10745553444d";
  private static final Clock CLOCK = Clock.fixed(Instant.ofEpochMilli(1_655_769_600_000L + 1_000_000L), ZoneOffset.UTC);

  private static BlockfrostChainBackend backend(boolean awaitConfirmation) {
    return new BlockfrostChainBackend(
        BlockfrostChainBackend.Config.builder()
            .network("cardano:preprod")
            .baseUrl(wm.baseUrl() + "/")
            .projectId("preprodKey")
            .requestTimeout(Duration.ofSeconds(2))
            .awaitConfirmation(awaitConfirmation)
            .confirmationPoll(Duration.ofMillis(5))
            .clock(CLOCK)
            .build());
  }

  private static String utxos(String consumedBy) {
    return "{\"hash\":\"" + TX + "\",\"inputs\":[],\"outputs\":[{\"output_index\":0,\"address\":\""
        + PAYER + "\",\"amount\":[{\"unit\":\"lovelace\",\"quantity\":\"5000000\"},{\"unit\":\"" + UNIT
        + "\",\"quantity\":\"7\"}],\"consumed_by_tx\":" + consumedBy + "}]}";
  }

  @Test
  void anUnspentOutputReportsOwnerValueAndKeyHash() {
    wm.stubFor(get("/txs/" + TX + "/utxos").withHeader("project_id", equalTo("preprodKey")).willReturn(okJson(utxos("null"))));

    UtxoSnapshot snapshot = backend(false).getUtxo(TX + "#0", "cardano:preprod");

    assertThat(snapshot.exists()).isTrue();
    assertThat(snapshot.address()).isEqualTo(PAYER);
    assertThat(snapshot.coin()).isEqualTo(BigInteger.valueOf(5_000_000));
    assertThat(snapshot.assets())
        .containsExactly(Map.entry("e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d", BigInteger.valueOf(7)));
    assertThat(snapshot.paymentKeyHash()).hasSize(56);
  }

  @Test
  void aConsumedOutputIsSpentButKeepsItsOwner() {
    wm.stubFor(get("/txs/" + TX + "/utxos").willReturn(okJson(utxos("\"" + "cd".repeat(32) + "\""))));

    UtxoSnapshot snapshot = backend(false).getUtxo(TX + "#0", "cardano:preprod");

    assertThat(snapshot.exists()).isFalse();
    assertThat(snapshot.address()).isEqualTo(PAYER);
  }

  @Test
  void anUnknownTransactionOrIndexDoesNotExist() {
    wm.stubFor(get("/txs/" + TX + "/utxos").willReturn(aResponse().withStatus(404)));
    assertThat(backend(false).getUtxo(TX + "#0", "cardano:preprod").exists()).isFalse();

    wm.stubFor(get("/txs/" + "cd".repeat(32) + "/utxos").willReturn(okJson(utxos("null"))));
    UtxoSnapshot missingIndex = backend(false).getUtxo("cd".repeat(32) + "#3", "cardano:preprod");
    assertThat(missingIndex.exists()).isFalse();
    assertThat(missingIndex.address()).isNull();
  }

  @Test
  void providerFailuresThrow() {
    wm.stubFor(get("/txs/" + TX + "/utxos").willReturn(aResponse().withStatus(500).withBody("boom")));
    assertThatThrownBy(() -> backend(false).getUtxo(TX + "#0", "cardano:preprod"))
        .isInstanceOf(ChainLookupException.class)
        .hasMessageContaining("500");
    assertThatThrownBy(() -> backend(false).getUtxo(TX + "#0", "cardano:mainnet"))
        .hasMessage("Backend configured for cardano:preprod but asked about cardano:mainnet");
  }

  @Test
  void theCurrentSlotComesFromTheClock() {
    assertThat(backend(false).getCurrentSlot("cardano:preprod")).isEqualTo(86_400L + 1_000L);
  }

  @Test
  void protocolParametersAreReadLiveAndCached() {
    wm.stubFor(
        get("/epochs/latest/parameters")
            .willReturn(okJson("{\"coins_per_utxo_size\":\"4310\",\"min_fee_a\":44,\"min_fee_b\":155381}")));
    BlockfrostChainBackend backend = backend(false);

    ProtocolParams first = backend.getProtocolParameters("cardano:preprod");
    ProtocolParams second = backend.getProtocolParameters("cardano:preprod");

    assertThat(first)
        .isEqualTo(Ccl.params(BigInteger.valueOf(4310), BigInteger.valueOf(44), BigInteger.valueOf(155381)));
    assertThat(second).isEqualTo(first);
    wm.verify(1, getRequestedFor(urlEqualTo("/epochs/latest/parameters")));
  }

  @Test
  void submitPostsTheExactBytesAndReportsMempool() {
    String tx = Vectors.fixture("01-default-happy").get("payload").get("payload").get("transaction").asText();
    String hash = CardanoTransactionDecoder.decode(tx).txHash();
    wm.stubFor(post("/tx/submit").willReturn(okJson("\"" + hash + "\"")));

    SubmissionResult result = backend(false).submitTransaction(tx, "cardano:preprod");

    assertThat(result.txHash()).isEqualTo(hash);
    assertThat(result.status()).isEqualTo(SettlementEvidence.Status.MEMPOOL);
    wm.verify(
        postRequestedFor(urlEqualTo("/tx/submit"))
            .withHeader("Content-Type", equalTo("application/cbor"))
            .withRequestBody(com.github.tomakehurst.wiremock.client.WireMock.binaryEqualTo(Base64.getDecoder().decode(tx))));
  }

  @Test
  void submitAwaitsInclusionWhenAsked() {
    String tx = Vectors.fixture("01-default-happy").get("payload").get("payload").get("transaction").asText();
    String hash = CardanoTransactionDecoder.decode(tx).txHash();
    wm.stubFor(post("/tx/submit").willReturn(okJson("\"" + hash + "\"")));
    wm.stubFor(get("/txs/" + hash).willReturn(okJson("{\"hash\":\"" + hash + "\",\"block_height\":10}")));

    assertThat(backend(true).submitTransaction(tx, "cardano:preprod").status())
        .isEqualTo(SettlementEvidence.Status.CONFIRMED);
  }

  @Test
  void aRejectedSubmissionThrowsWithTheNodeReason() {
    String tx = Vectors.fixture("01-default-happy").get("payload").get("payload").get("transaction").asText();
    wm.stubFor(post("/tx/submit").willReturn(aResponse().withStatus(400).withBody("{\"message\":\"BadInputsUTxO\"}")));

    assertThatThrownBy(() -> backend(false).submitTransaction(tx, "cardano:preprod"))
        .hasMessageContaining("BadInputsUTxO");
    assertThat(backend(false).isDefinitiveSubmissionRejection(new RuntimeException("x"))).isFalse();
  }

  @Test
  void evidenceReportsCanonicalDepth() {
    BlockfrostChainBackend backend = backend(false);
    assertThat(backend.supportsTransactionEvidence()).isTrue();

    wm.stubFor(get("/txs/" + TX).willReturn(aResponse().withStatus(404)));
    assertThat(backend.getTransactionEvidence(TX, "cardano:preprod")).isEqualTo(SettlementEvidence.unknown());

    wm.stubFor(get("/txs/" + TX).willReturn(okJson("{\"hash\":\"" + TX + "\",\"block_height\":100}")));
    wm.stubFor(get("/blocks/latest").willReturn(okJson("{\"height\":103}")));
    assertThat(backend.getTransactionEvidence(TX, "cardano:preprod"))
        .isEqualTo(new SettlementEvidence(SettlementEvidence.Status.CONFIRMED, 3));

    wm.stubFor(get("/txs/" + TX).willReturn(okJson("{\"hash\":\"" + TX + "\",\"block_height\":100,\"valid_contract\":false}")));
    assertThat(backend.getTransactionEvidence(TX, "cardano:preprod")).isEqualTo(SettlementEvidence.unknown());
  }

  @Test
  void aBackendWithoutEvaluationNeverCallsTheEvaluateEndpoint() {
    String tx = Vectors.fixture("01-default-happy").get("payload").get("payload").get("transaction").asText();
    wm.stubFor(post(urlPathEqualTo("/utils/txs/evaluate/utxos")).willReturn(aResponse().withStatus(404)));
    var noEvaluation = new BlockfrostChainBackend(BlockfrostChainBackend.Config.builder()
        .network("cardano:preprod").baseUrl(wm.baseUrl() + "/").projectId("preprodKey").clock(CLOCK)
        .evaluation(false).build());

    noEvaluation.evaluateTransaction(tx, "cardano:preprod");

    wm.verify(0, postRequestedFor(urlPathEqualTo("/utils/txs/evaluate/utxos")));
    assertThatThrownBy(() -> backend(false).evaluateTransaction(tx, "cardano:preprod"))
        .isInstanceOf(RuntimeException.class);
  }

  @Test
  void evaluationUsesTheJsonEndpointAndFailsOnScriptFailure() {
    String tx = Vectors.fixture("01-default-happy").get("payload").get("payload").get("transaction").asText();
    String cborHex = HexFormat.of().formatHex(Base64.getDecoder().decode(tx));
    wm.stubFor(
        post(urlPathEqualTo("/utils/txs/evaluate/utxos"))
            .withRequestBody(equalToJson("{\"cbor\":\"" + cborHex + "\",\"additionalUtxoSet\":[]}"))
            .willReturn(okJson("{\"type\":\"jsonwsp/response\",\"result\":{\"EvaluationResult\":{}}}")));
    backend(false).evaluateTransaction(tx, "cardano:preprod");

    wm.stubFor(
        post(urlPathEqualTo("/utils/txs/evaluate/utxos"))
            .willReturn(okJson("{\"type\":\"jsonwsp/response\",\"result\":{\"EvaluationFailure\":{\"x\":1}}}")));
    assertThatThrownBy(() -> backend(false).evaluateTransaction(tx, "cardano:preprod"))
        .hasMessageContaining("script evaluation failed");

    wm.stubFor(
        post(urlPathEqualTo("/utils/txs/evaluate/utxos"))
            .willReturn(okJson("{\"type\":\"jsonwsp/fault\",\"fault\":{\"string\":\"bad\"}}")));
    assertThatThrownBy(() -> backend(false).evaluateTransaction(tx, "cardano:preprod"))
        .hasMessageContaining("evaluation fault: bad");
  }

  @Test
  void knowsTheBlockfrostUrlOfEachNetwork() {
    assertThat(BlockfrostChainBackend.defaultBaseUrl("cardano:mainnet"))
        .isEqualTo("https://cardano-mainnet.blockfrost.io/api/v0");
    assertThat(BlockfrostChainBackend.defaultBaseUrl("cardano:preprod"))
        .isEqualTo("https://cardano-preprod.blockfrost.io/api/v0");
    assertThat(BlockfrostChainBackend.defaultBaseUrl("cardano:preview"))
        .isEqualTo("https://cardano-preview.blockfrost.io/api/v0");
  }

  @Test
  void anOutputIndexPast32BitsNeverMatchesIndexZero() {
    wm.stubFor(get("/txs/" + TX + "/utxos").willReturn(okJson(utxos("null"))));

    assertThat(backend(false).getUtxo(TX + "#4294967296", "cardano:preprod").exists()).isFalse();
  }

  @Test
  void anOutputIndexPast32BitsNeverMatchesIndexZeroOnTheAddressScan() {
    wm.stubFor(get("/txs/" + TX + "/utxos").willReturn(okJson(
        "{\"hash\":\"" + TX + "\",\"inputs\":[],\"outputs\":[{\"output_index\":0,\"address\":\""
            + PAYER + "\",\"amount\":[{\"unit\":\"lovelace\",\"quantity\":\"5000000\"}]}]}")));
    wm.stubFor(get(urlPathEqualTo("/addresses/" + PAYER + "/utxos")).willReturn(okJson(
        "[{\"tx_hash\":\"" + TX + "\",\"output_index\":0,\"amount\":[]}]")));

    assertThat(backend(false).getUtxo(TX + "#4294967296", "cardano:preprod").exists()).isFalse();
  }

  @Test
  void aFailedWalletPageIsALookupFailureNotAShortList() {
    StringBuilder full = new StringBuilder("[");
    for (int i = 0; i < 100; i++) {
      full.append(i == 0 ? "" : ",").append("{\"tx_hash\":\"").append(TX).append("\",\"output_index\":")
          .append(i).append(",\"amount\":[{\"unit\":\"lovelace\",\"quantity\":\"1000000\"}]}");
    }
    full.append("]");
    wm.stubFor(get(urlPathEqualTo("/addresses/" + PAYER + "/utxos")).withQueryParam("page", equalTo("1"))
        .willReturn(okJson(full.toString())));
    wm.stubFor(get(urlPathEqualTo("/addresses/" + PAYER + "/utxos")).withQueryParam("page", equalTo("2"))
        .willReturn(aResponse().withStatus(500).withBody("boom")));

    assertThatThrownBy(() -> backend(false).getAll(PAYER)).isInstanceOf(ChainLookupException.class);
  }

  @Test
  void aWalletPageThatIsNotAListIsALookupFailure() {
    wm.stubFor(get(urlPathEqualTo("/addresses/" + PAYER + "/utxos"))
        .willReturn(okJson("{\"error\":\"unexpected\"}")));

    assertThatThrownBy(() -> backend(false).getAll(PAYER)).isInstanceOf(ChainLookupException.class);
  }

  @Test
  void aUtxoAnswerWithoutOutputsIsALookupFailureNotSpent() {
    wm.stubFor(get("/txs/" + TX + "/utxos").willReturn(okJson("{\"hash\":\"" + TX + "\"}")));

    assertThatThrownBy(() -> backend(false).getUtxo(TX + "#0", "cardano:preprod"))
        .isInstanceOf(ChainLookupException.class);
  }

  @Test
  void aMatchingOutputWithoutAnAddressIsALookupFailureNotSpent() {
    wm.stubFor(get("/txs/" + TX + "/utxos").willReturn(okJson(
        "{\"hash\":\"" + TX + "\",\"outputs\":[{\"output_index\":0,\"amount\":[]}]}")));

    assertThatThrownBy(() -> backend(false).getUtxo(TX + "#0", "cardano:preprod"))
        .isInstanceOf(ChainLookupException.class);
  }

  @Test
  void anAddressScanPageThatIsNotAListIsALookupFailure() {
    wm.stubFor(get("/txs/" + TX + "/utxos").willReturn(okJson(
        "{\"hash\":\"" + TX + "\",\"outputs\":[{\"output_index\":0,\"address\":\""
            + PAYER + "\",\"amount\":[{\"unit\":\"lovelace\",\"quantity\":\"5000000\"}]}]}")));
    wm.stubFor(get(urlPathEqualTo("/addresses/" + PAYER + "/utxos")).willReturn(okJson("{}")));

    assertThatThrownBy(() -> backend(false).getUtxo(TX + "#0", "cardano:preprod"))
        .isInstanceOf(ChainLookupException.class);
  }

  @Test
  void anOversizedBlockHeightIsALookupFailure() {
    wm.stubFor(get("/txs/" + TX).willReturn(okJson(
        "{\"hash\":\"" + TX + "\",\"block_height\":18446744073709551616}")));
    wm.stubFor(get("/blocks/latest").willReturn(okJson("{\"height\":103}")));

    assertThatThrownBy(() -> backend(false).getTransactionEvidence(TX, "cardano:preprod"))
        .isInstanceOf(ChainLookupException.class);
  }

  @Test
  void evidenceForAnotherOrNoTransactionIsALookupFailure() {
    wm.stubFor(get("/blocks/latest").willReturn(okJson("{\"height\":103}")));
    for (String body : new String[] {"{\"block_height\":100}",
        "{\"hash\":\"" + "cd".repeat(32) + "\",\"block_height\":100}"}) {
      wm.stubFor(get("/txs/" + TX).willReturn(okJson(body)));
      assertThatThrownBy(() -> backend(false).getTransactionEvidence(TX, "cardano:preprod"))
          .as(body).isInstanceOf(ChainLookupException.class);
    }
  }

  @Test
  void aMissingTipIsALookupFailure() {
    wm.stubFor(get("/txs/" + TX).willReturn(okJson("{\"hash\":\"" + TX + "\",\"block_height\":100}")));
    wm.stubFor(get("/blocks/latest").willReturn(aResponse().withStatus(404)));

    assertThatThrownBy(() -> backend(false).getTransactionEvidence(TX, "cardano:preprod"))
        .isInstanceOf(ChainLookupException.class);
  }

  @Test
  void aMistypedConsumedByIsALookupFailureNotUnspent() {
    wm.stubFor(get("/txs/" + TX + "/utxos").willReturn(okJson(utxos("7"))));

    assertThatThrownBy(() -> backend(false).getUtxo(TX + "#0", "cardano:preprod"))
        .isInstanceOf(ChainLookupException.class);
  }

  @Test
  void malformedTransactionEvidenceIsALookupFailure() {
    wm.stubFor(get("/blocks/latest").willReturn(okJson("{\"height\":103}")));
    for (String body : new String[] {"null", "[]", "{\"hash\":\"" + TX + "\",\"block_height\":100,\"valid_contract\":\"false\"}"}) {
      wm.stubFor(get("/txs/" + TX).willReturn(okJson(body)));
      assertThatThrownBy(() -> backend(false).getTransactionEvidence(TX, "cardano:preprod"))
          .as(body).isInstanceOf(ChainLookupException.class);
    }
  }

  @Test
  void anEmptyConsumedByIsALookupFailureNotUnspent() {
    wm.stubFor(get("/txs/" + TX + "/utxos").willReturn(okJson(utxos("\"\""))));

    assertThatThrownBy(() -> backend(false).getUtxo(TX + "#0", "cardano:preprod"))
        .isInstanceOf(ChainLookupException.class);
  }

  @Test
  void anAddressScanRowWithoutAnIndexIsALookupFailureNotAMatch() {
    wm.stubFor(get("/txs/" + TX + "/utxos").willReturn(okJson(
        "{\"hash\":\"" + TX + "\",\"outputs\":[{\"output_index\":0,\"address\":\""
            + PAYER + "\",\"amount\":[{\"unit\":\"lovelace\",\"quantity\":\"5000000\"}]}]}")));
    wm.stubFor(get(urlPathEqualTo("/addresses/" + PAYER + "/utxos")).willReturn(okJson(
        "[{\"tx_hash\":\"" + TX + "\",\"amount\":[]}]")));

    assertThatThrownBy(() -> backend(false).getUtxo(TX + "#0", "cardano:preprod"))
        .isInstanceOf(ChainLookupException.class);
  }

  @Test
  void anOutputRowWithoutAnIndexIsALookupFailureNotSpent() {
    wm.stubFor(get("/txs/" + TX + "/utxos").willReturn(okJson(
        "{\"hash\":\"" + TX + "\",\"outputs\":[{\"address\":\"" + PAYER + "\",\"amount\":[]}]}")));

    assertThatThrownBy(() -> backend(false).getUtxo(TX + "#0", "cardano:preprod"))
        .isInstanceOf(ChainLookupException.class);
  }

  @Test
  void theCurrentSlotFollowsASlotConfigOverride() {
    var backend = new BlockfrostChainBackend(BlockfrostChainBackend.Config.builder()
        .network("cardano:preprod").baseUrl(wm.baseUrl()).clock(CLOCK)
        .slotConfig(new com.bloxbean.cardano.client.common.model.SlotConfig(2000, 0L, 1_655_769_600_000L))
        .build());

    // 1 000 000 ms after zero time at 2 s per slot.
    assertThat(backend.getCurrentSlot("cardano:preprod")).isEqualTo(500L);
  }

  private static BlockfrostChainBackend guarded() {
    return new BlockfrostChainBackend(BlockfrostChainBackend.Config.builder()
        .network("cardano:preprod").baseUrl(wm.baseUrl()).clock(CLOCK)
        .networkMagic(1).maxTipAge(java.time.Duration.ofMinutes(5)).build());
  }

  /** CLOCK is 1 000 000 ms after preprod zero time, i.e. slot 86 400 + 1 000. */
  private static void tipAtSlot(long slot) {
    wm.stubFor(get("/blocks/latest").willReturn(okJson("{\"height\":103,\"slot\":" + slot + "}")));
  }

  private static String fixtureTx() {
    return Vectors.fixture("01-default-happy").get("payload").get("payload").get("transaction").asText();
  }

  private static Throwable submitError(BlockfrostChainBackend backend) {
    try {
      backend.submitTransaction(fixtureTx(), "cardano:preprod");
      return null;
    } catch (RuntimeException e) {
      return e;
    }
  }

  @Test
  void aSubmitBlockedByTheIdentityGuardIsNeverSent() {
    wm.stubFor(get("/genesis").willReturn(okJson("{\"network_magic\":2}")));
    tipAtSlot(87_400);
    wm.stubFor(post(urlPathEqualTo("/tx/submit")).willReturn(okJson("\"" + TX + "\"")));
    BlockfrostChainBackend backend = guarded();

    Throwable error = submitError(backend);

    assertThat(backend.isSubmissionNeverSent(error)).isTrue();
    wm.verify(0, postRequestedFor(urlPathEqualTo("/tx/submit")));
  }

  @Test
  void aStaleTipBlocksSubmitAsNeverSent() {
    wm.stubFor(get("/genesis").willReturn(okJson("{\"network_magic\":1}")));
    tipAtSlot(87_400 - 3_600);
    BlockfrostChainBackend backend = guarded();

    assertThat(backend.isSubmissionNeverSent(submitError(backend))).isTrue();
    wm.verify(0, postRequestedFor(urlPathEqualTo("/tx/submit")));
  }

  @Test
  void aProviderErrorAfterThePostIsNotNeverSent() {
    wm.stubFor(get("/genesis").willReturn(okJson("{\"network_magic\":1}")));
    tipAtSlot(87_400);
    wm.stubFor(post(urlPathEqualTo("/tx/submit")).willReturn(aResponse().withStatus(500).withBody("boom")));
    BlockfrostChainBackend backend = guarded();

    Throwable error = submitError(backend);

    assertThat(error).isNotNull();
    assertThat(backend.isSubmissionNeverSent(error)).isFalse();
    wm.verify(1, postRequestedFor(urlPathEqualTo("/tx/submit")));
  }

  @Test
  void aSubmitTransportFailureIsNotNeverSent() {
    var unreachable = new BlockfrostChainBackend(BlockfrostChainBackend.Config.builder()
        .network("cardano:preprod").baseUrl("http://127.0.0.1:1/").clock(CLOCK)
        .requestTimeout(java.time.Duration.ofMillis(500)).build());

    Throwable error = submitError(unreachable);

    assertThat(error).isNotNull();
    assertThat(unreachable.isSubmissionNeverSent(error)).isFalse();
  }

  @Test
  void aWrappedNeverSentErrorIsNotNeverSent() {
    wm.stubFor(get("/genesis").willReturn(okJson("{\"network_magic\":2}")));
    tipAtSlot(87_400);
    BlockfrostChainBackend backend = guarded();
    Throwable error = submitError(backend);

    assertThat(backend.isSubmissionNeverSent(new IllegalStateException("retry wrapper", error))).isFalse();
  }

  @Test
  void aProviderOnAnotherNetworkIsALookupFailure() {
    wm.stubFor(get("/genesis").willReturn(okJson("{\"network_magic\":2}")));
    tipAtSlot(87_400);
    wm.stubFor(get("/txs/" + TX + "/utxos").willReturn(okJson(utxos("null"))));

    assertThatThrownBy(() -> guarded().getUtxo(TX + "#0", "cardano:preprod"))
        .isInstanceOf(ChainLookupException.class);
  }

  @Test
  void aStaleTipIsALookupFailure() {
    wm.stubFor(get("/genesis").willReturn(okJson("{\"network_magic\":1}")));
    tipAtSlot(87_400 - 3_600);
    wm.stubFor(get("/txs/" + TX + "/utxos").willReturn(okJson(utxos("null"))));

    assertThatThrownBy(() -> guarded().getUtxo(TX + "#0", "cardano:preprod"))
        .isInstanceOf(ChainLookupException.class);
  }

  @Test
  void theMatchingNetworkWithAFreshTipIsServed() {
    wm.stubFor(get("/genesis").willReturn(okJson("{\"network_magic\":1}")));
    tipAtSlot(87_390);
    wm.stubFor(get("/txs/" + TX + "/utxos").willReturn(okJson(utxos("null"))));

    assertThat(guarded().getUtxo(TX + "#0", "cardano:preprod").exists()).isTrue();
  }

  @Test
  void aTransactionInTheMempoolIsMempoolEvidence() {
    wm.stubFor(get("/txs/" + TX).willReturn(aResponse().withStatus(404)));
    wm.stubFor(get("/mempool/" + TX).willReturn(okJson("{\"tx\":{\"hash\":\"" + TX + "\"}}")));

    assertThat(backend(false).getTransactionEvidence(TX, "cardano:preprod").status())
        .isEqualTo(SettlementEvidence.Status.MEMPOOL);
  }

  @Test
  void aMempoolTheProviderCannotReadIsALookupFailureNotAbsence() {
    wm.stubFor(get("/txs/" + TX).willReturn(aResponse().withStatus(404)));
    for (int status : new int[] {401, 403, 429, 500, 503}) {
      wm.stubFor(get("/mempool/" + TX).willReturn(aResponse().withStatus(status)));
      assertThatThrownBy(() -> backend(false).getTransactionEvidence(TX, "cardano:preprod"))
          .as("mempool " + status).isInstanceOf(ChainLookupException.class);
    }
  }

  @Test
  void onlyAMempool404IsAbsence() {
    wm.stubFor(get("/txs/" + TX).willReturn(aResponse().withStatus(404)));
    wm.stubFor(get("/mempool/" + TX).willReturn(aResponse().withStatus(404)));

    assertThat(backend(false).getTransactionEvidence(TX, "cardano:preprod"))
        .isEqualTo(SettlementEvidence.unknown());
  }

  @Test
  void theHealthCheckRereadsTheTipEvenWhenParametersAreCached() {
    wm.stubFor(get("/genesis").willReturn(okJson("{\"network_magic\":1}")));
    wm.stubFor(get("/epochs/latest/parameters").willReturn(okJson(
        "{\"coins_per_utxo_size\":\"4310\",\"min_fee_a\":44,\"min_fee_b\":155381}")));
    tipAtSlot(87_390);
    BlockfrostChainBackend backend = guarded();
    backend.checkHealth("cardano:preprod");
    backend.getProtocolParameters("cardano:preprod");

    tipAtSlot(87_390 - 3_600);
    assertThatThrownBy(() -> backend.checkHealth("cardano:preprod"))
        .isInstanceOf(ChainLookupException.class);
  }

  @Test
  void theHealthCheckFailsWhenTheProviderIsUnreachable() {
    wm.stubFor(get("/blocks/latest").willReturn(aResponse().withStatus(503)));

    assertThatThrownBy(() -> backend(false).checkHealth("cardano:preprod"))
        .isInstanceOf(ChainLookupException.class);
  }

  /** A Blockfrost 400 body as the node reports Conway ledger failures. */
  private static String ledgerRejection(String... failures) {
    StringBuilder errors = new StringBuilder();
    for (String f : failures) {
      errors.append(errors.length() == 0 ? "" : ", ").append("ConwayUtxowFailure (UtxoFailure (").append(f).append("))");
    }
    return "{\"error\":\"Bad Request\",\"message\":\"transaction submit error ShelleyTxValidationError "
        + "ShelleyBasedEraConway (ApplyTxError (" + errors + " :| []))\",\"status_code\":400}";
  }

  private boolean classify(int status, String body) {
    String tx = Vectors.fixture("01-default-happy").get("payload").get("payload").get("transaction").asText();
    wm.stubFor(post("/tx/submit").willReturn(aResponse().withStatus(status).withBody(body)));
    BlockfrostChainBackend backend = backend(false);
    try {
      backend.submitTransaction(tx, "cardano:preprod");
    } catch (RuntimeException e) {
      return backend.isDefinitiveSubmissionRejection(e);
    }
    throw new AssertionError("submit did not fail");
  }

  @Test
  void badInputsIsNeverADefinitiveRejection() {
    assertThat(classify(400, ledgerRejection("BadInputsUTxO (fromList [TxIn (TxId abc) (TxIx 0)])"))).isFalse();
    assertThat(classify(400, ledgerRejection("BadInputsUTxO (fromList [])", "ValueNotConservedUTxO (Mismatch 1 2)")))
        .isFalse();
    assertThat(classify(400, ledgerRejection("BadInputsUTxO (fromList [])", "MissingVKeyWitnessesUTXOW (fromList [])")))
        .isFalse();
  }

  @Test
  void eachContentDecidedErrorAloneIsDefinitive() {
    // Deliberate requirement change (review B1, user-approved 2026-10-14): was also
    // OutsideValidityIntervalUTxO, which the node reports for a not-yet-valid transaction too.
    for (String f : new String[] {
        "MissingVKeyWitnessesUTXOW (fromList [])", "InvalidWitnessesUTXOW [VKey]",
        "FeeTooSmallUTxO (Coin 1) (Coin 2)", "ValueNotConservedUTxO (Mismatch 1 2)", "MaxTxSizeUTxO 70000 16384"}) {
      assertThat(classify(400, ledgerRejection(f))).as(f).isTrue();
    }
  }

  @Test
  void aValidityIntervalFailureIsNeverDefinitive() {
    // The node reports it both for an expired and for a not-yet-valid transaction.
    assertThat(classify(400, ledgerRejection("OutsideValidityIntervalUTxO (ValidityInterval {invalidBefore = "
        + "SJust (SlotNo 120), invalidHereafter = SJust (SlotNo 900)}) (SlotNo 100)"))).isFalse();
  }

  @Test
  void aDefinitiveErrorNextToARealUnsuffixedRuleIsNotDefinitive() {
    assertThat(classify(400, ledgerRejection("FeeTooSmallUTxO (Coin 1) (Coin 2)", "InsufficientCollateral (Coin 1) (Coin 2)")))
        .isFalse();
    assertThat(classify(400, ledgerRejection("FeeTooSmallUTxO (Coin 1) (Coin 2)",
        "NotAllowedSupplementalDatums (fromList []) (fromList [])"))).isFalse();
  }

  @Test
  void aDefinitiveErrorNextToAnUnlistedOneIsNotDefinitive() {
    assertThat(classify(400, ledgerRejection("FeeTooSmallUTxO (Coin 1) (Coin 2)", "InsufficientCollateralUTXOS (Coin 1)")))
        .isFalse();
  }

  @Test
  void nonLedgerFailuresAreNeverDefinitive() {
    assertThat(classify(400, "{\"message\":\"something else\"}")).isFalse();
    assertThat(classify(403, ledgerRejection("FeeTooSmallUTxO (Coin 1) (Coin 2)"))).isFalse();
    assertThat(classify(500, ledgerRejection("FeeTooSmallUTxO (Coin 1) (Coin 2)"))).isFalse();
    assertThat(classify(503, "upstream unavailable")).isFalse();
  }
}
