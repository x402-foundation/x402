package org.x402.integration;

import org.x402.http.PaymentHeaders;
import org.x402.http.X402HttpClient;
import org.x402.integration.RecordingHttpClient.Exchange;
import org.x402.integration.SimulatedChain.Broadcast;
import org.x402.integration.SimulatedChain.TransferWithAuthorization;
import org.x402.mechanisms.evm.EvmAddress;
import org.x402.mechanisms.evm.Hex;
import org.x402.mechanisms.evm.exact.ExactEvmClientScheme;
import org.x402.mechanisms.evm.exact.ExactEvmErrors;
import org.x402.mechanisms.evm.exact.ExactEvmPayload;
import org.x402.mechanisms.evm.rpc.FacilitatorEvmSigner;
import org.x402.types.PaymentPayload;
import org.x402.types.PaymentRequired;
import org.x402.types.PaymentRequirements;
import org.x402.types.SettleResponse;

import org.junit.jupiter.api.Test;

import java.math.BigInteger;
import java.net.http.HttpResponse;
import java.time.Clock;
import java.time.Duration;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_ADDRESS_0;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_ADDRESS_1;
import static org.x402.mechanisms.evm.CastVectors.BASE_SEPOLIA_CHAIN_ID;
import static org.x402.mechanisms.evm.CastVectors.BASE_SEPOLIA_USDC;

/**
 * Runs the paid-request flow on a {@link SimulatedChain}, so it needs no node, and checks what only a simulated
 * chain shows: the exact transaction the facilitator broadcast, payments that must never reach the handler, and a
 * transaction that reverts onchain.
 */
class ExactEvmPaymentFlowTest extends ExactEvmPaymentFlowContract {

    private final SimulatedChain chain = new SimulatedChain(BASE_SEPOLIA_CHAIN_ID, ANVIL_ADDRESS_0, BASE_SEPOLIA_USDC)
            .fund(ANVIL_ADDRESS_1, BigInteger.valueOf(10_000_000));

    @Override
    FacilitatorEvmSigner chain() {
        return chain;
    }

    @Test
    void broadcastsTheAuthorizationTheClientSigned() throws Exception {
        HttpResponse<String> response = client.send(api.request(), HttpResponse.BodyHandlers.ofString());

        List<Broadcast> broadcasts = chain.broadcasts();
        assertEquals(1, broadcasts.size());
        Broadcast broadcast = broadcasts.get(0);
        assertEquals(broadcast.hash(), X402HttpClient.settleResponse(response).orElseThrow().transaction());
        assertTrue(EvmAddress.equalsIgnoreCase(BASE_SEPOLIA_USDC, broadcast.to()));

        ExactEvmPayload signed = signedPayment(http.exchanges().get(1).paymentSignature());
        TransferWithAuthorization sent = TransferWithAuthorization.decode(Hex.decode(broadcast.data()));
        assertEquals(ANVIL_ADDRESS_1, sent.from());
        assertEquals(payTo, sent.to());
        assertEquals(PRICE, sent.value());
        assertEquals(BigInteger.ZERO, sent.validAfter());
        assertEquals(new BigInteger(signed.authorization().validBefore()), sent.validBefore());
        assertEquals(signed.authorization().nonce(), sent.nonce());
        byte[] signature = Hex.decode(signed.signature());
        assertEquals(Hex.encode(Arrays.copyOfRange(signature, 0, 32)), sent.r());
        assertEquals(Hex.encode(Arrays.copyOfRange(signature, 32, 64)), sent.s());
        assertEquals(signature[64] & 0xff, sent.v());
    }

    @Test
    void neverServesAnUnderpayingAuthorization() throws Exception {
        assertNeverServed(offered -> new ExactEvmClientScheme(payer).createPaymentPayload(
                withAmountAndPayTo(offered, "999", offered.payTo())),
                ExactEvmErrors.AUTHORIZATION_VALUE_MISMATCH);
    }

    @Test
    void neverServesAnExpiredAuthorization() throws Exception {
        // validBefore = now - 10 min + maxTimeoutSeconds (5 min): already past.
        Clock tenMinutesAgo = Clock.offset(Clock.systemUTC(), Duration.ofMinutes(-10));
        assertNeverServed(offered -> new ExactEvmClientScheme(payer, tenMinutesAgo).createPaymentPayload(offered),
                ExactEvmErrors.VALID_BEFORE_EXPIRED);
    }

    @Test
    void neverServesAnAuthorizationToAnotherRecipient() throws Exception {
        assertNeverServed(offered -> new ExactEvmClientScheme(payer).createPaymentPayload(
                withAmountAndPayTo(offered, offered.amount(), randomAddress())),
                ExactEvmErrors.RECIPIENT_MISMATCH);
    }

    @Test
    void withholdsTheResourceWhenTheSettlementRevertsOnchain() throws Exception {
        chain.revertNextTransaction();

        HttpResponse<String> response = client.send(api.request(), HttpResponse.BodyHandlers.ofString());

        assertEquals(402, response.statusCode());
        assertEquals("{\"error\":\"settlement_failed\"}", response.body());
        assertEquals(List.of(402, 402), http.exchanges().stream().map(Exchange::status).toList());
        SettleResponse settlement = X402HttpClient.settleResponse(response).orElseThrow();
        assertFalse(settlement.success());
        assertEquals(ExactEvmErrors.TRANSACTION_FAILED, settlement.errorReason());
        // The handler ran, but its body was withheld
        assertEquals(1, api.handled());
        assertEquals(1, chain.broadcasts().size());
        assertEquals(BigInteger.ZERO, balanceOf(chain, payTo));
    }

    /**
     * Pays the requirements the route offers with the authorization {@code sign} builds from them, and asserts the
     * payment is refused with {@code reason} before the handler runs or anything is broadcast.
     */
    private void assertNeverServed(Function<PaymentRequirements, Map<String, Object>> sign, String reason)
            throws Exception {
        HttpResponse<String> unpaid = http.send(api.request(), HttpResponse.BodyHandlers.ofString());
        PaymentRequired paymentRequired = PaymentHeaders.decode(
                unpaid.headers().firstValue(PaymentHeaders.PAYMENT_REQUIRED).orElseThrow(), PaymentRequired.class);
        PaymentRequirements offered = paymentRequired.accepts().get(0);
        PaymentPayload payment = new PaymentPayload(2, sign.apply(offered), offered, paymentRequired.resource(), null);

        HttpResponse<String> response = http.send(
                api.request(PaymentHeaders.encode(payment)), HttpResponse.BodyHandlers.ofString());

        assertPaymentRequired(response, reason);
        assertEquals(0, api.handled());
        assertEquals(List.of(), chain.broadcasts());
    }

    private static PaymentRequirements withAmountAndPayTo(PaymentRequirements offered, String amount, String payTo) {
        return new PaymentRequirements(offered.scheme(), offered.network(), offered.asset(), amount, payTo,
                offered.maxTimeoutSeconds(), offered.extra());
    }
}
