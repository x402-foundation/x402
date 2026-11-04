package org.x402.testsupport.server;

import org.x402.FacilitatorClient;
import org.x402.types.PaymentPayload;
import org.x402.types.PaymentRequirements;
import org.x402.types.SettleResponse;
import org.x402.types.SupportedKind;
import org.x402.types.SupportedResponse;
import org.x402.types.VerifyResponse;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Programmable in-memory facilitator for tests. Supports {@code exact} on the given networks, verifies every
 * payment as valid for {@link #PAYER} and settles with {@link #TRANSACTION}, unless a test swaps the behavior.
 */
public final class FakeFacilitator implements FacilitatorClient {

    /** Payer reported by default responses. */
    public static final String PAYER = "0x857b06519E91e3A54538791bDbb0E22373e36b66";

    /** Transaction hash reported by the default settle response. */
    public static final String TRANSACTION = "0x" + "ab".repeat(32);

    /** Verify behavior. */
    @FunctionalInterface
    public interface Verifier {
        VerifyResponse verify(PaymentPayload payload, PaymentRequirements requirements)
                throws IOException, InterruptedException;
    }

    /** Settle behavior. */
    @FunctionalInterface
    public interface Settler {
        SettleResponse settle(PaymentPayload payload, PaymentRequirements requirements)
                throws IOException, InterruptedException;
    }

    private final List<String> networks;
    private final AtomicInteger verifyCalls = new AtomicInteger();
    private final AtomicInteger settleCalls = new AtomicInteger();
    private volatile Verifier verifier = (payload, requirements) -> VerifyResponse.valid(PAYER);
    private volatile Settler settler =
            (payload, requirements) -> SettleResponse.success(PAYER, TRANSACTION, requirements.network());

    public FakeFacilitator(String... networks) {
        this.networks = List.of(networks);
    }

    public FakeFacilitator onVerify(Verifier verifier) {
        this.verifier = verifier;
        return this;
    }

    public FakeFacilitator onSettle(Settler settler) {
        this.settler = settler;
        return this;
    }

    public int verifyCalls() {
        return verifyCalls.get();
    }

    public int settleCalls() {
        return settleCalls.get();
    }

    @Override
    public VerifyResponse verify(PaymentPayload payload, PaymentRequirements requirements)
            throws IOException, InterruptedException {
        verifyCalls.incrementAndGet();
        return verifier.verify(payload, requirements);
    }

    @Override
    public SettleResponse settle(PaymentPayload payload, PaymentRequirements requirements)
            throws IOException, InterruptedException {
        settleCalls.incrementAndGet();
        return settler.settle(payload, requirements);
    }

    @Override
    public SupportedResponse supported() {
        List<SupportedKind> kinds = networks.stream()
                .map(network -> new SupportedKind(2, "exact", network, Map.of()))
                .toList();
        return new SupportedResponse(kinds, List.of(), Map.of());
    }
}
