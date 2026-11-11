package org.x402.core;

import java.time.Duration;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BiFunction;
import java.util.function.Supplier;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.core.types.SupportedResponse;
import org.x402.core.types.VerifyResponse;

/**
 * A scripted in-memory facilitator client. Thread-safe enough for the snapshot tests. It is an
 * in-process client, so it may stand in for the generated {@code local} entry.
 */
public final class FakeFacilitatorClient implements InProcessFacilitatorClient {

  private final String identifier;
  private volatile Supplier<SupportedResponse> supported;
  private final Deque<BiFunction<PaymentPayload, PaymentRequirements, VerifyResponse>> verifyScript =
      new ArrayDeque<>();
  private final Deque<BiFunction<PaymentPayload, PaymentRequirements, SettleResponse>> settleScript =
      new ArrayDeque<>();
  private volatile BiFunction<PaymentPayload, PaymentRequirements, VerifyResponse> verifyDefault =
      (p, r) -> VerifyResponse.valid("payer");
  private volatile BiFunction<PaymentPayload, PaymentRequirements, SettleResponse> settleDefault =
      (p, r) -> Fixtures.settled(r.network());
  public final AtomicInteger supportedCalls = new AtomicInteger();
  public final AtomicInteger verifyCalls = new AtomicInteger();
  public final AtomicInteger settleCalls = new AtomicInteger();
  public final List<PaymentRequirements> settledRequirements = new CopyOnWriteArrayList<>();
  public final List<PaymentPayload> settledPayloads = new CopyOnWriteArrayList<>();
  private Duration verifyTimeout = Duration.ZERO;
  private Duration settleTimeout = Duration.ZERO;

  public FakeFacilitatorClient(String identifier, SupportedResponse supported) {
    this.identifier = identifier;
    this.supported = () -> supported;
  }

  public FakeFacilitatorClient supported(Supplier<SupportedResponse> s) {
    this.supported = s;
    return this;
  }

  public FakeFacilitatorClient failSupported(RuntimeException e) {
    this.supported = () -> {
      throw e;
    };
    return this;
  }

  public synchronized FakeFacilitatorClient thenVerify(
      BiFunction<PaymentPayload, PaymentRequirements, VerifyResponse> step) {
    verifyScript.add(step);
    return this;
  }

  public synchronized FakeFacilitatorClient thenSettle(
      BiFunction<PaymentPayload, PaymentRequirements, SettleResponse> step) {
    settleScript.add(step);
    return this;
  }

  public FakeFacilitatorClient verifyAlways(
      BiFunction<PaymentPayload, PaymentRequirements, VerifyResponse> step) {
    this.verifyDefault = step;
    return this;
  }

  public FakeFacilitatorClient settleAlways(
      BiFunction<PaymentPayload, PaymentRequirements, SettleResponse> step) {
    this.settleDefault = step;
    return this;
  }

  public FakeFacilitatorClient timeouts(Duration verify, Duration settle) {
    this.verifyTimeout = verify;
    this.settleTimeout = settle;
    return this;
  }

  @Override
  public VerifyResponse verify(PaymentPayload payload, PaymentRequirements requirements) {
    verifyCalls.incrementAndGet();
    BiFunction<PaymentPayload, PaymentRequirements, VerifyResponse> step;
    synchronized (this) {
      step = verifyScript.isEmpty() ? verifyDefault : verifyScript.poll();
    }
    return step.apply(payload, requirements);
  }

  @Override
  public SettleResponse settle(PaymentPayload payload, PaymentRequirements requirements) {
    settleCalls.incrementAndGet();
    settledRequirements.add(requirements);
    settledPayloads.add(payload);
    BiFunction<PaymentPayload, PaymentRequirements, SettleResponse> step;
    synchronized (this) {
      step = settleScript.isEmpty() ? settleDefault : settleScript.poll();
    }
    return step.apply(payload, requirements);
  }

  @Override
  public SupportedResponse getSupported() {
    supportedCalls.incrementAndGet();
    return supported.get();
  }

  @Override
  public String identifier() {
    return identifier;
  }

  @Override
  public Duration verifyTimeout() {
    return verifyTimeout;
  }

  @Override
  public Duration settleTimeout() {
    return settleTimeout;
  }

  public int calls() {
    return verifyCalls.get() + settleCalls.get();
  }
}
