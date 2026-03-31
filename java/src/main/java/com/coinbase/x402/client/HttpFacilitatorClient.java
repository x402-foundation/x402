package com.coinbase.x402.client;

import com.coinbase.x402.model.PaymentPayload;
import com.coinbase.x402.model.PaymentRequirements;
import com.coinbase.x402.util.Json;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Synchronous facilitator client using Java 17 HttpClient. */
public class HttpFacilitatorClient implements FacilitatorClient {

    private final HttpClient http =
            HttpClient.newBuilder()
                      .connectTimeout(Duration.ofSeconds(5))
                      .build();

    private final String baseUrl;   // without trailing “/”

    /**
     * Creates a new HTTP facilitator client.
     *
     * @param baseUrl the base URL of the facilitator service (trailing slash will be removed)
     */
    public HttpFacilitatorClient(String baseUrl) {
        this.baseUrl = baseUrl.endsWith("/")
                ? baseUrl.substring(0, baseUrl.length() - 1)
                : baseUrl;
    }

    /* ------------------------------------------------ verify ------------- */

    @Override
    public VerificationResponse verify(PaymentPayload paymentPayload,
                                       PaymentRequirements req)
            throws IOException, InterruptedException {

        Map<String,Object> body = Map.of(
                "x402Version", paymentPayload.x402Version,
                "paymentPayload", paymentPayload,
                "paymentRequirements", req
        );

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl + "/verify"))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(
                        Json.MAPPER.writeValueAsString(body)))
                .build();

        HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != 200) {
            throw new IOException("HTTP " + response.statusCode() + ": " + response.body());
        }
        return Json.MAPPER.readValue(response.body(), VerificationResponse.class);
    }

    /* ------------------------------------------------ settle ------------- */

    @Override
    public SettlementResponse settle(PaymentPayload paymentPayload,
                                     PaymentRequirements req)
            throws IOException, InterruptedException {

        Map<String,Object> body = Map.of(
                "x402Version", paymentPayload.x402Version,
                "paymentPayload", paymentPayload,
                "paymentRequirements", req
        );

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl + "/settle"))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(
                        Json.MAPPER.writeValueAsString(body)))
                .build();

        HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != 200) {
            throw new IOException("HTTP " + response.statusCode() + ": " + response.body());
        }
        return Json.MAPPER.readValue(response.body(), SettlementResponse.class);
    }

    /* ------------------------------------------------ supported ---------- */

    @Override
    public Set<Kind> supported() throws IOException, InterruptedException {
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl + "/supported"))
                .GET()
                .build();


        HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != 200) {
            throw new IOException("HTTP " + response.statusCode() + ": " + response.body());
        }

        @SuppressWarnings("unchecked")
        Map<String,Object> map = Json.MAPPER.readValue(response.body(), Map.class);
        List<?> kinds = (List<?>) map.getOrDefault("kinds", List.of());


        Set<Kind> out = new HashSet<>();
        for (Object k : kinds) {
            out.add(Json.MAPPER.convertValue(k, Kind.class));
        }
        return out;
    }
}
