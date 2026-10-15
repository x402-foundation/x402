package org.x402.mechanisms.cardano.exact.server;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.junit.jupiter.api.Test;
import org.x402.core.SchemeNetworkServer.PaymentRequiredContext;
import org.x402.core.hooks.HookResults.Abort;
import org.x402.core.hooks.HookResults.AfterVerifyResult;
import org.x402.core.server.ServerHooks.VerifyResultContext;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;
import org.x402.core.types.VerifyResponse;
import org.x402.mechanisms.cardano.exact.masumi.InMemoryMasumiTermsStorage;
import org.x402.mechanisms.cardano.testing.Vectors;

/**
 * Terms binding: the first transaction to
 * claim a served Masumi quote owns it; a second transaction is a duplicate, altered terms are a
 * mismatch, unknown terms are refused, an identical paid retry is allowed, and two concurrent
 * first claims have exactly one winner.
 */
class MasumiTermsBindingTest {

  private final PaymentPayload first = Vectors.payload(Vectors.fixture("12-masumi-happy").get("payload"));
  private final PaymentPayload second =
      Vectors.payload(Vectors.fixture("12b-masumi-second-transaction").get("payload"));
  private final PaymentRequirements quote =
      Vectors.requirements(Vectors.fixture("12-masumi-happy").get("requirements"));

  /** A server that served {@link #quote} in a 402, so it is stored under its digest. */
  private ExactCardanoServerScheme serverThatIssuedTheQuote() {
    var server =
        new ExactCardanoServerScheme(
            ExactCardanoServerConfig.builder().masumiStorage(new InMemoryMasumiTermsStorage()).build());
    server.enrichPaymentRequiredResponse(
        new PaymentRequiredContext(
            List.of(quote), null, ResourceInfo.of("https://api.example.com/weather"), null, null, null));
    return server;
  }

  private static AfterVerifyResult afterVerify(ExactCardanoServerScheme server, PaymentPayload payload) {
    return server
        .schemeHooks()
        .onAfterVerify()
        .apply(
            new VerifyResultContext(
                payload, payload.accepted(), Map.of(), null, VerifyResponse.valid("addr_test1payer")));
  }

  private static String abortReason(AfterVerifyResult result) {
    assertThat(result).isInstanceOf(Abort.class);
    return ((Abort) result).reason();
  }

  @Test
  void aSecondTransactionForTheSameDigestIsADuplicateSettlement() {
    var server = serverThatIssuedTheQuote();

    assertThat(afterVerify(server, first)).isNotInstanceOf(Abort.class);
    AfterVerifyResult result = afterVerify(server, second);

    assertThat(abortReason(result)).isEqualTo("duplicate_settlement");
    assertThat(((Abort) result).message())
        .isEqualTo("Masumi terms are already bound to a different Cardano transaction");
  }

  @Test
  void alteredTermsAreAMismatch() {
    var server = serverThatIssuedTheQuote();
    // confirmationPolicy is outside termsDigest: same digest, different requirements.
    Map<String, Object> extra = new LinkedHashMap<>(quote.extra());
    extra.put("confirmationPolicy", Map.of("l1Confirmations", 0));
    PaymentPayload altered =
        new PaymentPayload(2, first.resource(), quote.withExtra(extra), first.payload(), null);

    AfterVerifyResult result = afterVerify(server, altered);

    assertThat(abortReason(result)).isEqualTo("masumi_terms_mismatch");
    assertThat(((Abort) result).message())
        .isEqualTo("Masumi payment altered the issued payment requirements");
  }

  @Test
  void unknownTermsAreRefused() {
    var server =
        new ExactCardanoServerScheme(
            ExactCardanoServerConfig.builder().masumiStorage(new InMemoryMasumiTermsStorage()).build());

    AfterVerifyResult result = afterVerify(server, first);

    assertThat(abortReason(result)).isEqualTo("masumi_terms_unknown");
    assertThat(((Abort) result).message())
        .isEqualTo("Masumi payment quotes terms this server did not issue");
  }

  @Test
  void anIdenticalPaidRetryIsAllowed() {
    var server = serverThatIssuedTheQuote();

    assertThat(afterVerify(server, first)).isNotInstanceOf(Abort.class);
    assertThat(afterVerify(server, first)).isNotInstanceOf(Abort.class);
    assertThat(afterVerify(server, first)).isNotInstanceOf(Abort.class);
  }

  @Test
  void twoConcurrentFirstClaimsHaveExactlyOneWinner() throws Exception {
    for (int round = 0; round < 20; round++) {
      var server = serverThatIssuedTheQuote();
      ExecutorService pool = Executors.newFixedThreadPool(2);
      CountDownLatch start = new CountDownLatch(1);
      List<Future<AfterVerifyResult>> results = new ArrayList<>();
      for (PaymentPayload payload : List.of(first, second)) {
        results.add(
            pool.submit(
                () -> {
                  start.await();
                  return afterVerify(server, payload);
                }));
      }
      start.countDown();
      int winners = 0;
      for (Future<AfterVerifyResult> r : results) {
        if (r.get() instanceof Abort abort) {
          assertThat(abort.reason()).isEqualTo("duplicate_settlement");
        } else {
          winners++;
        }
      }
      pool.shutdown();
      assertThat(winners).isEqualTo(1);
    }
  }

  @Test
  void onlyValidMasumiPaymentsAreBound() {
    var server = serverThatIssuedTheQuote();
    var invalid =
        new VerifyResultContext(
            second, second.accepted(), Map.of(), null, VerifyResponse.invalid("x", null));
    assertThat(server.schemeHooks().onAfterVerify().apply(invalid)).isNotInstanceOf(Abort.class);

    PaymentRequirements plain = quote.withExtra(Map.of("assetTransferMethod", "default"));
    PaymentPayload plainPayload = new PaymentPayload(2, null, plain, first.payload(), null);
    assertThat(afterVerify(server, plainPayload)).isNotInstanceOf(Abort.class);

    // The binding above did not touch the quote: the first real claim still wins.
    assertThat(afterVerify(server, second)).isNotInstanceOf(Abort.class);
    assertThat(abortReason(afterVerify(server, first))).isEqualTo("duplicate_settlement");
  }

  @Test
  void anUndecodableTransactionAborts() {
    var server = serverThatIssuedTheQuote();
    PaymentPayload garbage =
        new PaymentPayload(2, null, quote, Map.of("transaction", "AAAA", "nonce", "x"), null);
    assertThat(abortReason(afterVerify(server, garbage))).isEqualTo("invalid_exact_cardano_payload");

    PaymentPayload missing = new PaymentPayload(2, null, quote, Map.of(), null);
    AfterVerifyResult result = afterVerify(server, missing);
    assertThat(abortReason(result)).isEqualTo("invalid_exact_cardano_payload");
    assertThat(((Abort) result).message()).isEqualTo("Cardano transaction is missing");
  }
}
