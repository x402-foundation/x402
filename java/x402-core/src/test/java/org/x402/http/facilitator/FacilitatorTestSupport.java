package org.x402.http.facilitator;

import com.fasterxml.jackson.databind.JsonNode;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.BiFunction;
import java.util.function.Function;
import org.x402.core.FacilitatorContext;
import org.x402.core.SchemeNetworkFacilitator;
import org.x402.core.json.X402Json;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.core.types.VerifyResponse;
import org.x402.http.HttpFacilitatorClient;

/** Shared fakes and fixtures for the facilitator HTTP handler tests. */
final class FacilitatorTestSupport {

  static final String PREPROD = "cardano:preprod";
  static final String PAYER = "addr_test1vz09v9yfxguvlp0zsnrpa3tdtm7el8xufp3m5lsm7qxzclgmzkket";
  static final String TX = "8d7a2d0bd4a8b1b7a8c76e9f5d1b0a3f4e6c2d9b8a7f6e5d4c3b2a19081726354";

  private FacilitatorTestSupport() {}

  /** A configurable facilitator scheme that records the payloads it was called with. */
  static final class RecordingScheme implements SchemeNetworkFacilitator {
    BiFunction<PaymentPayload, PaymentRequirements, VerifyResponse> verify =
        (p, r) -> VerifyResponse.valid(PAYER);
    BiFunction<PaymentPayload, PaymentRequirements, SettleResponse> settle =
        (p, r) -> SettleResponse.success(TX, r.network(), PAYER);
    Function<String, Map<String, Object>> extra = n -> Map.of("areFeesSponsored", false);
    final List<PaymentPayload> payloads = new CopyOnWriteArrayList<>();
    final List<PaymentRequirements> requirements = new CopyOnWriteArrayList<>();

    @Override
    public String scheme() {
      return "exact";
    }

    @Override
    public String caipFamily() {
      return "cardano:*";
    }

    @Override
    public Map<String, Object> getExtra(String network) {
      return extra.apply(network);
    }

    @Override
    public List<String> getSigners(String network) {
      return List.of("addr_signer");
    }

    @Override
    public VerifyResponse verify(
        PaymentPayload payload, PaymentRequirements req, FacilitatorContext context) {
      payloads.add(payload);
      requirements.add(req);
      return verify.apply(payload, req);
    }

    @Override
    public SettleResponse settle(
        PaymentPayload payload, PaymentRequirements req, FacilitatorContext context) {
      payloads.add(payload);
      requirements.add(req);
      return settle.apply(payload, req);
    }
  }

  /** One captured request as the JDK server saw it. */
  record Captured(String method, String path, String body) {}

  /** Serves a {@link FacilitatorHttpHandler} on a random local port with the JDK HTTP server. */
  static final class HandlerServer implements AutoCloseable {
    private final HttpServer server;
    final List<Captured> requests = new CopyOnWriteArrayList<>();

    HandlerServer(FacilitatorHttpHandler handler) {
      try {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
      } catch (IOException e) {
        throw new UncheckedIOException(e);
      }
      server.createContext("/", exchange -> {
        byte[] body;
        try (InputStream in = exchange.getRequestBody()) {
          body = in.readAllBytes();
        }
        String path = exchange.getRequestURI().getRawPath();
        requests.add(new Captured(exchange.getRequestMethod(), path,
            new String(body, StandardCharsets.UTF_8)));
        FacilitatorHttpResponse response =
            handler.handle(exchange.getRequestMethod(), path, body);
        byte[] out = response.body().getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", FacilitatorHttpResponse.CONTENT_TYPE);
        exchange.sendResponseHeaders(response.status(), out.length);
        try (OutputStream os = exchange.getResponseBody()) {
          os.write(out);
        }
      });
      server.start();
    }

    String baseUrl() {
      return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    HttpFacilitatorClient client(String basePath) {
      return HttpFacilitatorClient.builder().url(baseUrl() + basePath).build();
    }

    @Override
    public void close() {
      server.stop(0);
    }
  }

  /** The vectors exported by {@code java/tools/ts-vectors/export-facilitator.ts}. */
  static final class Vectors {
    private static final JsonNode DOC = load();

    private Vectors() {}

    private static JsonNode load() {
      try (InputStream in = FacilitatorTestSupport.class.getResourceAsStream(
          "/vectors/facilitator/http-facilitator-client.json")) {
        if (in == null) {
          throw new IllegalStateException("missing vectors/facilitator/http-facilitator-client.json");
        }
        return X402Json.mapper().readTree(in);
      } catch (IOException e) {
        throw new UncheckedIOException(e);
      }
    }

    static JsonNode doc() {
      return DOC;
    }

    static JsonNode get(String name) {
      for (JsonNode c : DOC.get("cases")) {
        if (c.get("name").asText().equals(name)) {
          return c;
        }
      }
      throw new IllegalArgumentException("no vector case " + name);
    }

    static List<JsonNode> all() {
      List<JsonNode> out = new ArrayList<>();
      DOC.get("cases").forEach(out::add);
      return out;
    }

    /** The request body the TypeScript client sent for verify (identical for settle). */
    static String requestBody(String name) {
      return get(name).get("request").get("body").asText();
    }

    static JsonNode requestJson(String name) {
      try {
        return X402Json.mapper().readTree(requestBody(name));
      } catch (IOException e) {
        throw new UncheckedIOException(e);
      }
    }

    static PaymentPayload payload() {
      return X402Json.convert(requestJson("verify-valid").get("paymentPayload"),
          PaymentPayload.class);
    }

    static PaymentRequirements requirements() {
      return X402Json.convert(requestJson("verify-valid").get("paymentRequirements"),
          PaymentRequirements.class);
    }
  }

  /**
   * A strict check of the settle response shape: {@code success} boolean, {@code transaction}
   * string, {@code network} string; {@code errorReason}, {@code errorMessage}, {@code payer},
   * {@code amount} string or nullish; {@code extensions}, {@code extra} a record or nullish.
   * Other fields are stripped, not rejected.
   */
  static boolean passesTsSettleResponseSchema(JsonNode node) {
    if (node == null || !node.isObject()) {
      return false;
    }
    if (!node.path("success").isBoolean() || !node.path("transaction").isTextual()
        || !node.path("network").isTextual()) {
      return false;
    }
    for (String f : List.of("errorReason", "errorMessage", "payer", "amount")) {
      JsonNode v = node.get(f);
      if (v != null && !v.isNull() && !v.isTextual()) {
        return false;
      }
    }
    for (String f : List.of("extensions", "extra")) {
      JsonNode v = node.get(f);
      if (v != null && !v.isNull() && !v.isObject()) {
        return false;
      }
    }
    return true;
  }

  static JsonNode tree(String json) {
    try {
      return X402Json.mapper().readTree(json);
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }

  static byte[] bytes(String s) {
    return s.getBytes(StandardCharsets.UTF_8);
  }
}
