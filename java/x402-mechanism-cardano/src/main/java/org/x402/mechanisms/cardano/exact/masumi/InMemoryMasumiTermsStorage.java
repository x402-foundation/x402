package org.x402.mechanisms.cardano.exact.masumi;

import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.UnaryOperator;

/**
 * Process-local {@link MasumiTermsStorage}: bounded,
 * oldest quote evicted first, atomic within one JVM. Only correct for a single instance.
 */
public final class InMemoryMasumiTermsStorage implements MasumiTermsStorage {

  /** Default retained quotes. */
  public static final int DEFAULT_MAX_ENTRIES = 10_000;

  private final Map<String, MasumiTermsRecord> terms = new LinkedHashMap<>();
  private final int maxEntries;

  /** Creates a store with {@link #DEFAULT_MAX_ENTRIES}. */
  public InMemoryMasumiTermsStorage() {
    this(DEFAULT_MAX_ENTRIES);
  }

  /**
   * Creates a bounded store.
   *
   * @param maxEntries the capacity
   */
  public InMemoryMasumiTermsStorage(int maxEntries) {
    if (maxEntries <= 0) {
      throw new IllegalArgumentException("maxEntries must be a positive safe integer");
    }
    this.maxEntries = maxEntries;
  }

  @Override
  public synchronized MasumiTermsRecord get(String termsDigest) {
    return terms.get(termsDigest);
  }

  @Override
  public synchronized MasumiTermsUpdateResult updateTerms(
      String termsDigest, UnaryOperator<MasumiTermsRecord> update) {
    MasumiTermsRecord current = terms.get(termsDigest);
    MasumiTermsRecord next = update.apply(current);
    if (next == current) {
      return new MasumiTermsUpdateResult(current, MasumiTermsUpdateResult.Status.UNCHANGED);
    }
    if (next == null) {
      terms.remove(termsDigest);
      return new MasumiTermsUpdateResult(
          null, current != null ? MasumiTermsUpdateResult.Status.DELETED : MasumiTermsUpdateResult.Status.UNCHANGED);
    }
    // A replaced record keeps its insertion position, as a JS Map does.
    terms.put(termsDigest, next);
    while (terms.size() > maxEntries) {
      Iterator<String> oldest = terms.keySet().iterator();
      String key = oldest.next();
      if (key.equals(termsDigest)) {
        break;
      }
      oldest.remove();
    }
    return new MasumiTermsUpdateResult(next, MasumiTermsUpdateResult.Status.UPDATED);
  }
}
