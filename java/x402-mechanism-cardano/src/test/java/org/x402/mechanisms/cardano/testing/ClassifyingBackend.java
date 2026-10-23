package org.x402.mechanisms.cardano.testing;

import java.util.function.Predicate;
import org.x402.mechanisms.cardano.chain.CardanoChainBackend;
import com.bloxbean.cardano.client.api.model.ProtocolParams;
import org.x402.mechanisms.cardano.chain.SettlementEvidence;
import org.x402.mechanisms.cardano.chain.SubmissionResult;
import org.x402.mechanisms.cardano.chain.UtxoSnapshot;

/** A {@link FakeChain} whose submit-failure classifier the test chooses. */
public final class ClassifyingBackend implements CardanoChainBackend {

  private final FakeChain chain;
  private final Predicate<Throwable> definitive;

  /**
   * Wraps a chain.
   *
   * @param chain the chain
   * @param definitive the classifier; may throw
   */
  public ClassifyingBackend(FakeChain chain, Predicate<Throwable> definitive) {
    this.chain = chain;
    this.definitive = definitive;
  }

  @Override
  public UtxoSnapshot getUtxo(String ref, String network) {
    return chain.getUtxo(ref, network);
  }

  @Override
  public long getCurrentSlot(String network) {
    return chain.getCurrentSlot(network);
  }

  @Override
  public ProtocolParams getProtocolParameters(String network) {
    return chain.getProtocolParameters(network);
  }

  @Override
  public SubmissionResult submitTransaction(String tx, String network) {
    return chain.submitTransaction(tx, network);
  }

  @Override
  public boolean isDefinitiveSubmissionRejection(Throwable error) {
    return definitive.test(error);
  }

  @Override
  public boolean supportsTransactionEvidence() {
    return chain.supportsTransactionEvidence();
  }

  @Override
  public SettlementEvidence getTransactionEvidence(String txHash, String network) {
    return chain.getTransactionEvidence(txHash, network);
  }
}
