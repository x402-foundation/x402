package org.x402.e2e.facilitator;

import org.x402.X402Facilitator;
import org.x402.types.FacilitatorRequest;
import org.x402.types.SettleResponse;
import org.x402.types.VerifyResponse;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.lang.System.Logger.Level;
import java.net.InetSocketAddress;
import java.util.Map;
import java.util.concurrent.Executors;

/**
 * The facilitator HTTP API on the JDK's {@link HttpServer}, mirroring the routes of {@code e2e/facilitators/go}.
 *
 * <p>Status codes follow the reference facilitators: 200 for every verify or settle verdict, including
 * {@code isValid: false} and {@code success: false}; 400 {@code {"error"}} for a body that is not a facilitator
 * request; 500 {@code {"error"}} when the facilitator fails, e.g. because the chain cannot be reached.
 */
final class FacilitatorServer {

    private static final System.Logger LOG = System.getLogger(FacilitatorServer.class.getName());
    private static final ObjectMapper JSON = JsonMapper.builder()
            .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
            .defaultPropertyInclusion(
                    JsonInclude.Value.construct(JsonInclude.Include.NON_NULL, JsonInclude.Include.ALWAYS))
            .build();
    private static final long CLOSE_DELAY_MILLIS = 100;

    private final X402Facilitator facilitator;
    private final Map<String, Object> health;

    FacilitatorServer(X402Facilitator facilitator, Map<String, Object> health) {
        this.facilitator = facilitator;
        this.health = health;
    }

    /**
     * Starts serving on {@code port}.
     *
     * @param port the port
     * @throws IOException if the port cannot be bound
     */
    void start(int port) throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
        route(server, "POST", "/verify", this::verify);
        route(server, "POST", "/settle", this::settle);
        route(server, "GET", "/supported", body -> new Reply(200, facilitator.supported()));
        route(server, "GET", "/health", body -> new Reply(200, health));
        route(server, "POST", "/close", body -> close());
        // Settlements block on the receipt, so each request gets its own thread.
        server.setExecutor(Executors.newCachedThreadPool());
        server.start();
    }

    private Reply verify(byte[] body) throws BadRequest, IOException, InterruptedException {
        FacilitatorRequest request = parse(body);
        VerifyResponse response = facilitator.verify(request.paymentPayload(), request.paymentRequirements());
        if (!response.isValid()) {
            LOG.log(Level.WARNING, "Verification failed: {0}: {1}", response.invalidReason(), response.invalidMessage());
        }
        return new Reply(200, response);
    }

    private Reply settle(byte[] body) throws BadRequest, IOException, InterruptedException {
        FacilitatorRequest request = parse(body);
        SettleResponse response = facilitator.settle(request.paymentPayload(), request.paymentRequirements());
        if (response.success()) {
            LOG.log(Level.INFO, "Settlement completed: {0}", response.transaction());
        } else {
            LOG.log(Level.WARNING, "Settlement failed: {0}", response.errorReason());
        }
        return new Reply(200, response);
    }

    private static Reply close() {
        System.out.println("Received shutdown request");
        new Thread(FacilitatorServer::exitShortly, "close").start();
        return new Reply(200, Map.of("message", "Facilitator shutting down gracefully"));
    }

    private static void exitShortly() {
        try {
            Thread.sleep(CLOSE_DELAY_MILLIS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        System.exit(0);
    }

    private static FacilitatorRequest parse(byte[] body) throws BadRequest, IOException {
        FacilitatorRequest request;
        try {
            request = JSON.readValue(body, FacilitatorRequest.class);
        } catch (JsonProcessingException e) {
            throw new BadRequest("Invalid request: " + e.getOriginalMessage());
        }
        if (request == null || request.paymentPayload() == null || request.paymentRequirements() == null) {
            throw new BadRequest("Missing paymentPayload or paymentRequirements");
        }
        return request;
    }

    private static void route(HttpServer server, String method, String path, Endpoint endpoint) {
        server.createContext(path, exchange -> {
            Reply reply;
            if (!path.equals(exchange.getRequestURI().getPath())) {
                reply = new Reply(404, error("Not found"));
            } else if (!method.equals(exchange.getRequestMethod())) {
                exchange.getResponseHeaders().set("Allow", method);
                reply = new Reply(405, error("Method not allowed"));
            } else {
                reply = dispatch(endpoint, exchange.getRequestBody().readAllBytes());
            }
            send(exchange, reply);
        });
    }

    private static Reply dispatch(Endpoint endpoint, byte[] body) {
        try {
            return endpoint.handle(body);
        } catch (BadRequest e) {
            return new Reply(400, error(e.getMessage()));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return new Reply(500, error("Interrupted"));
        } catch (IOException | RuntimeException e) {
            LOG.log(Level.ERROR, "Facilitator request failed", e);
            return new Reply(500, error(e.getMessage() != null ? e.getMessage() : e.getClass().getName()));
        }
    }

    private static void send(HttpExchange exchange, Reply reply) throws IOException {
        byte[] bytes = JSON.writeValueAsBytes(reply.body());
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(reply.status(), bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }

    private static Map<String, String> error(String message) {
        return Map.of("error", message);
    }

    /** A status and the value serialized as the JSON body. */
    private record Reply(int status, Object body) {
    }

    @FunctionalInterface
    private interface Endpoint {
        Reply handle(byte[] body) throws BadRequest, IOException, InterruptedException;
    }

    /** A request body that is not a facilitator request; answered with 400. */
    private static final class BadRequest extends Exception {

        private static final long serialVersionUID = 1L;

        BadRequest(String message) {
            super(message);
        }
    }
}
