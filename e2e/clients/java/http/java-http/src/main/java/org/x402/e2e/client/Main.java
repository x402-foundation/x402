package org.x402.e2e.client;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.PrintStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Stream;
import org.x402.core.client.SpendControls;
import org.x402.core.client.X402Client;
import org.x402.core.json.X402Json;
import org.x402.core.types.SettleResponse;
import org.x402.e2e.client.networks.E2eClientNetwork;
import org.x402.e2e.client.networks.impl.CardanoClientNetwork;
import org.x402.http.X402HttpClient;

/**
 * One-shot x402 e2e client (Java v2 SDK).
 *
 * <p>Env: {@code RESOURCE_SERVER_URL}, {@code ENDPOINT_PATH}, plus each network's own keys: a
 * network is registered only when they are set (Cardano: {@link CardanoClientNetwork}). At least
 * one network must be configured.
 *
 * <p>Prints exactly one JSON line on stdout. {@code success} is true only for a 2xx answer (and a
 * successful settlement when a {@code PAYMENT-RESPONSE} is present).
 *
 * <ul>
 *   <li>2xx or 402: {@code {success, data, status_code[, payment_response]}}, exit 0. The harness
 *       itself fails a 402 or a failed settlement.
 *   <li>Any other status (e.g. 503 while the server waits for a facilitator): the same line plus
 *       {@code error}, exit 1. With exit 0 the harness would treat it as a pass.
 *   <li>The request could not be completed: {@code {success: false, error}}, exit 1.
 * </ul>
 *
 * <p>Everything else goes to stderr.
 */
public final class Main {

  private Main() {}

  /**
   * Runs one paid GET and prints the result line.
   *
   * @param args unused
   */
  public static void main(String[] args) {
    // Keep stdout for the single result line; the harness takes the first line starting with '{'.
    PrintStream out = System.out;
    System.setOut(System.err);
    int exitCode;
    String line;
    try {
      Map<String, Object> result = run();
      int status = (Integer) result.get("status_code");
      exitCode = status / 100 == 2 || status == 402 ? 0 : 1;
      line = X402Json.write(result);
    } catch (Throwable e) {
      e.printStackTrace(System.err);
      Map<String, Object> failure = new LinkedHashMap<>();
      failure.put("success", false);
      failure.put("error", describe(e));
      line = X402Json.write(failure);
      exitCode = 1;
    }
    out.println(line);
    out.flush();
    // Exit explicitly: the JDK HttpClient's selector thread must not keep the process alive.
    System.exit(exitCode);
  }

  private static Map<String, Object> run() throws Exception {
    String baseUrl = requireEnv("RESOURCE_SERVER_URL");
    String endpointPath = requireEnv("ENDPOINT_PATH");
    List<E2eClientNetwork> networks =
        Stream.of(CardanoClientNetwork.fromEnv()).flatMap(Optional::stream).toList();
    if (networks.isEmpty()) {
      throw new IllegalStateException(
          "no network configured (Cardano: CLIENT_CARDANO_MNEMONIC and BLOCKFROST_PROJECT_ID)");
    }

    // E2e routes are priced in non-default assets and above the $1 cap, so spend controls are off.
    X402Client client = new X402Client().setSpendControls(SpendControls.disabled());
    networks.forEach(network -> network.register(client));

    X402HttpClient http = X402HttpClient.wrap(HttpClient.newHttpClient(), client);
    // No per-request timeout: X402HttpClient applies its 240 s default.
    HttpRequest request = HttpRequest.newBuilder(URI.create(baseUrl + endpointPath)).GET().build();
    HttpResponse<String> response =
        http.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));

    Optional<SettleResponse> settle = X402HttpClient.paymentResponse(response);
    Object data = parseBody(response.body());

    int status = response.statusCode();
    boolean ok = status / 100 == 2;
    Map<String, Object> result = new LinkedHashMap<>();
    result.put("success", ok && settle.map(SettleResponse::success).orElse(true));
    result.put("data", data);
    result.put("status_code", status);
    settle.ifPresent(s -> result.put("payment_response", s));
    if (!ok && status != 402) {
      result.put("error", "unexpected HTTP status " + status + " from " + endpointPath);
    }

    settle.ifPresent(s -> afterSettle(networks, s));
    return result;
  }

  /** Runs the settling network's {@link E2eClientNetwork#afterSettle}; never throws. */
  private static void afterSettle(List<E2eClientNetwork> networks, SettleResponse settle) {
    String network = settle.network();
    int colon = network == null ? -1 : network.indexOf(':');
    if (colon <= 0) {
      return;
    }
    String namespace = network.substring(0, colon);
    try {
      for (E2eClientNetwork candidate : networks) {
        if (candidate.namespace().equals(namespace)) {
          candidate.afterSettle(settle);
          return;
        }
      }
    } catch (Throwable e) {
      // The payment has settled; a failed wait must not turn the result into a failure.
      System.err.println("[java-http] after-settle on " + network + " failed: " + e);
    }
  }

  private static Object parseBody(String body) {
    if (body == null || body.isEmpty()) {
      return null;
    }
    try {
      ObjectMapper mapper = X402Json.mapper();
      return mapper.readValue(body, Object.class);
    } catch (Exception e) {
      return body;
    }
  }

  private static String describe(Throwable e) {
    StringBuilder message = new StringBuilder(e.getClass().getSimpleName());
    if (e.getMessage() != null) {
      message.append(": ").append(e.getMessage());
    }
    Throwable cause = e.getCause();
    if (cause != null && cause != e && cause.getMessage() != null) {
      message.append(" (cause: ").append(cause.getMessage()).append(')');
    }
    return message.toString();
  }

  private static String requireEnv(String name) {
    String value = System.getenv(name);
    if (value == null || value.isBlank()) {
      throw new IllegalStateException(name + " is required");
    }
    return value.trim();
  }
}
