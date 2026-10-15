package org.x402.core.server;

import org.x402.core.PaymentFlow;
import org.x402.core.server.ServerHooks.SettlePhase;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;

/**
 * A settle that already happened for a payment, e.g. the escrow
 * deposit before the handler.
 *
 * @param phase the phase it ran in
 * @param flow the payment flow
 * @param result the facilitator's result
 * @param requirements the settled requirements
 */
public record CompletedSettlement(
    SettlePhase phase, PaymentFlow flow, SettleResponse result, PaymentRequirements requirements) {}
