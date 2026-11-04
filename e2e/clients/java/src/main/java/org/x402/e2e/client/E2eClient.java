package org.x402.e2e.client;

import org.x402.Network;
import org.x402.SpendControls;
import org.x402.X402Client;
import org.x402.X402Exception;
import org.x402.http.PaymentHeaders;
import org.x402.http.X402HttpClient;
import org.x402.mechanisms.evm.EvmNetworks;
import org.x402.mechanisms.evm.PrivateKeyEvmSigner;
import org.x402.mechanisms.evm.exact.ExactEvmClientScheme;
import org.x402.types.PaymentRequired;
import org.x402.types.SettleResponse;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.io.PrintStream;
import java.io.UncheckedIOException;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpResponse.BodyHandlers;
import java.util.Map;
import java.util.Optional;

/**
 * Shared e2e client logic, mirroring {@code e2e/clients/go/client.go}: builds a payment client from the harness
 * environment, sends one paid GET and reports the outcome as a single JSON line on stdout.
 */
public final class E2eClient {

    /** Omits null properties, as the Go client's {@code omitempty} tags do, but keeps map entries verbatim. */
    private static final ObjectMapper JSON = JsonMapper.builder()
            .defaultPropertyInclusion(
                    JsonInclude.Value.construct(JsonInclude.Include.NON_NULL, JsonInclude.Include.ALWAYS))
            .build();

    private final URI url;
    private final X402HttpClient http;

    private E2eClient(URI url, X402HttpClient http) {
        this.url = url;
        this.http = http;
    }

    /**
     * Builds a client from {@code RESOURCE_SERVER_URL}, {@code ENDPOINT_PATH}, {@code CLIENT_EVM_PRIVATE_KEY} and
     * {@code EVM_NETWORK}, paying with the exact EVM scheme on every network of {@code EVM_NETWORK}'s namespace.
     *
     * @param env the environment
     * @return the client
     * @throws IllegalArgumentException if a variable is missing or malformed
     */
    public static E2eClient fromEnv(Map<String, String> env) {
        String serverUrl = require(env, "RESOURCE_SERVER_URL");
        String endpointPath = require(env, "ENDPOINT_PATH");
        PrivateKeyEvmSigner signer = PrivateKeyEvmSigner.fromHex(require(env, "CLIENT_EVM_PRIVATE_KEY"));
        String network = env.get("EVM_NETWORK");
        String pattern = network == null || network.isBlank() ? EvmNetworks.FAMILY : Network.family(network);

        X402Client client = X402Client.builder()
                .register(pattern, new ExactEvmClientScheme(signer))
                // The e2e routes pay custom assets and amounts above the default cap, as in the Go client.
                .spendControls(SpendControls.disabled())
                .build();
        return new E2eClient(URI.create(serverUrl + endpointPath), new X402HttpClient(client));
    }

    /**
     * Runs one scenario with the process environment, prints its result and exits with
     * {@link ClientResult#exitCode()}. Nothing but the result line is written to stdout.
     */
    public static void run() {
        PrintStream stdout = System.out;
        System.setOut(System.err);
        ClientResult result = runScenario(System.getenv());
        try {
            stdout.println(JSON.writeValueAsString(result));
        } catch (JsonProcessingException e) {
            throw new UncheckedIOException(e);
        }
        stdout.flush();
        System.exit(result.exitCode());
    }

    private static ClientResult runScenario(Map<String, String> env) {
        E2eClient client;
        try {
            client = fromEnv(env);
        } catch (RuntimeException e) {
            return ClientResult.failure("Invalid client configuration: " + describe(e));
        }
        try {
            return client.issueRequest();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return ClientResult.failure("Request interrupted");
        } catch (X402Exception e) {
            return ClientResult.failure("Payment failed: " + e.reason() + ": " + e.getMessage());
        } catch (IOException | RuntimeException e) {
            return ClientResult.failure("Request failed: " + describe(e));
        }
    }

    /**
     * Sends the GET, paying if the server asks for it, and interprets the final response as the Go client does.
     *
     * @return the result
     * @throws IOException if the request fails or the response body is not JSON
     * @throws InterruptedException if interrupted while waiting for a response
     * @throws X402Exception if no offered payment option can be paid, or a payment header is malformed
     */
    public ClientResult issueRequest() throws IOException, InterruptedException {
        HttpResponse<String> response = http.send(HttpRequest.newBuilder(url).GET().build(), BodyHandlers.ofString());
        int status = response.statusCode();
        JsonNode data = JSON.readTree(response.body());
        if (data == null || data.isMissingNode()) {
            return new ClientResult(false, null, status, null, "Failed to decode response: empty body");
        }
        SettleResponse settlement = X402HttpClient.settleResponse(response).orElse(null);

        if (status == HttpURLConnection.HTTP_PAYMENT_REQUIRED) {
            return new ClientResult(false, data, status, settlement,
                    "Payment failed (402): " + paymentFailure(data, response));
        }
        if (status >= 400) {
            return new ClientResult(false, data, status, settlement,
                    "Request failed (" + status + "): " + errorOf(data).orElse(data.toString()));
        }
        if (settlement != null && !settlement.success()) {
            return new ClientResult(false, data, status, settlement, "Payment failed: " + settlement.errorReason());
        }
        return new ClientResult(true, data, status, settlement, null);
    }

    private static String paymentFailure(JsonNode data, HttpResponse<?> response) {
        return errorOf(data)
                .or(() -> response.headers().firstValue(PaymentHeaders.PAYMENT_REQUIRED)
                        .map(header -> PaymentHeaders.decode(header, PaymentRequired.class).error()))
                .orElse(data.toString());
    }

    private static Optional<String> errorOf(JsonNode data) {
        JsonNode error = data.get("error");
        return error != null && error.isTextual() && !error.asText().isEmpty()
                ? Optional.of(error.asText())
                : Optional.empty();
    }

    /** Names the exception when it has no message, as {@link java.net.ConnectException} often does. */
    private static String describe(Exception e) {
        return e.getMessage() != null ? e.getMessage() : e.getClass().getName();
    }

    private static String require(Map<String, String> env, String name) {
        String value = env.get(name);
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(name + " is required");
        }
        return value;
    }
}
