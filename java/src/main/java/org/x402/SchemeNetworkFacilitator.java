package org.x402;

import org.x402.types.PaymentPayload;
import org.x402.types.PaymentRequirements;
import org.x402.types.SettleResponse;
import org.x402.types.VerifyResponse;

import java.io.IOException;
import java.util.List;
import java.util.Map;

/**
 * Facilitator side of a payment scheme: verifies payloads and settles them onchain.
 *
 * <p>Implementations are registered on an {@link X402Facilitator} and must be thread-safe.
 */
public interface SchemeNetworkFacilitator {

    /**
     * Returns the scheme this facilitator implements, e.g. {@code "exact"}.
     *
     * @return the scheme id
     */
    String scheme();

    /**
     * Returns the CAIP family this facilitator serves, e.g. {@code "eip155:*"}.
     *
     * @return the CAIP family pattern
     */
    String caipFamily();

    /**
     * Returns scheme-specific data advertised in {@code /supported} for a network.
     *
     * @param network the CAIP-2 network
     * @return the extra data, or {@code null} when there is none
     */
    Map<String, Object> extra(String network);

    /**
     * Returns the addresses this facilitator signs settlement transactions with on a network.
     *
     * @param network the CAIP-2 network
     * @return the signer addresses
     */
    List<String> signers(String network);

    /**
     * Verifies a payment without settling it.
     *
     * @param payload the payment payload
     * @param requirements the requirements the payment must satisfy
     * @return the verification result; an invalid payment is reported with {@code isValid=false}, not thrown
     * @throws IOException if the chain cannot be queried
     * @throws InterruptedException if the calling thread is interrupted
     */
    VerifyResponse verify(PaymentPayload payload, PaymentRequirements requirements)
            throws IOException, InterruptedException;

    /**
     * Verifies and settles a payment onchain.
     *
     * @param payload the payment payload
     * @param requirements the requirements the payment must satisfy
     * @return the settlement result; a failed settlement is reported with {@code success=false}, not thrown
     * @throws IOException if the chain cannot be reached
     * @throws InterruptedException if the calling thread is interrupted
     */
    SettleResponse settle(PaymentPayload payload, PaymentRequirements requirements)
            throws IOException, InterruptedException;
}
