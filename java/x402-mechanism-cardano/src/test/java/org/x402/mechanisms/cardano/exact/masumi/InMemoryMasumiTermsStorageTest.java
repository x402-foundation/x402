package org.x402.mechanisms.cardano.exact.masumi;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.junit.jupiter.api.Test;
import org.x402.core.types.PaymentRequirements;

/** Storage, first-claim binding, atomic updates and oldest-first eviction. */
class InMemoryMasumiTermsStorageTest {

  private static PaymentRequirements requirements(String amount) {
    return new PaymentRequirements(
        "exact",
        "cardano:preprod",
        "lovelace",
        amount,
        "addr_test1wzs4e6wc95hke",
        600,
        Map.of("assetTransferMethod", "masumi"));
  }

  private static MasumiTermsRecord terms(String digest) {
    return new MasumiTermsRecord(digest, requirements("5000000"), null);
  }

  @Test
  void storesAQuoteAndReturnsItByDigest() {
    var store = new InMemoryMasumiTermsStorage();
    MasumiTermsRecord issued = terms("digest-a");

    var result = store.updateTerms("digest-a", current -> current != null ? current : issued);

    assertThat(result.status()).isEqualTo(MasumiTermsUpdateResult.Status.UPDATED);
    assertThat(store.get("digest-a")).isEqualTo(issued);
    assertThat(store.get("digest-b")).isNull();
  }

  @Test
  void keepsTheFirstQuoteForADigest() {
    var store = new InMemoryMasumiTermsStorage();
    MasumiTermsRecord first = terms("digest-a");
    MasumiTermsRecord second = new MasumiTermsRecord("digest-a", requirements("9999999"), null);

    store.updateTerms("digest-a", current -> current != null ? current : first);
    var result = store.updateTerms("digest-a", current -> current != null ? current : second);

    assertThat(result.status()).isEqualTo(MasumiTermsUpdateResult.Status.UNCHANGED);
    assertThat(store.get("digest-a").requirements().amount()).isEqualTo("5000000");
  }

  @Test
  void bindsTheFirstTransaction() {
    var store = new InMemoryMasumiTermsStorage();
    store.updateTerms("digest-a", current -> terms("digest-a"));

    var first =
        store.updateTerms(
            "digest-a", c -> c.claimedTxHash() == null ? c.withClaimedTxHash("tx-a") : c);
    var second =
        store.updateTerms(
            "digest-a", c -> c.claimedTxHash() == null ? c.withClaimedTxHash("tx-b") : c);

    assertThat(first.terms().claimedTxHash()).isEqualTo("tx-a");
    assertThat(second.status()).isEqualTo(MasumiTermsUpdateResult.Status.UNCHANGED);
    assertThat(second.terms().claimedTxHash()).isEqualTo("tx-a");
  }

  @Test
  void serializesConcurrentUpdatesForTheSameDigest() throws Exception {
    var store = new InMemoryMasumiTermsStorage();
    store.updateTerms("digest-a", c -> terms("digest-a"));
    ExecutorService pool = Executors.newFixedThreadPool(8);
    CountDownLatch start = new CountDownLatch(1);
    List<Future<String>> results = new ArrayList<>();
    for (int i = 0; i < 8; i++) {
      String tx = "tx-" + i;
      results.add(
          pool.submit(
              () -> {
                start.await();
                return store
                    .updateTerms("digest-a", c -> c.claimedTxHash() != null ? c : c.withClaimedTxHash(tx))
                    .terms()
                    .claimedTxHash();
              }));
    }
    start.countDown();
    String winner = results.get(0).get();
    for (Future<String> r : results) {
      assertThat(r.get()).isEqualTo(winner);
    }
    pool.shutdown();
  }

  @Test
  void evictsTheOldestQuoteOnceFull() {
    var store = new InMemoryMasumiTermsStorage(2);
    store.updateTerms("digest-a", c -> terms("digest-a"));
    store.updateTerms("digest-b", c -> terms("digest-b"));
    store.updateTerms("digest-c", c -> terms("digest-c"));

    assertThat(store.get("digest-a")).isNull();
    assertThat(store.get("digest-b")).isNotNull();
    assertThat(store.get("digest-c")).isNotNull();
  }

  @Test
  void rejectsANonPositiveCapacity() {
    assertThatThrownBy(() -> new InMemoryMasumiTermsStorage(0))
        .hasMessage("maxEntries must be a positive safe integer");
  }

  @Test
  void deletesARecordWhenTheCallbackReturnsNull() {
    var store = new InMemoryMasumiTermsStorage();
    store.updateTerms("digest-a", c -> terms("digest-a"));

    var result = store.updateTerms("digest-a", c -> null);
    assertThat(result.status()).isEqualTo(MasumiTermsUpdateResult.Status.DELETED);
    assertThat(store.get("digest-a")).isNull();

    assertThat(store.updateTerms("digest-x", c -> null).status())
        .isEqualTo(MasumiTermsUpdateResult.Status.UNCHANGED);
    assertThat(InMemoryMasumiTermsStorage.DEFAULT_MAX_ENTRIES).isEqualTo(10_000);
  }
}
