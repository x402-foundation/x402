package org.x402;

import org.x402.types.PaymentRequirements;

import java.util.List;

/**
 * Narrows the payment options an {@link X402Client} considers, for example to restrict payments to one network.
 *
 * <p>Policies run in registration order, after {@link SpendControls} and before the authorization-flow
 * preference and the {@link PaymentRequirementsSelector}. A policy may drop or reorder options but cannot add or
 * change them: every returned element must be one of {@code candidates}, so policies cannot bypass spend controls.
 *
 * <p>Example, paying only on Base:
 * <pre>{@code
 * PaymentPolicy baseOnly = candidates -> candidates.stream()
 *         .filter(requirements -> requirements.network().equals("eip155:8453"))
 *         .toList();
 * }</pre>
 *
 * <p>Implementations must be thread-safe when the client is shared between threads.
 */
@FunctionalInterface
public interface PaymentPolicy {

    /**
     * Filters or reorders the payment options.
     *
     * @param candidates the remaining options; never empty and unmodifiable
     * @return the options to keep; an empty list makes selection fail with
     *     {@link PaymentException#UNSUPPORTED_SCHEME}, and returning {@code null} or an element that is not in
     *     {@code candidates} makes the client throw {@link IllegalStateException}
     */
    List<PaymentRequirements> apply(List<PaymentRequirements> candidates);
}
