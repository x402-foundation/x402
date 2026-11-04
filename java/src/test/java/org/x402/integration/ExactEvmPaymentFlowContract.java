package org.x402.integration;

import org.x402.X402Client;
import org.x402.http.PaymentHeaders;
import org.x402.http.X402HttpClient;
import org.x402.integration.RecordingHttpClient.Exchange;
import org.x402.mechanisms.evm.EvmAddress;
import org.x402.mechanisms.evm.Hex;
import org.x402.mechanisms.evm.PrivateKeyEvmSigner;
import org.x402.mechanisms.evm.exact.Eip3009Authorization;
import org.x402.mechanisms.evm.exact.ExactEvmClientScheme;
import org.x402.mechanisms.evm.exact.ExactEvmErrors;
import org.x402.mechanisms.evm.exact.ExactEvmPayload;
import org.x402.mechanisms.evm.rpc.Abi;
import org.x402.mechanisms.evm.rpc.FacilitatorEvmSigner;
import org.x402.types.PaymentPayload;
import org.x402.types.PaymentRequired;
import org.x402.types.SettleResponse;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.math.BigInteger;
import java.net.http.HttpResponse;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.x402.integration.PaidApiServer.NETWORK;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_ADDRESS_1;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_KEY_1;
import static org.x402.mechanisms.evm.CastVectors.BASE_SEPOLIA_USDC;

/**
 * A paid request end to end over HTTP with the SDK's real exact EVM schemes: {@link X402HttpClient} pays with
 * {@link ExactEvmClientScheme} for anvil account #1, and {@link PaidApiServer} verifies and settles on the
 * {@link #chain()} each subclass provides.
 */
abstract class ExactEvmPaymentFlowContract {

    /** {@code $0.001} in Base Sepolia USDC, which has 6 decimals. */
    static final BigInteger PRICE = BigInteger.valueOf(1_000);

    private static final SecureRandom RANDOM = new SecureRandom();

    final PrivateKeyEvmSigner payer = PrivateKeyEvmSigner.fromHex(ANVIL_KEY_1);
    final RecordingHttpClient http = new RecordingHttpClient();
    final String payTo = randomAddress();
    PaidApiServer api;
    X402HttpClient client;

    /** Returns the facilitator's account on the chain the payments settle on. */
    abstract FacilitatorEvmSigner chain();

    @BeforeEach
    void startServer() throws Exception {
        api = PaidApiServer.start(chain(), payTo);
        client = new X402HttpClient(
                X402Client.builder().register("eip155:*", new ExactEvmClientScheme(payer)).build(), http);
    }

    @AfterEach
    void stopServer() throws Exception {
        api.close();
    }

    @Test
    void paysThe402AndGetsTheResourceOnceSettled() throws Exception {
        HttpResponse<String> response = client.send(api.request(), HttpResponse.BodyHandlers.ofString());

        assertEquals(200, response.statusCode());
        assertEquals(PaidApiServer.BODY, response.body());
        assertEquals(1, api.handled());
        List<Exchange> exchanges = http.exchanges();
        assertEquals(2, exchanges.size());
        assertNull(exchanges.get(0).paymentSignature());
        assertEquals(402, exchanges.get(0).status());
        assertNotNull(exchanges.get(1).paymentSignature());
        assertEquals(200, exchanges.get(1).status());

        Eip3009Authorization signed = signedPayment(exchanges.get(1).paymentSignature()).authorization();
        assertEquals(ANVIL_ADDRESS_1, signed.from());
        assertEquals(payTo, signed.to());
        assertEquals(PRICE.toString(), signed.value());

        SettleResponse settlement = X402HttpClient.settleResponse(response).orElseThrow();
        assertTrue(settlement.success(), () -> settlement.errorReason() + ": " + settlement.errorMessage());
        assertEquals(ANVIL_ADDRESS_1, settlement.payer());
        assertEquals(NETWORK, settlement.network());
        assertEquals(32, Hex.decode(settlement.transaction()).length);
        assertTrue(chain().waitForReceipt(settlement.transaction(), Duration.ofSeconds(30)).successful());
        assertEquals(PRICE, balanceOf(chain(), payTo));
        assertTrue(isUsed(signed));
    }

    @Test
    void rejectsAReplayedPaymentSignature() throws Exception {
        assertEquals(200, client.send(api.request(), HttpResponse.BodyHandlers.ofString()).statusCode());
        String paymentSignature = http.exchanges().get(1).paymentSignature();

        HttpResponse<String> replay = http.send(api.request(paymentSignature), HttpResponse.BodyHandlers.ofString());

        assertPaymentRequired(replay, ExactEvmErrors.NONCE_ALREADY_USED);
        assertEquals(1, api.handled());
        assertEquals(PRICE, balanceOf(chain(), payTo));
    }

    /** Asserts a 402 whose {@code PAYMENT-REQUIRED} and body carry {@code error}. */
    static void assertPaymentRequired(HttpResponse<String> response, String error) {
        assertEquals(402, response.statusCode());
        assertEquals("{\"error\":\"" + error + "\"}", response.body());
        PaymentRequired paymentRequired = PaymentHeaders.decode(
                response.headers().firstValue(PaymentHeaders.PAYMENT_REQUIRED).orElseThrow(), PaymentRequired.class);
        assertEquals(error, paymentRequired.error());
    }

    static ExactEvmPayload signedPayment(String paymentSignature) {
        return ExactEvmPayload.fromMap(PaymentHeaders.decode(paymentSignature, PaymentPayload.class).payload());
    }

    static BigInteger balanceOf(FacilitatorEvmSigner chain, String account) throws Exception {
        return Abi.decodeUint256(chain.call(BASE_SEPOLIA_USDC, Abi.encodeCall("balanceOf(address)", account)));
    }

    private boolean isUsed(Eip3009Authorization authorization) throws Exception {
        return Abi.decodeBool(chain().call(BASE_SEPOLIA_USDC, Abi.encodeCall(
                "authorizationState(address,bytes32)", authorization.from(), Hex.decode(authorization.nonce()))));
    }

    static String randomAddress() {
        byte[] address = new byte[EvmAddress.LENGTH];
        RANDOM.nextBytes(address);
        return EvmAddress.toChecksum(address);
    }
}
