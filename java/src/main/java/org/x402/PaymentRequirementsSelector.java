package org.x402;

import org.x402.types.PaymentRequirements;

import java.util.List;

/**
 * Chooses which of the remaining payment options an {@link X402Client} pays.
 *
 * <p>The selector runs last, after the client has dropped options it cannot pay, options with an unknown
 * {@code paymentFlow}, options rejected by {@link SpendControls}, options removed by {@link PaymentPolicy}
 * instances, and, when any remain, every option that does not use the {@code authorization} flow.
 *
 * <p>Example, preferring the cheapest option:
 * <pre>{@code
 * PaymentRequirementsSelector cheapest = candidates -> candidates.stream()
 *         .min(Comparator.comparing(requirements -> new BigInteger(requirements.amount())))
 *         .orElseThrow();
 * }</pre>
 *
 * <p>Implementations must be thread-safe when the client is shared between threads.
 */
@FunctionalInterface
public interface PaymentRequirementsSelector {

    /**
     * Picks one option.
     *
     * @param candidates the payable options in server preference order; never empty and unmodifiable
     * @return one element of {@code candidates}; returning {@code null} or any other value makes the client throw
     *     {@link IllegalStateException}, so a selector cannot bypass spend controls
     */
    PaymentRequirements select(List<PaymentRequirements> candidates);

    /**
     * Returns the default selector, which picks the first candidate and so honours the server's preference
     * order.
     *
     * @return the first-candidate selector
     */
    static PaymentRequirementsSelector first() {
        return candidates -> candidates.get(0);
    }
}
