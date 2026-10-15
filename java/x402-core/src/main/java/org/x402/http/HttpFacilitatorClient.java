package org.x402.http;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Function;
import org.x402.core.FacilitatorClient;
import org.x402.core.FacilitatorResponseException;
import org.x402.core.FacilitatorStatusException;
import org.x402.core.SettleException;
import org.x402.core.VerifyException;
import org.x402.core.json.X402Json;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.core.types.SupportedKind;
import org.x402.core.types.SupportedResponse;
import org.x402.core.types.VerifyResponse;
import org.x402.core.utils.JsonValues;

/**
 * A facilitator over HTTP built on {@code java.net.http}.
 *
 * <ul>
 *   <li>{@code POST {url}/verify}, {@code POST {url}/settle} with {@code {x402Version,
 *       paymentPayload, paymentRequirements}}; {@code GET {url}/supported}.
 *   <li>Timeouts: {@link #DEFAULT_TIMEOUT} (90 s) for settle and supported, and a separate
 *       {@link #DEFAULT_VERIFY_TIMEOUT} (15 s) for verify. A timeout throws {@link
 *       FacilitatorResponseException.Timeout}.
 *   <li>Error statuses: a body with {@code isValid} / {@code success} throws {@link
 *       VerifyException} / {@link SettleException}; any other error status throws {@link
 *       FacilitatorStatusException} carrying the status and a body excerpt; an unusable 2xx
 *       body or a failed connection throws {@link FacilitatorResponseException}.
 *   <li>{@code /supported} retries a 429 up to three attempts, honouring {@code Retry-After}.
 *   <li>Per-endpoint headers from a {@link FacilitatorAuthProvider}.
 *   <li>Redirects are not followed: a 3xx answer throws {@link
 *       FacilitatorResponseException}, so auth headers never reach another host. A client passed
 *       to {@link Builder#httpClient} keeps its own redirect setting.
 * </ul>
 */
public final class HttpFacilitatorClient implements FacilitatorClient {

  /** The default facilitator URL. */
  public static final String DEFAULT_URL = "https://x402.org/facilitator";

  /** The timeout for settle and supported. */
  public static final Duration DEFAULT_TIMEOUT = Duration.ofSeconds(90);

  /** The verify timeout. */
  public static final Duration DEFAULT_VERIFY_TIMEOUT = Duration.ofSeconds(15);

  private static final int SUPPORTED_ATTEMPTS = 3;
  private static final long RETRY_BASE_MILLIS = 1000;
  private static final long MAX_RETRY_MILLIS = 30_000;
  private static final List<String> EXTENSION_LOG_FIELDS =
      List.of("status", "rejectedReason", "reason", "code");
  private static final System.Logger LOG =
      System.getLogger(HttpFacilitatorClient.class.getName());

  /** Waits between {@code /supported} retries; replaceable in tests. */
  @FunctionalInterface
  public interface Sleeper {
    /**
     * Sleeps.
     *
     * @param duration how long
     * @throws InterruptedException when interrupted
     */
    void sleep(Duration duration) throws InterruptedException;
  }

  private final String url;
  private final String identifier;
  private final Duration timeout;
  private final Duration verifyTimeout;
  private final FacilitatorAuthProvider auth;
  private final HttpClient http;
  private final Clock clock;
  private final Sleeper sleeper;

  private HttpFacilitatorClient(Builder b) {
    this.url = stripTrailingSlashes(b.url);
    this.identifier = b.identifier == null ? this.url : stripTrailingSlashes(b.identifier);
    this.timeout = positive(b.timeout, "timeout");
    this.verifyTimeout = positive(b.verifyTimeout, "verifyTimeout");
    this.auth = b.auth;
    this.http = b.http != null ? b.http
        : HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build();
    this.clock = b.clock;
    this.sleeper = b.sleeper;
  }

  /**
   * Starts a builder with the default URL and timeouts.
   *
   * @return the builder
   */
  public static Builder builder() {
    return new Builder();
  }

  /** Builds an {@link HttpFacilitatorClient}. */
  public static final class Builder {
    private String url = DEFAULT_URL;
    private String identifier;
    private Duration timeout = DEFAULT_TIMEOUT;
    private Duration verifyTimeout = DEFAULT_VERIFY_TIMEOUT;
    private FacilitatorAuthProvider auth;
    private HttpClient http;
    private Clock clock = Clock.systemUTC();
    private Sleeper sleeper = d -> Thread.sleep(d.toMillis());

    private Builder() {}

    /**
     * Sets the base URL; trailing slashes are removed.
     *
     * @param value the URL
     * @return this builder
     */
    public Builder url(String value) {
      this.url = Objects.requireNonNull(value, "url");
      return this;
    }

    /**
     * Sets the identifier used in logs, health and pins (default: the URL).
     *
     * @param value the identifier; trailing slashes are removed
     * @return this builder
     */
    public Builder identifier(String value) {
      this.identifier = value;
      return this;
    }

    /**
     * Sets the settle and supported timeout (default 90 s).
     *
     * @param value the timeout
     * @return this builder
     */
    public Builder timeout(Duration value) {
      this.timeout = value;
      return this;
    }

    /**
     * Sets the verify timeout (default 15 s).
     *
     * @param value the timeout
     * @return this builder
     */
    public Builder verifyTimeout(Duration value) {
      this.verifyTimeout = value;
      return this;
    }

    /**
     * Sets the auth header provider.
     *
     * @param value the provider
     * @return this builder
     */
    public Builder authProvider(FacilitatorAuthProvider value) {
      this.auth = value;
      return this;
    }

    /**
     * Uses an existing {@code HttpClient} (proxy, TLS, executor).
     *
     * @param value the client
     * @return this builder
     */
    public Builder httpClient(HttpClient value) {
      this.http = value;
      return this;
    }

    /**
     * Sets the clock used for {@code Retry-After} dates.
     *
     * @param value the clock
     * @return this builder
     */
    public Builder clock(Clock value) {
      this.clock = Objects.requireNonNull(value, "clock");
      return this;
    }

    /**
     * Sets how retries wait.
     *
     * @param value the sleeper
     * @return this builder
     */
    public Builder sleeper(Sleeper value) {
      this.sleeper = Objects.requireNonNull(value, "sleeper");
      return this;
    }

    /**
     * Builds the client.
     *
     * @return the client
     * @throws IllegalArgumentException for a non-positive timeout
     */
    public HttpFacilitatorClient build() {
      return new HttpFacilitatorClient(this);
    }
  }

  /**
   * The base URL without trailing slashes.
   *
   * @return the URL
   */
  public String url() {
    return url;
  }

  @Override
  public String identifier() {
    return identifier;
  }

  @Override
  public Duration verifyTimeout() {
    return verifyTimeout;
  }

  @Override
  public Duration settleTimeout() {
    return timeout;
  }

  @Override
  public VerifyResponse verify(PaymentPayload payload, PaymentRequirements requirements) {
    HttpResponse<String> response = post("verify", payload, requirements, verifyTimeout,
        auth == null ? Map.of() : auth.createAuthHeaders().verify());
    rejectRedirect("verify", response);
    if (!ok(response)) {
      JsonNode data = errorBody("verify", response);
      if (data.isObject() && data.has("isValid")) {
        throw new VerifyException(response.statusCode(), lenientVerify(data));
      }
      throw new FacilitatorStatusException("Facilitator verify failed (" + response.statusCode()
          + "): " + excerpt(X402Json.write(data)), response.statusCode());
    }
    JsonNode data = successBody("verify", response);
    if (!data.isObject() || !data.path("isValid").isBoolean() || !optionalStrings(data,
        "invalidReason", "invalidMessage", "payer") || !optionalObjects(data, "extensions",
        "extra")) {
      throw invalidData("verify", response);
    }
    return new VerifyResponse(data.get("isValid").asBoolean(), text(data, "invalidReason"),
        text(data, "invalidMessage"), text(data, "payer"), object(data, "extensions"),
        extensionResponses(response), object(data, "extra"));
  }

  @Override
  public SettleResponse settle(PaymentPayload payload, PaymentRequirements requirements) {
    HttpResponse<String> response = post("settle", payload, requirements, timeout,
        auth == null ? Map.of() : auth.createAuthHeaders().settle());
    rejectRedirect("settle", response);
    if (!ok(response)) {
      JsonNode data = errorBody("settle", response);
      if (data.isObject() && data.has("success")) {
        throw new SettleException(response.statusCode(), lenientSettle(data));
      }
      throw new FacilitatorStatusException("Facilitator settle failed (" + response.statusCode()
          + "): " + excerpt(X402Json.write(data)), response.statusCode());
    }
    JsonNode data = successBody("settle", response);
    if (!data.isObject() || !data.path("success").isBoolean()
        || !data.path("transaction").isTextual() || !data.path("network").isTextual()
        || !optionalStrings(data, "errorReason", "errorMessage", "payer", "amount")
        || !optionalObjects(data, "extensions", "extra")) {
      throw invalidData("settle", response);
    }
    return new SettleResponse(data.get("success").asBoolean(), text(data, "errorReason"),
        text(data, "errorMessage"), text(data, "payer"), text(data, "transaction"),
        text(data, "network"), text(data, "amount"), object(data, "extensions"),
        extensionResponses(response), object(data, "extra"));
  }

  @Override
  public SupportedResponse getSupported() {
    Map<String, String> headers = auth == null ? Map.of() : auth.createAuthHeaders().supported();
    for (int attempt = 0; ; attempt++) {
      HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(url + "/supported"))
          .timeout(timeout).header("Content-Type", "application/json").GET();
      headers.forEach(request::header);
      HttpResponse<String> response = exchange("supported", request.build(), timeout);
      rejectRedirect("supported", response);
      if (ok(response)) {
        return parseSupported(response);
      }
      FacilitatorStatusException error = new FacilitatorStatusException(
          "Facilitator getSupported failed (" + response.statusCode() + "): "
              + excerpt(response.body()), response.statusCode());
      if (response.statusCode() != 429 || attempt >= SUPPORTED_ATTEMPTS - 1) {
        throw error;
      }
      Duration delay = computeRetryDelay(
          response.headers().firstValue("Retry-After").orElse(null), attempt, clock);
      try {
        sleeper.sleep(delay);
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        throw error;
      }
    }
  }

  private SupportedResponse parseSupported(HttpResponse<String> response) {
    JsonNode data = successBody("supported", response);
    if (!data.isObject() || !data.path("kinds").isArray()) {
      throw invalidData("supported", response);
    }
    List<SupportedKind> kinds = new ArrayList<>();
    for (JsonNode k : data.get("kinds")) {
      if (!k.isObject() || !k.path("x402Version").isNumber() || !k.path("scheme").isTextual()
          || !k.path("network").isTextual() || !optionalObjects(k, "extra")) {
        throw invalidData("supported", response);
      }
      kinds.add(new SupportedKind(k.get("x402Version").asInt(), k.get("scheme").asText(),
          k.get("network").asText(), object(k, "extra")));
    }
    List<String> extensions = new ArrayList<>();
    JsonNode ext = data.get("extensions");
    if (ext != null && !ext.isNull()) {
      if (!ext.isArray()) {
        throw invalidData("supported", response);
      }
      for (JsonNode e : ext) {
        if (!e.isTextual()) {
          throw invalidData("supported", response);
        }
        extensions.add(e.asText());
      }
    }
    Map<String, List<String>> signers = new LinkedHashMap<>();
    JsonNode sig = data.get("signers");
    if (sig != null && !sig.isNull()) {
      if (!sig.isObject()) {
        throw invalidData("supported", response);
      }
      for (Map.Entry<String, JsonNode> e : sig.properties()) {
        List<String> addresses = new ArrayList<>();
        if (!e.getValue().isArray()) {
          throw invalidData("supported", response);
        }
        for (JsonNode a : e.getValue()) {
          if (!a.isTextual()) {
            throw invalidData("supported", response);
          }
          addresses.add(a.asText());
        }
        signers.put(e.getKey(), addresses);
      }
    }
    return new SupportedResponse(kinds, extensions, signers);
  }

  /**
   * The delay before a retry: {@code Retry-After} seconds or HTTP date, else exponential
   * backoff from 1 s, capped at 30 s.
   *
   * @param retryAfter the header value, may be {@code null}
   * @param attempt the zero-based attempt that failed
   * @param clock the clock for HTTP dates
   * @return the delay
   */
  static Duration computeRetryDelay(String retryAfter, int attempt, Clock clock) {
    Long delay = null;
    if (retryAfter != null) {
      String trimmed = retryAfter.strip();
      if (trimmed.matches("\\d+")) {
        delay = Long.parseLong(trimmed) * 1000;
      } else {
        try {
          ZonedDateTime date = ZonedDateTime.parse(retryAfter.strip(),
              DateTimeFormatter.RFC_1123_DATE_TIME);
          delay = date.toInstant().toEpochMilli() - clock.millis();
        } catch (DateTimeParseException e) {
          delay = null;
        }
      }
    }
    if (delay == null || delay <= 0) {
      delay = RETRY_BASE_MILLIS * (1L << Math.min(attempt, 20));
    }
    return Duration.ofMillis(Math.min(delay, MAX_RETRY_MILLIS));
  }

  // ---------------------------------------------------------------- transport

  private HttpResponse<String> post(String operation, PaymentPayload payload,
      PaymentRequirements requirements, Duration limit, Map<String, String> headers) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("x402Version", payload.x402Version());
    body.put("paymentPayload", payload);
    body.put("paymentRequirements", requirements);
    HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(url + "/" + operation))
        .timeout(limit).header("Content-Type", "application/json")
        .POST(HttpRequest.BodyPublishers.ofString(X402Json.write(body), StandardCharsets.UTF_8));
    headers.forEach(request::header);
    return exchange(operation, request.build(), limit);
  }

  /**
   * A facilitator answering 3xx is an error: the default transport never follows it, so the
   * per-endpoint auth headers cannot reach another host.
   */
  private static void rejectRedirect(String operation, HttpResponse<String> response) {
    int status = response.statusCode();
    if (status >= 300 && status < 400) {
      throw new FacilitatorResponseException("Facilitator " + operation + " answered a redirect ("
          + status + ") to " + response.headers().firstValue("Location").orElse("<none>")
          + "; facilitator redirects are not followed, configure the final URL", status, null);
    }
  }

  private HttpResponse<String> exchange(String operation, HttpRequest request, Duration limit) {
    CompletableFuture<HttpResponse<String>> call =
        http.sendAsync(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    try {
      return call.get(limit.toNanos(), TimeUnit.NANOSECONDS);
    } catch (TimeoutException e) {
      call.cancel(true);
      throw new FacilitatorResponseException.Timeout(operation, limit.toMillis());
    } catch (ExecutionException e) {
      Throwable cause = e.getCause();
      if (cause instanceof HttpTimeoutException) {
        throw new FacilitatorResponseException.Timeout(operation, limit.toMillis());
      }
      throw new FacilitatorResponseException("Facilitator " + operation + " request failed: "
          + cause, 0, cause);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      call.cancel(true);
      throw new FacilitatorResponseException("Facilitator " + operation + " request interrupted",
          0, e);
    }
  }

  private static boolean ok(HttpResponse<String> response) {
    return response.statusCode() >= 200 && response.statusCode() < 300;
  }

  private static JsonNode errorBody(String operation, HttpResponse<String> response) {
    JsonNode node;
    try {
      node = X402Json.mapper().readTree(response.body());
    } catch (JsonProcessingException e) {
      node = null;
    }
    if (node == null || node.isMissingNode()) {
      throw new FacilitatorStatusException("Facilitator " + operation + " failed ("
          + response.statusCode() + "): " + excerpt(response.body()), response.statusCode());
    }
    return node;
  }

  private static JsonNode successBody(String operation, HttpResponse<String> response) {
    try {
      JsonNode node = X402Json.mapper().readTree(response.body());
      if (node == null || node.isMissingNode()) {
        throw new FacilitatorResponseException("Facilitator " + operation
            + " returned invalid JSON: " + excerpt(response.body()), response.statusCode(), null);
      }
      return node;
    } catch (JsonProcessingException e) {
      throw new FacilitatorResponseException("Facilitator " + operation
          + " returned invalid JSON: " + excerpt(response.body()), response.statusCode(), e);
    }
  }

  private static FacilitatorResponseException invalidData(
      String operation, HttpResponse<String> response) {
    return new FacilitatorResponseException("Facilitator " + operation + " returned invalid data: "
        + excerpt(response.body()), response.statusCode(), null);
  }

  /**
   * An excerpt of a response body: whitespace collapsed, at most 200 characters.
   *
   * @param text the body
   * @return the excerpt
   */
  static String excerpt(String text) {
    String compact = text == null ? "" : text.strip().replaceAll("\\s+", " ");
    if (compact.isEmpty()) {
      return "<empty response>";
    }
    return compact.length() <= 200 ? compact : compact.substring(0, 197) + "...";
  }

  private Map<String, Object> extensionResponses(HttpResponse<String> response) {
    String header = response.headers().firstValue("EXTENSION-RESPONSES").orElse(null);
    if (header == null) {
      return null;
    }
    try {
      JsonNode decoded = X402Json.mapper().readTree(
          new String(Base64.getDecoder().decode(header), StandardCharsets.UTF_8));
      if (decoded == null || !decoded.isObject()) {
        return null;
      }
      Map<String, Object> sanitized = new LinkedHashMap<>();
      for (Map.Entry<String, JsonNode> e : decoded.properties()) {
        Map<String, Object> fields = new LinkedHashMap<>();
        for (String key : EXTENSION_LOG_FIELDS) {
          if (e.getValue().has(key)) {
            fields.put(key, JsonValues.toPlain(e.getValue().get(key)));
          }
        }
        sanitized.put(e.getKey(), fields);
      }
      LOG.log(System.Logger.Level.INFO, "[x402] extension responses: "
          + X402Json.write(sanitized));
      return asMap(decoded);
    } catch (IllegalArgumentException | JsonProcessingException e) {
      return null;
    }
  }

  private static VerifyResponse lenientVerify(JsonNode data) {
    return new VerifyResponse(data.path("isValid").asBoolean(false), text(data, "invalidReason"),
        text(data, "invalidMessage"), text(data, "payer"), object(data, "extensions"), null,
        object(data, "extra"));
  }

  private static SettleResponse lenientSettle(JsonNode data) {
    String transaction = text(data, "transaction");
    return new SettleResponse(data.path("success").asBoolean(false), text(data, "errorReason"),
        text(data, "errorMessage"), text(data, "payer"), transaction == null ? "" : transaction,
        text(data, "network"), text(data, "amount"), object(data, "extensions"), null,
        object(data, "extra"));
  }

  private static boolean optionalStrings(JsonNode node, String... fields) {
    return check(node, JsonNode::isTextual, fields);
  }

  private static boolean optionalObjects(JsonNode node, String... fields) {
    return check(node, JsonNode::isObject, fields);
  }

  private static boolean check(JsonNode node, Function<JsonNode, Boolean> type, String[] fields) {
    for (String f : fields) {
      JsonNode v = node.get(f);
      if (v != null && !v.isNull() && !type.apply(v)) {
        return false;
      }
    }
    return true;
  }

  private static String text(JsonNode node, String field) {
    JsonNode v = node.get(field);
    return v != null && v.isTextual() ? v.asText() : null;
  }

  private static Map<String, Object> object(JsonNode node, String field) {
    JsonNode v = node.get(field);
    return v != null && v.isObject() ? asMap(v) : null;
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> asMap(JsonNode node) {
    return (Map<String, Object>) JsonValues.toPlain(node);
  }

  private static String stripTrailingSlashes(String s) {
    int end = s.length();
    while (end > 0 && s.charAt(end - 1) == '/') {
      end--;
    }
    return s.substring(0, end);
  }

  private static Duration positive(Duration d, String name) {
    if (d == null || d.isNegative() || d.isZero()) {
      throw new IllegalArgumentException(name + " must be a positive duration, got " + d);
    }
    return d;
  }
}
