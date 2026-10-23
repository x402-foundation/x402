package org.x402.mechanisms.cardano.testing;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.x402.mechanisms.cardano.utils.CardanoTransactionDecoder;
import org.x402.mechanisms.cardano.utils.DecodedCardanoTransaction;
import org.x402.mechanisms.cardano.chain.CardanoChainBackend;
import com.bloxbean.cardano.client.api.model.ProtocolParams;
import org.x402.mechanisms.cardano.chain.SettlementEvidence;
import org.x402.mechanisms.cardano.chain.SubmissionResult;
import org.x402.mechanisms.cardano.chain.UtxoSnapshot;

/**
 * A small programmable ledger for settlement-flow tests. It models a node with a mempool: a
 * transaction resubmitted while still in the mempool is "already known" (accepted again, same
 * hash); once {@linkplain #include included} its inputs are spent and a resubmission is rejected.
 * Evidence reports {@code mempool} for a transaction the node holds, until it is included or its
 * TTL passes (a node drops it then), like Blockfrost's {@code /mempool}.
 */
public final class FakeChain implements CardanoChainBackend {

  /** What a fresh submission does. */
  public enum SubmitMode {
    /** The node accepts it into the mempool. */
    ACCEPT,
    /** Accepted, and the submitter itself saw it included. */
    ACCEPT_CONFIRMED,
    /** A transport failure: the outcome is unknown, nothing reached the mempool. */
    THROW_TRANSPORT,
    /** A transport failure after the transaction did reach the mempool. */
    THROW_AFTER_BROADCAST,
    /** The node definitively rejects it. */
    THROW_DEFINITIVE,
    /** The submitter reports a different transaction hash. */
    WRONG_HASH,
    /** The backend refuses before sending: provably nothing reached a node. */
    NEVER_SENT
  }

  /** The error of {@link SubmitMode#NEVER_SENT}. */
  public static final class NeverSentError extends IllegalStateException {
    private static final long serialVersionUID = 1L;

    NeverSentError() {
      super("provider guard failed before sending");
    }
  }

  private final Map<String, UtxoSnapshot> utxos = new LinkedHashMap<>();
  private final Map<String, SettlementEvidence> included = new HashMap<>();
  private final Set<String> mempool = new HashSet<>();
  private final java.util.Map<String, java.math.BigInteger> ttlByHash = new java.util.HashMap<>();
  private final List<String> submissions = Collections.synchronizedList(new ArrayList<>());
  private long currentSlot;
  private ProtocolParams protocolParameters;
  private boolean evidenceCapable = true;
  private SubmitMode mode = SubmitMode.ACCEPT;

  private FakeChain() {}

  /**
   * A ledger holding the UTxOs of the given fixtures (slot and parameters from the first).
   *
   * @param fixtureIds fixture ids from {@code cardano-facilitator.json}
   * @return the chain
   */
  public static FakeChain fromFixtures(String... fixtureIds) {
    FakeChain chain = new FakeChain();
    for (String id : fixtureIds) {
      JsonNode snapshot = Vectors.fixture(id).get("chain");
      SnapshotChainBackend replay = new SnapshotChainBackend(snapshot);
      snapshot.get("utxos").fieldNames().forEachRemaining(ref -> chain.utxos.put(ref, replay.getUtxo(ref, "")));
      if (chain.protocolParameters == null) {
        chain.currentSlot = replay.getCurrentSlot("");
        chain.protocolParameters = replay.getProtocolParameters("");
      }
    }
    return chain;
  }

  /**
   * Sets what the next fresh submissions do.
   *
   * @param mode the mode
   * @return this chain
   */
  public FakeChain submitMode(SubmitMode mode) {
    this.mode = mode;
    return this;
  }

  /**
   * Turns the evidence read on or off (off = a provider like Koios).
   *
   * @param capable whether evidence can be read
   * @return this chain
   */
  public FakeChain evidenceCapable(boolean capable) {
    this.evidenceCapable = capable;
    return this;
  }

  /**
   * Moves the tip.
   *
   * @param slot the current slot
   * @return this chain
   */
  public FakeChain currentSlot(long slot) {
    this.currentSlot = slot;
    return this;
  }

  /**
   * The current slot.
   *
   * @return the slot
   */
  public long currentSlot() {
    return currentSlot;
  }

  /**
   * Includes a transaction in a block: its inputs become spent, evidence reports the depth.
   *
   * @param transactionBase64 the signed transaction
   * @param confirmations newer blocks on top of it
   */
  public synchronized void include(String transactionBase64, int confirmations) {
    DecodedCardanoTransaction tx = CardanoTransactionDecoder.decode(transactionBase64);
    mempool.remove(tx.txHash());
    for (String ref : tx.inputs()) {
      UtxoSnapshot old = utxos.get(ref);
      if (old != null) {
        utxos.put(ref, new UtxoSnapshot(false, old.address(), null, null, old.paymentKeyHash()));
      }
    }
    included.put(
        tx.txHash(),
        new SettlementEvidence(SettlementEvidence.Status.CONFIRMED, confirmations));
  }

  /**
   * Rolls an included transaction back: the ledger no longer shows it (its inputs stay spent).
   *
   * @param transactionBase64 the signed transaction
   */
  public synchronized void rollback(String transactionBase64) {
    String hash = CardanoTransactionDecoder.decode(transactionBase64).txHash();
    included.remove(hash);
    mempool.remove(hash);
  }

  /**
   * Every transaction handed to {@link #submitTransaction}, in order.
   *
   * @return the submissions
   */
  public List<String> submissions() {
    return List.copyOf(submissions);
  }

  @Override
  public synchronized UtxoSnapshot getUtxo(String ref, String network) {
    UtxoSnapshot snapshot = utxos.get(ref.toLowerCase(Locale.ROOT));
    if (snapshot == null) {
      throw new IllegalStateException("unknown utxo " + ref);
    }
    return snapshot;
  }

  @Override
  public long getCurrentSlot(String network) {
    return currentSlot;
  }

  @Override
  public ProtocolParams getProtocolParameters(String network) {
    return protocolParameters;
  }

  @Override
  public synchronized SubmissionResult submitTransaction(String tx, String network) {
    submissions.add(tx);
    DecodedCardanoTransaction decodedTx = CardanoTransactionDecoder.decode(tx);
    String hash = decodedTx.txHash();
    if (decodedTx.ttlSlot() != null) {
      ttlByHash.put(hash, decodedTx.ttlSlot());
    }
    if (included.containsKey(hash)) {
      throw new IllegalStateException("BadInputsUTxO: inputs already spent");
    }
    if (mempool.contains(hash)) {
      return new SubmissionResult(hash, SettlementEvidence.Status.MEMPOOL);
    }
    switch (mode) {
      case THROW_TRANSPORT:
        throw new IllegalStateException("connection reset", new RuntimeException("socket closed"));
      case THROW_AFTER_BROADCAST:
        mempool.add(hash);
        throw new IllegalStateException("read timed out");
      case THROW_DEFINITIVE:
        throw new IllegalArgumentException("definitive: ValueNotConservedUTxO");
      case NEVER_SENT:
        throw new NeverSentError();
      case WRONG_HASH:
        mempool.add(hash);
        return new SubmissionResult("00".repeat(32), SettlementEvidence.Status.MEMPOOL);
      case ACCEPT_CONFIRMED:
        mempool.add(hash);
        return new SubmissionResult(hash, SettlementEvidence.Status.CONFIRMED);
      default:
        mempool.add(hash);
        return new SubmissionResult(hash, SettlementEvidence.Status.MEMPOOL);
    }
  }

  @Override
  public boolean isSubmissionNeverSent(Throwable error) {
    return error instanceof NeverSentError;
  }

  @Override
  public boolean isDefinitiveSubmissionRejection(Throwable error) {
    return error instanceof IllegalArgumentException
        && String.valueOf(error.getMessage()).startsWith("definitive:");
  }

  @Override
  public boolean supportsTransactionEvidence() {
    return evidenceCapable;
  }

  @Override
  public synchronized SettlementEvidence getTransactionEvidence(String txHash, String network) {
    SettlementEvidence evidence = included.get(txHash);
    if (evidence != null) {
      return evidence;
    }
    // Like Blockfrost's /mempool: a transaction the node accepted is visible until included.
    java.math.BigInteger ttl = ttlByHash.get(txHash);
    boolean held = mempool.contains(txHash)
        && (ttl == null || ttl.compareTo(java.math.BigInteger.valueOf(currentSlot)) >= 0);
    return held ? new SettlementEvidence(SettlementEvidence.Status.MEMPOOL, -1) : SettlementEvidence.unknown();
  }
}
