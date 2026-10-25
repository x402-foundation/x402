package org.x402.http.facilitator;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.StreamReadConstraints;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import org.x402.core.SettleAbortedException;
import org.x402.core.facilitator.X402Facilitator;
import org.x402.core.json.X402Json;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.core.types.VerifyResponse;

/**
 * A framework-free facilitator HTTP endpoint around an {@link
 * X402Facilitator}. It implements the wire contract x402 resource servers expect:
 *
 * <table>
 *   <caption>Wire contract, relative to the base path</caption>
 *   <tr><th>Request</th><th>Answer</th></tr>
 *   <tr><td>{@code POST /verify} {@code {x402Version, paymentPayload, paymentRequirements}}</td>
 *       <td>200 {@code VerifyResponse}; an invalid payment is 200 with {@code isValid:false}</td></tr>
 *   <tr><td>{@code POST /settle} (same body)</td>
 *       <td>200 {@code SettleResponse}; a {@link SettleAbortedException} is 200 {@code
 *       {success:false, errorReason, transaction:"", network:<paymentRequirements.network>}}</td>
 *       </tr>
 *   <tr><td>{@code GET /supported}</td><td>200 {@link X402Facilitator#getSupported()}</td></tr>
 *   <tr><td>a missing (or {@code null}) body field</td>
 *       <td>400 {@code {error}}; so is a malformed body or a field that does not fit its type</td>
 *       </tr>
 *   <tr><td>any other exception</td><td>500 {@code {error: <message>}}</td></tr>
 *   <tr><td>another path / method</td><td>404 / 405 {@code {error}}</td></tr>
 * </table>
 *
 * <p>Unknown JSON fields inside the open maps of the typed model ({@code payload}, {@code
 * extensions}, {@code extra}) reach the scheme unchanged; unknown top-level fields are accepted
 * and ignored. The server-internal {@code extensionResponses} side channel is
 * never written, and no {@code EXTENSION-RESPONSES} header exists. One log line per verify and
 * settle (network, payTo, result) goes to {@link System.Logger}.
 *
 * <p>Status codes and bodies are fixed: other x402 resource servers depend on them. A
 * 500 body carries the exception's message, which can include a chain provider's error text;
 * expose the endpoint only to the resource servers you run, or map errors in front of it.
 * Stateless and thread-safe.
 */
public final class FacilitatorHttpHandler {

  /** The base path the Spring facilitator server uses by default. */
  public static final String DEFAULT_BASE_PATH = "/x402";

  /** The 400 message for an absent or {@code null} body field. */
  static final String MISSING_FIELDS =
      "Missing x402Version, paymentPayload or paymentRequirements";

  private static final String VERIFY = "verify";
  private static final String SETTLE = "settle";
  private static final String SUPPORTED = "supported";
  private static final int EXCERPT_LIMIT = 200;
  private static final System.Logger LOG =
      System.getLogger(FacilitatorHttpHandler.class.getName());

  private final X402Facilitator facilitator;
  private final String basePath;

  /**
   * Creates a handler.
   *
   * @param facilitator the facilitator to serve
   * @param basePath the path prefix of the three endpoints, e.g. {@link #DEFAULT_BASE_PATH};
   *     {@code null}, {@code ""} and {@code "/"} serve at the root; a missing leading slash is
   *     added and trailing slashes are removed
   */
  public FacilitatorHttpHandler(X402Facilitator facilitator, String basePath) {
    this.facilitator = Objects.requireNonNull(facilitator, "facilitator");
    this.basePath = normalizeBasePath(basePath);
  }

  private static String normalizeBasePath(String path) {
    String trimmed = stripTrailingSlashes(path == null ? "" : path.strip());
    if (trimmed.isEmpty()) {
      return "";
    }
    return trimmed.startsWith("/") ? trimmed : "/" + trimmed;
  }

  private static String stripTrailingSlashes(String s) {
    int end = s.length();
    while (end > 0 && s.charAt(end - 1) == '/') {
      end--;
    }
    return s.substring(0, end);
  }

  /**
   * The normalized base path: empty for the root, else a leading slash and no trailing slash.
   *
   * @return the base path
   */
  public String basePath() {
    return basePath;
  }

  /**
   * Handles one request.
   *
   * @param method the HTTP method (case-insensitive)
   * @param path the request path; a query string and trailing slashes are ignored
   * @param body the request body, may be {@code null}
   * @return the status and JSON body
   */
  public FacilitatorHttpResponse handle(String method, String path, byte[] body) {
    String endpoint = endpoint(path);
    if (endpoint == null) {
      return error(404, "Not found");
    }
    String expected = SUPPORTED.equals(endpoint) ? "GET" : "POST";
    if (method == null || !expected.equals(method.toUpperCase(Locale.ROOT))) {
      return error(405, "Method not allowed; use " + expected);
    }
    if (SUPPORTED.equals(endpoint)) {
      return supported();
    }
    PaidRequest request;
    try {
      request = PaidRequest.parse(body);
    } catch (BadRequestException e) {
      return error(400, e.getMessage());
    }
    return VERIFY.equals(endpoint) ? verify(request) : settle(request);
  }

  private String endpoint(String path) {
    if (path == null) {
      return null;
    }
    String p = path;
    int query = p.indexOf('?');
    if (query >= 0) {
      p = p.substring(0, query);
    }
    p = stripTrailingSlashes(p);
    String prefix = basePath + "/";
    if (!p.startsWith(prefix)) {
      return null;
    }
    String rest = p.substring(prefix.length());
    return VERIFY.equals(rest) || SETTLE.equals(rest) || SUPPORTED.equals(rest) ? rest : null;
  }

  private FacilitatorHttpResponse supported() {
    try {
      return ok(X402Json.write(facilitator.getSupported()));
    } catch (RuntimeException e) {
      return failed(SUPPORTED, e);
    }
  }

  private FacilitatorHttpResponse verify(PaidRequest request) {
    try {
      VerifyResponse result = verify(facilitator, request.payload(), request.requirements());
      LOG.log(System.Logger.Level.INFO, () -> "[x402] facilitator verify network="
          + quoted(request.requirements().network()) + " payTo="
          + quoted(request.requirements().payTo()) + " isValid=" + result.isValid()
          + (result.isValid() ? "" : " invalidReason=" + quoted(result.invalidReason())));
      return ok(X402Json.write(result));
    } catch (RuntimeException e) {
      return failed(VERIFY, e);
    }
  }

  private FacilitatorHttpResponse settle(PaidRequest request) {
    try {
      SettleResponse result = settle(facilitator, request.payload(), request.requirements());
      LOG.log(System.Logger.Level.INFO, () -> "[x402] facilitator settle network="
          + quoted(request.requirements().network()) + " payTo="
          + quoted(request.requirements().payTo()) + " success=" + result.success()
          + " transaction=" + quoted(result.transaction())
          + (result.success() ? "" : " errorReason=" + quoted(result.errorReason())));
      return ok(X402Json.write(result));
    } catch (RuntimeException e) {
      return failed(SETTLE, e);
    }
  }

  private static FacilitatorHttpResponse failed(String operation, RuntimeException e) {
    LOG.log(System.Logger.Level.WARNING, "[x402] facilitator " + operation + " failed", e);
    return error(500, errorMessage(e));
  }

  /** JSON-quotes a request value for a log line, so it cannot forge lines. */
  private static String quoted(String value) {
    return X402Json.write(value);
  }

  private static FacilitatorHttpResponse ok(String json) {
    return new FacilitatorHttpResponse(200, json);
  }

  private static FacilitatorHttpResponse error(int status, String message) {
    return new FacilitatorHttpResponse(status, errorBody(message));
  }

  // ----------------------------------------------- shared with LocalFacilitatorClient

  /**
   * Verify as it goes on the wire: the facilitator's verdict without the server-internal side
   * channel.
   */
  static VerifyResponse verify(
      X402Facilitator facilitator, PaymentPayload payload, PaymentRequirements requirements) {
    VerifyResponse r = facilitator.verify(payload, requirements);
    return r.extensionResponses() == null ? r : new VerifyResponse(r.isValid(), r.invalidReason(),
        r.invalidMessage(), r.payer(), r.extensions(), null, r.extra());
  }

  /**
   * Settle as it goes on the wire: a {@link SettleAbortedException} becomes {@code
   * {success:false, errorReason, transaction:"", network:<requirements.network>}}; the
   * server-internal side channel is dropped.
   */
  static SettleResponse settle(
      X402Facilitator facilitator, PaymentPayload payload, PaymentRequirements requirements) {
    try {
      return facilitator.settle(payload, requirements).withoutExtensionResponses();
    } catch (SettleAbortedException e) {
      return SettleResponse.failure(e.reason(), null, "",
          requirements.network() == null ? "" : requirements.network());
    }
  }

  /** The {@code error} text of a 500 body: the exception message, else its class name. */
  static String errorMessage(Throwable e) {
    String message = e.getMessage();
    return message == null || message.isEmpty() ? e.getClass().getName() : message;
  }

  /** The {@code {error}} body. */
  static String errorBody(String message) {
    return X402Json.write(Map.of("error", message));
  }

  /** An excerpt of a response body: whitespace collapsed, at most 200 characters. */
  static String excerpt(String text) {
    String compact = text == null ? "" : text.strip().replaceAll("\\s+", " ");
    if (compact.isEmpty()) {
      return "<empty response>";
    }
    return compact.length() <= EXCERPT_LIMIT ? compact
        : compact.substring(0, EXCERPT_LIMIT - 3) + "...";
  }

  // ----------------------------------------------- request parsing

  /** A 400 answer. */
  private static final class BadRequestException extends Exception {
    private static final long serialVersionUID = 1L;

    BadRequestException(String message) {
      super(message, null, false, false);
    }
  }

  /**
   * Parses request bodies: the shared x402 configuration with bounds on nesting (64), string
   * length (200 000) and number length (1000), so a hostile body costs bounded work. The shared
   * mapper, used for responses and provider answers, is unchanged.
   */
  private static final ObjectMapper REQUEST_MAPPER = requestMapper();

  private static ObjectMapper requestMapper() {
    ObjectMapper mapper = X402Json.mapper().copy();
    mapper.getFactory().setStreamReadConstraints(StreamReadConstraints.builder()
        .maxNestingDepth(64)
        .maxStringLength(200_000)
        .maxNumberLength(1000)
        .build());
    return mapper;
  }

  /** A parsed verify/settle body. */
  private record PaidRequest(PaymentPayload payload, PaymentRequirements requirements) {

    static PaidRequest parse(byte[] body) throws BadRequestException {
      if (body == null || body.length == 0) {
        throw new BadRequestException(MISSING_FIELDS);
      }
      JsonNode root;
      try {
        root = REQUEST_MAPPER.readTree(body);
      } catch (JsonProcessingException e) {
        throw new BadRequestException("Invalid JSON body");
      } catch (IOException e) {
        throw new BadRequestException("Unreadable body");
      }
      if (root == null || !root.isObject()) {
        throw new BadRequestException("Request body must be a JSON object");
      }
      JsonNode version = root.get("x402Version");
      JsonNode payload = root.get("paymentPayload");
      JsonNode requirements = root.get("paymentRequirements");
      if (absent(version) || absent(payload) || absent(requirements)) {
        throw new BadRequestException(MISSING_FIELDS);
      }
      if (!version.isIntegralNumber() || !version.canConvertToInt()) {
        throw new BadRequestException("Invalid x402Version: must be an integer");
      }
      return new PaidRequest(convert(payload, "paymentPayload", PaymentPayload.class),
          convert(requirements, "paymentRequirements", PaymentRequirements.class));
    }

    private static boolean absent(JsonNode node) {
      return node == null || node.isNull();
    }

    private static <T> T convert(JsonNode node, String field, Class<T> type)
        throws BadRequestException {
      if (!node.isObject()) {
        throw new BadRequestException("Invalid " + field + ": must be a JSON object");
      }
      try {
        return REQUEST_MAPPER.convertValue(node, type);
      } catch (IllegalArgumentException e) {
        throw new BadRequestException("Invalid " + field + ": does not match "
            + type.getSimpleName());
      }
    }
  }
}
