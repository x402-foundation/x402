package org.x402.mechanisms.cardano.parity;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
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

import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.common.model.Networks;
import com.github.tomakehurst.wiremock.junit5.WireMockExtension;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.RegisterExtension;
import org.x402.core.FacilitatorContext;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.core.types.VerifyResponse;
import org.x402.mechanisms.cardano.utils.CardanoErrors;
import org.x402.mechanisms.cardano.utils.CardanoTransactionDecoder;
import org.x402.mechanisms.cardano.chain.BlockfrostChainBackend;
import org.x402.mechanisms.cardano.chain.ChainLookupException;
import org.x402.mechanisms.cardano.chain.SettlementEvidence;
import org.x402.mechanisms.cardano.exact.facilitator.ExactCardanoFacilitatorOptions;
import org.x402.mechanisms.cardano.exact.facilitator.ExactCardanoFacilitatorScheme;
import org.x402.mechanisms.cardano.testing.TxBuilder;

/**
 * Work package B8-gaps, chain-provider part: the app's Blockfrost, provider-identity and lookup
 * budget tests, ported to the SDK's {@link BlockfrostChainBackend} against WireMock where the SDK
 * has the concept (the per-request session cache, executor budget and backend factory are
 * app-internal and have no SDK counterpart).
 */
class AppB8ChainGapsTest {

  @RegisterExtension
  static WireMockExtension wm = WireMockExtension.newInstance().options(wireMockConfig().dynamicPort()).build();

  private static final String NETWORK = "cardano:preprod";
  private static final String PAYER = TxBuilder.walletAddress();
  private static final String PAY_TO =
      new Account(Networks.testnet(), "test walk nut penalty hip pave soap entry language right filter choice", 1)
          .baseAddress();
  private static final String HASH = TxBuilder.hash32(0xaa);
  /** One million milliseconds after the preprod zero time: slot 86 400 + 1 000. */
  private static final Clock CLOCK = Clock.fixed(Instant.ofEpochMilli(1_655_769_600_000L + 1_000_000L), ZoneOffset.UTC);
  private static final long NOW_SLOT = 87_400L;
  private static final String PARAMS = "{\"coins_per_utxo_size\":\"4310\",\"min_fee_a\":44,\"min_fee_b\":155381}";

  @BeforeEach
  void reset() {
    wm.resetAll();
  }

  private static BlockfrostChainBackend plain() {
    return plain(Duration.ofSeconds(2));
  }

  private static BlockfrostChainBackend plain(Duration timeout) {
    return new BlockfrostChainBackend(BlockfrostChainBackend.Config.builder()
        .network(NETWORK).baseUrl(wm.baseUrl()).requestTimeout(timeout).awaitConfirmation(false)
        .evaluation(false).clock(CLOCK).build());
  }

  private static BlockfrostChainBackend guarded() {
    return new BlockfrostChainBackend(BlockfrostChainBackend.Config.builder()
        .network(NETWORK).baseUrl(wm.baseUrl()).clock(CLOCK)
        .networkMagic(1).maxTipAge(Duration.ofMinutes(5)).build());
  }

  private static void utxo(String ref, String address, long coin) {
    String[] parts = ref.split("#");
    wm.stubFor(get("/txs/" + parts[0] + "/utxos").willReturn(okJson(
        "{\"hash\":\"" + parts[0] + "\",\"outputs\":[{\"output_index\":" + parts[1] + ",\"address\":\"" + address
            + "\",\"amount\":[{\"unit\":\"lovelace\",\"quantity\":\"" + coin + "\"}],\"consumed_by_tx\":null}]}")));
  }

  private static void tipAtSlot(long slot) {
    wm.stubFor(get("/blocks/latest").willReturn(okJson("{\"height\":103,\"slot\":" + slot + "}")));
  }

  private static String payment(Long ttl) {
    return TxBuilder.create().input(HASH, 0)
        .output(PAY_TO, 2_000_000, Map.of(), null, false)
        .output(PAYER, 7_800_000, Map.of(), null, false)
        .fee(200_000).ttl(ttl).signWith(TxBuilder.WALLET).build();
  }

  private static PaymentRequirements requirements() {
    return new PaymentRequirements("exact", NETWORK, "lovelace", "2000000", PAY_TO, 600, Map.of());
  }

  private static PaymentPayload payload(String tx) {
    Map<String, Object> p = new LinkedHashMap<>();
    p.put("transaction", tx);
    p.put("nonce", HASH + "#0");
    return new PaymentPayload(2, null, requirements(), p, null);
  }

  private static ExactCardanoFacilitatorScheme scheme(BlockfrostChainBackend backend) {
    return new ExactCardanoFacilitatorScheme(backend, null, ExactCardanoFacilitatorOptions.builder()
        .clock(CLOCK).confirmationTimeout(Duration.ofMillis(20)).confirmationPoll(Duration.ofMillis(5)).build());
  }

  // ============================================================ BlockfrostChainServiceTest GP

  /**
   * GP BlockfrostChainServiceTest#demoExpiryAtQuotedTimeoutPassesBetweenBlocksButLongerExpiryStillFails
   * (preprod at-limit TTL boundary). The SDK derives the current slot from the clock; a TTL of
   * now + maxTimeoutSeconds passes, one slot later is too far, and the current slot is expired.
   */
  @Test
  void aTtlAtTheQuotedTimeoutPassesAndOneSlotLaterIsTooFarOnPreprod() {
    utxo(HASH + "#0", PAYER, 10_000_000);
    wm.stubFor(get("/epochs/latest/parameters").willReturn(okJson(PARAMS)));
    ExactCardanoFacilitatorScheme scheme = scheme(plain());

    VerifyResponse atLimit = scheme.verify(payload(payment(NOW_SLOT + 600)), requirements(), FacilitatorContext.EMPTY);
    assertThat(atLimit.isValid()).as(atLimit.invalidReason() + " " + atLimit.invalidMessage()).isTrue();
    assertThat(scheme.verify(payload(payment(NOW_SLOT + 601)), requirements(), FacilitatorContext.EMPTY).invalidReason())
        .isEqualTo(CardanoErrors.TTL_TOO_FAR);
    assertThat(scheme.verify(payload(payment(NOW_SLOT)), requirements(), FacilitatorContext.EMPTY).invalidReason())
        .isEqualTo(CardanoErrors.TTL_EXPIRED);
  }

  /**
   * GP BlockfrostChainServiceTest#wrongHashIsUnknownNotAcceptance, at the Blockfrost level: the
   * provider answers another transaction id for the submission. The backend reports what the
   * provider returned and the scheme must not treat the settlement as the payment's.
   */
  @Test
  void aProviderThatAcknowledgesAnotherTransactionIdIsNotASettlement() {
    utxo(HASH + "#0", PAYER, 10_000_000);
    wm.stubFor(get("/epochs/latest/parameters").willReturn(okJson(PARAMS)));
    String wrong = "ee".repeat(32);
    wm.stubFor(post("/tx/submit").willReturn(okJson("\"" + wrong + "\"")));
    wm.stubFor(get(urlPathEqualTo("/txs/" + wrong)).willReturn(aResponse().withStatus(404)));
    wm.stubFor(get(urlPathEqualTo("/mempool/" + wrong)).willReturn(aResponse().withStatus(404)));
    String tx = payment(NOW_SLOT + 300);
    String realHash = CardanoTransactionDecoder.decode(tx).txHash();
    wm.stubFor(get(urlPathEqualTo("/txs/" + realHash)).willReturn(aResponse().withStatus(404)));
    wm.stubFor(get(urlPathEqualTo("/mempool/" + realHash)).willReturn(aResponse().withStatus(404)));

    assertThat(plain().submitTransaction(tx, NETWORK).txHash()).isEqualTo(wrong);
    wm.resetRequests();

    SettleResponse settled = scheme(plain()).settle(payload(tx), requirements(), FacilitatorContext.EMPTY);

    wm.verify(1, postRequestedFor(urlEqualTo("/tx/submit")));
    assertThat(settled.success()).isFalse();
    assertThat(settled.transaction()).isEqualTo(realHash);
    assertThat(settled.errorReason()).isEqualTo(CardanoErrors.SETTLEMENT_PENDING);
    assertThat(settled.errorMessage()).contains("submitter returned transaction " + wrong);
  }

  /**
   * GP BlockfrostChainServiceTest#persistentPollingFailureCannotBecomeAbsence: while the settlement
   * waits for the transaction a failing provider is a lookup failure, never "not seen".
   */
  @Test
  void aFailingProviderWhileWaitingForInclusionIsNeverAbsence() {
    String tx = payment(NOW_SLOT + 300);
    String hash = CardanoTransactionDecoder.decode(tx).txHash();
    wm.stubFor(get("/txs/" + hash).willReturn(aResponse().withStatus(503)));
    wm.stubFor(post("/tx/submit").willReturn(okJson("\"" + hash + "\"")));

    assertThatThrownBy(() -> plain().getTransactionEvidence(hash, NETWORK)).isInstanceOf(ChainLookupException.class);
    // The broadcast already succeeded: a poll failure leaves it in the mempool, not rejected or absent.
    BlockfrostChainBackend waiting = new BlockfrostChainBackend(BlockfrostChainBackend.Config.builder()
        .network(NETWORK).baseUrl(wm.baseUrl()).requestTimeout(Duration.ofMillis(300))
        .confirmationPoll(Duration.ofMillis(10)).awaitConfirmation(true).clock(CLOCK).build());
    assertThat(waiting.submitTransaction(tx, NETWORK).status()).isEqualTo(SettlementEvidence.Status.MEMPOOL);
  }

  /**
   * GP BlockfrostChainServiceTest#pathologicalAddressScanHasAHardProviderCallBudget: an address
   * whose pages never contain the output is read for at most 50 pages, then fails as a lookup
   * failure (never "spent").
   */
  @Test
  void theAddressScanIsCappedAtFiftyPagesAndFailsAsALookupFailure() {
    wm.stubFor(get("/txs/" + HASH + "/utxos").willReturn(okJson(
        "{\"hash\":\"" + HASH + "\",\"outputs\":[{\"output_index\":0,\"address\":\"" + PAYER
            + "\",\"amount\":[{\"unit\":\"lovelace\",\"quantity\":\"5000000\"}]}]}")));
    String other = "{\"tx_hash\":\"" + "ff".repeat(32) + "\",\"output_index\":0,\"amount\":[]}";
    wm.stubFor(get(urlPathEqualTo("/addresses/" + PAYER + "/utxos"))
        .willReturn(okJson("[" + String.join(",", Collections.nCopies(100, other)) + "]")));

    assertThatThrownBy(() -> plain().getUtxo(HASH + "#0", NETWORK)).isInstanceOf(ChainLookupException.class);

    wm.verify(50, getRequestedFor(urlPathEqualTo("/addresses/" + PAYER + "/utxos")));
  }

  /**
   * GP BlockfrostChainServiceTest#totalBudgetCoversAllInputsAndFailsClosedWithoutFurtherCalls: the
   * SDK budget is the number of input lookups per verification (default 64); 64 inputs verify, 65
   * fail as a lookup failure before any provider call.
   */
  @Test
  void aVerificationResolvesAtMostSixtyFourInputsAndMakesNoCallBeyondThat() {
    wm.stubFor(get("/epochs/latest/parameters").willReturn(okJson(PARAMS)));
    wm.stubFor(get("/txs/" + HASH + "/utxos").willReturn(okJson(
        "{\"hash\":\"" + HASH + "\",\"outputs\":[" + outputs(65) + "]}")));
    ExactCardanoFacilitatorScheme scheme = scheme(plain());

    VerifyResponse ok = scheme.verify(payload(manyInputs(64)), requirements(), FacilitatorContext.EMPTY);
    assertThat(ok.isValid()).as(ok.invalidReason() + " " + ok.invalidMessage()).isTrue();
    int callsFor64 = wm.findAll(getRequestedFor(urlEqualTo("/txs/" + HASH + "/utxos"))).size();
    assertThat(callsFor64).isEqualTo(64);

    VerifyResponse tooMany = scheme.verify(payload(manyInputs(65)), requirements(), FacilitatorContext.EMPTY);
    assertThat(tooMany.invalidReason()).isEqualTo(CardanoErrors.CHAIN_LOOKUP_FAILED);
    assertThat(wm.findAll(getRequestedFor(urlEqualTo("/txs/" + HASH + "/utxos")))).hasSize(callsFor64);
  }

  private static String outputs(int count) {
    StringBuilder sb = new StringBuilder();
    for (int i = 0; i < count; i++) {
      sb.append(i == 0 ? "" : ",").append("{\"output_index\":").append(i).append(",\"address\":\"").append(PAYER)
          .append("\",\"amount\":[{\"unit\":\"lovelace\",\"quantity\":\"1000000\"}],\"consumed_by_tx\":null}");
    }
    return sb.toString();
  }

  private static String manyInputs(int count) {
    TxBuilder tx = TxBuilder.create();
    for (int i = 0; i < count; i++) {
      tx.input(HASH, i);
    }
    return tx.output(PAY_TO, 2_000_000, Map.of(), null, false)
        .output(PAYER, count * 1_000_000L - 2_000_000 - 400_000, Map.of(), null, false)
        .fee(400_000).ttl(NOW_SLOT + 300).signWith(TxBuilder.WALLET).build();
  }

  /**
   * GAP BlockfrostChainServiceTest#blockedProviderReturnsUnknownAtRequestDeadline (:162-181). The
   * app bounded a provider that ignores cancellation with an executor deadline; the SDK bounds a
   * provider call by the HTTP request timeout, and the scheme answers a lookup failure without
   * making a second call.
   */
  @Test
  void aBlockedProviderIsALookupFailureAtTheRequestDeadline() {
    wm.stubFor(get("/txs/" + HASH + "/utxos").willReturn(aResponse().withFixedDelay(5_000).withStatus(200).withBody("{}")));
    ExactCardanoFacilitatorScheme scheme = scheme(plain(Duration.ofMillis(200)));

    org.junit.jupiter.api.Assertions.assertTimeoutPreemptively(Duration.ofSeconds(3), () -> {
      VerifyResponse verdict = scheme.verify(payload(payment(NOW_SLOT + 300)), requirements(), FacilitatorContext.EMPTY);
      assertThat(verdict.invalidReason()).isEqualTo(CardanoErrors.CHAIN_LOOKUP_FAILED);
    });
    wm.verify(1, getRequestedFor(urlEqualTo("/txs/" + HASH + "/utxos")));
  }

  // ============================================================ ProviderNetworkIdentityTest

  /** GAP ProviderNetworkIdentityTest#unavailableIdentityFailsClosed (:55-63). */
  @Test
  void anUnreadableProviderIdentityFailsClosedForReadsHealthAndSubmission() {
    wm.stubFor(get("/genesis").willReturn(aResponse().withStatus(503)));
    tipAtSlot(NOW_SLOT - 10);
    utxo(HASH + "#0", PAYER, 10_000_000);
    wm.stubFor(post("/tx/submit").willReturn(okJson("\"" + HASH + "\"")));
    BlockfrostChainBackend backend = guarded();

    assertThatThrownBy(() -> backend.getUtxo(HASH + "#0", NETWORK)).isInstanceOf(ChainLookupException.class);
    assertThatThrownBy(() -> backend.checkHealth(NETWORK)).isInstanceOf(ChainLookupException.class);
    Throwable submit = null;
    try {
      backend.submitTransaction(payment(NOW_SLOT + 300), NETWORK);
    } catch (RuntimeException e) {
      submit = e;
    }
    assertThat(submit).isNotNull();
    assertThat(backend.isSubmissionNeverSent(submit)).isTrue();
    wm.verify(0, postRequestedFor(urlEqualTo("/tx/submit")));
  }

  /**
   * GP ProviderNetworkIdentityTest#matchingProviderIsHealthyAndIdentityIsCached: the identity is
   * fetched once for several reads inside the recheck window, and the health check itself re-reads.
   */
  @Test
  void theProviderIdentityIsFetchedOnceAcrossReads() {
    wm.stubFor(get("/genesis").willReturn(okJson("{\"network_magic\":1}")));
    tipAtSlot(NOW_SLOT - 10);
    utxo(HASH + "#0", PAYER, 10_000_000);
    BlockfrostChainBackend backend = guarded();

    for (int i = 0; i < 3; i++) {
      assertThat(backend.getUtxo(HASH + "#0", NETWORK).exists()).isTrue();
    }

    wm.verify(1, getRequestedFor(urlEqualTo("/genesis")));
  }
}
