package org.x402.mechanisms.cardano.testing;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.x402.mechanisms.cardano.utils.CardanoTransactionDecoder;
import org.x402.mechanisms.cardano.chain.CardanoChainBackend;
import com.bloxbean.cardano.client.api.model.ProtocolParams;
import org.x402.mechanisms.cardano.chain.SettlementEvidence;
import org.x402.mechanisms.cardano.chain.SubmissionResult;
import org.x402.mechanisms.cardano.chain.UtxoSnapshot;

/** A backend whose every answer a test sets directly. */
public class StubBackend implements CardanoChainBackend {

  /** UTxOs by lowercase reference; a missing reference throws. */
  public final Map<String, UtxoSnapshot> utxos = new HashMap<>();
  /** The current slot. */
  public long slot = 100_000_000L;
  /** Thrown by {@link #getCurrentSlot} when set. */
  public RuntimeException slotError;
  /** Served parameters ({@code null} = not offered). */
  public ProtocolParams parameters =
      Ccl.params(BigInteger.valueOf(4310), BigInteger.valueOf(44), BigInteger.valueOf(155381));
  /** Thrown by {@link #getProtocolParameters} when set. */
  public RuntimeException parametersError;
  /** Whether evidence can be read. */
  public boolean evidenceCapable = true;
  /** Evidence by transaction id. */
  public final Map<String, SettlementEvidence> evidence = new HashMap<>();
  /** Thrown by {@link #getTransactionEvidence} when set. */
  public RuntimeException evidenceError;
  /** Whether a complete phase-1 validator exists. */
  public boolean phase1Validator;
  /** Thrown by the phase-1 validator when set. */
  public RuntimeException phase1Error;
  /** Thrown by {@link #evaluateTransaction} when set. */
  public RuntimeException evaluateError;
  /** Submitted transactions. */
  public final List<String> submitted = new ArrayList<>();

  /**
   * Registers an unspent input owned by an address.
   *
   * @param ref the reference
   * @param address the owner
   * @param coin lovelace
   * @param assets assets, may be empty
   * @return this backend
   */
  public StubBackend unspent(String ref, String address, long coin, Map<String, BigInteger> assets) {
    utxos.put(ref.toLowerCase(java.util.Locale.ROOT), new UtxoSnapshot(true, address, BigInteger.valueOf(coin), assets, null));
    return this;
  }

  @Override
  public UtxoSnapshot getUtxo(String ref, String network) {
    UtxoSnapshot s = utxos.get(ref.toLowerCase(java.util.Locale.ROOT));
    if (s == null) {
      throw new IllegalStateException("unknown utxo " + ref);
    }
    return s;
  }

  @Override
  public long getCurrentSlot(String network) {
    if (slotError != null) {
      throw slotError;
    }
    return slot;
  }

  @Override
  public ProtocolParams getProtocolParameters(String network) {
    if (parametersError != null) {
      throw parametersError;
    }
    return parameters;
  }

  @Override
  public SubmissionResult submitTransaction(String tx, String network) {
    submitted.add(tx);
    return new SubmissionResult(CardanoTransactionDecoder.decode(tx).txHash(), SettlementEvidence.Status.MEMPOOL);
  }

  @Override
  public boolean supportsTransactionEvidence() {
    return evidenceCapable;
  }

  @Override
  public SettlementEvidence getTransactionEvidence(String txHash, String network) {
    if (evidenceError != null) {
      throw evidenceError;
    }
    return evidence.getOrDefault(txHash, SettlementEvidence.unknown());
  }

  @Override
  public boolean supportsPhase1Validation() {
    return phase1Validator;
  }

  @Override
  public void validatePhase1Transaction(String tx, String network) {
    if (phase1Error != null) {
      throw phase1Error;
    }
  }

  @Override
  public void evaluateTransaction(String tx, String network) {
    if (evaluateError != null) {
      throw evaluateError;
    }
  }
}
