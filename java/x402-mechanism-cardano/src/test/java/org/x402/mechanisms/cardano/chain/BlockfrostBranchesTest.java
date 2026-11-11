package org.x402.mechanisms.cardano.chain;

import static com.github.tomakehurst.wiremock.client.WireMock.absent;
import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.get;
import static com.github.tomakehurst.wiremock.client.WireMock.getRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.okJson;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.urlPathEqualTo;
import static com.github.tomakehurst.wiremock.core.WireMockConfiguration.wireMockConfig;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.github.tomakehurst.wiremock.junit5.WireMockExtension;
import java.time.Duration;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.RegisterExtension;
import org.x402.mechanisms.cardano.testing.TxBuilder;
import org.x402.mechanisms.cardano.utils.CardanoTransactionDecoder;

/** Blockfrost backend edge cases. */
class BlockfrostBranchesTest {

  @RegisterExtension
  static WireMockExtension wm = WireMockExtension.newInstance().options(wireMockConfig().dynamicPort()).build();

  private static final String TX = "cd".repeat(32);
  private static final String OWNER = TxBuilder.walletAddress();

  private static BlockfrostChainBackend backend() {
    return new BlockfrostChainBackend(
        BlockfrostChainBackend.Config.builder()
            .network("cardano:preprod")
            .baseUrl(wm.baseUrl())
            .requestTimeout(Duration.ofMillis(200))
            .confirmationPoll(Duration.ofMillis(50))
            .build());
  }

  @Test
  void withoutConsumedByTheOwnersUtxoSetDecides() {
    wm.stubFor(get("/txs/" + TX + "/utxos").withHeader("project_id", absent())
        .willReturn(okJson("{\"outputs\":[{\"output_index\":1,\"address\":\"" + OWNER + "\",\"amount\":[{\"unit\":\"lovelace\",\"quantity\":\"9\"}]}]}")));
    wm.stubFor(get(urlPathEqualTo("/addresses/" + OWNER + "/utxos")).withQueryParam("page", com.github.tomakehurst.wiremock.client.WireMock.equalTo("1"))
        .willReturn(okJson("[{\"tx_hash\":\"" + TX + "\",\"output_index\":1}]")));
    assertThat(backend().getUtxo(TX + "#1", "cardano:preprod").exists()).isTrue();

    wm.stubFor(get(urlPathEqualTo("/addresses/" + OWNER + "/utxos")).withQueryParam("page", com.github.tomakehurst.wiremock.client.WireMock.equalTo("1"))
        .willReturn(okJson("[{\"tx_hash\":\"" + "00".repeat(32) + "\",\"output_index\":1}]")));
    wm.stubFor(get(urlPathEqualTo("/addresses/" + OWNER + "/utxos")).withQueryParam("page", com.github.tomakehurst.wiremock.client.WireMock.equalTo("2"))
        .willReturn(okJson("[]")));
    assertThat(backend().getUtxo(TX + "#1", "cardano:preprod").exists()).isFalse();
    wm.verify(getRequestedFor(urlPathEqualTo("/addresses/" + OWNER + "/utxos")));
  }

  @Test
  void anOwnerWithMoreUtxosThanThePageLimitIsALookupFailureNotSpent() {
    wm.stubFor(get("/txs/" + TX + "/utxos")
        .willReturn(okJson("{\"outputs\":[{\"output_index\":1,\"address\":\"" + OWNER + "\",\"amount\":[{\"unit\":\"lovelace\",\"quantity\":\"9\"}]}]}")));
    String other = "{\"tx_hash\":\"" + "00".repeat(32) + "\",\"output_index\":0}";
    wm.stubFor(get(urlPathEqualTo("/addresses/" + OWNER + "/utxos"))
        .willReturn(okJson("[" + String.join(",", java.util.Collections.nCopies(100, other)) + "]")));

    assertThatThrownBy(() -> backend().getUtxo(TX + "#1", "cardano:preprod"))
        .isInstanceOf(ChainLookupException.class);
  }

  @Test
  void malformedAnswersAndMissingResourcesAreLookupFailures() {
    wm.stubFor(get("/epochs/latest/parameters").willReturn(aResponse().withStatus(404)));
    assertThatThrownBy(() -> backend().getProtocolParameters("cardano:preprod")).hasMessage("Blockfrost returned no protocol parameters");
    wm.stubFor(get("/txs/" + TX).willReturn(aResponse().withStatus(200).withBody("{not json")));
    assertThatThrownBy(() -> backend().getTransactionEvidence(TX, "cardano:preprod")).hasMessage("Blockfrost returned malformed JSON");
    wm.stubFor(get("/txs/" + TX).willReturn(okJson("{\"hash\":\"x\"}")));
    wm.stubFor(get("/blocks/latest").willReturn(aResponse().withStatus(404)));
    assertThatThrownBy(() -> backend().getTransactionEvidence(TX, "cardano:preprod"))
        .isInstanceOf(ChainLookupException.class);
    assertThatThrownBy(() -> new BlockfrostChainBackend(BlockfrostChainBackend.Config.builder().network("cardano:preprod")
            .baseUrl("http://127.0.0.1:1").requestTimeout(Duration.ofMillis(200)).build()).getTransactionEvidence(TX, "cardano:preprod"))
        .isInstanceOf(ChainLookupException.class);
  }

  @Test
  void evaluationAndConfirmationEdges() {
    String tx = TxBuilder.create().input(TxBuilder.hash32(1), 0).output(OWNER, 1, java.util.Map.of(), null, false).build();
    wm.stubFor(post(urlPathEqualTo("/utils/txs/evaluate/utxos")).willReturn(okJson("{\"type\":\"jsonwsp/response\"}")));
    assertThatThrownBy(() -> backend().evaluateTransaction(tx, "cardano:preprod")).hasMessage("Blockfrost evaluation returned no result");
    wm.stubFor(post(urlPathEqualTo("/utils/txs/evaluate/utxos")).willReturn(okJson("{\"result\":{}}")));
    assertThatThrownBy(() -> backend().evaluateTransaction(tx, "cardano:preprod")).hasMessage("Blockfrost evaluation returned no result");
    wm.stubFor(post(urlPathEqualTo("/utils/txs/evaluate/utxos")).willReturn(aResponse().withStatus(500)));
    assertThatThrownBy(() -> backend().evaluateTransaction(tx, "cardano:preprod")).hasMessageStartingWith("Blockfrost evaluateTx failed: 500");

    String hash = CardanoTransactionDecoder.decode(tx).txHash();
    wm.stubFor(post("/tx/submit").willReturn(okJson("\"" + hash + "\"")));
    wm.stubFor(get("/txs/" + hash).willReturn(aResponse().withStatus(500)));
    assertThat(backend().submitTransaction(tx, "cardano:preprod").status()).isEqualTo(SettlementEvidence.Status.MEMPOOL);
    wm.stubFor(get("/txs/" + hash).willReturn(aResponse().withStatus(404)));
    assertThat(backend().submitTransaction(tx, "cardano:preprod").status()).isEqualTo(SettlementEvidence.Status.MEMPOOL);
  }

  @Test
  void configurationIsValidated() {
    assertThatThrownBy(() -> BlockfrostChainBackend.Config.builder().network("eip155:1").build())
        .hasMessage("Unsupported Cardano network: eip155:1");
    assertThatThrownBy(() -> BlockfrostChainBackend.Config.builder().network("cardano:preprod").requestTimeout(Duration.ZERO).build())
        .hasMessage("Cardano provider requestTimeout must be from 1 ms to 120 s");
    assertThatThrownBy(() -> BlockfrostChainBackend.Config.builder().network("cardano:preprod").requestTimeout(Duration.ofMinutes(3)).build())
        .hasMessage("Cardano provider requestTimeout must be from 1 ms to 120 s");
    var defaults = BlockfrostChainBackend.Config.builder().network("cardano:mainnet").build();
    assertThat(defaults.baseUrl()).isEqualTo("https://cardano-mainnet.blockfrost.io/api/v0");
    assertThat(defaults.awaitConfirmation()).isTrue();
    assertThat(new ChainLookupException("x").getMessage()).isEqualTo("x");
  }
}
