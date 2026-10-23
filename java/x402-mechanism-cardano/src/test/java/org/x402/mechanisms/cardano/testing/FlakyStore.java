package org.x402.mechanisms.cardano.testing;

import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;
import org.x402.mechanisms.cardano.exact.facilitator.InMemorySettlementClaimStore;
import org.x402.mechanisms.cardano.exact.facilitator.SettlementClaim;
import org.x402.mechanisms.cardano.exact.facilitator.SettlementClaimResult;
import org.x402.mechanisms.cardano.exact.facilitator.SettlementClaimState;
import org.x402.mechanisms.cardano.exact.facilitator.SettlementClaimStore;

/**
 * A claim store that delegates to {@link InMemorySettlementClaimStore} and throws from chosen
 * operations: each counter is the number of upcoming calls that fail ({@code -1}: every call).
 */
public final class FlakyStore implements SettlementClaimStore {

  public final InMemorySettlementClaimStore delegate = new InMemorySettlementClaimStore();
  public final AtomicInteger failClaim = new AtomicInteger();
  public final AtomicInteger failMarkSubmitted = new AtomicInteger();
  public final AtomicInteger failMarkRejected = new AtomicInteger();
  public final AtomicInteger failMarkSettled = new AtomicInteger();
  public final AtomicInteger failRelease = new AtomicInteger();

  private static void maybeFail(AtomicInteger counter, String operation) {
    int left = counter.get();
    if (left == -1 || (left > 0 && counter.compareAndSet(left, left - 1))) {
      throw new IllegalStateException("store down: " + operation);
    }
  }

  @Override
  public SettlementClaimResult claimSettlement(SettlementClaim claim) {
    maybeFail(failClaim, "claimSettlement");
    return delegate.claimSettlement(claim);
  }

  @Override
  public void markSubmitted(String txHash, String ownerToken) {
    maybeFail(failMarkSubmitted, "markSubmitted");
    delegate.markSubmitted(txHash, ownerToken);
  }

  @Override
  public void markRejected(String txHash, String ownerToken) {
    maybeFail(failMarkRejected, "markRejected");
    delegate.markRejected(txHash, ownerToken);
  }

  @Override
  public boolean markSettled(String txHash, String ownerToken) {
    maybeFail(failMarkSettled, "markSettled");
    return delegate.markSettled(txHash, ownerToken);
  }

  @Override
  public Optional<SettlementClaimState> claimState(String txHash) {
    return delegate.claimState(txHash);
  }

  @Override
  public void releaseClaim(String txHash, String ownerToken) {
    maybeFail(failRelease, "releaseClaim");
    delegate.releaseClaim(txHash, ownerToken);
  }
}
