package org.x402.mechanisms.evm.rpc;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.IntNode;
import com.fasterxml.jackson.databind.node.TextNode;
import com.github.tomakehurst.wiremock.WireMockServer;
import com.github.tomakehurst.wiremock.client.ResponseDefinitionBuilder;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.math.BigInteger;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpTimeoutException;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.equalTo;
import static com.github.tomakehurst.wiremock.client.WireMock.equalToJson;
import static com.github.tomakehurst.wiremock.client.WireMock.matchingJsonPath;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.postRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static com.github.tomakehurst.wiremock.core.WireMockConfiguration.options;
import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class JsonRpcClientTest {

    private static final HttpClient HTTP = HttpClient.newHttpClient();

    private static WireMockServer wm;

    private JsonRpcClient client;

    @BeforeAll
    static void startServer() {
        wm = new WireMockServer(options().dynamicPort());
        wm.start();
    }

    @AfterAll
    static void stopServer() {
        wm.stop();
    }

    @BeforeEach
    void reset() {
        wm.resetAll();
        client = new JsonRpcClient(endpoint(), HTTP, Duration.ofSeconds(5));
    }

    @Test
    void sendsJsonRpcRequestAndReturnsResult() throws Exception {
        respond(ok("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x14a34\"}"));

        JsonNode result = client.call("eth_getCode", List.of("0xabc", "latest"));

        assertEquals("0x14a34", result.textValue());
        wm.verify(postRequestedFor(urlEqualTo("/rpc"))
                .withHeader("Content-Type", equalTo("application/json"))
                .withRequestBody(equalToJson("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getCode\","
                        + "\"params\":[\"0xabc\",\"latest\"]}")));
    }

    @Test
    void usesANewIdForEveryRequest() throws Exception {
        respond(ok("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x1\"}"));
        client.call("eth_chainId", List.of());
        wm.resetAll();
        respond(ok("{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":\"0x2\"}"));

        assertEquals("0x2", client.call("eth_chainId", List.of()).textValue());
        wm.verify(postRequestedFor(urlEqualTo("/rpc")).withRequestBody(matchingJsonPath("$.id", equalTo("2"))));
    }

    @Test
    void returnsNullNodeForNullResult() throws Exception {
        respond(ok("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":null}"));

        assertTrue(client.call("eth_getTransactionReceipt", List.of("0x00")).isNull());
    }

    @Test
    void reportsErrorObjectsAsJsonRpcException() {
        respond(ok("{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":3,"
                + "\"message\":\"execution reverted: FiatTokenV2: invalid signature\",\"data\":\"0x08c379a0\"}}"));

        JsonRpcException e = assertThrows(JsonRpcException.class, () -> client.call("eth_call", List.of()));

        assertEquals(3, e.code());
        assertEquals("execution reverted: FiatTokenV2: invalid signature", e.rpcMessage());
        assertEquals("0x08c379a0", e.data());
        assertEquals("eth_call: execution reverted: FiatTokenV2: invalid signature (code 3)", e.getMessage());
    }

    @Test
    void acceptsErrorsWithNullIdAndNonTextData() {
        respond(ok("{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32700,\"message\":\"parse error\","
                + "\"data\":{\"detail\":1}}}"));

        JsonRpcException e = assertThrows(JsonRpcException.class, () -> client.call("eth_call", List.of()));

        assertEquals(-32700, e.code());
        assertEquals("{\"detail\":1}", e.data());
    }

    @Test
    void reportsErrorsWithoutData() {
        respond(ok("{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32000,\"message\":\"nonce too low\","
                + "\"data\":null}}"));

        JsonRpcException e = assertThrows(JsonRpcException.class, () -> client.call("eth_send", List.of()));

        assertNull(e.data());
    }

    @Test
    void rejectsNon2xxStatusWithBodySnippet() {
        respond(aResponse().withStatus(503).withBody("upstream unavailable"));

        HttpStatusException e = assertThrows(HttpStatusException.class, () -> client.call("eth_chainId", List.of()));

        assertEquals(503, e.status());
        assertEquals("eth_chainId: HTTP status 503: upstream unavailable", e.getMessage());
    }

    @Test
    void truncatesLongBodiesInErrorsAndNeverNamesTheEndpoint() {
        respond(aResponse().withStatus(500).withBody("x".repeat(1000)));

        IOException e = assertThrows(IOException.class, () -> client.call("eth_chainId", List.of()));

        assertEquals("eth_chainId: HTTP status 500: " + "x".repeat(200) + "...", e.getMessage());
        assertFalse(e.getMessage().contains(String.valueOf(wm.port())));
    }

    @Test
    void rejectsEmptyErrorBody() {
        respond(aResponse().withStatus(429));

        IOException e = assertThrows(IOException.class, () -> client.call("eth_chainId", List.of()));

        assertEquals("eth_chainId: HTTP status 429", e.getMessage());
    }

    @Test
    void rejectsMalformedJson() {
        respond(ok("{\"jsonrpc\":"));

        IOException e = assertThrows(IOException.class, () -> client.call("eth_chainId", List.of()));

        assertTrue(e.getMessage().startsWith("eth_chainId: response is not JSON"));
    }

    @Test
    void rejectsResponsesThatAreNotJsonRpcObjects() {
        respond(ok("[{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x1\"}]"));
        assertMalformed("response is not a JSON-RPC object");

        respond(ok(""));
        assertMalformed("response is not a JSON-RPC object");

        respond(ok("{\"jsonrpc\":\"1.0\",\"id\":1,\"result\":\"0x1\"}"));
        assertMalformed("response is not JSON-RPC 2.0");

        respond(ok("{\"id\":1,\"result\":\"0x1\"}"));
        assertMalformed("response is not JSON-RPC 2.0");
    }

    @Test
    void rejectsResponsesForAnotherRequest() {
        respond(ok("{\"jsonrpc\":\"2.0\",\"id\":99,\"result\":\"0x1\"}"));
        assertMalformed("response id does not match the request");

        respond(ok("{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"result\":\"0x1\"}"));
        assertMalformed("response id does not match the request");

        respond(ok("{\"jsonrpc\":\"2.0\",\"result\":\"0x1\"}"));
        assertMalformed("response id does not match the request");

        respond(ok("{\"jsonrpc\":\"2.0\",\"id\":99,\"error\":{\"code\":1,\"message\":\"m\"}}"));
        assertMalformed("response id does not match the request");
    }

    @Test
    void rejectsResponsesWithoutResultOrValidError() {
        respond(ok("{\"jsonrpc\":\"2.0\",\"id\":1}"));
        assertMalformed("response has neither result nor error");

        respond(ok("{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":\"boom\"}"));
        assertMalformed("malformed JSON-RPC error object");

        respond(ok("{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":1.5,\"message\":\"m\"}}"));
        assertMalformed("malformed JSON-RPC error object");

        respond(ok("{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":99999999999,\"message\":\"m\"}}"));
        assertMalformed("malformed JSON-RPC error object");

        respond(ok("{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":1}}"));
        assertMalformed("malformed JSON-RPC error object");

        respond(ok("{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"message\":\"m\"}}"));
        assertMalformed("malformed JSON-RPC error object");

        respond(ok("{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":1,\"message\":7}}"));
        assertMalformed("malformed JSON-RPC error object");
    }

    @Test
    void rejectsOversizedResponses() {
        String body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x" + "0".repeat(JsonRpcClient.MAX_RESPONSE_BYTES)
                + "\"}";
        respond(ok(body));

        IOException e = assertThrows(IOException.class, () -> client.call("eth_getCode", List.of()));

        assertEquals("eth_getCode: response exceeds " + JsonRpcClient.MAX_RESPONSE_BYTES + " bytes", e.getMessage());
    }

    @Test
    void timesOutSlowNodes() {
        respond(ok("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x1\"}").withFixedDelay(2_000));
        JsonRpcClient impatient = new JsonRpcClient(endpoint(), HTTP, Duration.ofMillis(100));

        HttpTimeoutException e =
                assertThrows(HttpTimeoutException.class, () -> impatient.call("eth_chainId", List.of()));

        assertEquals("eth_chainId: no response within PT0.1S", e.getMessage());
        assertNotNull(e.getCause());
    }

    @Test
    void boundsACallByAShorterTimeout() {
        respond(ok("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x1\"}").withFixedDelay(2_000));

        HttpTimeoutException e = assertThrows(HttpTimeoutException.class,
                () -> client.call("eth_getTransactionReceipt", List.of(), Duration.ofMillis(100)));

        assertEquals("eth_getTransactionReceipt: no response within PT0.1S", e.getMessage());
    }

    @Test
    void capsACallTimeoutAtTheRequestTimeout() {
        respond(ok("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x1\"}").withFixedDelay(2_000));
        JsonRpcClient impatient = new JsonRpcClient(endpoint(), HTTP, Duration.ofMillis(100));

        HttpTimeoutException e = assertThrows(HttpTimeoutException.class,
                () -> impatient.call("eth_chainId", List.of(), Duration.ofSeconds(30)));

        assertEquals("eth_chainId: no response within PT0.1S", e.getMessage());
    }

    @Test
    void rejectsANonPositiveCallTimeout() {
        assertThrows(IllegalArgumentException.class, () -> client.call("eth_chainId", List.of(), Duration.ZERO));
    }

    @Test
    void timesOutNodesThatStallWhileSendingTheBody() {
        // Headers arrive at once; the body trickles in over two seconds
        respond(ok("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x1\"}").withChunkedDribbleDelay(10, 2_000));
        JsonRpcClient impatient = new JsonRpcClient(endpoint(), HTTP, Duration.ofMillis(300));

        long started = System.nanoTime();
        HttpTimeoutException e =
                assertThrows(HttpTimeoutException.class, () -> impatient.call("eth_chainId", List.of()));

        assertEquals("eth_chainId: no response within PT0.3S", e.getMessage());
        assertTrue(Duration.ofNanos(System.nanoTime() - started).compareTo(Duration.ofMillis(1_500)) < 0);
    }

    @Test
    void stopsWaitingWhenTheCallerIsInterrupted() throws Exception {
        respond(ok("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x1\"}").withFixedDelay(5_000));
        AtomicReference<Throwable> outcome = new AtomicReference<>();
        Thread caller = new Thread(() -> {
            try {
                client.call("eth_chainId", List.of());
            } catch (Throwable t) {
                outcome.set(t);
            }
        });

        caller.start();
        Thread.sleep(200);
        caller.interrupt();
        caller.join(2_000);

        assertFalse(caller.isAlive());
        assertInstanceOf(InterruptedException.class, outcome.get());
    }

    @Test
    void reportsUnreachableNodesWithoutTheirAddress() throws Exception {
        int port;
        try (ServerSocket socket = new ServerSocket(0)) {
            port = socket.getLocalPort();
        }
        JsonRpcClient unreachable =
                new JsonRpcClient(URI.create("http://127.0.0.1:" + port + "/"), HTTP, Duration.ofSeconds(2));

        IOException e = assertThrows(IOException.class, () -> unreachable.call("eth_chainId", List.of()));

        assertTrue(e.getMessage().startsWith("eth_chainId: request failed"));
    }

    @Test
    void decodesQuantities() throws Exception {
        assertEquals(BigInteger.valueOf(84532), JsonRpcClient.decodeQuantity(new TextNode("0x14a34"), "q"));
        assertEquals(BigInteger.ZERO, JsonRpcClient.decodeQuantity(new TextNode("0x0"), "q"));
        assertEquals(BigInteger.ONE, JsonRpcClient.decodeQuantity(new TextNode("0x01"), "q"));
    }

    @Test
    void rejectsMalformedQuantities() {
        for (JsonNode bad : List.of(new TextNode("0x"), new TextNode("14a34"), new TextNode("0xzz"),
                new TextNode("0x" + "f".repeat(65)), new IntNode(5))) {
            IOException e = assertThrows(IOException.class, () -> JsonRpcClient.decodeQuantity(bad, "eth_chainId"));
            assertEquals("eth_chainId is not a hex quantity", e.getMessage());
        }
        assertThrows(IOException.class, () -> JsonRpcClient.decodeQuantity(null, "q"));
    }

    @Test
    void decodesData() throws Exception {
        assertArrayEquals(new byte[] {0x12, (byte) 0xab}, JsonRpcClient.decodeData(new TextNode("0x12AB"), "d"));
        assertArrayEquals(new byte[0], JsonRpcClient.decodeData(new TextNode("0x"), "d"));
    }

    @Test
    void rejectsMalformedData() {
        for (JsonNode bad : List.of(new TextNode("0x123"), new TextNode("12"), new TextNode("0xgg"), new IntNode(1))) {
            assertThrows(IOException.class, () -> JsonRpcClient.decodeData(bad, "eth_call result"));
        }
        assertThrows(IOException.class, () -> JsonRpcClient.decodeData(null, "d"));
    }

    @Test
    void serializesStructuredParams() throws Exception {
        respond(ok("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x\"}"));

        client.call("eth_call", List.of(Map.of("to", "0x01"), "latest", false));

        wm.verify(postRequestedFor(urlEqualTo("/rpc"))
                .withRequestBody(matchingJsonPath("$.params[0].to", equalTo("0x01")))
                .withRequestBody(matchingJsonPath("$.params[2]", equalTo("false"))));
    }

    private void assertMalformed(String expected) {
        IOException e = assertThrows(IOException.class, () -> client.call("eth_chainId", List.of()));
        assertFalse(e instanceof JsonRpcException);
        assertTrue(e.getMessage().startsWith("eth_chainId: " + expected), e.getMessage());
        wm.resetAll();
        client = new JsonRpcClient(endpoint(), HTTP, Duration.ofSeconds(5));
    }

    private static URI endpoint() {
        return URI.create("http://localhost:" + wm.port() + "/rpc");
    }

    private static void respond(ResponseDefinitionBuilder response) {
        wm.stubFor(post(urlEqualTo("/rpc")).willReturn(response));
    }

    private static ResponseDefinitionBuilder ok(String body) {
        return aResponse().withStatus(200).withHeader("Content-Type", "application/json").withBody(body);
    }
}
