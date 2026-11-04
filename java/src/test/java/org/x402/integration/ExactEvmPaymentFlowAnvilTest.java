package org.x402.integration;

import org.x402.mechanisms.evm.EvmAddress;
import org.x402.mechanisms.evm.Hex;
import org.x402.mechanisms.evm.Keccak;
import org.x402.mechanisms.evm.PrivateKeyEvmSigner;
import org.x402.mechanisms.evm.Uint256;
import org.x402.mechanisms.evm.exact.ExactEvmClientScheme;
import org.x402.mechanisms.evm.exact.ExactEvmErrors;
import org.x402.mechanisms.evm.exact.ExactEvmFacilitatorScheme;
import org.x402.mechanisms.evm.rpc.FacilitatorEvmSigner;
import org.x402.mechanisms.evm.rpc.JsonRpcFacilitatorEvmSigner;
import org.x402.types.PaymentPayload;
import org.x402.types.PaymentRequirements;
import org.x402.types.VerifyResponse;
import org.x402.util.Json;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

import java.math.BigInteger;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.x402.integration.PaidApiServer.NETWORK;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_ADDRESS_1;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_KEY_0;
import static org.x402.mechanisms.evm.CastVectors.BASE_SEPOLIA_USDC;

/**
 * Runs the paid-request flow and the onchain verify checks against an anvil fork of Base Sepolia, settling with
 * {@link JsonRpcFacilitatorEvmSigner}:
 * <pre>{@code
 * anvil --fork-url https://sepolia.base.org --port 8546 --silent &
 * X402_TEST_EVM_RPC_URL=http://127.0.0.1:8546 mvn test -Dtest=ExactEvmPaymentFlowAnvilTest
 * }</pre>
 * The facilitator is anvil account #0, which anvil funds with ETH, and the payer is account #1. A payer without
 * USDC is funded by writing FiatToken's balance mapping (storage slot 9) with {@code anvil_setStorageAt}.
 */
@EnabledIfEnvironmentVariable(named = "X402_TEST_EVM_RPC_URL", matches = ".+")
class ExactEvmPaymentFlowAnvilTest extends ExactEvmPaymentFlowContract {

    private static final BigInteger FUNDED = BigInteger.valueOf(10_000_000);
    private static final int FIAT_TOKEN_BALANCES_SLOT = 9;

    private static URI rpcUrl;
    private static JsonRpcFacilitatorEvmSigner signer;

    @BeforeAll
    static void connectAndFundThePayer() throws Exception {
        rpcUrl = URI.create(System.getenv("X402_TEST_EVM_RPC_URL"));
        signer = JsonRpcFacilitatorEvmSigner.builder(NETWORK, rpcUrl, PrivateKeyEvmSigner.fromHex(ANVIL_KEY_0))
                .receiptPollInterval(Duration.ofMillis(200))
                .connect();
        if (balanceOf(signer, ANVIL_ADDRESS_1).compareTo(PRICE.multiply(BigInteger.TEN)) < 0) {
            // balances[payer] lives at keccak256(pad32(payer) || pad32(9))
            byte[] payer = new byte[32];
            System.arraycopy(EvmAddress.toBytes(ANVIL_ADDRESS_1), 0, payer, 12, EvmAddress.LENGTH);
            byte[] slot = Keccak.keccak256(payer, Uint256.toBytes(BigInteger.valueOf(FIAT_TOKEN_BALANCES_SLOT)));
            anvilSetStorageAt(BASE_SEPOLIA_USDC, Hex.encode(slot), Hex.encode(Uint256.toBytes(FUNDED)));
            assertEquals(FUNDED, balanceOf(signer, ANVIL_ADDRESS_1), "FiatToken balance slot 9 did not fund the payer");
        }
    }

    @Override
    FacilitatorEvmSigner chain() {
        return signer;
    }

    @Test
    void reportsAnInsufficientBalanceFromTheSimulation() throws Exception {
        BigInteger tooMuch = balanceOf(signer, ANVIL_ADDRESS_1).add(BigInteger.ONE);

        VerifyResponse response = verify(requirements(tooMuch, "USDC"));

        assertFalse(response.isValid());
        assertEquals(ExactEvmErrors.INSUFFICIENT_BALANCE, response.invalidReason(), response.invalidMessage());
    }

    @Test
    void reportsAWrongEip712DomainAsAnInvalidSignature() throws Exception {
        // Signed and checked offline under "USD Coin", but the token's onchain domain name is "USDC"
        VerifyResponse response = verify(requirements(PRICE, "USD Coin"));

        assertFalse(response.isValid());
        assertEquals(ExactEvmErrors.INVALID_SIGNATURE, response.invalidReason(), response.invalidMessage());
    }

    private VerifyResponse verify(PaymentRequirements requirements) throws Exception {
        PaymentPayload payload = new PaymentPayload(2,
                new ExactEvmClientScheme(payer).createPaymentPayload(requirements), requirements, null, null);
        return new ExactEvmFacilitatorScheme(signer).verify(payload, requirements);
    }

    private static PaymentRequirements requirements(BigInteger amount, String domainName) {
        return new PaymentRequirements("exact", NETWORK, BASE_SEPOLIA_USDC, amount.toString(), randomAddress(), 300,
                Map.of("name", domainName, "version", "2"));
    }

    private static void anvilSetStorageAt(String address, String slot, String value) throws Exception {
        String body = Json.write(Map.of("jsonrpc", "2.0", "id", 1, "method", "anvil_setStorageAt",
                "params", List.of(address, slot, value)));
        HttpResponse<String> response = HttpClient.newHttpClient().send(
                HttpRequest.newBuilder(rpcUrl).header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(body)).build(),
                HttpResponse.BodyHandlers.ofString());
        assertEquals(200, response.statusCode(), response.body());
        JsonNode reply = Json.readTree(response.body());
        assertNull(reply.get("error"), () -> "anvil_setStorageAt failed: " + reply.get("error"));
    }
}
