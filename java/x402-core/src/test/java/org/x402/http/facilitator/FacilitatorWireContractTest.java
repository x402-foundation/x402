package org.x402.http.facilitator;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.x402.http.facilitator.FacilitatorTestSupport.PAYER;
import static org.x402.http.facilitator.FacilitatorTestSupport.PREPROD;
import static org.x402.http.facilitator.FacilitatorTestSupport.TX;
import static org.x402.http.facilitator.FacilitatorTestSupport.bytes;
import static org.x402.http.facilitator.FacilitatorTestSupport.passesTsSettleResponseSchema;
import static org.x402.http.facilitator.FacilitatorTestSupport.tree;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.x402.core.FacilitatorStatusException;
import org.x402.core.facilitator.X402Facilitator;
import org.x402.core.hooks.HookResults.Decision;
import org.x402.core.json.X402Json;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.core.types.SupportedResponse;
import org.x402.core.types.VerifyResponse;
import org.x402.core.utils.JsonValues;
import org.x402.http.HttpFacilitatorClient;
import org.x402.http.facilitator.FacilitatorTestSupport.HandlerServer;
import org.x402.http.facilitator.FacilitatorTestSupport.RecordingScheme;
import org.x402.http.facilitator.FacilitatorTestSupport.Vectors;

/**
 * The normative facilitator wire table against requests captured from the TypeScript
 * facilitator client ({@code vectors/facilitator/http-facilitator-client.json}).
 */
class FacilitatorWireContractTest {

  private final RecordingScheme scheme = new RecordingScheme();
  private final X402Facilitator facilitator = new X402Facilitator().register(PREPROD, scheme);
  private final FacilitatorHttpHandler handler =
      new FacilitatorHttpHandler(facilitator, FacilitatorHttpHandler.DEFAULT_BASE_PATH);

  private FacilitatorHttpResponse replay(String vectorCase) {
    JsonNode request = Vectors.get(vectorCase).get("request");
    JsonNode body = request.get("body");
    return handler.handle(request.get("method").asText(), request.get("path").asText(),
        body == null || body.isNull() ? null : bytes(body.asText()));
  }

  private static FacilitatorHttpResponse served(String vectorCase) {
    JsonNode served = Vectors.get(vectorCase).get("response");
    return new FacilitatorHttpResponse(served.get("status").asInt(), served.get("body").asText());
  }

  // ------------------------------------------------------------- captured requests

  @Test
  void theDefaultBasePathIsX402AndMatchesTheCapturedPaths() {
    assertThat(FacilitatorHttpHandler.DEFAULT_BASE_PATH).isEqualTo("/x402");
    assertThat(Vectors.doc().get("basePath").asText()).isEqualTo("/x402");
    assertThat(handler.basePath()).isEqualTo("/x402");
    for (JsonNode c : Vectors.all()) {
      JsonNode request = c.get("request");
      assertThat(request.get("path").asText()).isEqualTo("/x402/" + c.get("operation").asText());
      assertThat(request.get("method").asText())
          .isEqualTo(c.get("operation").asText().equals("supported") ? "GET" : "POST");
      assertThat(request.get("contentType").asText()).isEqualTo("application/json");
    }
  }

  @Test
  void aValidPaymentAnswersTheTableBody() {
    assertThat(replay("verify-valid")).isEqualTo(served("verify-valid"));
  }

  @Test
  void anInvalidPaymentIs200WithIsValidFalse() {
    scheme.verify = (p, r) -> new VerifyResponse(false, "insufficient_funds", null, PAYER, null,
        null, null);
    assertThat(replay("verify-invalid")).isEqualTo(served("verify-invalid"));
  }

  @Test
  void aBeforeVerifyAbortIs200WithIsValidFalseAndTheReason() {
    facilitator.onBeforeVerify(ctx -> Decision.abort("payee_not_allowed"));
    assertThat(replay("verify-hook-abort")).isEqualTo(served("verify-hook-abort"));
    assertThat(scheme.payloads).isEmpty();
  }

  @Test
  void aVerifyErrorIs500WithError() {
    scheme.verify = (p, r) -> {
      throw new IllegalStateException("boom");
    };
    assertThat(replay("verify-error")).isEqualTo(served("verify-error"));
  }

  @Test
  void aSettledPaymentAnswersTheTableBody() {
    assertThat(replay("settle-success")).isEqualTo(served("settle-success"));
  }

  @Test
  void aBeforeSettleAbortAnswersTheAbortBody() {
    facilitator.onBeforeSettle(ctx -> Decision.abort("payee_not_allowed"));
    FacilitatorHttpResponse response = replay("settle-abort");
    assertThat(response).isEqualTo(served("settle-abort"));
    assertThat(response.body()).isEqualTo("{\"success\":false,\"errorReason\":\"payee_not_allowed\","
        + "\"transaction\":\"\",\"network\":\"cardano:preprod\"}");
    assertThat(passesTsSettleResponseSchema(tree(response.body()))).isTrue();
    assertThat(scheme.payloads).isEmpty();
  }

  @Test
  void theAbortNetworkComesFromThePaymentRequirements() {
    facilitator.onBeforeSettle(ctx -> Decision.abort("nope"));
    ObjectNode body = (ObjectNode) Vectors.requestJson("settle-abort");
    ((ObjectNode) body.get("paymentRequirements")).put("network", "cardano:mainnet");
    ((ObjectNode) body.get("paymentPayload").get("accepted")).put("network", "cardano:preview");
    FacilitatorHttpResponse response =
        handler.handle("POST", "/x402/settle", bytes(X402Json.write(body)));
    assertThat(response.status()).isEqualTo(200);
    assertThat(tree(response.body()).get("network").asText()).isEqualTo("cardano:mainnet");
    assertThat(passesTsSettleResponseSchema(tree(response.body()))).isTrue();
  }

  @Test
  void aSettleAbortedExceptionFromTheSchemeAlsoAnswersTheAbortBody() {
    scheme.settle = (p, r) -> {
      throw new org.x402.core.SettleAbortedException("scheme_abort");
    };
    FacilitatorHttpResponse response = replay("settle-abort");
    assertThat(response.status()).isEqualTo(200);
    assertThat(response.body()).isEqualTo("{\"success\":false,\"errorReason\":\"scheme_abort\","
        + "\"transaction\":\"\",\"network\":\"cardano:preprod\"}");
  }

  @Test
  void aSettleErrorIs500WithError() {
    scheme.settle = (p, r) -> {
      throw new IllegalStateException("boom");
    };
    assertThat(replay("settle-error")).isEqualTo(served("settle-error"));
  }

  @Test
  void hookExceptionsAre500() {
    facilitator.onBeforeSettle(ctx -> {
      throw new IllegalStateException("boom");
    });
    facilitator.onBeforeVerify(ctx -> {
      throw new IllegalStateException("boom");
    });
    assertThat(replay("settle-error")).isEqualTo(served("settle-error"));
    assertThat(replay("verify-error")).isEqualTo(served("verify-error"));
  }

  @Test
  void anUnregisteredNetworkIs500() {
    ObjectNode body = (ObjectNode) Vectors.requestJson("verify-valid");
    ((ObjectNode) body.get("paymentRequirements")).put("network", "eip155:8453");
    FacilitatorHttpResponse response =
        handler.handle("POST", "/x402/verify", bytes(X402Json.write(body)));
    assertThat(response.status()).isEqualTo(500);
    assertThat(tree(response.body()).get("error").asText()).contains("No facilitator registered");
  }

  @Test
  void anExceptionWithoutMessageStillAnswersAnErrorString() {
    scheme.verify = (p, r) -> {
      throw new IllegalStateException();
    };
    FacilitatorHttpResponse response = replay("verify-error");
    assertThat(response.status()).isEqualTo(500);
    JsonNode error = tree(response.body()).get("error");
    assertThat(error.isTextual()).isTrue();
    assertThat(error.asText()).isNotEmpty();
  }

  @Test
  void supportedAnswersTheTableBody() {
    FacilitatorHttpResponse response = replay("supported");
    assertThat(response).isEqualTo(served("supported"));
    assertThat(response.body()).isEqualTo(X402Json.write(facilitator.getSupported()));
  }

  @Test
  void aSupportedErrorIs500WithError() {
    scheme.extra = n -> {
      throw new IllegalStateException("boom");
    };
    assertThat(replay("supported-error")).isEqualTo(served("supported-error"));
  }

  @Test
  void supportedListsExtensionsAndSigners() {
    facilitator.registerExtension(() -> "bazaar");
    JsonNode body = tree(handler.handle("GET", "/x402/supported", null).body());
    assertThat(body.get("extensions").toString()).isEqualTo("[\"bazaar\"]");
    assertThat(body.get("signers").toString()).isEqualTo("{\"cardano:*\":[\"addr_signer\"]}");
  }

  // ------------------------------------------------------------- 400: missing fields

  @ParameterizedTest
  @ValueSource(strings = {"x402Version", "paymentPayload", "paymentRequirements"})
  void aMissingFieldIs400(String field) {
    for (String op : List.of("verify", "settle")) {
      ObjectNode body = (ObjectNode) Vectors.requestJson("verify-valid");
      body.remove(field);
      FacilitatorHttpResponse response =
          handler.handle("POST", "/x402/" + op, bytes(X402Json.write(body)));
      assertThat(response).isEqualTo(served("verify-missing-field"));
      ObjectNode nulled = (ObjectNode) Vectors.requestJson("verify-valid");
      nulled.putNull(field);
      assertThat(handler.handle("POST", "/x402/" + op, bytes(X402Json.write(nulled))))
          .isEqualTo(served("verify-missing-field"));
    }
    assertThat(scheme.payloads).isEmpty();
  }

  @ParameterizedTest
  @ValueSource(strings = {"", "not json", "[1,2]", "\"text\"", "{\"x402Version\":2,"})
  void aMalformedBodyIs400(String body) {
    FacilitatorHttpResponse response = handler.handle("POST", "/x402/verify", bytes(body));
    assertThat(response.status()).isEqualTo(400);
    assertThat(tree(response.body()).get("error").isTextual()).isTrue();
  }

  @Test
  void aMissingBodyIs400() {
    assertThat(handler.handle("POST", "/x402/settle", null).status()).isEqualTo(400);
  }

  @Test
  void fieldsOfTheWrongTypeAre400() {
    for (String field : List.of("x402Version", "paymentPayload", "paymentRequirements")) {
      ObjectNode body = (ObjectNode) Vectors.requestJson("verify-valid");
      body.put(field, field.equals("x402Version") ? "two" : "not-an-object");
      FacilitatorHttpResponse response =
          handler.handle("POST", "/x402/verify", bytes(X402Json.write(body)));
      assertThat(response.status()).as(field).isEqualTo(400);
      assertThat(tree(response.body()).get("error").asText()).contains(field);
    }
    ObjectNode body = (ObjectNode) Vectors.requestJson("verify-valid");
    ((ObjectNode) body.get("paymentRequirements")).put("maxTimeoutSeconds", "soon");
    assertThat(handler.handle("POST", "/x402/verify", bytes(X402Json.write(body))).status())
        .isEqualTo(400);
    assertThat(scheme.payloads).isEmpty();
  }

  // ------------------------------------------------------------- unknown fields

  @Test
  void theSchemeReceivesTheCapturedPayloadIncludingUnknownFields() {
    replay("verify-valid");
    JsonNode sent = Vectors.requestJson("verify-valid");
    assertThat(scheme.payloads).hasSize(1);
    assertThat(JsonValues.deepEqual(scheme.payloads.get(0), sent.get("paymentPayload"))).isTrue();
    assertThat(JsonValues.deepEqual(scheme.requirements.get(0), sent.get("paymentRequirements")))
        .isTrue();
    PaymentPayload payload = scheme.payloads.get(0);
    assertThat(payload.payload()).containsKey("futurePayloadField");
    assertThat(payload.extensions()).containsKey("vendorExtension");
    assertThat(payload.accepted().extra()).containsKey("futureExtra");
    assertThat(scheme.requirements.get(0).extra()).containsKey("futureExtra");
  }

  @Test
  void unknownTopLevelFieldsAreAccepted() {
    ObjectNode body = (ObjectNode) Vectors.requestJson("settle-success");
    body.put("futureRequestField", 1);
    ((ObjectNode) body.get("paymentPayload")).put("futurePayloadTopLevel", "x");
    ((ObjectNode) body.get("paymentRequirements")).put("futureRequirementsTopLevel", "y");
    FacilitatorHttpResponse response =
        handler.handle("POST", "/x402/settle", bytes(X402Json.write(body)));
    assertThat(response).isEqualTo(served("settle-success"));
  }

  @Test
  void theResponseCarriesNoExtensionResponsesSideChannel() {
    Map<String, Object> side = Map.of("bazaar", Map.of("status", "ok"));
    scheme.verify = (p, r) -> new VerifyResponse(true, null, null, PAYER, Map.of("e", "v"), side,
        Map.of("x", "y"));
    scheme.settle = (p, r) -> new SettleResponse(true, null, null, PAYER, TX, PREPROD, null,
        Map.of("e", "v"), side, Map.of("x", "y"));
    JsonNode verify = tree(replay("verify-valid").body());
    JsonNode settle = tree(replay("settle-success").body());
    assertThat(verify.has("extensionResponses")).isFalse();
    assertThat(settle.has("extensionResponses")).isFalse();
    assertThat(verify.get("extensions").toString()).isEqualTo("{\"e\":\"v\"}");
    assertThat(settle.get("extra").toString()).isEqualTo("{\"x\":\"y\"}");
  }

  // ------------------------------------------------------------- settle response schema

  @Test
  void theSchemaPortAgreesWithTsOnEveryCapturedSettleAnswer() {
    int checked = 0;
    for (JsonNode c : Vectors.all()) {
      if (!c.get("operation").asText().equals("settle")
          || c.get("response").get("status").asInt() != 200) {
        continue;
      }
      boolean tsAccepted = c.get("tsOutcome").has("result");
      assertThat(passesTsSettleResponseSchema(tree(c.get("response").get("body").asText())))
          .as(c.get("name").asText()).isEqualTo(tsAccepted);
      checked++;
    }
    assertThat(checked).isEqualTo(3);
    assertThat(Vectors.get("settle-abort-ts-e2e-shape").get("tsOutcome").has("error")).isTrue();
    assertThat(passesTsSettleResponseSchema(tree("{\"success\":false,\"transaction\":\"\","
        + "\"network\":\"n\",\"payer\":1}"))).isFalse();
    assertThat(passesTsSettleResponseSchema(tree("{\"success\":false,\"transaction\":\"\","
        + "\"network\":\"n\",\"extra\":[]}"))).isFalse();
    assertThat(passesTsSettleResponseSchema(tree("[]"))).isFalse();
  }

  // ------------------------------------------------------------- paths and methods

  @ParameterizedTest
  @ValueSource(strings = {"", "/"})
  void anEmptyOrSlashBasePathServesAtTheRoot(String base) {
    FacilitatorHttpHandler root = new FacilitatorHttpHandler(facilitator, base);
    assertThat(root.basePath()).isEmpty();
    assertThat(root.handle("GET", "/supported", null)).isEqualTo(served("supported"));
    assertThat(root.handle("POST", "/verify", bytes(Vectors.requestBody("verify-valid"))))
        .isEqualTo(served("verify-valid"));
    assertThat(root.handle("GET", "/x402/supported", null).status()).isEqualTo(404);
  }

  @Test
  void aNullBasePathServesAtTheRoot() {
    assertThat(new FacilitatorHttpHandler(facilitator, null).basePath()).isEmpty();
  }

  @Test
  void basePathsAreNormalized() {
    FacilitatorHttpHandler custom = new FacilitatorHttpHandler(facilitator, "pay/facilitator//");
    assertThat(custom.basePath()).isEqualTo("/pay/facilitator");
    assertThat(custom.handle("GET", "/pay/facilitator/supported", null).status()).isEqualTo(200);
  }

  @Test
  void trailingSlashesAndQueryStringsAreTolerated() {
    assertThat(handler.handle("GET", "/x402/supported/", null).status()).isEqualTo(200);
    assertThat(handler.handle("GET", "/x402/supported?probe=1", null).status()).isEqualTo(200);
  }

  @Test
  void unknownPathsAre404() {
    for (String path : List.of("/supported", "/x402", "/x402/", "/x402/discovery/resources",
        "/x402/verify/extra", "/x402verify", "", "/other/x402/verify")) {
      FacilitatorHttpResponse response = handler.handle("POST", path, bytes("{}"));
      assertThat(response.status()).as(path).isEqualTo(404);
      assertThat(tree(response.body()).get("error").isTextual()).isTrue();
    }
    assertThat(handler.handle("GET", null, null).status()).isEqualTo(404);
  }

  @Test
  void wrongMethodsAre405() {
    assertThat(handler.handle("GET", "/x402/verify", null).status()).isEqualTo(405);
    assertThat(handler.handle("PUT", "/x402/settle", bytes("{}")).status()).isEqualTo(405);
    assertThat(handler.handle("POST", "/x402/supported", bytes("{}")).status()).isEqualTo(405);
    assertThat(handler.handle("post", "/x402/verify", bytes(Vectors.requestBody("verify-valid")))
        .status()).isEqualTo(200);
    assertThat(tree(handler.handle("DELETE", "/x402/verify", null).body()).get("error")
        .isTextual()).isTrue();
  }

  @Test
  void theResponseIsJson() {
    FacilitatorHttpResponse response = replay("verify-valid");
    assertThat(FacilitatorHttpResponse.CONTENT_TYPE).isEqualTo("application/json");
    assertThat(response.bodyBytes()).isEqualTo(bytes(response.body()));
  }

  @Test
  void theFacilitatorIsRequired() {
    assertThatThrownBy(() -> new FacilitatorHttpHandler(null, "/x402"))
        .isInstanceOf(NullPointerException.class);
  }

  // ------------------------------------------------------------- Java client round trip

  @Test
  void theJavaClientRoundTripsAgainstTheHandler() {
    PaymentPayload payload = Vectors.payload();
    PaymentRequirements requirements = Vectors.requirements();
    try (HandlerServer server = new HandlerServer(handler)) {
      HttpFacilitatorClient client = server.client("/x402");
      assertThat(client.verify(payload, requirements)).isEqualTo(VerifyResponse.valid(PAYER));
      assertThat(client.settle(payload, requirements))
          .isEqualTo(SettleResponse.success(TX, PREPROD, PAYER));
      SupportedResponse supported = client.getSupported();
      assertThat(X402Json.write(supported)).isEqualTo(X402Json.write(facilitator.getSupported()));

      scheme.verify = (p, r) -> VerifyResponse.invalid("insufficient_funds", "short by 1");
      assertThat(client.verify(payload, requirements))
          .isEqualTo(VerifyResponse.invalid("insufficient_funds", "short by 1"));

      facilitator.onBeforeSettle(ctx -> Decision.abort("payee_not_allowed"));
      assertThat(client.settle(payload, requirements))
          .isEqualTo(SettleResponse.failure("payee_not_allowed", null, "", PREPROD));

      scheme.verify = (p, r) -> {
        throw new IllegalStateException("boom");
      };
      assertThatThrownBy(() -> client.verify(payload, requirements))
          .isInstanceOf(FacilitatorStatusException.class)
          .hasMessage(Vectors.get("verify-error").get("tsOutcome").get("error").get("message")
              .asText())
          .satisfies(e -> assertThat(((FacilitatorStatusException) e).statusCode())
              .isEqualTo(500));
    }
  }

  @Test
  void theJavaClientSendsTheBytesTheTsClientSends() {
    try (HandlerServer server = new HandlerServer(handler)) {
      HttpFacilitatorClient client = server.client("/x402/");
      client.verify(Vectors.payload(), Vectors.requirements());
      client.settle(Vectors.payload(), Vectors.requirements());
      client.getSupported();
      assertThat(server.requests).hasSize(3);
      for (int i = 0; i < 3; i++) {
        JsonNode ts = Vectors.get(List.of("verify-valid", "settle-success", "supported").get(i))
            .get("request");
        assertThat(server.requests.get(i).method()).isEqualTo(ts.get("method").asText());
        assertThat(server.requests.get(i).path()).isEqualTo(ts.get("path").asText());
        String tsBody = ts.get("body").isNull() ? "" : ts.get("body").asText();
        assertThat(server.requests.get(i).body()).isEqualTo(tsBody);
      }
    }
  }
}
